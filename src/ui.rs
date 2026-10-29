use super::*;
use crate::text_input::{self, Changed, TextInput};
use gpui::{prelude::*, *};
#[cfg(windows)]
use std::collections::HashSet;
use std::{cell::RefCell, ops::Range, path::Path, rc::Rc};

#[cfg(windows)]
type AccessibleAction =
    Rc<dyn Fn(&mut Nido, &accesskit::ActionRequest, &mut Window, &mut Context<Nido>)>;
type UiAction = Rc<dyn Fn(&mut Nido, &mut Window, &mut Context<Nido>)>;

#[path = "grid_view.rs"]
mod grid_view;
use grid_view::GridCache;

pub(super) struct Nido {
    model: Model,
    focus: FocusHandle,
    inputs: HashMap<&'static str, Entity<TextInput>>,
    grids: HashMap<String, GridCache>,
    tree_scroll: UniformListScrollHandle,
    palette_scroll: UniformListScrollHandle,
    palette_position: Option<(u64, usize)>,
    context_entry: Option<(String, Value)>,
    control_focus: RefCell<HashMap<SharedString, FocusHandle>>,
    #[cfg(windows)]
    accessibility: crate::accessibility::Accessibility,
    #[cfg(windows)]
    accessible_actions: RefCell<HashMap<accesskit::NodeId, AccessibleAction>>,
    #[cfg(windows)]
    accessible_fields: RefCell<HashSet<&'static str>>,
    resize_sidebar: bool,
    resize_terminal: bool,
    terminal_height: f32,
    started: Instant,
    painted: u64,
    acrylic: Option<bool>,
    font_setting: String,
    font_family: String,
}

pub fn run() -> anyhow::Result<()> {
    let data = persistence::data_dir();
    let saved = persistence::read_layout(&data.join("workspaces.json")).unwrap_or_default();
    let startup_error = Rc::new(RefCell::new(None));
    let open_error = startup_error.clone();
    Application::new()
        .with_assets(crate::assets::Assets)
        .run(move |cx| {
            text_input::init(cx);
            let width = saved.window["width"].as_f64().unwrap_or(1440.0) as f32;
            let height = saved.window["height"].as_f64().unwrap_or(940.0) as f32;
            let bounds = Bounds::centered(
                None,
                size(px(width.clamp(850., 3840.)), px(height.clamp(560., 2160.))),
                cx,
            );
            let options = WindowOptions {
                show: !cfg!(windows),
                focus: !cfg!(windows),
                window_bounds: Some(if saved.window["maximized"] == true {
                    WindowBounds::Maximized(bounds)
                } else {
                    WindowBounds::Windowed(bounds)
                }),
                titlebar: Some(TitlebarOptions {
                    title: Some("Nido".into()),
                    appears_transparent: true,
                    ..Default::default()
                }),
                app_id: Some("com.kanata9819.nido".into()),
                window_min_size: Some(size(px(700.), px(420.))),
                ..Default::default()
            };
            if let Err(error) = cx.open_window(options, |window, cx| {
                cx.new(|cx| Nido::new(data, window, cx))
            }) {
                *open_error.borrow_mut() = Some(format!("Open Nido: {error:#}"));
                cx.quit();
            }
            cx.on_window_closed(|cx| {
                if cx.windows().is_empty() {
                    cx.quit();
                }
            })
            .detach();
            cx.activate(true);
        });
    if let Some(error) = startup_error.borrow_mut().take() {
        anyhow::bail!(error);
    }
    Ok(())
}

