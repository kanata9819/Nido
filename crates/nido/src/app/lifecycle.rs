use super::*;

impl Model {
    pub(super) fn load(data: PathBuf, repaint: Arc<dyn Fn() + Send + Sync>) -> Self {
        let (tx, rx) = mpsc::channel();
        let loaded = settings::load(&data);
        let mut notifications = vec![];
        let settings = match loaded {
            Ok(v) => v,
            Err(e) => {
                notifications.push((format!("Settings: {e:#}"), Instant::now()));
                settings::defaults()
            }
        };
        let saved = persistence::read_layout(&data.join("workspaces.json"));
        let restore_valid = saved.is_ok();
        let saved = match saved {
            Ok(v) => v,
            Err(e) => {
                notifications.push((format!("Workspace restore: {e:#}"), Instant::now()));
                Layout::default()
            }
        };
        let favorite_path = data.join("favorites.json");
        let favorites = if favorite_path.exists() {
            match persistence::read_favorites(&favorite_path) {
                Ok(v) => v,
                Err(_) => {
                    notifications.push((
                        "Favorites are damaged; the original file was preserved".into(),
                        Instant::now(),
                    ));
                    json!([])
                }
            }
        } else {
            json!([])
        };
        let mut app = Self {
            workspaces: vec![],
            active: String::new(),
            terminal_visible: false,
            terminal_focused: false,
            explorer_focus: false,
            settings: settings.clone(),
            settings_before: settings.clone(),
            data,
            tx,
            rx,
            repaint,
            panel: String::new(),
            palette: None,
            palette_generation: 0,
            file_request: None,
            closing: None,
            notifications,
            favorites,
            git: Value::Null,
            diff: String::new(),
            commit: String::new(),
            branches: Value::Null,
            git_history: Value::Null,
            commit_files: Value::Null,
            selected_commit: String::new(),
            history: Value::Null,
            history_preview: Value::Null,
            search_query: String::new(),
            search_options: json!({"caseSensitive":false,"wholeWord":false,"regex":false,"folder":""}),
            search_results: Value::Null,
            replacement: String::new(),
            replacement_preview: Value::Null,
            search_selected: BTreeSet::new(),
            extensions: Value::Null,
            markdown: String::new(),
            hover: String::new(),
            diagnostics: Value::Null,
            update: json!({"status":"idle"}),
            wsl_list: Value::Null,
            wsl_choice: String::new(),
            wsl_path: String::new(),
            show_wsl: false,
            focus_editor: true,
            mode_pending: false,
            queued_input: vec![],
            exit_allowed: false,
            install_after_close: false,
            restore_valid,
            translations: serde_json::from_str(include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../resources/nido/ja.json"
            )))
            .unwrap_or_default(),
            last_persist: Instant::now(),
            preedit: String::new(),
            shells: nido_backend::session::available_shells(),
            window: saved.window.clone(),
            window_command: None,
        };
        let selected = saved.active;
        for workspace in saved.workspaces {
            let terminal = workspace.kind == "terminal";
            let root = PathBuf::from(&workspace.root);
            let paired = workspace.terminal;
            let id = app.add_workspace(root.clone(), terminal, Some(workspace), None);
            if paired {
                app.add_workspace(root, true, None, Some(id));
            }
        }
        if let Some(w) = app
            .workspaces
            .iter()
            .filter(|w| w.parent.is_none())
            .nth(selected)
        {
            app.active = w.session.id.clone();
        }
        if let Some(path) = std::env::args().skip(1).find(|a| !a.starts_with('-')) {
            let path = normal_path(PathBuf::from(path));
            if path.is_dir() {
                if let Some(w) = app
                    .workspaces
                    .iter()
                    .find(|w| w.parent.is_none() && !w.session.terminal && w.session.root == path)
                {
                    app.active = w.session.id.clone();
                } else {
                    app.add_workspace(path, false, None, None);
                }
            }
        }
        app
    }

    pub(super) fn tr(&self, text: &str) -> String {
        if self.settings["language"] == "ja" {
            self.translations[text].as_str().unwrap_or(text).into()
        } else {
            text.into()
        }
    }

    pub(super) fn error(&mut self, message: impl Into<String>) {
        self.notifications.push((message.into(), Instant::now()));
        if self.notifications.len() > 10 {
            self.notifications.remove(0);
        }
    }

    pub(super) fn persist(&mut self) -> bool {
        if !self.restore_valid {
            return true;
        }
        let roots: Vec<_> = self
            .workspaces
            .iter()
            .filter(|w| w.parent.is_none())
            .collect();
        let workspaces = roots
            .iter()
            .map(|w| {
                let mut snapshot = w.snapshot.clone();
                snapshot.terminal = self
                    .workspaces
                    .iter()
                    .any(|t| t.parent.as_deref() == Some(&w.session.id));
                snapshot
            })
            .collect();
        let active = roots
            .iter()
            .position(|w| w.session.id == self.active)
            .unwrap_or(0);
        let layout = Layout {
            version: 1,
            workspaces,
            active,
            window: self.window.clone(),
        };
        if let Err(error) = persistence::write_layout(&self.data.join("workspaces.json"), &layout) {
            self.error(format!("Workspace checkpoint: {error:#}"));
            self.last_persist = Instant::now();
            return false;
        }
        self.last_persist = Instant::now();
        true
    }
}

impl Drop for Model {
    fn drop(&mut self) {
        for w in &self.workspaces {
            w.session.send("stop", json!([]));
        }
    }
}
