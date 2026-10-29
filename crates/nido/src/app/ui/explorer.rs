use super::*;

impl Nido {
    pub(in crate::app::ui) fn reveal_tree(&mut self) {
        let Some(i) = self.model.active_index() else {
            return;
        };
        let current = self.model.workspaces[i].current();
        if current != self.model.workspaces[i].last_file {
            self.model.workspaces[i].last_file = current.clone();
            let root = &self.model.workspaces[i].session.root;
            let path = if let Some(remote) = nido_backend::wsl::Remote::parse(root) {
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

    pub(in crate::app::ui) fn explorer(&mut self, cx: &Context<Self>) -> AnyElement {
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
}