impl Nido {
    fn new(data: PathBuf, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let (wake, wake_rx) = async_channel::bounded(1);
        let repaint: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            let _ = wake.try_send(());
        });
        let model = Model::load(data, repaint.clone());
        #[cfg(windows)]
        let accessibility = crate::accessibility::Accessibility::new(window, repaint);
        let focus = cx.focus_handle();
        #[cfg(windows)]
        accessibility.show();
        window.activate_window();
        window.focus(&focus);
        let entity = cx.weak_entity();
        window.on_window_should_close(cx, move |_, cx| {
            entity
                .update(cx, |this, cx| {
                    this.model.request_close(true);
                    cx.notify();
                    this.model.exit_allowed
                })
                .unwrap_or(true)
        });
        cx.observe_window_bounds(window, |this, window, _| {
            let bounds = window.window_bounds().get_bounds();
            this.model.window = json!({"width":f32::from(bounds.size.width),"height":f32::from(bounds.size.height),"maximized":window.is_maximized()});
        }).detach();
        cx.observe_window_activation(window, |this, window, cx| {
            if !window.is_window_active() {
                this.model.preedit.clear();
            }
            cx.notify();
        })
        .detach();
        cx.spawn_in(window, async move |entity, cx| {
            while wake_rx.recv().await.is_ok() {
                if entity
                    .update_in(cx, |this, window, cx| this.tick(window, cx))
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        cx.spawn_in(window, async move |entity, cx| {
            loop {
                let delay = entity
                    .read_with(cx, |this, _| {
                        if this.model.settings["smoothBlink"] == true
                            || this.model.settings["smoothCursor"] == true
                        {
                            32
                        } else {
                            200
                        }
                    })
                    .unwrap_or(200);
                Timer::after(Duration::from_millis(delay)).await;
                if entity
                    .update_in(cx, |this, window, cx| {
                        this.model.pump();
                        if this.focus.is_focused(window) && window.is_window_active()
                            || this.model.exit_allowed
                        {
                            this.tick(window, cx);
                        }
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        Self {
            model,
            focus,
            inputs: HashMap::new(),
            grids: HashMap::new(),
            tree_scroll: UniformListScrollHandle::new(),
            palette_scroll: UniformListScrollHandle::new(),
            palette_position: None,
            context_entry: None,
            control_focus: RefCell::new(HashMap::new()),
            #[cfg(windows)]
            accessibility,
            #[cfg(windows)]
            accessible_actions: RefCell::new(HashMap::new()),
            #[cfg(windows)]
            accessible_fields: RefCell::new(HashSet::new()),
            resize_sidebar: false,
            resize_terminal: false,
            terminal_height: 260.,
            started: Instant::now(),
            painted: 0,
            acrylic: None,
            font_setting: String::new(),
            font_family: "Cascadia Code".into(),
        }
    }

    fn tick(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        #[cfg(windows)]
        for request in self.accessibility.take_actions() {
            let action = self
                .accessible_actions
                .borrow()
                .get(&request.target_node)
                .cloned();
            if let Some(action) = action {
                action(self, &request, window, cx);
            }
        }
        self.model.pump();
        if self.model.exit_allowed {
            window.remove_window();
            return;
        }
        if let Some(command) = self.model.window_command.take() {
            match command.as_str() {
                "minimize" => window.minimize_window(),
                "maximize" => window.zoom_window(),
                _ => {}
            }
        }
        self.sync_focus(window, cx);
        cx.notify();
    }

    fn act(&mut self, action: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.model.execute(action);
        self.tick(window, cx);
    }

    fn sync_focus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.model.palette.as_ref().is_some_and(|p| p.focus) {
            let query = self.model.palette.as_ref().unwrap().query.clone();
            let input = self.field("palette", query, "Search…", cx);
            window.focus(&input.focus_handle(cx));
            self.model.palette.as_mut().unwrap().focus = false;
        } else if self.model.file_request.as_ref().is_some_and(|r| r.focus) {
            let request = self.model.file_request.as_mut().unwrap();
            request.focus = false;
            if request.action != "delete" {
                let target = request.target.clone();
                let input = self.field("file", target, "Path", cx);
                window.focus(&input.focus_handle(cx));
            } else {
                window.focus(&self.focus);
            }
        } else if self.model.focus_editor
            && self.model.palette.is_none()
            && self.model.file_request.is_none()
            && !self.model.show_wsl
        {
            window.focus(&self.focus);
            self.model.focus_editor = false;
        }
        if let Some(p) = &self.model.palette
            && self.palette_position != Some((p.generation, p.index))
        {
            self.palette_scroll
                .scroll_to_item(p.index, ScrollStrategy::Top);
            self.palette_position = Some((p.generation, p.index));
        } else if self.model.palette.is_none() {
            self.palette_position = None;
        }
    }

    fn field(
        &mut self,
        key: &'static str,
        content: String,
        placeholder: &str,
        cx: &mut Context<Self>,
    ) -> Entity<TextInput> {
        let tab_stop = !self.modal_open() || matches!(key, "palette" | "file" | "wslPath");
        #[cfg(windows)]
        if tab_stop {
            self.accessible_fields.borrow_mut().insert(key);
        }
        if let Some(input) = self.inputs.get(key) {
            input.update(cx, |input, cx| {
                input.tab_stop = tab_stop;
                input.set(&content, cx);
            });
            return input.clone();
        }
        let input = cx.new(|cx| {
            let mut input = TextInput::new(content, self.model.tr(placeholder), cx);
            input.tab_stop = tab_stop;
            input
        });
        cx.subscribe(&input, move |this, _, changed: &Changed, cx| {
            this.edit(key, &changed.0);
            cx.notify();
        })
        .detach();
        self.inputs.insert(key, input.clone());
        input
    }

    fn edit(&mut self, key: &str, text: &str) {
        match key {
            "palette" => {
                if let Some(p) = self.model.palette.as_mut() {
                    p.query = text.into();
                    self.model.palette_changed();
                }
            }
            "file" => {
                if let Some(r) = self.model.file_request.as_mut() {
                    r.target = text.into();
                }
            }
            "search" => {
                self.model.search_query = text.into();
                self.invalidate_search();
            }
            "folder" => {
                self.model.search_options["folder"] = json!(text);
                self.invalidate_search();
            }
            "replacement" => {
                self.model.replacement = text.into();
                self.model.replacement_preview = Value::Null;
            }
            "commit" => self.model.commit = text.into(),
            "font" => self.model.settings["fontFamily"] = json!(text),
            "wslPath" => self.model.wsl_path = text.into(),
            _ => {}
        }
    }

    fn invalidate_search(&mut self) {
        self.model.search_results = Value::Null;
        self.model.replacement_preview = Value::Null;
        self.model.search_selected.clear();
    }

    fn key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let key = &event.keystroke;
        let editor = self.focus.is_focused(window);
        let ctrl = key.modifiers.control && !key.modifiers.alt;
        let mut handled = false;
        if key.modifiers.alt && key.key == "f4" {
            self.model.request_close(true);
            window.prevent_default();
            cx.stop_propagation();
            self.tick(window, cx);
            return;
        }
        if key.key == "escape" && self.context_entry.take().is_some() {
            window.prevent_default();
            cx.stop_propagation();
            self.tick(window, cx);
            return;
        }
        if key.key == "tab" && (!editor || self.modal_open()) && !ctrl && !key.modifiers.alt {
            if key.modifiers.shift {
                window.focus_prev();
            } else {
                window.focus_next();
            }
            window.prevent_default();
            cx.stop_propagation();
            return;
        }
        if key.key == "enter"
            && self.model.file_request.is_some()
            && !editor
            && !self
                .inputs
                .get("file")
                .is_some_and(|input| input.focus_handle(cx).is_focused(window))
        {
            return;
        }

        if editor && ctrl && key.modifiers.shift && key.key == "v" {
            if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text())
                && let Some(i) = self.model.input_index()
            {
                self.model.workspaces[i]
                    .session
                    .send("paste", json!([text]));
            }
            handled = true;
        } else if key.key == "enter"
            && self.model.panel == "search"
            && self
                .inputs
                .get("search")
                .is_some_and(|input| input.focus_handle(cx).is_focused(window))
        {
            self.model.send(
                "search",
                json!([self.model.search_query, self.model.search_options]),
            );
            handled = true;
        } else if key.key == "enter" && ctrl && self.model.panel == "git" {
            self.model
                .git_mutation("commit", json!([self.model.commit]));
            handled = true;
        }
        if handled || self.model.key(key, editor) {
            cx.stop_propagation();
            window.prevent_default();
        }
        self.tick(window, cx);
    }

    fn button(
        &self,
        id: impl Into<SharedString>,
        label: impl Into<SharedString>,
        action: impl Fn(&mut Self, &mut Window, &mut Context<Self>) + 'static,
        cx: &Context<Self>,
    ) -> Stateful<Div> {
        let id = id.into();
        let modal = self.modal_open();
        let tab_stop = !modal || id.starts_with("modal-");
        let label = label.into();
        let action = Rc::new(action);
        let click = action.clone();
        let focus = self
            .control_focus
            .borrow_mut()
            .entry(id.clone())
            .or_insert_with(|| cx.focus_handle())
            .clone();
        #[cfg(windows)]
        if tab_stop {
            let mut node = accesskit::Node::new(accesskit::Role::Button);
            node.set_label(if label.is_empty() {
                id.replace('-', " ")
            } else {
                label.to_string()
            });
            node.add_action(accesskit::Action::Click);
            node.add_action(accesskit::Action::Focus);
            self.accessibility.insert(&id, node);
            let action = action.clone();
            let focus = focus.clone();
            self.accessible_actions.borrow_mut().insert(
                crate::accessibility::id(&id),
                Rc::new(move |this, request, window, cx| match request.action {
                    accesskit::Action::Click => action(this, window, cx),
                    accesskit::Action::Focus => window.focus(&focus),
                    _ => {}
                }),
            );
        }
        let marker = self.accessible_bounds(id.to_string(), cx.entity());
        div()
            .id(id)
            .track_focus(&focus)
            .tab_index(0)
            .tab_stop(tab_stop)
            .flex()
            .items_center()
            .gap_2()
            .px_2()
            .py_1()
            .rounded(px(4.))
            .cursor_pointer()
            .hover(|s| s.bg(rgb(0x2b333b)))
            .focus(|s| s.bg(rgb(0x34473b)))
            .relative()
            .child(label)
            .child(marker)
            .on_click(cx.listener(move |this, _, window, cx| {
                click(this, window, cx);
                cx.notify();
            }))
            .on_key_down(cx.listener(move |this, event: &KeyDownEvent, window, cx| {
                if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                    cx.stop_propagation();
                    window.prevent_default();
                    action(this, window, cx);
                    cx.notify();
                }
            }))
    }

    fn accessible_bounds(&self, key: String, entity: Entity<Self>) -> AnyElement {
        canvas(
            move |bounds, window, cx| {
                #[cfg(windows)]
                entity
                    .read(cx)
                    .accessibility
                    .bounds(&key, bounds, window.scale_factor());
                #[cfg(not(windows))]
                let _ = (&entity, &key, bounds, window, cx);
            },
            |_, _, _, _| {},
        )
        .absolute()
        .size_full()
        .into_any_element()
    }

    fn accessible_item(
        &self,
        key: String,
        label: String,
        action: UiAction,
        entity: Entity<Self>,
    ) -> AnyElement {
        #[cfg(windows)]
        if !self.modal_open() || key.starts_with("modal-") {
            let mut node = accesskit::Node::new(accesskit::Role::Button);
            node.set_label(label);
            node.add_action(accesskit::Action::Click);
            self.accessibility.insert(&key, node);
            self.accessible_actions.borrow_mut().insert(
                crate::accessibility::id(&key),
                Rc::new(move |this, request, window, cx| {
                    if request.action == accesskit::Action::Click {
                        action(this, window, cx);
                    }
                }),
            );
        }
        #[cfg(not(windows))]
        let _ = (label, action);
        self.accessible_bounds(key, entity)
    }

    #[cfg(windows)]
    fn publish_accessibility(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let mut focus = None;
        for (key, handle) in self.control_focus.borrow().iter() {
            if handle.is_focused(window) {
                focus = Some(crate::accessibility::id(key));
            }
        }
        for key in self.accessible_fields.borrow().iter().copied() {
            let Some(input) = self.inputs.get(key) else {
                continue;
            };
            let state = input.read(cx);
            let (label, value, bounds) = state.accessibility();
            let mut node = accesskit::Node::new(accesskit::Role::TextInput);
            node.set_label(label);
            node.set_value(value);
            node.add_action(accesskit::Action::Focus);
            node.add_action(accesskit::Action::SetValue);
            let name = format!("input-{key}");
            let id = crate::accessibility::id(&name);
            self.accessibility.insert(&name, node);
            if let Some(bounds) = bounds {
                self.accessibility
                    .bounds(&name, bounds, window.scale_factor());
            }
            if state.focus_handle(cx).is_focused(window) {
                focus = Some(id);
            }
            let input = input.clone();
            self.accessible_actions.borrow_mut().insert(
                id,
                Rc::new(move |_, request, window, cx| {
                    window.focus(&input.focus_handle(cx));
                    if request.action == accesskit::Action::SetValue
                        && let Some(accesskit::ActionData::Value(value)) = &request.data
                    {
                        input.update(cx, |input, cx| {
                            let end = input.content.encode_utf16().count();
                            input.replace_text_in_range(Some(0..end), value, window, cx);
                        });
                    }
                }),
            );
        }
        if !self.modal_open() {
            for workspace in &self.model.workspaces {
                let Some(cache) = self.grids.get(&workspace.session.id) else {
                    continue;
                };
                if workspace.session.id != self.model.active
                    && workspace.parent.as_deref() != Some(&self.model.active)
                {
                    continue;
                }
                if workspace.parent.is_some() && !self.model.terminal_visible {
                    continue;
                }
                let key = format!("editor-{}", workspace.session.id);
                let id = crate::accessibility::id(&key);
                let mut node = accesskit::Node::new(accesskit::Role::MultilineTextInput);
                node.set_label(if workspace.parent.is_some() {
                    "Terminal"
                } else {
                    "Editor"
                });
                // shortcut: expose the visible grid; add text runs for screen-reader caret navigation.
                node.set_value(workspace.grid.description());
                node.add_action(accesskit::Action::Focus);
                self.accessibility.insert(&key, node);
                self.accessibility
                    .bounds(&key, cache.bounds, window.scale_factor());
                let terminal = workspace.parent.is_some();
                if self.focus.is_focused(window) && self.model.terminal_focused == terminal {
                    focus = Some(id);
                }
                self.accessible_actions.borrow_mut().insert(
                    id,
                    Rc::new(move |this, request, window, _| {
                        if request.action == accesskit::Action::Focus {
                            this.model.terminal_focused = terminal;
                            this.model.explorer_focus = false;
                            window.focus(&this.focus);
                        }
                    }),
                );
            }
        }
        self.accessibility.publish(focus);
    }

    fn modal_open(&self) -> bool {
        self.model.closing.is_some()
            || self.model.palette.is_some()
            || self.model.file_request.is_some()
            || self.model.show_wsl
            || self.context_entry.is_some()
            || !self.model.hover.is_empty()
            || !self.model.diagnostics.is_null()
    }

    fn command(&self, id: &str, label: &str, action: &str, cx: &Context<Self>) -> Stateful<Div> {
        let action = action.to_owned();
        self.button(
            id.to_owned(),
            self.model.tr(label),
            move |this, window, cx| this.act(&action, window, cx),
            cx,
        )
    }

    fn icon_button(
        &self,
        id: &str,
        name: &str,
        label: &str,
        action: &str,
        cx: &Context<Self>,
    ) -> Stateful<Div> {
        let title = self.model.tr(label);
        let button = self.command(id, "", action, cx);
        #[cfg(windows)]
        self.accessibility.label(id, &title);
        button
            .h_full()
            .px_2()
            .child(icon(name, 17.))
            .tooltip(move |_, cx| cx.new(|_| Tooltip(title.clone())).into())
    }

    fn titlebar(&self, cx: &Context<Self>) -> AnyElement {
        let compact = self.model.settings["compactMode"] == true;
        let height = if compact { 24. } else { 38. };
        let mut tabs = div()
            .id("workspace-tabs")
            .flex()
            .h_full()
            .min_w_0()
            .gap(px(if compact { 4. } else { 7. }))
            .pt(px(if compact { 0. } else { 3. }))
            .overflow_x_scroll();
        for (i, w) in self
            .model
            .workspaces
            .iter()
            .filter(|w| w.parent.is_none())
            .enumerate()
        {
            let id = w.session.id.clone();
            let close_id = id.clone();
            let active = id == self.model.active;
            tabs = tabs.child(
                div()
                    .id(SharedString::from(format!("workspace-{id}")))
                    .flex()
                    .h_full()
                    .min_w(px(if compact { 100. } else { 146. }))
                    .max_w(px(235.))
                    .flex_shrink_0()
                    .rounded_t(px(if compact { 0. } else { 9. }))
                    .border_t_2()
                    .border_color(if active { rgb(0x99c68c) } else { rgb(0x0e1012) })
                    .when(active, |el| el.bg(rgb(0x202326)))
                    .child(
                        self.button(
                            format!("workspace-select-{id}"),
                            "",
                            move |this, window, cx| {
                                this.model.active = id.clone();
                                this.model.terminal_focused = false;
                                this.model.explorer_focus = false;
                                this.model.panel.clear();
                                this.model.focus_editor = true;
                                this.tick(window, cx);
                            },
                            cx,
                        )
                        .h_full()
                        .flex_1()
                        .min_w_0()
                        .child(if w.session.terminal {
                            icon("square-terminal", 15.)
                        } else {
                            icon("leaf", 15.)
                        })
                        .child(div().truncate().child(w.name()))
                        .when(!compact, |el| el.child(kbd(format!("{}", i + 1)))),
                    )
                    .child(
                        self.button(
                            format!("workspace-close-{close_id}"),
                            "",
                            move |this, window, cx| {
                                this.model.active = close_id.clone();
                                this.model.request_close(false);
                                this.tick(window, cx);
                            },
                            cx,
                        )
                        .h_full()
                        .px_1()
                        .text_color(rgb(0x929eaa))
                        .child(icon("x", 13.)),
                    ),
            );
        }
        div()
            .flex()
            .h(px(height))
            .flex_shrink_0()
            .bg(rgb(0x0e1012))
            .border_b_1()
            .border_color(rgb(0x282c30))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(11.))
                    .w(px(if compact { 40. } else { 115. }))
                    .pl(px(14.))
                    .flex_shrink_0()
                    .text_color(rgb(0x99c68c))
                    .child(icon("leaf", if compact { 16. } else { 22. }))
                    .when(!compact, |el| {
                        el.child(
                            div()
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_size(px(15.))
                                .child("Nido"),
                        )
                    })
                    .on_mouse_down(MouseButton::Left, |_, window, _| window.start_window_move()),
            )
            .child(tabs)
            .child(self.icon_button("new", "plus", "New workspace", "new", cx))
            .child(self.icon_button(
                "new-terminal",
                "square-terminal",
                "New terminal workspace",
                "newTerminal",
                cx,
            ))
            .child(div().flex_1().min_w(px(18.)).on_mouse_down(
                MouseButton::Left,
                |event, window, _| {
                    if event.click_count == 2 {
                        window.zoom_window();
                    } else {
                        window.start_window_move();
                    }
                },
            ))
            .child(self.icon_button(
                "favorite",
                "star",
                "Toggle workspace favorite",
                "favorite",
                cx,
            ))
            .child(self.icon_button("commands", "keyboard", "Commands", "commands", cx))
            .child(self.icon_button("settings", "settings-2", "Settings", "settings", cx))
            .child(
                self.icon_button("minimize", "minus", "Minimize window", "minimize", cx)
                    .window_control_area(WindowControlArea::Min),
            )
            .child(
                self.icon_button("maximize", "square", "Maximize window", "maximize", cx)
                    .window_control_area(WindowControlArea::Max),
            )
            .child(
                self.icon_button("quit", "x", "Quit", "quit", cx)
                    .window_control_area(WindowControlArea::Close),
            )
            .into_any_element()
    }

    fn navigation(&self, horizontal: bool, cx: &Context<Self>) -> AnyElement {
        let mut rail = div()
            .flex()
            .flex_shrink_0()
            .bg(rgb(0x111518))
            .items_center()
            .gap(px(3.))
            .py_1();
        rail = if horizontal {
            rail.h(px(38.)).w_full()
        } else {
            rail.flex_col().w(px(47.)).h_full()
        };
        for (name, label, action) in [
            ("files", "Explorer", "explorer"),
            ("search", "Find file", "files"),
            ("square", "Workspaces", "workspaces"),
            ("git-branch", "Source control", "git"),
            ("history", "Time Machine", "history"),
            ("blocks", "Extensions", "extensions"),
        ] {
            rail = rail.child(
                self.icon_button(&format!("nav-{action}"), name, label, action, cx)
                    .h(px(34.))
                    .w(px(40.))
                    .justify_center()
                    .when(
                        self.model.panel == action
                            || action == "explorer" && self.model.explorer_focus,
                        |el| el.text_color(rgb(0x99c68c)).bg(rgb(0x20282d)),
                    ),
            );
        }
        rail.into_any_element()
    }

    fn reveal_tree(&mut self) {
        let Some(i) = self.model.active_index() else {
            return;
        };
        let current = self.model.workspaces[i].current();
        if current != self.model.workspaces[i].last_file {
            self.model.workspaces[i].last_file = current.clone();
            let root = &self.model.workspaces[i].session.root;
            let path = if let Some(remote) = crate::wsl::Remote::parse(root) {
                remote.host(&current)
            } else {
                PathBuf::from(current)
            };
            if let Ok(relative) = path.strip_prefix(root) {
                self.model.workspaces[i].reveal_file =
                    Some(relative.to_string_lossy().replace('\\', "/"));
                let mut parent = relative.parent();
                let mut folders = vec![];
                while let Some(folder) = parent {
                    let name = folder.to_string_lossy().replace('\\', "/");
                    if !name.is_empty() {
                        folders.push(name);
                    }
                    parent = folder.parent();
                }
                for folder in folders {
                    self.model.expand_folder(i, &folder);
                }
            }
        }
        let rows = tree_rows(&self.model.workspaces[i], "", 0);
        if let Some(path) = &self.model.workspaces[i].reveal_file
            && let Some(index) = rows.iter().position(|(e, _)| e["path"] == *path)
        {
            self.model.workspaces[i].selected = index;
            self.model.workspaces[i].reveal_selected = true;
            self.model.workspaces[i].reveal_file = None;
        }
        if self.model.workspaces[i].reveal_selected {
            self.tree_scroll
                .scroll_to_item(self.model.workspaces[i].selected, ScrollStrategy::Top);
            self.model.workspaces[i].reveal_selected = false;
        }
    }

    fn explorer(&mut self, cx: &Context<Self>) -> AnyElement {
        let Some(index) = self.model.active_index() else {
            return div().into_any_element();
        };
        self.reveal_tree();
        let w = &self.model.workspaces[index];
        let root_name = w.name();
        let rows = tree_rows(w, "", 0);
        let entity = cx.entity();
        let tree = uniform_list("explorer-tree", rows.len(), move |range, _, cx| {
            let view = entity.read(cx);
            let w = &view.model.workspaces[index];
            range
                .map(|row| {
                    let (entry, depth) = &rows[row];
                    let e = entry.clone();
                    let context_e = entry.clone();
                    let folder = entry["directory"] == true;
                    let expanded = w.expanded.contains(s(&entry["path"]));
                    let click_entity = entity.clone();
                    let context_entity = entity.clone();
                    let workspace = w.session.id.clone();
                    let activate: UiAction = Rc::new(move |this, window, cx| {
                        if this
                            .model
                            .workspaces
                            .get(index)
                            .is_some_and(|w| w.session.id == workspace)
                        {
                            this.model.workspaces[index].selected = row;
                            this.model.explorer_focus = true;
                            this.model.tree_action(index, "open", &e);
                            this.tick(window, cx);
                        }
                    });
                    let marker = view.accessible_item(
                        format!("tree-{}-{}", w.session.id, s(&entry["path"])),
                        s(&entry["name"]).to_owned(),
                        activate.clone(),
                        entity.clone(),
                    );
                    div()
                        .id(("tree-row", row))
                        .relative()
                        .flex()
                        .h(px(26.))
                        .items_center()
                        .gap(px(7.))
                        .pl(px(12. + *depth as f32 * 16.))
                        .pr_2()
                        .w_full()
                        .min_w_0()
                        .cursor_pointer()
                        .when(row == w.selected, |el| el.bg(rgb(0x29343c)))
                        .hover(|el| el.bg(rgb(0x252d34)))
                        .child(if folder {
                            icon(
                                if expanded {
                                    "chevron-down"
                                } else {
                                    "chevron-right"
                                },
                                12.,
                            )
                            .into_any_element()
                        } else {
                            div().w(px(12.)).into_any_element()
                        })
                        .child(if folder {
                            icon(if expanded { "folder-open" } else { "folder" }, 16.)
                                .text_color(rgb(0xb9c6ab))
                                .into_any_element()
                        } else {
                            file_icon(s(&entry["path"]))
                        })
                        .child(div().truncate().child(s(&entry["name"]).to_owned()))
                        .child(marker)
                        .on_click(move |_, window, cx| {
                            click_entity.update(cx, |this, cx| activate(this, window, cx))
                        })
                        .on_mouse_down(MouseButton::Right, move |_, window, cx| {
                            context_entity.update(cx, |this, cx| {
                                this.model.workspaces[index].selected = row;
                                this.model.explorer_focus = true;
                                this.context_entry =
                                    Some((this.model.active.clone(), context_e.clone()));
                                window.focus(&this.focus);
                                cx.notify();
                            })
                        })
                })
                .collect::<Vec<_>>()
        })
        .track_scroll(self.tree_scroll.clone())
        .flex_1()
        .min_h_0();
        div()
            .flex()
            .flex_col()
            .h_full()
            .min_w_0()
            .bg(rgb(0x171c20))
            .border_r_1()
            .border_color(rgb(0x282c30))
            .child(
                div()
                    .flex()
                    .items_center()
                    .h(px(37.))
                    .px_3()
                    .gap_1()
                    .child(
                        div()
                            .flex_1()
                            .text_size(px(11.))
                            .text_color(rgb(0x929eaa))
                            .child(self.model.tr("Explorer").to_uppercase()),
                    )
                    .child(
                        self.button(
                            "new-file",
                            "",
                            |this, window, cx| {
                                this.model.file_request = Some(FileRequest {
                                    workspace: this.model.active.clone(),
                                    action: "createFile".into(),
                                    source: String::new(),
                                    target: String::new(),
                                    focus: true,
                                });
                                this.tick(window, cx);
                            },
                            cx,
                        )
                        .child(icon("file-plus", 15.)),
                    )
                    .child(
                        self.button(
                            "refresh-tree",
                            "",
                            |this, _, _| {
                                this.model.send("files", json!([""]));
                                if let Some(i) = this.model.active_index() {
                                    this.model.workspaces[i].session.send_tag(
                                        "files",
                                        json!([""]),
                                        "files:",
                                    );
                                }
                            },
                            cx,
                        )
                        .child(icon("refresh-cw", 14.)),
                    ),
            )
            .child(
                div()
                    .h(px(29.))
                    .px_3()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(root_name),
            )
            .child(tree)
            .into_any_element()
    }

    fn buffer_tabs(&self, i: usize, cx: &Context<Self>) -> AnyElement {
        let w = &self.model.workspaces[i];
        let mut tabs = div()
            .id("buffer-tabs")
            .flex()
            .h(px(if self.model.settings["compactMode"] == true {
                28.
            } else {
                35.
            }))
            .flex_shrink_0()
            .bg(rgb(0x14191d))
            .border_b_1()
            .border_color(rgb(0x282c30))
            .overflow_x_scroll();
        for b in w.buffers() {
            let id = b["id"].clone();
            let close_id = id.clone();
            let active = b["id"] == w.state["current"];
            let path = s(&b["name"]);
            let name = Path::new(path)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            tabs = tabs.child(
                div()
                    .flex()
                    .h_full()
                    .flex_shrink_0()
                    .border_r_1()
                    .border_color(rgb(0x282c30))
                    .when(active, |el| {
                        el.bg(rgb(0x191e23))
                            .border_t_2()
                            .border_color(rgb(0x99c68c))
                    })
                    .child(
                        self.button(
                            format!("buffer-{id}"),
                            "",
                            move |this, window, cx| {
                                this.model.send("selectBuffer", json!([id]));
                                this.model.focus_editor = true;
                                this.tick(window, cx);
                            },
                            cx,
                        )
                        .h_full()
                        .gap(px(10.))
                        .px_3()
                        .child(file_icon(path))
                        .child(if name.is_empty() {
                            "[No Name]".into()
                        } else {
                            name
                        })
                        .when(b["modified"] == true, |el| {
                            el.child(div().size(px(6.)).rounded_full().bg(rgb(0x99c68c)))
                        }),
                    )
                    .child(
                        self.button(
                            format!("buffer-close-{close_id}"),
                            "",
                            move |this, window, cx| {
                                this.model.send("closeBuffer", json!([close_id, false]));
                                this.tick(window, cx);
                            },
                            cx,
                        )
                        .px_1()
                        .child(icon("x", 12.)),
                    ),
            );
        }
        tabs.into_any_element()
    }

    fn editor(&self, index: usize, terminal: bool, cx: &Context<Self>) -> AnyElement {
        let id = self.model.workspaces[index].session.id.clone();
        let prepaint = cx.entity();
        let paint = prepaint.clone();
        let grid_id = id.clone();
        let paint_id = id.clone();
        div()
            .id(SharedString::from(format!("editor-{id}")))
            .relative()
            .flex_1()
            .min_h_0()
            .min_w_0()
            .overflow_hidden()
            .cursor_text()
            .child(
                canvas(
                    move |bounds, window, cx| {
                        prepaint.update(cx, |this, cx| {
                            this.prepare_grid(&grid_id, bounds, window, cx)
                        })
                    },
                    move |bounds, _, window, cx| {
                        paint.update(cx, |this, cx| {
                            this.paint_grid(&paint_id, bounds, window, cx)
                        })
                    },
                )
                .size_full(),
            )
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |this, event: &MouseDownEvent, window, cx| {
                    this.model.explorer_focus = false;
                    this.model.terminal_focused = terminal;
                    window.focus(&this.focus);
                    this.grid_mouse(index, "press", event.position, event.modifiers, window, cx);
                }),
            )
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(move |this, event: &MouseUpEvent, window, cx| {
                    this.grid_mouse(
                        index,
                        "release",
                        event.position,
                        event.modifiers,
                        window,
                        cx,
                    );
                }),
            )
            .on_mouse_move(
                cx.listener(move |this, event: &MouseMoveEvent, window, cx| {
                    if event.pressed_button == Some(MouseButton::Left) {
                        this.grid_mouse(index, "drag", event.position, event.modifiers, window, cx);
                    }
                }),
            )
            .on_scroll_wheel(cx.listener(move |this, event: &ScrollWheelEvent, _, _| {
                let w = &this.model.workspaces[index];
                if let Some(cache) = this.grids.get(&w.session.id) {
                    let delta = event.delta.pixel_delta(px(cache.cell.height));
                    w.session.send(
                        "scroll",
                        json!([
                            -f32::from(delta.y) / cache.cell.height,
                            -f32::from(delta.x) / cache.cell.width
                        ]),
                    );
                }
            }))
            .into_any_element()
    }

    fn grid_mouse(
        &mut self,
        index: usize,
        action: &str,
        position: Point<Pixels>,
        modifiers: Modifiers,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(w) = self.model.workspaces.get(index) else {
            return;
        };
        let Some(cache) = self.grids.get(&w.session.id) else {
            return;
        };
        if w.grid.completion.is_object()
            && let Some((bounds, start, count)) = cache.completion
            && bounds.contains(&position)
        {
            if action == "press" {
                let item =
                    (f32::from(position.y - bounds.top()) / cache.cell.height).floor() as usize;
                if item < count {
                    w.session.send(
                        "rpc",
                        json!(["nvim_select_popupmenu_item", [start + item, true, true, {}]]),
                    );
                }
            }
            cx.stop_propagation();
            return;
        }
        let row = (f32::from(position.y - cache.bounds.top()) / cache.cell.height)
            .floor()
            .max(0.) as usize;
        let col = (f32::from(position.x - cache.bounds.left()) / cache.cell.width)
            .floor()
            .max(0.) as usize;
        if action == "press" && self.model.settings["stickyScroll"] != false {
            let max = self.model.settings["stickyScrollMaxLines"]
                .as_u64()
                .unwrap_or(5) as usize;
            if let Some(scope) = array(&w.grid.sticky["scopes"])
                .iter()
                .filter(|s| s["top"].as_i64().unwrap_or(0) < 0)
                .take(max)
                .nth(row)
            {
                w.session.send(
                    "lua",
                    json!([
                        "return require('nido_sticky').jump(...)",
                        [
                            w.grid.sticky["window"],
                            w.grid.sticky["buffer"],
                            scope["line"]
                        ]
                    ]),
                );
                self.tick(window, cx);
                return;
            }
        }
        let mut m = String::new();
        if modifiers.shift {
            m.push('S');
        }
        if modifiers.control {
            m.push('C');
        }
        if modifiers.alt {
            m.push('A');
        }
        w.session
            .send("mouse", json!(["left", action, m, 1, row, col]));
        cx.notify();
    }

    fn welcome(&self, cx: &Context<Self>) -> AnyElement {
        let mut content = div()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap_3()
            .size_full()
            .text_color(rgb(0x929eaa))
            .child(icon("leaf", 52.).text_color(rgb(0x99c68c)))
            .child(
                div()
                    .text_size(px(38.))
                    .text_color(rgb(0xd6dce2))
                    .child("Nido"),
            )
            .child(self.model.tr("Open a local or WSL workspace"))
            .child(self.command("welcome-new", "New workspace", "new", cx))
            .child(self.command(
                "welcome-terminal",
                "New terminal workspace",
                "newTerminal",
                cx,
            ))
            .child(self.command("welcome-wsl", "Connect to WSL", "wsl", cx));
        for (i, favorite) in array(&self.model.favorites).iter().enumerate() {
            let f = favorite.clone();
            content = content.child(self.button(
                format!("favorite-{i}"),
                s(&f["name"]).to_owned(),
                move |this, window, cx| {
                    this.model.add_workspace(
                        PathBuf::from(s(&f["root"])),
                        f["kind"] == "terminal",
                        None,
                        None,
                    );
                    this.tick(window, cx);
                },
                cx,
            ));
        }
        content
            .child(
                div()
                    .mt_4()
                    .text_size(px(12.))
                    .child("Ctrl+Shift+N   Open workspace       Space   Commands"),
            )
            .into_any_element()
    }

    fn status(&self, cx: &Context<Self>) -> AnyElement {
        let state = self
            .model
            .active_index()
            .map(|i| self.model.workspaces[i].state.clone())
            .unwrap_or_default();
        div()
            .flex()
            .h(px(25.))
            .items_center()
            .gap_2()
            .px_2()
            .flex_shrink_0()
            .bg(rgb(0x111619))
            .border_t_1()
            .border_color(rgb(0x282c30))
            .text_size(px(11.))
            .text_color(rgb(0x929eaa))
            .child(
                div()
                    .px_2()
                    .py(px(2.))
                    .rounded(px(3.))
                    .text_color(rgb(0x99c68c))
                    .bg(rgb(0x25322a))
                    .child(s(&state["mode"]).to_uppercase()),
            )
            .child(self.command("status-branch", s(&state["branch"]), "git", cx))
            .child(self.command(
                "status-problems",
                &format!("{} {}", s(&state["filetype"]), s(&state["lsp"])),
                "problems",
                cx,
            ))
            .child(div().flex_1())
            .child(format!(
                "Ln {}, Col {}",
                n(&state["line"]),
                n(&state["column"])
            ))
            .child(self.command(
                "status-eol",
                if state["fileformat"] == "dos" {
                    "CRLF"
                } else {
                    "LF"
                },
                if state["fileformat"] == "dos" {
                    "lf"
                } else {
                    "crlf"
                },
                cx,
            ))
            .child("UTF-8")
            .child(self.command("status-terminal", "Terminal", "terminal", cx))
            .child(self.command("status-commands", "Space  Commands", "commands", cx))
            .into_any_element()
    }
}

