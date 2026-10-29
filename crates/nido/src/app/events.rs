use super::*;

impl Model {
    pub(super) fn events(&mut self) {
        while let Ok(event) = self.rx.try_recv() {
            match event {
                Event::Error(error) => {
                    self.error(error);
                    if self.closing.as_ref().is_some_and(|c| c.stage != "stopping") {
                        self.closing = None;
                        self.exit_allowed = false;
                    }
                    self.mode_pending = false;
                }
                Event::Closed(id) => {
                    if let Some(index) = self.workspaces.iter().position(|w| w.session.id == id) {
                        self.workspaces[index].ready = false;
                        self.workspaces[index].closed = true;
                        if self.workspaces[index].session.terminal && self.closing.is_none() {
                            let workspace = self.workspaces.remove(index);
                            if workspace.parent.as_deref() == Some(&self.active)
                                || id == self.active
                            {
                                self.terminal_visible = false;
                                self.terminal_focused = false;
                                self.focus_editor = true;
                            }
                            if id == self.active {
                                self.active = self
                                    .workspaces
                                    .iter()
                                    .find(|w| w.parent.is_none())
                                    .map(|w| w.session.id.clone())
                                    .unwrap_or_default();
                            }
                        }
                    }
                    if let Some(close) = self.closing.as_mut()
                        && close.stage == "stopping"
                    {
                        close.waiting.remove(&id);
                    }
                }
                Event::Notify(id, method, args) => {
                    if let Some(i) = self.workspaces.iter().position(|w| w.session.id == id) {
                        let w = &mut self.workspaces[i];
                        w.grid.notify(&method, &args);
                        match method.as_str() {
                            "nido:state" => {
                                if let Some(state) = args[0].as_object() {
                                    for (k, v) in state {
                                        w.state[k] = v.clone();
                                    }
                                }
                            }
                            "nido:references" => w.state["references"] = args[0].clone(),
                            "nido:symbols" => w.state["symbols"] = args[0].clone(),
                            "nido:debug" => w.state["debug"] = args[0].clone(),
                            "nido:message" => {
                                if args[1].as_i64().unwrap_or(2) >= 2 {
                                    self.error(format!("{}: {}", s(&args[2]), s(&args[0])));
                                }
                            }
                            "nido:hover" => {
                                self.hover = s(&args[0]).into();
                            }
                            "nido:diagnostics" => {
                                self.diagnostics = if array(&args[0]).is_empty() {
                                    Value::Null
                                } else {
                                    args[0].clone()
                                };
                            }
                            "nido:edit" if id == self.active && self.panel == "markdown" => {
                                w.session.send("markdown", json!([]));
                            }
                            "nido:terminal_exit" => {
                                self.workspaces[i].session.send("stop", json!([]));
                                if self.workspaces[i].parent.is_some() {
                                    self.terminal_visible = false;
                                }
                            }
                            _ => {}
                        }
                    }
                }
                Event::Result(id, tag, value) => self.result(&id, &tag, value),
            }
        }
        let finish = self.closing.as_ref().is_some_and(|c| c.waiting.is_empty());
        if finish {
            let stage = self.closing.as_ref().unwrap().stage.clone();
            match stage.as_str() {
                "probing" => {
                    if self.closing.as_ref().unwrap().modified {
                        self.closing.as_mut().unwrap().stage = "prompt".into();
                    } else {
                        self.close_snapshots();
                    }
                }
                "saving" => self.close_snapshots(),
                "snapshots" => {
                    if !self.persist() {
                        self.closing = None;
                        self.install_after_close = false;
                        return;
                    }
                    let close = self.closing.as_mut().unwrap();
                    close.stage = "stopping".into();
                    close.waiting = self
                        .workspaces
                        .iter()
                        .filter(|w| close.ids.contains(&w.session.id) && !w.closed)
                        .map(|w| w.session.id.clone())
                        .collect();
                    for w in &self.workspaces {
                        if close.waiting.contains(&w.session.id) {
                            w.session.send("stop", json!([]));
                        }
                    }
                }
                "stopping" => {
                    let close = self.closing.take().unwrap();
                    self.workspaces
                        .retain(|w| !close.ids.contains(&w.session.id));
                    if close.quit {
                        if self.install_after_close {
                            self.install_after_close = false;
                            if let Err(error) = nido_backend::updater::install(&self.data) {
                                self.error(format!("Update: {error:#}"));
                                return;
                            }
                        }
                        self.exit_allowed = true;
                    } else {
                        if !self.workspaces.iter().any(|w| w.session.id == self.active) {
                            self.active = self
                                .workspaces
                                .iter()
                                .find(|w| w.parent.is_none())
                                .map(|w| w.session.id.clone())
                                .unwrap_or_default();
                        }
                        self.persist();
                        self.focus_editor = true;
                    }
                }
                _ => {}
            }
        }
    }

