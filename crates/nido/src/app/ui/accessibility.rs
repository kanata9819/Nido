use super::*;

impl Nido {
    pub(in crate::app::ui) fn accessible_bounds(
        &self,
        key: String,
        entity: Entity<Self>,
    ) -> AnyElement {
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

    pub(in crate::app::ui) fn accessible_item(
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
    pub(in crate::app::ui) fn publish_accessibility(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
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

    pub(in crate::app::ui) fn modal_open(&self) -> bool {
        self.model.closing.is_some()
            || self.model.palette.is_some()
            || self.model.file_request.is_some()
            || self.model.show_wsl
            || self.context_entry.is_some()
            || !self.model.hover.is_empty()
            || !self.model.diagnostics.is_null()
    }
}
