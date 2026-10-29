use super::*;

impl Nido {
    pub(in crate::app::ui) fn sync_focus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
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

    pub(in crate::app::ui) fn key_down(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
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
}
