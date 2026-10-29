use super::*;

impl Nido {
    pub(in crate::app::ui) fn titlebar(&self, cx: &Context<Self>) -> AnyElement {
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

    pub(in crate::app::ui) fn navigation(
        &self,
        horizontal: bool,
        cx: &Context<Self>,
    ) -> AnyElement {
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

    pub(in crate::app::ui) fn status(&self, cx: &Context<Self>) -> AnyElement {
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
