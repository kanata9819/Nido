use super::*;

impl Model {
    pub(super) fn expand_folder(&mut self, index: usize, folder: &str) {
        let w = &mut self.workspaces[index];
        if w.expanded.insert(folder.into()) || !w.files.contains_key(folder) {
            w.session
                .send_tag("files", json!([folder]), &format!("files:{folder}"));
        }
    }

    pub(super) fn tree_action(&mut self, index: usize, action: &str, entry: &Value) {
        let path = s(&entry["path"]);
        if action == "open" {
            if entry["directory"] == true {
                if !self.workspaces[index].expanded.remove(path) {
                    self.expand_folder(index, path);
                }
            } else {
                self.workspaces[index]
                    .session
                    .send("open", json!([path, 0, 1]));
                self.explorer_focus = false;
                self.focus_editor = true;
            }
        } else {
            let source = if ["createFile", "createDirectory"].contains(&action) {
                if entry["directory"] == true {
                    format!("{path}/")
                } else {
                    Path::new(path)
                        .parent()
                        .map(|p| format!("{}/", p.to_string_lossy()))
                        .unwrap_or_default()
                }
            } else {
                path.into()
            };
            self.file_request = Some(FileRequest {
                workspace: self.active.clone(),
                action: action.into(),
                target: source.clone(),
                source,
                focus: true,
            });
        }
    }

    pub(super) fn explorer_key(&mut self, key: &str) {
        let Some(i) = self.active_index() else { return };
        let rows = tree_rows(&self.workspaces[i], "", 0);
        let Some((entry, _)) = rows.get(self.workspaces[i].selected).cloned() else {
            return;
        };
        match key {
            "j" => {
                self.workspaces[i].selected =
                    (self.workspaces[i].selected + 1).min(rows.len().saturating_sub(1))
            }
            "k" => self.workspaces[i].selected = self.workspaces[i].selected.saturating_sub(1),
            "l" => {
                if entry["directory"] == true {
                    self.expand_folder(i, s(&entry["path"]));
                } else {
                    self.tree_action(i, "open", &entry);
                }
            }
            "h" => {
                if !self.workspaces[i].expanded.remove(s(&entry["path"]))
                    && let Some(parent) = Path::new(s(&entry["path"])).parent()
                {
                    let parent = parent.to_string_lossy().replace('\\', "/");
                    if let Some(index) = rows.iter().position(|(e, _)| e["path"] == parent) {
                        self.workspaces[i].selected = index;
                    }
                }
            }
            "enter" => self.tree_action(i, "open", &entry),
            "n" => self.tree_action(i, "createFile", &entry),
            "N" => self.tree_action(i, "createDirectory", &entry),
            "r" => self.tree_action(i, "rename", &entry),
            "c" => self.tree_action(i, "copy", &entry),
            "d" | "delete" => self.tree_action(i, "delete", &entry),
            _ => {}
        }
        self.workspaces[i].reveal_selected = true;
    }

    pub(super) fn submit_file(&mut self) {
        if self.file_request.is_none() {
            return;
        }
        let request = self.file_request.take().unwrap();
        let Some(workspace) = self
            .workspaces
            .iter()
            .find(|w| w.session.id == request.workspace)
        else {
            self.error("The workspace was closed. Reopen the file operation.");
            return;
        };
        if request.action == "gitBranch" {
            workspace.session.send_tag(
                "git",
                json!(["switch", [request.target, true]]),
                "gitMutation",
            );
        } else {
            let path = if request.action == "createFile" || request.action == "createDirectory" {
                request.target.as_str()
            } else {
                request.source.as_str()
            };
            workspace
                .session
                .send("fileAction", json!([request.action, path, request.target]));
        }
        self.focus_editor = true;
    }
}

pub(super) fn tree_rows(workspace: &Workspace, folder: &str, depth: usize) -> Vec<(Value, usize)> {
    let mut rows = vec![];
    if depth > 32 {
        return rows;
    }
    if let Some(entries) = workspace.files.get(folder) {
        for entry in array(entries) {
            rows.push((entry.clone(), depth));
            if entry["directory"] == true && workspace.expanded.contains(s(&entry["path"])) {
                rows.extend(tree_rows(workspace, s(&entry["path"]), depth + 1));
            }
        }
    }
    rows
}
