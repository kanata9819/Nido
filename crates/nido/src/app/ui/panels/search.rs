use super::*;

impl Nido {
    pub(in crate::app::ui) fn search_panel(&mut self, cx: &mut Context<Self>) -> AnyElement {
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
}
