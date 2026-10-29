use super::*;

impl Nido {
    pub(in crate::app::ui) fn side_panel(&mut self, cx: &mut Context<Self>) -> AnyElement {
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
}

mod debug;
mod extensions;
mod git;
mod locations;
mod search;
mod settings;
mod time_machine;
