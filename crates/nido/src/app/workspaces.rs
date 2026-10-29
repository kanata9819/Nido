use super::*;

impl Model {
    pub(super) fn add_workspace(
        &mut self,
        root: PathBuf,
        terminal: bool,
        saved: Option<SavedWorkspace>,
        parent: Option<String>,
    ) -> String {
        let root = normal_path(root);
        let snapshot = saved.clone().unwrap_or_else(|| SavedWorkspace {
            root: root.to_string_lossy().into_owned(),
            kind: if terminal { "terminal" } else { "editor" }.into(),
            ..Default::default()
        });
        let session = Session::start(
            root,
            terminal,
            saved,
            self.settings.clone(),
            self.tx.clone(),
            self.repaint.clone(),
            self.data.clone(),
        );
        let id = session.id.clone();
        self.workspaces.push(Workspace {
            session,
            parent: parent.clone(),
            grid: Grid::default(),
            state: json!({"buffers":[],"current":0,"mode":"n","line":1,"column":1,"filetype":""}),
            ready: false,
            closed: false,
            snapshot,
            files: HashMap::new(),
            expanded: BTreeSet::new(),
            selected: 0,
            last_file: String::new(),
            reveal_file: None,
            reveal_selected: false,
            size: (0, 0),
        });
        if parent.is_none() {
            self.active = id.clone();
            self.terminal_focused = false;
            self.palette = None;
        }
        self.focus_editor = true;
        id
    }

    pub(super) fn active_index(&self) -> Option<usize> {
        self.workspaces
            .iter()
            .position(|w| w.session.id == self.active)
    }

    pub(super) fn input_index(&self) -> Option<usize> {
        if self.terminal_visible && self.terminal_focused && !self.explorer_focus {
            self.workspaces
                .iter()
                .position(|w| w.parent.as_deref() == Some(&self.active))
                .or_else(|| self.active_index())
        } else {
            self.active_index()
        }
    }

    pub(super) fn send(&self, name: &str, args: Value) {
        if let Some(index) = self.active_index() {
            self.workspaces[index].session.send(name, args);
        }
    }

    pub(super) fn input(&self, text: &str) {
        if let Some(index) = self.input_index() {
            self.workspaces[index].session.send("input", json!([text]));
        }
    }

    pub(super) fn open_folder(&mut self, terminal: bool) {
        let tx = self.tx.clone();
        let repaint = self.repaint.clone();
        std::thread::spawn(move || {
            if let Some(folder) = rfd::FileDialog::new()
                .set_title("Open workspace")
                .pick_folder()
            {
                let _ = tx.send(Event::Result(
                    String::new(),
                    "openFolder".into(),
                    json!({"root":folder,"terminal":terminal}),
                ));
                repaint();
            }
        });
    }

    pub(super) fn toggle_terminal(&mut self) {
        self.workspaces
            .retain(|w| !(w.closed && w.parent.as_deref() == Some(&self.active)));
        if let Some(index) = self.active_index() {
            if self.workspaces[index].session.terminal {
                return;
            }
            if !self
                .workspaces
                .iter()
                .any(|w| w.parent.as_deref() == Some(&self.active))
            {
                let root = self.workspaces[index].session.root.clone();
                self.add_workspace(root, true, None, Some(self.active.clone()));
            }
            self.terminal_visible = !self.terminal_visible;
            self.terminal_focused = self.terminal_visible;
            self.explorer_focus = false;
            self.focus_editor = true;
        }
    }

    pub(super) fn switch_workspace(&mut self, offset: isize) {
        let ids: Vec<_> = self
            .workspaces
            .iter()
            .filter(|w| w.parent.is_none())
            .map(|w| w.session.id.clone())
            .collect();
        if !ids.is_empty() {
            let index = ids.iter().position(|id| id == &self.active).unwrap_or(0);
            self.active =
                ids[(index as isize + offset).rem_euclid(ids.len() as isize) as usize].clone();
            self.terminal_focused = false;
            self.focus_editor = true;
            self.explorer_focus = false;
            self.panel.clear();
        }
    }
}

impl Workspace {
    pub(super) fn name(&self) -> String {
        let name = self
            .session
            .root
            .file_name()
            .unwrap_or(self.session.root.as_os_str())
            .to_string_lossy();
        format!(
            "{}{name}",
            if self.session.terminal {
                "Terminal · "
            } else {
                ""
            }
        )
    }
    pub(super) fn buffers(&self) -> &[Value] {
        array(&self.state["buffers"])
    }
    pub(super) fn current(&self) -> String {
        self.buffers()
            .iter()
            .find(|b| b["id"] == self.state["current"])
            .map(|b| s(&b["name"]).to_owned())
            .unwrap_or_default()
    }
}
