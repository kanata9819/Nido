use super::*;

impl Nido {
    pub(in crate::app::ui) fn settings_panel(&mut self, cx: &mut Context<Self>) -> AnyElement {
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
}