impl Render for Nido {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.grids
            .retain(|id, _| self.model.workspaces.iter().any(|w| w.session.id == *id));
        #[cfg(windows)]
        {
            self.accessibility.clear();
            self.accessible_actions.borrow_mut().clear();
            self.accessible_fields.borrow_mut().clear();
        }
        self.sync_focus(window, cx);
        let acrylic = self.model.settings["theme"] == "acrylic";
        if self.acrylic != Some(acrylic) {
            window.set_background_appearance(if acrylic {
                WindowBackgroundAppearance::Blurred
            } else {
                WindowBackgroundAppearance::Opaque
            });
            self.acrylic = Some(acrylic);
        }
        let top_rail = self.model.settings["activityBarPosition"] == "top";
        let mut center = div().flex().flex_col().flex_1().min_w_0().min_h_0();
        if let Some(i) = self.model.active_index() {
            center = center
                .child(self.buffer_tabs(i, cx))
                .child(self.editor(i, false, cx));
        } else {
            center = center.child(self.welcome(cx));
        }
        if self.model.terminal_visible
            && let Some(index) = self
                .model
                .workspaces
                .iter()
                .position(|w| w.parent.as_deref() == Some(&self.model.active))
        {
            center = center
                .child(
                    div()
                        .id("terminal-divider")
                        .h(px(4.))
                        .flex_shrink_0()
                        .cursor(CursorStyle::ResizeUpDown)
                        .bg(rgb(0x282c30))
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(|this, _, _, _| this.resize_terminal = true),
                        ),
                )
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .h(px(self.terminal_height))
                        .min_h(px(100.))
                        .flex_shrink_0()
                        .child(
                            div()
                                .flex()
                                .h(px(30.))
                                .items_center()
                                .px_2()
                                .gap_2()
                                .bg(rgb(0x151b20))
                                .child(div().flex_1().child(self.model.tr("Terminal")))
                                .child(self.button(
                                    "restart-paired",
                                    "Restart shell",
                                    move |this, _, _| {
                                        this.model.workspaces[index]
                                            .session
                                            .send("restartTerminal", json!([]))
                                    },
                                    cx,
                                ))
                                .child(
                                    self.button(
                                        "hide-terminal",
                                        "",
                                        |this, window, cx| {
                                            this.model.terminal_visible = false;
                                            this.model.focus_editor = true;
                                            this.tick(window, cx);
                                        },
                                        cx,
                                    )
                                    .child(icon("x", 14.)),
                                ),
                        )
                        .child(self.editor(index, true, cx)),
                );
        }
        let mut body = div().flex().flex_1().min_h_0().overflow_hidden();
        if !top_rail {
            body = body.child(self.navigation(false, cx));
        }
        if self.model.settings["sidebar"] != false && self.model.active_index().is_some() {
            body = body
                .child(
                    div()
                        .w(px(
                            self.model.settings["sidebarWidth"].as_f64().unwrap_or(243.) as f32,
                        ))
                        .flex_shrink_0()
                        .h_full()
                        .child(self.explorer(cx)),
                )
                .child(
                    div()
                        .id("sidebar-divider")
                        .w(px(3.))
                        .h_full()
                        .flex_shrink_0()
                        .cursor(CursorStyle::ResizeLeftRight)
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(|this, _, _, _| this.resize_sidebar = true),
                        ),
                );
        }
        body = body.child(center);
        if !self.model.panel.is_empty() {
            body = body.child(self.side_panel(cx));
        }
        div()
            .id("nido")
            .track_focus(&self.focus)
            .relative()
            .flex()
            .flex_col()
            .size_full()
            .overflow_hidden()
            .font_family("Segoe UI Variable")
            .text_size(px(13.))
            .text_color(rgb(0xd6dce2))
            .bg(if acrylic {
                rgba(0x191e23dc)
            } else {
                rgba(0x191e23ff)
            })
            .capture_key_down(cx.listener(Self::key_down))
            .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, window, cx| {
                if this.resize_sidebar {
                    this.model.settings["sidebarWidth"] =
                        json!((f32::from(event.position.x) - 47.).clamp(160., 480.));
                    cx.notify();
                }
                if this.resize_terminal {
                    this.terminal_height =
                        (f32::from(window.viewport_size().height - event.position.y) - 25.)
                            .clamp(100., 700.);
                    cx.notify();
                }
            }))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, _, _, _| {
                    this.resize_sidebar = false;
                    this.resize_terminal = false;
                }),
            )
            .child(self.titlebar(cx))
            .when(top_rail, |el| el.child(self.navigation(true, cx)))
            .child(body)
            .child(self.status(cx))
            .children(self.overlay(cx))
            .children(self.notifications(cx))
            .child({
                let entity = cx.entity();
                canvas(
                    |_, _, _| {},
                    move |_, _, window, cx| {
                        #[cfg(windows)]
                        entity.update(cx, |this, cx| this.publish_accessibility(window, cx));
                        #[cfg(not(windows))]
                        let _ = (&entity, window, cx);
                    },
                )
                .absolute()
                .size_full()
            })
    }
}

