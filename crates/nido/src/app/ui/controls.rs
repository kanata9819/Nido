use super::*;

impl Nido {
    pub(in crate::app::ui) fn button(
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

    pub(in crate::app::ui) fn command(
        &self,
        id: &str,
        label: &str,
        action: &str,
        cx: &Context<Self>,
    ) -> Stateful<Div> {
        let action = action.to_owned();
        self.button(
            id.to_owned(),
            self.model.tr(label),
            move |this, window, cx| this.act(&action, window, cx),
            cx,
        )
    }

    pub(in crate::app::ui) fn icon_button(
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
pub(super) fn icon(name: &str, size: f32) -> Svg {
    svg()
        .path(format!("{name}.svg"))
        .text_color(rgb(if name == "leaf" { 0x99c68c } else { 0xa4b0bb }))
        .size(px(size))
        .flex_shrink_0()
}
pub(super) fn kbd(text: impl Into<SharedString>) -> Div {
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
pub(super) fn file_icon(path: &str) -> AnyElement {
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

pub(super) fn column() -> Div {
    div().flex().flex_col().gap_2().w_full().min_w_0()
}
pub(super) fn row() -> Div {
    div().flex().items_center().gap_1().min_w_0()
}
