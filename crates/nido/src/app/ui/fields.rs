use super::*;

impl Nido {
    pub(in crate::app::ui) fn field(
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

    pub(in crate::app::ui) fn edit(&mut self, key: &str, text: &str) {
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

    pub(in crate::app::ui) fn invalidate_search(&mut self) {
        self.model.search_results = Value::Null;
        self.model.replacement_preview = Value::Null;
        self.model.search_selected.clear();
    }
}