struct Tooltip(String);
impl Render for Tooltip {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .px_2()
            .py_1()
            .bg(rgb(0x29333c))
            .rounded(px(4.))
            .text_size(px(12.))
            .text_color(rgb(0xd6dce2))
            .child(self.0.clone())
    }
}
fn icon(name: &str, size: f32) -> Svg {
    svg()
        .path(format!("{name}.svg"))
        .text_color(rgb(if name == "leaf" { 0x99c68c } else { 0xa4b0bb }))
        .size(px(size))
        .flex_shrink_0()
}
fn kbd(text: impl Into<SharedString>) -> Div {
    div()
        .px(px(5.))
        .py(px(1.))
        .rounded(px(4.))
        .bg(rgba(0xffffff06))
        .border_1()
        .border_color(rgba(0xffffff05))
        .text_size(px(10.))
        .text_color(rgb(0x929eaa))
        .child(text.into())
}
fn file_icon(path: &str) -> AnyElement {
    let ext = Path::new(path)
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();
    let name = match ext.as_str() {
        "rs" => "rust",
        "ts" | "mts" | "cts" => "typescript",
        "js" | "mjs" | "cjs" => "javascript",
        "tsx" | "jsx" => "react",
        "py" | "pyw" | "pyi" => "python",
        "go" => "go",
        "c" | "h" => "c",
        "cpp" | "hpp" | "cc" | "cxx" | "hxx" => "cplusplus",
        "cs" => "csharp",
        "html" | "htm" => "html5",
        "css" | "scss" | "sass" | "less" => "css3",
        "lua" => "lua",
        _ => "",
    };
    if name.is_empty() {
        icon("file-text", 16.)
            .text_color(rgb(0x80b9d9))
            .into_any_element()
    } else {
        img(ImageSource::Resource(Resource::Embedded(
            format!("{name}.svg").into(),
        )))
        .size(px(16.))
        .flex_shrink_0()
        .into_any_element()
    }
}