    pub(super) fn result(&mut self, id: &str, tag: &str, value: Value) {
        if tag == "openFolder" {
            if self.closing.is_some() || self.exit_allowed {
                return;
            }
            if let Some(root) = value["root"].as_str() {
                self.add_workspace(PathBuf::from(root), value["terminal"] == true, None, None);
            }
            return;
        }
        if tag == "wslDistributions" {
            self.wsl_list = value;
            if self.wsl_choice.is_empty() {
                self.wsl_choice = s(&self.wsl_list[0]).into();
            }
            return;
        }
        if tag == "update" {
            self.update = value;
            return;
        }
        if tag == "installedPack" {
            for w in &self.workspaces {
                w.session.send("reloadPacks", json!([]));
            }
            self.send("packs", json!([]));
            return;
        }
        let Some(i) = self.workspaces.iter().position(|w| w.session.id == id) else {
            return;
        };
        if tag == "ready" {
            self.workspaces[i].ready = true;
            self.workspaces[i]
                .session
                .send_tag("files", json!([""]), "files:");
            return;
        }
        if tag == "checkpoint" || tag == "snapshot" || tag == "closeSnapshot" {
            if let Ok(snapshot) = serde_json::from_value(value) {
                self.workspaces[i].snapshot = snapshot;
            }
            if tag == "closeSnapshot"
                && let Some(close) = self.closing.as_mut()
            {
                close.waiting.remove(id);
            }
            return;
        }
        if tag == "closeProbe" {
            if let Some(close) = self.closing.as_mut() {
                close.modified |= value == true;
                close.waiting.remove(id);
            }
            return;
        }
        if tag == "closeSave" {
            if let Some(close) = self.closing.as_mut() {
                close.waiting.remove(id);
            }
            return;
        }
        if let Some(folder) = tag.strip_prefix("files:") {
            self.workspaces[i].files.insert(folder.into(), value);
            return;
        }
        if let Some(generation) = tag.strip_prefix("palette:") {
            if let Some(p) = self.palette.as_mut()
                && id == self.active
                && p.generation.to_string() == generation
            {
                p.items = value;
            }
            return;
        }
        if tag == "modeShortcut" {
            self.mode_pending = false;
            if id != self.active {
                return;
            }
            let key = s(&value["key"]);
            if value["mode"] == "n" {
                match key {
                    " " => self.open_palette("commands"),
                    "<C-p>" => self.open_palette("files"),
                    "H" | "L" => {
                        let w = &self.workspaces[i];
                        let buffers = w.buffers();
                        if let Some(index) =
                            buffers.iter().position(|b| b["id"] == w.state["current"])
                            && !buffers.is_empty()
                        {
                            let offset = if key == "H" { -1 } else { 1 };
                            let next = (index as isize + offset).rem_euclid(buffers.len() as isize)
                                as usize;
                            w.session.send("selectBuffer", json!([buffers[next]["id"]]));
                        }
                    }
                    _ => self.input(key),
                }
            } else {
                self.input(key)
            }
            return;
        }
        if id != self.active {
            return;
        }
        match tag {
            "filesChanged" | "fileAction" => {
                let folders: Vec<_> = self.workspaces[i].files.keys().cloned().collect();
                for folder in folders {
                    self.workspaces[i].session.send_tag(
                        "files",
                        json!([folder]),
                        &format!("files:{folder}"),
                    );
                }
            }
            "git" => {
                if value.get("changes").is_some() {
                    self.git = value;
                } else if value.get("commits").is_some() {
                    self.git_history = value;
                } else if value.is_array() {
                    if value[0].get("name").is_some() {
                        self.branches = value;
                    } else {
                        self.commit_files = value;
                    }
                } else if value.is_string() {
                    self.diff = s(&value).into();
                } else {
                    self.send("git", json!(["status", []]));
                }
            }
            "gitMutation" => {
                self.send("git", json!(["status", []]));
                self.send("lua", json!(["local s=require('nido_git_signs'); if s.refresh_all then s.refresh_all() end", []]));
                self.diff.clear();
            }
            "gitDiff" => self.diff = s(&value).into(),
            "gitBranches" => self.branches = value,
            "gitHistory" => self.git_history = value,
            "commitFiles" => self.commit_files = value,
            "history" => {
                if value.get("versions").is_some() {
                    self.history = value;
                    self.history_preview = Value::Null;
                } else if value.get("diff").is_some() {
                    self.history_preview = value;
                } else {
                    self.send("history", json!(["list", {}]));
                }
            }
            "search" => {
                if value["query"] != self.search_query || value["options"] != self.search_options {
                    return;
                }
                self.search_results = value;
                self.replacement_preview = Value::Null;
                self.search_selected =
                    (0..array(&self.search_results["matches"]).len().min(200)).collect();
            }
            "previewReplacement" => {
                if value["searchToken"] == self.search_results["token"]
                    && value["replacement"] == self.replacement
                {
                    self.replacement_preview = value;
                }
            }
            "applyReplacement" => {
                self.error("Replacement applied to buffers. Save to write files.");
                self.replacement_preview = Value::Null;
            }
            "packs" => self.extensions = value,
            "markdown" => self.markdown = s(&value).into(),
            _ => {}
        }
    }
}
