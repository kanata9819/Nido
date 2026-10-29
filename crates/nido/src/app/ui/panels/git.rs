use super::*;

impl Nido {
    pub(in crate::app::ui) fn git_panel(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let commit = self.field("commit", self.model.commit.clone(), "Commit message", cx);
        let mut list = column()
            .child(
                row()
                    .child(self.button(
                        "git-refresh",
                        self.model.tr("Refresh"),
                        |this, _, _| this.model.send("git", json!(["status", []])),
                        cx,
                    ))
                    .child(self.button(
                        "git-stage-all",
                        self.model.tr("Stage all"),
                        |this, _, _| this.model.git_mutation("stageAll", json!([])),
                        cx,
                    ))
                    .child(self.button(
                        "git-branches",
                        self.model.tr("Branches"),
                        |this, _, _| {
                            if let Some(i) = this.model.active_index() {
                                this.model.workspaces[i].session.send_tag(
                                    "git",
                                    json!(["branches", []]),
                                    "gitBranches",
                                );
                            }
                        },
                        cx,
                    ))
                    .child(self.command("git-history", "History", "gitHistory", cx)),
            )
            .child(format!("Branch: {}", s(&self.model.git["branch"])));
        for branch in array(&self.model.branches) {
            let name = s(&branch["name"]).to_owned();
            let value = name.clone();
            list = list.child(
                self.button(
                    format!("branch-{name}"),
                    name,
                    move |this, _, _| {
                        this.model.git_mutation("switch", json!([value, false]));
                        this.model.branches = Value::Null;
                    },
                    cx,
                )
                .when(branch["current"] == true, |el| el.text_color(rgb(0x99c68c))),
            );
        }
        if self.model.branches.is_array() {
            list = list.child(self.button(
                "git-new-branch",
                self.model.tr("New branch"),
                |this, window, cx| {
                    this.model.file_request = Some(FileRequest {
                        workspace: this.model.active.clone(),
                        action: "gitBranch".into(),
                        source: String::new(),
                        target: String::new(),
                        focus: true,
                    });
                    this.tick(window, cx);
                },
                cx,
            ));
        }
        list = list.child(commit).child(self.button(
            "git-commit",
            self.model.tr("Commit"),
            |this, _, _| {
                this.model
                    .git_mutation("commit", json!([this.model.commit]))
            },
            cx,
        ));
        for (i, change) in array(&self.model.git["changes"]).iter().enumerate() {
            let c = change.clone();
            let diff = c.clone();
            let open = c.clone();
            let staged = c["staged"] == true;
            list = list.child(
                row()
                    .child(self.button(
                        format!("stage-{i}"),
                        if staged { "−" } else { "+" },
                        move |this, _, _| {
                            this.model
                                .git_mutation("stage", json!([c["path"], !staged]))
                        },
                        cx,
                    ))
                    .child(
                        self.button(
                            format!("diff-{i}"),
                            format!("{} {}", s(&change["status"]), s(&change["path"])),
                            move |this, _, _| {
                                if let Some(i) = this.model.active_index() {
                                    this.model.workspaces[i].session.send_tag(
                                        "git",
                                        json!(["diff", [diff["path"], staged]]),
                                        "gitDiff",
                                    );
                                }
                            },
                            cx,
                        )
                        .flex_1()
                        .min_w_0()
                        .overflow_hidden(),
                    )
                    .child(
                        self.button(
                            format!("git-open-{i}"),
                            "",
                            move |this, window, cx| {
                                this.model.send("openGit", json!([open["path"]]));
                                this.model.focus_editor = true;
                                this.tick(window, cx);
                            },
                            cx,
                        )
                        .child(icon("file-text", 14.)),
                    ),
            );
        }
        list.child(diff(&self.model.diff)).into_any_element()
    }

    pub(in crate::app::ui) fn git_history_panel(&self, cx: &Context<Self>) -> AnyElement {
        let mut list = column().child(self.button(
            "history-refresh",
            self.model.tr("Refresh"),
            |this, _, _| this.model.send("git", json!(["history", [0]])),
            cx,
        ));
        for commit in array(&self.model.git_history["commits"]) {
            let hash = s(&commit["hash"]);
            let value = hash.to_owned();
            list = list.child(
                self.button(
                    format!("commit-{hash}"),
                    format!(
                        "{}  {}",
                        hash.chars().take(8).collect::<String>(),
                        s(&commit["message"])
                    ),
                    move |this, _, _| {
                        this.model.selected_commit = value.clone();
                        this.model.send("git", json!(["commitFiles", [value]]));
                    },
                    cx,
                )
                .when(self.model.selected_commit == hash, |el| {
                    el.bg(rgb(0x29343c))
                }),
            );
        }
        list = list.child(self.button(
            "history-next",
            "Next 50 commits",
            |this, _, _| {
                let skip = this.model.git_history["skip"].as_u64().unwrap_or(0) + 50;
                if let Some(i) = this.model.active_index() {
                    this.model.workspaces[i].session.send_tag(
                        "git",
                        json!(["history", [skip]]),
                        "gitHistory",
                    );
                }
                this.model.git_history["skip"] = json!(skip);
            },
            cx,
        ));
        for (i, file) in array(&self.model.commit_files).iter().enumerate() {
            let f = file.clone();
            list = list.child(self.button(
                format!("commit-file-{i}"),
                s(file).to_owned(),
                move |this, _, _| {
                    this.model.send(
                        "git",
                        json!(["commitDiff", [this.model.selected_commit, f]]),
                    )
                },
                cx,
            ));
        }
        list.child(diff(&self.model.diff)).into_any_element()
    }
}
