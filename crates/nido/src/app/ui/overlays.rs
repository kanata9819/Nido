use super::*;

impl Nido {
    pub(in crate::app::ui) fn overlay(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
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
                            let remote = nido_backend::wsl::Remote {
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

    pub(in crate::app::ui) fn notifications(&self, cx: &Context<Self>) -> Option<AnyElement> {
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