impl Nido {
    fn side_panel(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let panel = self.model.panel.clone();
        let content = match panel.as_str() {
            "settings" => self.settings_panel(cx),
            "git" => self.git_panel(cx),
            "gitHistory" => self.git_history_panel(cx),
            "search" => self.search_panel(cx),
            "history" => self.history_panel(cx),
            "debug" => self.debug_panel(cx),
            "extensions" => self.extensions_panel(cx),
            "markdown" => markdown(&self.model.markdown),
            "references" | "problems" => self.locations_panel(cx),
            _ => div().into_any_element(),
        };
        let title = match panel.as_str() {
            "settings" => "Settings",
            "git" => "Source control",
            "gitHistory" => "Git history",
            "search" => "Search in files",
            "history" => "Time Machine",
            "debug" => "Debug",
            "extensions" => "Extensions",
            "markdown" => "Markdown preview",
            "references" => "References",
            _ => "Problems",
        };
        div()
            .flex()
            .flex_col()
            .w(px(510.))
            .max_w(relative(0.55))
            .h_full()
            .flex_shrink_0()
            .bg(rgb(0x171c20))
            .border_l_1()
            .border_color(rgb(0x303840))
            .child(
                div()
                    .flex()
                    .items_center()
                    .h(px(37.))
                    .flex_shrink_0()
                    .px_3()
                    .border_b_1()
                    .border_color(rgb(0x282c30))
                    .child(
                        div()
                            .flex_1()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(self.model.tr(title)),
                    )
                    .child(
                        self.button(
                            "panel-close",
                            "",
                            |this, window, cx| {
                                this.model.panel.clear();
                                this.model.focus_editor = true;
                                this.tick(window, cx);
                            },
                            cx,
                        )
                        .child(icon("x", 15.)),
                    ),
            )
            .child(
                div()
                    .id("panel-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .p_3()
                    .child(content),
            )
            .into_any_element()
    }

    fn settings_panel(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let mut list = column();
        for (key, title, options) in [
            (
                "language",
                "Language",
                vec![("en", "English"), ("ja", "日本語")],
            ),
            (
                "theme",
                "Theme",
                vec![("dark", "Dark"), ("acrylic", "Acrylic")],
            ),
            (
                "activityBarPosition",
                "Navigation",
                vec![("left", "Left edge"), ("top", "Above Explorer")],
            ),
        ] {
            let mut choices = row().child(self.model.tr(title));
            for (value, label) in options {
                let selected = self.model.settings[key] == value;
                choices = choices.child(
                    self.button(
                        format!("setting-{key}-{value}"),
                        self.model.tr(label),
                        move |this, _, _| {
                            this.model.settings[key] = json!(value);
                        },
                        cx,
                    )
                    .when(selected, |el| {
                        el.bg(rgb(0x314237)).text_color(rgb(0xafd39f))
                    }),
                );
            }
            list = list.child(choices);
        }
        let family = s(&self.model.settings["fontFamily"]).to_owned();
        let field = self.field("font", family, "Font family", cx);
        list = list.child(self.model.tr("Font family")).child(field);
        for (key, title, min, max, step) in [
            ("fontSize", "Font size", 8., 40., 1.),
            ("fontWeight", "Font weight", 100., 900., 50.),
            ("lineHeight", "Line height", 1., 2.5, 0.1),
            (
                "stickyScrollMaxLines",
                "Sticky Scroll max lines",
                1.,
                10.,
                1.,
            ),
        ] {
            let value = self.model.settings[key].as_f64().unwrap_or(min);
            list = list.child(
                row()
                    .child(
                        div()
                            .flex_1()
                            .child(format!("{}  {value:.1}", self.model.tr(title))),
                    )
                    .child(self.button(
                        format!("setting-minus-{key}"),
                        "−",
                        move |this, _, _| {
                            this.model.settings[key] = json!((value - step).clamp(min, max));
                        },
                        cx,
                    ))
                    .child(self.button(
                        format!("setting-plus-{key}"),
                        "+",
                        move |this, _, _| {
                            this.model.settings[key] = json!((value + step).clamp(min, max));
                        },
                        cx,
                    )),
            );
        }
        for (key, title) in [
            ("relativeLineNumbers", "Relative line numbers"),
            ("wordWrap", "Word wrap"),
            ("stickyScroll", "Sticky Scroll"),
            ("methodSeparators", "Method separators"),
            ("editorConfig", "EditorConfig"),
            ("formatOnSave", "Format on save"),
            ("clipboardSharing", "Share OS clipboard"),
            ("historyEnabled", "Time Machine"),
            ("sidebar", "Show sidebar"),
            ("compactMode", "Compact mode"),
            ("animations", "Animations"),
            ("smoothCursor", "Smooth cursor"),
            ("smoothBlink", "Smooth cursor blink"),
            ("scrollFollowCursor", "Scroll follows cursor"),
        ] {
            let checked = self.model.settings[key] == true;
            list = list.child(
                self.button(
                    format!("setting-{key}"),
                    "",
                    move |this, _, _| {
                        this.model.settings[key] = json!(!checked);
                    },
                    cx,
                )
                .w_full()
                .child(
                    icon(if checked { "check" } else { "square" }, 15.)
                        .text_color(rgb(if checked { 0x99c68c } else { 0x77818a })),
                )
                .child(self.model.tr(title)),
            );
        }
        list = list.child(self.model.tr("Terminal shell"));
        for shell in &self.model.shells {
            let value = shell.clone();
            list = list.child(
                self.button(
                    format!("shell-{shell}"),
                    shell.clone(),
                    move |this, _, _| this.model.settings["terminalShell"] = json!(value),
                    cx,
                )
                .when(
                    self.model.settings["terminalShell"] == shell.as_str(),
                    |el| el.bg(rgb(0x314237)),
                ),
            );
        }
        let status = s(&self.model.update["status"]).to_owned();
        let action = match status.as_str() {
            "available" => "download",
            "downloaded" => "install",
            _ => "check",
        };
        list = list
            .child(format!(
                "Nido {} · Rust / GPUI 0.2.2",
                env!("CARGO_PKG_VERSION")
            ))
            .child(format!("Update: {status}"));
        if !["checking", "downloading", "installing"].contains(&status.as_str()) {
            list = list.child(self.button(
                "update",
                self.model.tr(match action {
                    "download" => "Download update",
                    "install" => "Install update",
                    _ => "Check for updates",
                }),
                move |this, window, cx| {
                    if action == "install" {
                        this.model.install_after_close = true;
                        this.model.request_close(true);
                        this.tick(window, cx);
                    } else {
                        this.model.run_update(action);
                    }
                },
                cx,
            ));
        }
        if status == "downloading" {
            list = list.child(format!("{}%", self.model.update["percent"]));
        }
        list.into_any_element()
    }

    fn git_panel(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let commit = self.field("commit", self.model.commit.clone(), "Commit message", cx);
        let mut list = column()
            .child(
                row()
                    .child(self.button(
                        "git-refresh",
                        self.model.tr("Refresh"),
                        |this, _, _| this.model.send("git", json!(["status", []])),
                        cx,
                    ))
                    .child(self.button(
                        "git-stage-all",
                        self.model.tr("Stage all"),
                        |this, _, _| this.model.git_mutation("stageAll", json!([])),
                        cx,
                    ))
                    .child(self.button(
                        "git-branches",
                        self.model.tr("Branches"),
                        |this, _, _| {
                            if let Some(i) = this.model.active_index() {
                                this.model.workspaces[i].session.send_tag(
                                    "git",
                                    json!(["branches", []]),
                                    "gitBranches",
                                );
                            }
                        },
                        cx,
                    ))
                    .child(self.command("git-history", "History", "gitHistory", cx)),
            )
            .child(format!("Branch: {}", s(&self.model.git["branch"])));
        for branch in array(&self.model.branches) {
            let name = s(&branch["name"]).to_owned();
            let value = name.clone();
            list = list.child(
                self.button(
                    format!("branch-{name}"),
                    name,
                    move |this, _, _| {
                        this.model.git_mutation("switch", json!([value, false]));
                        this.model.branches = Value::Null;
                    },
                    cx,
                )
                .when(branch["current"] == true, |el| el.text_color(rgb(0x99c68c))),
            );
        }
        if self.model.branches.is_array() {
            list = list.child(self.button(
                "git-new-branch",
                self.model.tr("New branch"),
                |this, window, cx| {
                    this.model.file_request = Some(FileRequest {
                        workspace: this.model.active.clone(),
                        action: "gitBranch".into(),
                        source: String::new(),
                        target: String::new(),
                        focus: true,
                    });
                    this.tick(window, cx);
                },
                cx,
            ));
        }
        list = list.child(commit).child(self.button(
            "git-commit",
            self.model.tr("Commit"),
            |this, _, _| {
                this.model
                    .git_mutation("commit", json!([this.model.commit]))
            },
            cx,
        ));
        for (i, change) in array(&self.model.git["changes"]).iter().enumerate() {
            let c = change.clone();
            let diff = c.clone();
            let open = c.clone();
            let staged = c["staged"] == true;
            list = list.child(
                row()
                    .child(self.button(
                        format!("stage-{i}"),
                        if staged { "−" } else { "+" },
                        move |this, _, _| {
                            this.model
                                .git_mutation("stage", json!([c["path"], !staged]))
                        },
                        cx,
                    ))
                    .child(
                        self.button(
                            format!("diff-{i}"),
                            format!("{} {}", s(&change["status"]), s(&change["path"])),
                            move |this, _, _| {
                                if let Some(i) = this.model.active_index() {
                                    this.model.workspaces[i].session.send_tag(
                                        "git",
                                        json!(["diff", [diff["path"], staged]]),
                                        "gitDiff",
                                    );
                                }
                            },
                            cx,
                        )
                        .flex_1()
                        .min_w_0()
                        .overflow_hidden(),
                    )
                    .child(
                        self.button(
                            format!("git-open-{i}"),
                            "",
                            move |this, window, cx| {
                                this.model.send("openGit", json!([open["path"]]));
                                this.model.focus_editor = true;
                                this.tick(window, cx);
                            },
                            cx,
                        )
                        .child(icon("file-text", 14.)),
                    ),
            );
        }
        list.child(diff(&self.model.diff)).into_any_element()
    }

    fn git_history_panel(&self, cx: &Context<Self>) -> AnyElement {
        let mut list = column().child(self.button(
            "history-refresh",
            self.model.tr("Refresh"),
            |this, _, _| this.model.send("git", json!(["history", [0]])),
            cx,
        ));
        for commit in array(&self.model.git_history["commits"]) {
            let hash = s(&commit["hash"]);
            let value = hash.to_owned();
            list = list.child(
                self.button(
                    format!("commit-{hash}"),
                    format!(
                        "{}  {}",
                        hash.chars().take(8).collect::<String>(),
                        s(&commit["message"])
                    ),
                    move |this, _, _| {
                        this.model.selected_commit = value.clone();
                        this.model.send("git", json!(["commitFiles", [value]]));
                    },
                    cx,
                )
                .when(self.model.selected_commit == hash, |el| {
                    el.bg(rgb(0x29343c))
                }),
            );
        }
        list = list.child(self.button(
            "history-next",
            "Next 50 commits",
            |this, _, _| {
                let skip = this.model.git_history["skip"].as_u64().unwrap_or(0) + 50;
                if let Some(i) = this.model.active_index() {
                    this.model.workspaces[i].session.send_tag(
                        "git",
                        json!(["history", [skip]]),
                        "gitHistory",
                    );
                }
                this.model.git_history["skip"] = json!(skip);
            },
            cx,
        ));
        for (i, file) in array(&self.model.commit_files).iter().enumerate() {
            let f = file.clone();
            list = list.child(self.button(
                format!("commit-file-{i}"),
                s(file).to_owned(),
                move |this, _, _| {
                    this.model.send(
                        "git",
                        json!(["commitDiff", [this.model.selected_commit, f]]),
                    )
                },
                cx,
            ));
        }
        list.child(diff(&self.model.diff)).into_any_element()
    }

    fn search_panel(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let query = self.field(
            "search",
            self.model.search_query.clone(),
            "Search in files",
            cx,
        );
        let folder = self.field(
            "folder",
            s(&self.model.search_options["folder"]).to_owned(),
            "Search folder",
            cx,
        );
        let replacement = self.field(
            "replacement",
            self.model.replacement.clone(),
            "Replace with",
            cx,
        );
        let mut options = row();
        for (key, label) in [
            ("caseSensitive", "Aa"),
            ("wholeWord", "Word"),
            ("regex", ".*"),
        ] {
            let checked = self.model.search_options[key] == true;
            options = options.child(
                self.button(
                    format!("search-{key}"),
                    label,
                    move |this, _, _| {
                        this.model.search_options[key] = json!(!checked);
                        this.invalidate_search();
                    },
                    cx,
                )
                .when(checked, |el| el.bg(rgb(0x314237))),
            );
        }
        let mut list = column()
            .child(query)
            .child(options)
            .child(folder)
            .child(self.button(
                "search-run",
                self.model.tr("Search"),
                |this, _, _| {
                    this.model.send(
                        "search",
                        json!([this.model.search_query, this.model.search_options]),
                    )
                },
                cx,
            ))
            .child(replacement);
        if self.model.search_results["token"].is_string() && !self.model.search_selected.is_empty()
        {
            list = list.child(self.button(
                "replacement-preview",
                self.model.tr("Preview replacement"),
                |this, _, _| {
                    this.model.send(
                        "previewReplacement",
                        json!([
                            this.model.search_results["token"],
                            this.model.replacement,
                            this.model
                                .search_selected
                                .iter()
                                .copied()
                                .collect::<Vec<_>>()
                        ]),
                    )
                },
                cx,
            ));
        }
        if self.model.search_results["truncated"] == true {
            list = list.child("Showing first 200 matching lines. Narrow the search.");
        }
        for (i, item) in array(&self.model.search_results["matches"])
            .iter()
            .take(200)
            .enumerate()
        {
            let checked = self.model.search_selected.contains(&i);
            let item = item.clone();
            list = list.child(
                row()
                    .child(
                        self.button(
                            format!("search-select-{i}"),
                            "",
                            move |this, _, _| {
                                this.model.replacement_preview = Value::Null;
                                if checked {
                                    this.model.search_selected.remove(&i);
                                } else {
                                    this.model.search_selected.insert(i);
                                }
                            },
                            cx,
                        )
                        .child(icon(if checked { "check" } else { "square" }, 14.)),
                    )
                    .child(
                        self.button(
                            format!("search-result-{i}"),
                            format!(
                                "{}:{}  {}",
                                s(&item["path"]),
                                n(&item["line"]),
                                s(&item["text"])
                            ),
                            move |this, window, cx| {
                                this.model.send(
                                    "open",
                                    json!([item["path"], item["line"], item["column"]]),
                                );
                                this.model.focus_editor = true;
                                this.tick(window, cx);
                            },
                            cx,
                        )
                        .flex_1()
                        .min_w_0()
                        .overflow_hidden(),
                    ),
            );
        }
        if self.model.replacement_preview.is_object() {
            list = list
                .child(self.button(
                    "replacement-apply",
                    self.model.tr("Apply replacement"),
                    |this, _, _| {
                        this.model.send(
                            "applyReplacement",
                            json!([this.model.replacement_preview["token"]]),
                        )
                    },
                    cx,
                ))
                .child("Replacements become unsaved, undoable buffer edits.");
            for file in array(&self.model.replacement_preview["files"]) {
                let source = similar::TextDiff::from_lines(s(&file["before"]), s(&file["after"]))
                    .unified_diff()
                    .context_radius(3)
                    .to_string();
                list = list
                    .child(format!(
                        "{} · {} matches",
                        s(&file["path"]),
                        n(&file["count"])
                    ))
                    .child(diff(&source));
            }
        }
        list.into_any_element()
    }

    fn history_panel(&self, cx: &Context<Self>) -> AnyElement {
        let mut list = column()
            .child(self.button(
                "time-refresh",
                self.model.tr("Refresh"),
                |this, _, _| this.model.send("history", json!(["list", {}])),
                cx,
            ))
            .child(s(&self.model.history["path"]).to_owned());
        for version in array(&self.model.history["versions"]) {
            let ago = crate::history::now()
                .saturating_sub(version["timestamp"].as_u64().unwrap_or(0))
                / 1000;
            let id = version["id"].clone();
            list = list.child(
                self.button(
                    format!("time-{id}"),
                    format!(
                        "{} · {}s ago · {} lines",
                        s(&version["kind"]),
                        ago,
                        n(&version["lines"])
                    ),
                    move |this, _, _| {
                        this.model.send(
                            "history",
                            json!(["preview",{"path":this.model.history["path"],"id":id}]),
                        )
                    },
                    cx,
                )
                .when(
                    self.model.history_preview["version"]["id"] == version["id"],
                    |el| el.bg(rgb(0x29343c)),
                ),
            );
        }
        if self.model.history_preview.get("token").is_some() {
            list=list.child(self.button("time-restore",self.model.tr("Restore this version"),|this,_,_|this.model.send("history",json!(["restore",{"path":this.model.history_preview["path"],"id":this.model.history_preview["version"]["id"],"token":this.model.history_preview["token"]}])),cx))
                .child(self.model.tr("Restored content stays unsaved. Undo returns to the previous draft.")).child(diff(s(&self.model.history_preview["diff"])));
        }
        list.into_any_element()
    }

    fn debug_panel(&self, cx: &Context<Self>) -> AnyElement {
        let debug = self
            .model
            .active_index()
            .map(|i| self.model.workspaces[i].state["debug"].clone())
            .unwrap_or_default();
        let mut controls = row();
        for (label, action) in [
            ("F5", "start"),
            ("Stop", "stop"),
            ("Pause", "pause"),
            ("F10", "over"),
            ("F11", "into"),
            ("Out", "out"),
            ("F9", "breakpoint"),
        ] {
            controls = controls.child(self.button(
                format!("debug-{action}"),
                label,
                move |this, _, _| this.model.send("debug", json!([action, 0])),
                cx,
            ));
        }
        let mut list = column().child(controls).child(format!(
            "{}  {}",
            s(&debug["status"]),
            s(&debug["location"])
        ));
        for (i, target) in array(&debug["targets"]).iter().enumerate() {
            list = list.child(self.button(
                format!("debug-target-{i}"),
                s(&target["name"]).to_owned(),
                move |this, _, _| this.model.send("debug", json!(["launch", i + 1])),
                cx,
            ));
        }
        for (i, variable) in array(&debug["variables"]).iter().enumerate() {
            let v = variable.clone();
            let prefix = if v["expandable"] == true {
                if v["expanded"] == true { "▾" } else { "▸" }
            } else {
                " "
            };
            list = list.child(self.button(
                format!("variable-{i}"),
                format!(
                    "{}{} {} = {}",
                    "  ".repeat(n(&v["depth"]).min(30)),
                    prefix,
                    s(&v["name"]),
                    s(&v["value"])
                ),
                move |this, _, _| {
                    if v["expandable"] == true {
                        this.model.send("debug", json!(["variable", v["id"]]));
                    }
                },
                cx,
            ));
        }
        list.child(
            div()
                .font_family("Consolas")
                .whitespace_normal()
                .child(s(&debug["output"]).to_owned()),
        )
        .into_any_element()
    }

    fn locations_panel(&self, cx: &Context<Self>) -> AnyElement {
        let state = self
            .model
            .active_index()
            .map(|i| self.model.workspaces[i].state.clone())
            .unwrap_or_default();
        let references = self.model.panel == "references";
        let list = if references {
            state["references"].clone()
        } else {
            json!({"items":state["problems"]})
        };
        let mut content = column();
        if list["loading"] == true {
            content = content.child("Loading…");
        }
        if let Some(error) = list["error"].as_str() {
            content = content.child(error.to_owned());
        }
        for (i, item) in array(&list["items"]).iter().enumerate() {
            let item = item.clone();
            let version = list["version"].clone();
            content=content.child(self.button(format!("location-{i}"),format!("{}:{}:{}  {}",s(&item["path"]),n(&item["line"]),n(&item["column"]),if references{s(&item["text"])}else{s(&item["message"])}),move|this,window,cx|{
                if references {this.model.send("lua",json!(["require('nido_references').open(...)",[i+1,version]]));}
                else {this.model.send("lua",json!(["local p,l,c=...;require('nido_scroll').restore();require('nido_eol').open(p);l=math.min(l,vim.api.nvim_buf_line_count(0));local text=vim.api.nvim_buf_get_lines(0,l-1,l,false)[1]or'';vim.api.nvim_win_set_cursor(0,{l,math.min(c-1,#text)});vim.cmd('normal! zvzz')",[item["path"],item["line"],item["column"]]]));}
                this.model.focus_editor=true;this.tick(window,cx);
            },cx));
        }
        content.into_any_element()
    }

    fn extensions_panel(&self, cx: &Context<Self>) -> AnyElement {
        let mut list = column().child(
            row()
                .child(self.button(
                    "packs-reload",
                    self.model.tr("Reload"),
                    |this, _, _| this.reload_packs(),
                    cx,
                ))
                .child(self.button(
                    "packs-install",
                    self.model.tr("Install language pack"),
                    |this, _, _| {
                        let tx = this.model.tx.clone();
                        let data = this.model.data.clone();
                        let repaint = this.model.repaint.clone();
                        std::thread::spawn(move || {
                            if let Some(path) = rfd::FileDialog::new()
                                .add_filter("Language pack", &["json"])
                                .pick_file()
                            {
                                let event = match crate::packs::install(&data, &path) {
                                    Ok(_) => Event::Result(
                                        String::new(),
                                        "installedPack".into(),
                                        Value::Null,
                                    ),
                                    Err(e) => Event::Error(format!("Language pack: {e:#}")),
                                };
                                let _ = tx.send(event);
                                repaint();
                            }
                        });
                    },
                    cx,
                )),
        );
        for error in array(&self.model.extensions["errors"]) {
            list = list.child(s(error).to_owned());
        }
        for pack in array(&self.model.extensions["packs"]) {
            let id = s(&pack["id"]).to_owned();
            let value = id.clone();
            let checked = !array(&self.model.extensions["disabled"])
                .iter()
                .any(|v| v == &id);
            let mut card = column()
                .p_2()
                .border_1()
                .border_color(rgb(0x303840))
                .rounded(px(5.))
                .child(
                    self.button(
                        format!("pack-{id}"),
                        "",
                        move |this, _, _| match crate::packs::set_enabled(
                            &this.model.data,
                            &value,
                            !checked,
                        ) {
                            Ok(()) => this.reload_packs(),
                            Err(error) => this.model.error(error.to_string()),
                        },
                        cx,
                    )
                    .child(icon(if checked { "check" } else { "square" }, 15.))
                    .child(s(&pack["title"]).to_owned()),
                )
                .child(s(&pack["description"]).to_owned());
            if let Some(runtime) = array(&self.model.extensions["runtime"])
                .iter()
                .find(|p| p["id"] == id)
            {
                card = card.child(format!(
                    "{} {}",
                    s(&runtime["status"]),
                    s(&runtime["message"])
                ));
            }
            if let Some(setup) = pack["setup"].as_str() {
                card = card.child(setup.to_owned());
            }
            for language in array(&pack["languages"]) {
                card = card
                    .child(s(&language["title"]).to_owned())
                    .child(s(&language["description"]).to_owned())
                    .child(s(&language["requirement"]).to_owned());
            }
            list = list.child(card);
        }
        list.into_any_element()
    }
    fn reload_packs(&self) {
        for w in &self.model.workspaces {
            w.session.send("reloadPacks", json!([]));
        }
        self.model.send("packs", json!([]));
    }

    fn overlay(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let mut content = column()
            .w_full()
            .p_4()
            .rounded(px(9.))
            .bg(rgb(0x20272e))
            .border_1()
            .border_color(rgb(0x3b454d))
            .shadow_lg();
        if let Some(close) = &self.model.closing {
            content = content.child(self.model.tr(if close.stage == "prompt" {
                "Unsaved changes"
            } else {
                "Closing workspace…"
            }));
            if close.stage == "prompt" {
                content = content.child(self.model.tr("Save your changes before closing?"));
                let mut choices = row();
                for (choice, title) in [
                    ("save", "Save all"),
                    ("discard", "Discard"),
                    ("cancel", "Cancel"),
                ] {
                    choices = choices.child(self.button(
                        format!("modal-close-{choice}"),
                        self.model.tr(title),
                        move |this, window, cx| {
                            this.model.close_choice(choice);
                            this.tick(window, cx);
                        },
                        cx,
                    ));
                }
                content = content.child(choices);
            }
        } else if let Some(p) = &self.model.palette {
            let generation = p.generation;
            let kind = p.kind.clone();
            let query = p.query.clone();
            let index = p.index;
            let items = self.model.palette_items();
            let entity = cx.entity();
            let input = self.field("palette", query, &format!("{kind}…"), cx);
            content = content.child(input).child(
                uniform_list("palette-items", items.len(), move |range, _, cx| {
                    let view = entity.read(cx);
                    range
                        .map(|i| {
                            let item = items[i].clone();
                            let e = entity.clone();
                            let label = format!("{} {}", s(&item["title"]), s(&item["detail"]));
                            let selected_item = item.clone();
                            let activate: UiAction = Rc::new(move |this, window, cx| {
                                if this
                                    .model
                                    .palette
                                    .as_ref()
                                    .is_some_and(|p| p.generation == generation)
                                {
                                    this.model.activate_palette(selected_item.clone());
                                    this.tick(window, cx);
                                }
                            });
                            let marker = view.accessible_item(
                                format!("modal-palette-{generation}-{i}"),
                                label,
                                activate.clone(),
                                entity.clone(),
                            );
                            div()
                                .id(("palette-item", i))
                                .relative()
                                .w_full()
                                .min_w_0()
                                .flex()
                                .h(px(36.))
                                .items_center()
                                .gap_3()
                                .px_2()
                                .rounded(px(4.))
                                .cursor_pointer()
                                .when(i == index, |el| el.bg(rgb(0x34473b)))
                                .hover(|el| el.bg(rgb(0x303c35)))
                                .child(kbd(s(&item["key"]).to_owned()))
                                .child(
                                    div()
                                        .flex_1()
                                        .truncate()
                                        .child(s(&item["title"]).to_owned()),
                                )
                                .child(
                                    div()
                                        .text_size(px(11.))
                                        .text_color(rgb(0x929eaa))
                                        .truncate()
                                        .max_w(px(230.))
                                        .child(s(&item["detail"]).to_owned()),
                                )
                                .on_click(move |_, window, cx| {
                                    e.update(cx, |this, cx| activate(this, window, cx))
                                })
                                .child(marker)
                                .text_color(if view.model.palette.is_some() {
                                    rgb(0xd6dce2)
                                } else {
                                    rgb(0x929eaa)
                                })
                        })
                        .collect::<Vec<_>>()
                })
                .track_scroll(self.palette_scroll.clone())
                .h(px(360.)),
            );
        } else if let Some(r) = &self.model.file_request {
            let action = r.action.clone();
            let target = r.target.clone();
            let source = r.source.clone();
            content = content.child(format!("{action}: {source}"));
            if action == "delete" {
                content = content.child("Move this file or folder to the trash?");
            } else {
                content = content.child(self.field("file", target, "Path", cx));
            }
            content = content.child(
                row()
                    .child(self.button(
                        "modal-file-ok",
                        "OK",
                        |this, window, cx| {
                            this.model.submit_file();
                            this.tick(window, cx);
                        },
                        cx,
                    ))
                    .child(self.button(
                        "modal-file-cancel",
                        self.model.tr("Cancel"),
                        |this, window, cx| {
                            this.model.file_request = None;
                            this.model.focus_editor = true;
                            this.tick(window, cx);
                        },
                        cx,
                    )),
            );
        } else if self.model.show_wsl {
            content = content.child(self.model.tr("Connect to WSL"));
            for distro in array(&self.model.wsl_list) {
                let distro = s(distro).to_owned();
                let value = distro.clone();
                content = content.child(
                    self.button(
                        format!("modal-wsl-{distro}"),
                        distro.clone(),
                        move |this, _, _| this.model.wsl_choice = value.clone(),
                        cx,
                    )
                    .when(self.model.wsl_choice == distro, |el| el.bg(rgb(0x314237))),
                );
            }
            content = content
                .child(self.field(
                    "wslPath",
                    self.model.wsl_path.clone(),
                    "/home/you/project",
                    cx,
                ))
                .child(self.button(
                    "modal-wsl-connect",
                    "Connect",
                    |this, window, cx| {
                        if !this.model.wsl_path.starts_with('/')
                            || !array(&this.model.wsl_list)
                                .iter()
                                .any(|v| v == &this.model.wsl_choice)
                        {
                            this.model
                                .error("Choose a distribution and an absolute Linux path");
                        } else {
                            let remote = crate::wsl::Remote {
                                distribution: this.model.wsl_choice.clone(),
                                path: this.model.wsl_path.clone(),
                            };
                            let root = remote.host(&remote.path);
                            if root.is_dir() {
                                this.model.show_wsl = false;
                                this.model.add_workspace(root, false, None, None);
                            } else {
                                this.model.error("The Linux folder is unavailable");
                            }
                        }
                        this.tick(window, cx);
                    },
                    cx,
                ));
        } else if let Some((workspace, entry)) = &self.context_entry {
            let mut actions = column();
            for (title, action) in [
                ("Open", "open"),
                ("New file", "createFile"),
                ("New folder", "createDirectory"),
                ("Rename", "rename"),
                ("Copy", "copy"),
                ("Delete", "delete"),
            ] {
                let entry = entry.clone();
                let workspace = workspace.clone();
                actions = actions.child(self.button(
                    format!("modal-tree-{action}"),
                    self.model.tr(title),
                    move |this, window, cx| {
                        this.context_entry = None;
                        if this.model.active == workspace
                            && let Some(i) = this.model.active_index()
                        {
                            this.model.tree_action(i, action, &entry);
                        }
                        this.tick(window, cx);
                    },
                    cx,
                ));
            }
            content = content.child(actions).child(self.button(
                "modal-tree-cancel",
                self.model.tr("Cancel"),
                |this, _, _| this.context_entry = None,
                cx,
            ));
        } else if !self.model.hover.is_empty() || !self.model.diagnostics.is_null() {
            content = content.child(self.button(
                "modal-info-close",
                "Close",
                |this, window, cx| {
                    this.model.hover.clear();
                    this.model.diagnostics = Value::Null;
                    this.model.focus_editor = true;
                    this.tick(window, cx);
                },
                cx,
            ));
            if !self.model.hover.is_empty() {
                content = content.child(markdown(&self.model.hover));
            }
            for item in array(&self.model.diagnostics) {
                content = content
                    .child(format!("{} {}", s(&item["source"]), s(&item["code"])))
                    .child(s(&item["message"]).to_owned());
            }
        } else {
            return None;
        }
        Some(
            div()
                .id("modal-backdrop")
                .absolute()
                .inset_0()
                .size_full()
                .bg(rgba(0x00000066))
                .flex()
                .justify_center()
                .items_start()
                .pt(px(72.))
                .child(
                    div()
                        .id("modal-content")
                        .w(px(640.))
                        .max_w(relative(0.92))
                        .max_h(relative(0.85))
                        .overflow_y_scroll()
                        .child(content),
                )
                .into_any_element(),
        )
    }

    fn notifications(&self, cx: &Context<Self>) -> Option<AnyElement> {
        if self.model.notifications.is_empty() {
            return None;
        }
        let mut list = column()
            .absolute()
            .right(px(16.))
            .bottom(px(40.))
            .w(px(440.))
            .max_w(relative(0.8));
        for (i, (text, _)) in self.model.notifications.iter().enumerate() {
            list = list.child(
                row()
                    .p_3()
                    .bg(rgb(0x273039))
                    .border_1()
                    .border_color(rgb(0x414d58))
                    .rounded(px(5.))
                    .child(div().flex_1().whitespace_normal().child(text.clone()))
                    .child(
                        self.button(
                            format!("notification-{i}"),
                            "",
                            move |this, _, _| {
                                this.model.notifications.remove(i);
                            },
                            cx,
                        )
                        .child(icon("x", 13.)),
                    ),
            );
        }
        Some(list.into_any_element())
    }
}

fn column() -> Div {
    div().flex().flex_col().gap_2().w_full().min_w_0()
}
fn row() -> Div {
    div().flex().items_center().gap_1().min_w_0()
}
fn diff(source: &str) -> AnyElement {
    let mut list = column().gap_0().font_family("Consolas").text_size(px(12.));
    for line in source.lines() {
        let color = if line.starts_with('+') {
            0x99c68c
        } else if line.starts_with('-') {
            0xe59b96
        } else if line.starts_with('@') {
            0x80b9d9
        } else {
            0xa8b2bc
        };
        list = list.child(div().whitespace_normal().text_color(rgb(color)).child(
            if line.is_empty() {
                " ".into()
            } else {
                line.to_owned()
            },
        ));
    }
    list.into_any_element()
}
fn markdown(source: &str) -> AnyElement {
    use pulldown_cmark::{Event as Md, Tag, TagEnd};
    let mut list = column();
    let mut text = String::new();
    let mut heading = false;
    let mut code = false;
    for event in pulldown_cmark::Parser::new_ext(
        source,
        pulldown_cmark::Options::ENABLE_TABLES | pulldown_cmark::Options::ENABLE_STRIKETHROUGH,
    ) {
        match event {
            Md::Start(Tag::Heading { .. }) => heading = true,
            Md::Start(Tag::CodeBlock(_)) => code = true,
            Md::Text(t) | Md::Code(t) => text.push_str(&t),
            Md::SoftBreak | Md::HardBreak => text.push('\n'),
            Md::End(
                TagEnd::Paragraph
                | TagEnd::Heading(_)
                | TagEnd::CodeBlock
                | TagEnd::Item
                | TagEnd::TableRow,
            ) => {
                if !text.is_empty() {
                    list = list.child(
                        div()
                            .whitespace_normal()
                            .when(heading, |el| {
                                el.font_weight(FontWeight::SEMIBOLD).text_size(px(20.))
                            })
                            .when(code, |el| {
                                el.font_family("Consolas").p_2().bg(rgb(0x12181e))
                            })
                            .child(std::mem::take(&mut text)),
                    );
                }
                heading = false;
                code = false;
            }
            _ => {}
        }
    }
    if !text.is_empty() {
        list = list.child(text);
    }
    list.into_any_element()
}

pub fn verify_gui() -> anyhow::Result<()> {
    use anyhow::ensure;
    use std::cell::{Cell, RefCell};
    let root = std::env::temp_dir().join(format!("nido-gpui-check-{}", uuid::Uuid::new_v4()));
    let project = root.join("project");
    fs::create_dir_all(&project)?;
    fs::write(project.join("hello.txt"), "Native GPUI\n")?;
    let phase = Rc::new(Cell::new(0usize));
    let progress = phase.clone();
    let failure = Rc::new(RefCell::new(None::<String>));
    let error = failure.clone();
    let open_failure = failure.clone();
    let data = root.join("data");
    Application::new()
        .with_assets(crate::assets::Assets)
        .run(move |cx| {
            text_input::init(cx);
            let options = WindowOptions {
                show: !cfg!(windows),
                focus: !cfg!(windows),
                window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                    None,
                    size(px(1200.), px(800.)),
                    cx,
                ))),
                titlebar: Some(TitlebarOptions {
                    title: Some("Nido GPUI check".into()),
                    appears_transparent: true,
                    ..Default::default()
                }),
                ..Default::default()
            };
            let opened = cx.open_window(options, move |window, cx| {
                cx.new(|cx| {
                    let mut view = Nido::new(data, window, cx);
                    view.model.add_workspace(project, false, None, None);
                    cx.spawn_in(window, async move |entity, cx| {
                        let started = Instant::now();
                        loop {
                            Timer::after(Duration::from_millis(150)).await;
                            let checked =
                                entity.update_in(cx, |this, window, cx| -> anyhow::Result<()> {
                                    ensure!(
                                        started.elapsed() < Duration::from_secs(45),
                                        "GPUI check timed out at phase {}",
                                        progress.get()
                                    );
                                    let step = progress.get();
                                    let i = this.model.active_index().unwrap();
                                    match step {
                                        0 if this.model.workspaces[i].ready => {
                                            this.model.send("open", json!(["hello.txt", 1, 1]));
                                            progress.set(1);
                                        }
                                        1 if this.model.workspaces[i]
                                            .grid
                                            .description()
                                            .contains("Native GPUI") =>
                                        {
                                            ensure!(
                                                this.painted > 0,
                                                "GPUI did not paint the editor"
                                            );
                                            this.model.text("i");
                                            progress.set(2);
                                        }
                                        2 if this.model.workspaces[i].state["mode"] == "i" => {
                                            this.replace_and_mark_text_in_range(
                                                None,
                                                "日本語",
                                                None,
                                                window,
                                                cx,
                                            );
                                            progress.set(3);
                                        }
                                        3 => {
                                            ensure!(
                                                this.model.preedit == "日本語",
                                                "Editor lost IME preedit"
                                            );
                                            ensure!(
                                                this.bounds_for_range(
                                                    0..3,
                                                    Bounds::default(),
                                                    window,
                                                    cx
                                                )
                                                .is_some(),
                                                "IME candidate position is missing"
                                            );
                                            this.replace_text_in_range(
                                                None,
                                                "GPUI日本語",
                                                window,
                                                cx,
                                            );
                                            this.key_down(
                                                &KeyDownEvent {
                                                    keystroke: Keystroke::parse("escape").unwrap(),
                                                    is_held: false,
                                                },
                                                window,
                                                cx,
                                            );
                                            progress.set(4);
                                        }
                                        4 if this.model.workspaces[i]
                                            .grid
                                            .description()
                                            .contains("GPUI日本語") =>
                                        {
                                            this.key_down(
                                                &KeyDownEvent {
                                                    keystroke: Keystroke::parse("ctrl-s").unwrap(),
                                                    is_held: false,
                                                },
                                                window,
                                                cx,
                                            );
                                            progress.set(5);
                                        }
                                        5 if this.model.workspaces[i]
                                            .buffers()
                                            .iter()
                                            .all(|b| b["modified"] == false) =>
                                        {
                                            ensure!(
                                                fs::read_to_string(
                                                    this.model.workspaces[i]
                                                        .session
                                                        .root
                                                        .join("hello.txt")
                                                )?
                                                .contains("GPUI日本語"),
                                                "GPUI input was not saved"
                                            );
                                            this.model.open_palette("files");
                                            this.sync_focus(window, cx);
                                            progress.set(6);
                                        }
                                        6 if this
                                            .model
                                            .palette
                                            .as_ref()
                                            .is_some_and(|p| !array(&p.items).is_empty()) =>
                                        {
                                            #[cfg(windows)]
                                            ensure!(this.accessibility.has_label("hello.txt "), "Palette result is missing from Windows UI Automation");
                                            let field = this.inputs.get("palette").unwrap().clone();
                                            ensure!(
                                                field.focus_handle(cx).is_focused(window),
                                                "Palette did not receive focus"
                                            );
                                            field.update(cx, |input, cx| {
                                                input.replace_and_mark_text_in_range(
                                                    None,
                                                    "日本語",
                                                    None,
                                                    window,
                                                    cx,
                                                );
                                                input.set("", cx);
                                                assert_eq!(
                                                    input.content.as_ref(),
                                                    "日本語",
                                                    "Parent repaint reset IME composition"
                                                );
                                                input.replace_text_in_range(
                                                    None, "hello", window, cx,
                                                );
                                            });
                                            progress.set(7);
                                        }
                                        7 => {
                                            ensure!(
                                                this.model
                                                    .palette
                                                    .as_ref()
                                                    .is_some_and(|p| p.query == "hello"),
                                                "Palette lost committed text"
                                            );
                                            this.key_down(
                                                &KeyDownEvent {
                                                    keystroke: Keystroke::parse("escape").unwrap(),
                                                    is_held: false,
                                                },
                                                window,
                                                cx,
                                            );
                                            progress.set(8);
                                        }
                                        8..=17 => {
                                            const PANELS: [&str; 10] = [
                                                "search",
                                                "git",
                                                "gitHistory",
                                                "history",
                                                "debug",
                                                "references",
                                                "problems",
                                                "extensions",
                                                "markdown",
                                                "settings",
                                            ];
                                            this.model.show_panel(PANELS[step - 8]);
                                            if step == 17 {
                                                this.model.settings["fontFamily"] = json!(r"C:\Windows\Fonts\consola.ttf");
                                            }
                                            progress.set(step + 1);
                                        }
                                        18 => {
                                            #[cfg(windows)]
                                            ensure!(this.font_family == "Consolas", "Font file setting did not load: {}", this.font_family);
                                            this.model.panel.clear();
                                            this.key_down(&KeyDownEvent { keystroke: Keystroke::parse("alt-f4").unwrap(), is_held: false }, window, cx);
                                            progress.set(19);
                                        }
                                        _ => {}
                                    }
                                    this.tick(window, cx);
                                    Ok(())
                                });
                            match checked {
                                Ok(Ok(())) => {}
                                Ok(Err(e)) => {
                                    *error.borrow_mut() = Some(format!("{e:#}"));
                                    let _ = cx.update(|_, cx| cx.quit());
                                    break;
                                }
                                Err(_) => break,
                            }
                        }
                    })
                    .detach();
                    view
                })
            });
            if let Err(e) = opened {
                *open_failure.borrow_mut() = Some(format!("Open GPUI check: {e:#}"));
                cx.quit();
            }
            cx.on_window_closed(|cx| {
                if cx.windows().is_empty() {
                    cx.quit();
                }
            })
            .detach();
        });
    // The normal close path removes the window only after snapshots and all sessions stop.
    ensure!(
        phase.get() == 19,
        "GPUI check ended early at phase {}; data: {}",
        phase.get(),
        root.display()
    );
    if let Some(error) = failure.borrow_mut().take() {
        anyhow::bail!("{error}; data: {}", root.display());
    }
    fs::remove_dir_all(&root)?;
    println!(
        "PASS: GPUI window, grid painting, IME preedit/commit, candidate position, save, palette focus, all panels and clean close"
    );
    Ok(())
}
