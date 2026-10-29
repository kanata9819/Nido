use crate::{
    backend::Session,
    files::normal_path,
    grid::{self, Grid, array, n, s},
    persistence::{self, Layout, SavedWorkspace},
    rpc::Event,
    settings,
};
use gpui::{Keystroke, Modifiers};
use serde_json::{Value, json};
use std::{
    collections::{BTreeSet, HashMap},
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc,
        mpsc::{self, Receiver, Sender},
    },
    time::{Duration, Instant},
};

struct Workspace {
    session: Session,
    parent: Option<String>,
    grid: Grid,
    state: Value,
    ready: bool,
    closed: bool,
    snapshot: SavedWorkspace,
    files: HashMap<String, Value>,
    expanded: BTreeSet<String>,
    selected: usize,
    last_file: String,
    reveal_file: Option<String>,
    reveal_selected: bool,
    size: (usize, usize),
}
impl Workspace {
    fn name(&self) -> String {
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
    fn buffers(&self) -> &[Value] {
        array(&self.state["buffers"])
    }
    fn current(&self) -> String {
        self.buffers()
            .iter()
            .find(|b| b["id"] == self.state["current"])
            .map(|b| s(&b["name"]).to_owned())
            .unwrap_or_default()
    }
}
struct Palette {
    kind: String,
    query: String,
    items: Value,
    index: usize,
    focus: bool,
    generation: u64,
}
struct FileRequest {
    workspace: String,
    action: String,
    source: String,
    target: String,
    focus: bool,
}
struct Closing {
    ids: BTreeSet<String>,
    waiting: BTreeSet<String>,
    modified: bool,
    stage: String,
    quit: bool,
}
pub(super) struct Model {
    workspaces: Vec<Workspace>,
    active: String,
    terminal_visible: bool,
    terminal_focused: bool,
    explorer_focus: bool,
    settings: Value,
    data: PathBuf,
    tx: Sender<Event>,
    rx: Receiver<Event>,
    repaint: Arc<dyn Fn() + Send + Sync>,
    panel: String,
    palette: Option<Palette>,
    palette_generation: u64,
    file_request: Option<FileRequest>,
    closing: Option<Closing>,
    notifications: Vec<(String, Instant)>,
    favorites: Value,
    git: Value,
    diff: String,
    commit: String,
    branches: Value,
    git_history: Value,
    commit_files: Value,
    selected_commit: String,
    history: Value,
    history_preview: Value,
    search_query: String,
    search_options: Value,
    search_results: Value,
    replacement: String,
    replacement_preview: Value,
    search_selected: BTreeSet<usize>,
    extensions: Value,
    markdown: String,
    hover: String,
    diagnostics: Value,
    update: Value,
    wsl_list: Value,
    wsl_choice: String,
    wsl_path: String,
    show_wsl: bool,
    focus_editor: bool,
    mode_pending: bool,
    queued_input: Vec<InputEvent>,
    exit_allowed: bool,
    install_after_close: bool,
    restore_valid: bool,
    translations: Value,
    last_persist: Instant,
    settings_before: Value,
    preedit: String,
    shells: Vec<String>,
    window: Value,
    window_command: Option<String>,
}
impl Model {
    fn load(data: PathBuf, repaint: Arc<dyn Fn() + Send + Sync>) -> Self {
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
            translations: serde_json::from_str(include_str!("../resources/nido/ja.json"))
                .unwrap_or_default(),
            last_persist: Instant::now(),
            preedit: String::new(),
            shells: crate::backend::available_shells(),
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
    fn tr(&self, text: &str) -> String {
        if self.settings["language"] == "ja" {
            self.translations[text].as_str().unwrap_or(text).into()
        } else {
            text.into()
        }
    }
    fn add_workspace(
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
    fn active_index(&self) -> Option<usize> {
        self.workspaces
            .iter()
            .position(|w| w.session.id == self.active)
    }
    fn input_index(&self) -> Option<usize> {
        if self.terminal_visible && self.terminal_focused && !self.explorer_focus {
            self.workspaces
                .iter()
                .position(|w| w.parent.as_deref() == Some(&self.active))
                .or_else(|| self.active_index())
        } else {
            self.active_index()
        }
    }
    fn send(&self, name: &str, args: Value) {
        if let Some(index) = self.active_index() {
            self.workspaces[index].session.send(name, args);
        }
    }
    fn input(&self, text: &str) {
        if let Some(index) = self.input_index() {
            self.workspaces[index].session.send("input", json!([text]));
        }
    }
    fn error(&mut self, message: impl Into<String>) {
        self.notifications.push((message.into(), Instant::now()));
        if self.notifications.len() > 10 {
            self.notifications.remove(0);
        }
    }
    fn open_folder(&mut self, terminal: bool) {
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
    fn toggle_terminal(&mut self) {
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
    fn switch_workspace(&mut self, offset: isize) {
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
    fn open_palette(&mut self, kind: &str) {
        self.panel.clear();
        self.palette = Some(Palette {
            kind: kind.into(),
            query: String::new(),
            items: json!([]),
            index: 0,
            focus: true,
            generation: 0,
        });
        self.refresh_palette();
    }
    fn refresh_palette(&mut self) {
        let Some(p) = self.palette.as_mut() else {
            return;
        };
        self.palette_generation += 1;
        p.generation = self.palette_generation;
        p.index = 0;
        let kind = p.kind.clone();
        let query = p.query.clone();
        let tag = format!("palette:{}", p.generation);
        if kind == "files" {
            if let Some(i) = self.active_index() {
                self.workspaces[i]
                    .session
                    .send_tag("findFiles", json!([query]), &tag);
            }
        } else if kind == "symbols" {
            self.send("lua", json!(["return require('nido_symbols').find()", []]));
        }
    }
    fn show_panel(&mut self, panel: &str) {
        self.palette = None;
        self.panel = if self.panel == panel {
            String::new()
        } else {
            panel.into()
        };
        self.explorer_focus = false;
        match self.panel.as_str() {
            "git" => self.send("git", json!(["status", []])),
            "gitHistory" => self.send("git", json!(["history", [0]])),
            "history" => self.send("history", json!(["list", {}])),
            "extensions" => self.send("packs", json!([])),
            "markdown" => self.send("markdown", json!([])),
            _ => {}
        }
    }
    fn events(&mut self) {
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
                            if let Err(error) = crate::updater::install(&self.data) {
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
    fn result(&mut self, id: &str, tag: &str, value: Value) {
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
    fn request_close(&mut self, quit: bool) {
        if self.closing.is_some() {
            return;
        }
        let ids: BTreeSet<_> = self
            .workspaces
            .iter()
            .filter(|w| {
                quit || w.session.id == self.active || w.parent.as_deref() == Some(&self.active)
            })
            .map(|w| w.session.id.clone())
            .collect();
        if ids.is_empty() {
            if quit {
                if self.install_after_close {
                    self.install_after_close = false;
                    if let Err(error) = crate::updater::install(&self.data) {
                        self.error(format!("Update: {error:#}"));
                        return;
                    }
                }
                self.exit_allowed = true;
            }
            return;
        }
        for w in &self.workspaces {
            if ids.contains(&w.session.id) && !w.closed {
                w.session.send("input", json!(["<Esc>"]));
                w.session.send_tag("modified", json!([]), "closeProbe");
            }
        }
        self.closing = Some(Closing {
            waiting: self
                .workspaces
                .iter()
                .filter(|w| ids.contains(&w.session.id) && !w.closed)
                .map(|w| w.session.id.clone())
                .collect(),
            ids,
            modified: false,
            stage: "probing".into(),
            quit,
        });
    }
    fn close_snapshots(&mut self) {
        if let Some(close) = self.closing.as_mut() {
            close.stage = "snapshots".into();
            close.waiting = self
                .workspaces
                .iter()
                .filter(|w| close.ids.contains(&w.session.id) && !w.closed)
                .map(|w| w.session.id.clone())
                .collect();
            for w in &self.workspaces {
                if close.waiting.contains(&w.session.id) {
                    w.session.send_tag("snapshot", json!([]), "closeSnapshot");
                }
            }
        }
    }
    fn persist(&mut self) -> bool {
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

impl Model {
    fn mode_shortcut(&mut self, key: &str) {
        if let Some(i) = self.active_index() {
            self.mode_pending = true;
            self.workspaces[i]
                .session
                .send("modeShortcut", json!([key]));
        }
    }
    fn execute(&mut self, action: &str) {
        match action {
            "new" => self.open_folder(false),
            "newTerminal" => self.open_folder(true),
            "wsl" => self.open_wsl(),
            "commands" | "files" | "buffers" | "symbols" | "workspaces" | "favorites" => {
                self.open_palette(action)
            }
            "search" | "git" | "gitHistory" | "history" | "problems" | "settings"
            | "extensions" | "debug" | "references" | "markdown" => self.show_panel(action),
            "explorer" => {
                self.settings["sidebar"] = json!(true);
                self.explorer_focus = true;
                self.panel.clear();
            }
            "save" => {
                self.send("save", json!(["write"]));
                self.focus_editor = true;
            }
            "saveAll" => self.send("save", json!(["wall"])),
            "closeWorkspace" => self.request_close(false),
            "closeBuffer" => {
                if let Some(i) = self.active_index() {
                    self.send(
                        "closeBuffer",
                        json!([self.workspaces[i].state["current"], false]),
                    );
                }
            }
            "terminal" => self.toggle_terminal(),
            "restartTerminal" => {
                if let Some(i) = self.input_index() {
                    self.workspaces[i]
                        .session
                        .send("restartTerminal", json!([]));
                }
            }
            "nextWorkspace" => self.switch_workspace(1),
            "previousWorkspace" => self.switch_workspace(-1),
            "moveLeft" | "moveRight" => {
                if let Some(index) = self.active_index() {
                    let offset = if action == "moveLeft" { -1 } else { 1 };
                    let next = (index as isize + offset)
                        .clamp(0, self.workspaces.len().saturating_sub(1) as isize)
                        as usize;
                    self.workspaces.swap(index, next);
                }
            }
            "favorite" => {
                if let Err(error) = persistence::read_favorites(&self.data.join("favorites.json")) {
                    self.error(error.to_string());
                    return;
                }
                if let Some(i) = self.active_index() {
                    let w = &self.workspaces[i];
                    let root = w.session.root.to_string_lossy().into_owned();
                    let kind = if w.session.terminal {
                        "terminal"
                    } else {
                        "editor"
                    };
                    let mut favorites = array(&self.favorites).to_vec();
                    if let Some(index) = favorites
                        .iter()
                        .position(|f| f["root"] == root && f["kind"] == kind)
                    {
                        favorites.remove(index);
                    } else {
                        favorites.push(json!({"root":root,"name":w.name(),"kind":kind}));
                    }
                    match persistence::write_json(&self.data.join("favorites.json"), &favorites) {
                        Ok(()) => self.favorites = json!(favorites),
                        Err(e) => self.error(e.to_string()),
                    }
                }
            }
            "focusEditor" => {
                self.terminal_focused = false;
                self.explorer_focus = false;
                self.panel.clear();
                self.focus_editor = true;
            }
            "lf" | "crlf" => self.send(
                "lua",
                json!([
                    "require('nido_eol').convert(...)",
                    [if action == "lf" { "LF" } else { "CRLF" }]
                ]),
            ),
            "minimize" | "maximize" => self.window_command = Some(action.into()),
            "quit" => self.request_close(true),
            action if action.starts_with("key:") => {
                self.input(&action[4..]);
                self.focus_editor = true;
            }
            action if action.starts_with("debug:") => self.send("debug", json!([&action[6..], 0])),
            _ => {}
        }
    }
    fn palette_items(&self) -> Vec<Value> {
        let Some(p) = &self.palette else {
            return vec![];
        };
        let query = p.query.to_lowercase();
        let items=match p.kind.as_str(){
            "commands"=>COMMANDS.iter().map(|(key,title,detail,action)|json!({"key":key,"title":self.tr(title),"detail":detail,"action":action})).collect::<Vec<_>>(),
            "files"=>array(&p.items).iter().map(|v|json!({"title":v["path"],"detail":"","path":v["path"]})).collect(),
            "buffers"=>self.active_index().map(|i|self.workspaces[i].buffers().iter().map(|v|json!({"title":v["name"],"detail":if v["modified"]==true{"modified"}else{""},"buffer":v["id"]})).collect()).unwrap_or_default(),
            "symbols"=>self.active_index().map(|i|array(&self.workspaces[i].state["symbols"]["items"]).iter().enumerate().map(|(index,v)|json!({"title":v["name"],"detail":v["kind"],"symbol":index+1})).collect()).unwrap_or_default(),
            "workspaces"=>self.workspaces.iter().filter(|w|w.parent.is_none()).map(|w|json!({"title":w.name(),"detail":w.session.root,"workspace":w.session.id})).collect(),
            "favorites"=>array(&self.favorites).iter().map(|v|json!({"title":v["name"],"detail":v["root"],"favorite":v})).collect(),
            _=>vec![]
        };
        items
            .into_iter()
            .filter(|item| {
                p.kind == "files"
                    || format!("{} {}", s(&item["title"]), s(&item["detail"]))
                        .to_lowercase()
                        .contains(&query)
            })
            .collect()
    }
    fn expand_folder(&mut self, index: usize, folder: &str) {
        let w = &mut self.workspaces[index];
        if w.expanded.insert(folder.into()) || !w.files.contains_key(folder) {
            w.session
                .send_tag("files", json!([folder]), &format!("files:{folder}"));
        }
    }
    fn tree_action(&mut self, index: usize, action: &str, entry: &Value) {
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
    fn explorer_key(&mut self, key: &str) {
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
    fn submit_file(&mut self) {
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
    fn close_choice(&mut self, choice: &str) {
        if self.closing.is_none() {
            return;
        }
        match choice {
            "cancel" => {
                self.closing = None;
                self.install_after_close = false;
                self.focus_editor = true;
            }
            "discard" => self.close_snapshots(),
            "save" => {
                let close = self.closing.as_mut().unwrap();
                close.stage = "saving".into();
                close.waiting = self
                    .workspaces
                    .iter()
                    .filter(|w| {
                        close.ids.contains(&w.session.id) && !w.session.terminal && !w.closed
                    })
                    .map(|w| w.session.id.clone())
                    .collect();
                for w in &self.workspaces {
                    if close.waiting.contains(&w.session.id) {
                        w.session.send_tag("save", json!(["wall"]), "closeSave");
                    }
                }
            }
            _ => {}
        }
    }
    fn run_update(&mut self, action: &str) {
        let data = self.data.clone();
        let tx = self.tx.clone();
        let repaint = self.repaint.clone();
        let action = action.to_owned();
        std::thread::spawn(move || {
            if let Err(error) = crate::updater::run(&action, &data, tx.clone(), repaint.clone()) {
                let _ = tx.send(Event::Error(format!("Update: {error:#}")));
                let _ = tx.send(Event::Result(
                    String::new(),
                    "update".into(),
                    json!({"status":"error"}),
                ));
                repaint();
            }
        });
    }
    fn git_mutation(&self, action: &str, args: Value) {
        if let Some(i) = self.active_index() {
            self.workspaces[i]
                .session
                .send_tag("git", json!([action, args]), "gitMutation");
        }
    }
    fn open_wsl(&mut self) {
        self.show_wsl = true;
        let tx = self.tx.clone();
        let repaint = self.repaint.clone();
        std::thread::spawn(move || {
            match crate::wsl::distributions() {
                Ok(list) => {
                    let _ = tx.send(Event::Result(
                        String::new(),
                        "wslDistributions".into(),
                        json!(list),
                    ));
                }
                Err(error) => {
                    let _ = tx.send(Event::Error(error.to_string()));
                }
            }
            repaint();
        });
    }
    fn activate_palette(&mut self, item: Value) {
        self.palette = None;
        self.focus_editor = true;
        if let Some(action) = item["action"].as_str() {
            self.execute(action);
        } else if let Some(path) = item["path"].as_str() {
            self.send("open", json!([path, 0, 1]));
        } else if item.get("buffer").is_some() {
            self.send("selectBuffer", json!([item["buffer"]]));
        } else if item.get("symbol").is_some() {
            if let Some(i) = self.active_index() {
                self.send(
                    "lua",
                    json!([
                        "require('nido_symbols').open(...)",
                        [
                            item["symbol"],
                            self.workspaces[i].state["symbols"]["version"]
                        ]
                    ]),
                );
            }
        } else if let Some(id) = item["workspace"].as_str() {
            self.active = id.into();
        } else if item.get("favorite").is_some() {
            let f = &item["favorite"];
            self.add_workspace(
                PathBuf::from(s(&f["root"])),
                f["kind"] == "terminal",
                None,
                None,
            );
        }
    }
}
fn tree_rows(workspace: &Workspace, folder: &str, depth: usize) -> Vec<(Value, usize)> {
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
const COMMANDS: &[(&str, &str, &str, &str)] = &[
    ("n", "New workspace", "Ctrl+Shift+N", "new"),
    ("t", "New terminal workspace", "", "newTerminal"),
    ("", "Connect to WSL", "Linux workspace", "wsl"),
    ("f", "Find file", "Ctrl+P", "files"),
    ("b", "Switch file", "Open buffers", "buffers"),
    ("o", "Go to symbol in file", "Ctrl+Shift+O", "symbols"),
    ("e", "Focus explorer", "j / k / h / l", "explorer"),
    ("s", "Save file", "Ctrl+S", "save"),
    ("", "Save all files", ":wall", "saveAll"),
    ("d", "Close file", "Protect unsaved changes", "closeBuffer"),
    (
        "x",
        "Close workspace",
        "Protect unsaved changes",
        "closeWorkspace",
    ),
    ("g", "Source control", "Ctrl+Shift+G", "git"),
    ("", "Git history", "Commits and branches", "gitHistory"),
    ("m", "Problems", "Ctrl+Shift+M", "problems"),
    ("h", "Time Machine", "Ctrl+Shift+H", "history"),
    ("v", "Markdown preview", "Preview current edits", "markdown"),
    ("", "Search in files", "Ctrl+Shift+F", "search"),
    ("D", "Open debug panel", "Run and debug", "debug"),
    ("", "Extensions", "Ctrl+Shift+X", "extensions"),
    ("", "Toggle terminal", "Ctrl+@", "terminal"),
    ("", "Restart shell", "Ctrl+Shift+R", "restartTerminal"),
    ("w", "Switch workspace", "Ctrl+Tab", "workspaces"),
    ("a", "Favorite workspaces", "", "favorites"),
    ("*", "Toggle workspace favorite", "", "favorite"),
    ("l", "Move workspace right", "Reorder tabs", "moveRight"),
    ("H", "Move workspace left", "Reorder tabs", "moveLeft"),
    ("", "Toggle line comments", "Ctrl+/", "key:<C-/>"),
    ("", "Undo", "u", "key:u"),
    ("", "Redo", "Ctrl+R", "key:<C-r>"),
    ("", "Go to definition", "F12 / gd", "key:<Esc>gd"),
    ("", "Find references", "Shift+F12 / gr", "key:<Esc>gr"),
    ("", "Go to implementation", "gI", "key:<Esc>gI"),
    ("", "Go to type definition", "gy", "key:<Esc>gy"),
    ("", "Show documentation", "K", "key:<Esc>K"),
    ("", "Rename symbol", "F2", "key:<F2>"),
    ("", "Code actions", "gra", "key:<Esc>gra"),
    ("", "Format file", "g=", "key:<Esc>g="),
    ("", "Show diagnostic", "gl", "key:<Esc>gl"),
    ("", "Next diagnostic", "]d", "key:<Esc>]d"),
    ("", "Start / continue debugging", "F5", "debug:start"),
    ("", "Toggle breakpoint", "F9", "debug:breakpoint"),
    ("", "Step over", "F10", "debug:over"),
    ("", "Step into", "F11", "debug:into"),
    ("", "Step out", "Shift+F11", "debug:out"),
    ("", "Stop debugging", "Shift+F5", "debug:stop"),
    ("", "Pause debugging", "", "debug:pause"),
    ("", "Run Rust at cursor", "gR", "key:<Esc>gR"),
    ("", "Debug Rust at cursor", "gD", "key:<Esc>gD"),
    ("", "Convert line endings to LF", "Save to apply", "lf"),
    ("", "Convert line endings to CRLF", "Save to apply", "crlf"),
    (",", "Settings", "Editor and appearance", "settings"),
    ("-", "Minimize window", "", "minimize"),
    ("+", "Maximize window", "", "maximize"),
    ("q", "Quit", "", "quit"),
];

#[path = "ui.rs"]
mod ui;
pub use ui::{run, verify_gui};
#[path = "ui_check.rs"]
mod ui_check;
pub use ui_check::run as verify_ui;

#[derive(Clone)]
enum InputEvent {
    Key(Keystroke),
    Text(String),
}

impl Model {
    fn pump(&mut self) {
        self.events();
        if !self.mode_pending {
            let queued = std::mem::take(&mut self.queued_input);
            for event in queued {
                match event {
                    InputEvent::Key(key) => {
                        self.key(&key, true);
                    }
                    InputEvent::Text(text) => self.text(&text),
                }
            }
        }
        if self.settings != self.settings_before {
            if let Err(error) = settings::save(&self.data, &self.settings) {
                self.error(format!("Settings: {error}"));
            }
            for w in &self.workspaces {
                w.session.send("settings", self.settings.clone());
            }
            self.settings_before = self.settings.clone();
        }
        self.notifications
            .retain(|(_, time)| time.elapsed() < Duration::from_secs(30));
        if self.last_persist.elapsed() > Duration::from_secs(5) {
            self.persist();
        }
    }

    fn palette_changed(&mut self) {
        if let Some(p) = &self.palette
            && p.kind == "commands"
            && p.query.chars().count() == 1
            && let Some(command) = COMMANDS.iter().find(|c| c.0 == p.query)
        {
            let action = command.3;
            self.palette = None;
            self.execute(action);
            return;
        }
        self.refresh_palette();
    }

    fn text(&mut self, text: &str) {
        if self.mode_pending {
            self.queued_input.push(InputEvent::Text(text.into()));
        } else if let Some(p) = self.palette.as_mut() {
            p.query.push_str(text);
            self.palette_changed();
        } else if self.closing.is_none() && self.file_request.is_none() && !self.show_wsl {
            if self.explorer_focus {
                self.explorer_key(text);
            } else if [" ", "H", "L"].contains(&text)
                && self.input_index() == self.active_index()
                && self.active_index().is_some_and(|i| {
                    !self.workspaces[i].session.terminal
                        && self.workspaces[i].grid.commands.is_empty()
                })
            {
                self.mode_shortcut(text);
            } else {
                self.input(&text.replace('<', "<LT>"));
            }
        }
    }

    fn key(&mut self, stroke: &Keystroke, editor: bool) -> bool {
        let key = stroke.key.as_str();
        let m = stroke.modifiers;
        let ctrl = m.control && !m.alt && !m.platform;
        if let Some(close) = &self.closing {
            if key == "escape" && close.stage == "prompt" {
                self.close_choice("cancel");
                return true;
            }
            return editor;
        }
        if key == "escape" {
            let modal =
                self.palette.take().is_some() | self.file_request.take().is_some() | self.show_wsl;
            self.show_wsl = false;
            if modal
                || !self.hover.is_empty()
                || !self.diagnostics.is_null()
                || !self.panel.is_empty()
                || self.explorer_focus
            {
                self.hover.clear();
                self.diagnostics = Value::Null;
                self.panel.clear();
                self.explorer_focus = false;
                self.focus_editor = true;
                return true;
            }
        }
        if self.palette.is_some() {
            let items = self.palette_items();
            if key == "down" || (ctrl && key == "j") {
                let p = self.palette.as_mut().unwrap();
                p.index = (p.index + 1).min(items.len().saturating_sub(1));
            } else if key == "up" || (ctrl && key == "k") {
                let p = self.palette.as_mut().unwrap();
                p.index = p.index.saturating_sub(1);
            } else if key == "enter" {
                if let Some(item) = items.get(self.palette.as_ref().unwrap().index) {
                    self.activate_palette(item.clone());
                }
            } else {
                return false;
            }
            return true;
        }
        if self.file_request.is_some() {
            if key == "enter" {
                self.submit_file();
                return true;
            }
            return false;
        }
        if self.show_wsl {
            return false;
        }
        if ctrl && self.preedit.is_empty() {
            let action = match (key, m.shift) {
                ("n", true) => Some("new"),
                ("p", true) => Some("commands"),
                ("f", true) => Some("search"),
                ("g", true) => Some("git"),
                ("m", true) => Some("problems"),
                ("h", true) => Some("history"),
                ("o", true) => Some("symbols"),
                ("x", true) => Some("extensions"),
                ("d", true) => Some("debug"),
                ("s", false)
                    if self.input_index() == self.active_index()
                        && self
                            .active_index()
                            .is_some_and(|i| !self.workspaces[i].session.terminal) =>
                {
                    Some("save")
                }
                ("`" | "@", _) | ("2", true) => Some("terminal"),
                ("h", false) => Some("explorer"),
                ("j", false) => Some("debug"),
                ("k", false)
                    if self.terminal_focused || self.explorer_focus || !self.panel.is_empty() =>
                {
                    Some("focusEditor")
                }
                ("l", false) => Some("focusEditor"),
                ("r", true) => Some("restartTerminal"),
                ("tab", false) => Some("nextWorkspace"),
                ("tab", true) => Some("previousWorkspace"),
                _ => None,
            };
            if let Some(action) = action {
                self.execute(action);
                return true;
            }
            if editor
                && key == "p"
                && self.input_index() == self.active_index()
                && self
                    .active_index()
                    .is_some_and(|i| !self.workspaces[i].session.terminal)
            {
                self.mode_shortcut("<C-p>");
                return true;
            }
        }
        if m.alt
            && !m.control
            && let Ok(digit @ 1..=9) = key.parse::<usize>()
        {
            if let Some(w) = self
                .workspaces
                .iter()
                .filter(|w| w.parent.is_none())
                .nth(digit - 1)
            {
                self.active = w.session.id.clone();
                self.focus_editor = true;
            }
            return true;
        }
        if !editor {
            return false;
        }
        if self.mode_pending {
            if vim_key(stroke).is_some() {
                self.queued_input.push(InputEvent::Key(stroke.clone()));
                return true;
            }
            return false;
        }
        if !self.preedit.is_empty() {
            return false;
        }
        if self.explorer_focus {
            self.explorer_key(match key {
                "down" => "j",
                "up" => "k",
                "left" => "h",
                "right" => "l",
                key => key,
            });
            return matches!(key, "down" | "up" | "left" | "right" | "enter" | "delete");
        }
        let debug = match (key, m.shift) {
            ("f5", false) => Some("start"),
            ("f5", true) => Some("stop"),
            ("f9", _) => Some("breakpoint"),
            ("f10", _) => Some("over"),
            ("f11", false) => Some("into"),
            ("f11", true) => Some("out"),
            _ => None,
        };
        if let Some(action) = debug {
            self.send("debug", json!([action, 0]));
            return true;
        }
        if let Some(key) = vim_key(stroke) {
            self.input(&key);
            return true;
        }
        false
    }
}

fn vim_key(stroke: &Keystroke) -> Option<String> {
    let m = stroke.modifiers;
    if m.control && m.alt {
        return None;
    }
    let special = match stroke.key.as_str() {
        "escape" => Some("Esc"),
        "enter" => Some("CR"),
        "backspace" => Some("BS"),
        "tab" => Some("Tab"),
        "delete" => Some("Del"),
        "insert" => Some("Insert"),
        "up" => Some("Up"),
        "down" => Some("Down"),
        "left" => Some("Left"),
        "right" => Some("Right"),
        "home" => Some("Home"),
        "end" => Some("End"),
        "pageup" => Some("PageUp"),
        "pagedown" => Some("PageDown"),
        "space" if m.control => Some("Space"),
        k if k.starts_with('f') && k[1..].parse::<u8>().is_ok_and(|n| (1..=24).contains(&n)) => {
            Some(k)
        }
        _ => None,
    };
    if special.is_none() && !m.control && !m.alt && !m.platform {
        return None;
    }
    let name = special.unwrap_or(&stroke.key);
    let mut prefix = String::new();
    if m.control {
        prefix.push_str("C-");
    }
    if m.alt {
        prefix.push_str("A-");
    }
    if m.platform {
        prefix.push_str("D-");
    }
    if m.shift {
        prefix.push_str("S-");
    }
    Some(format!("<{prefix}{name}>"))
}

impl Drop for Model {
    fn drop(&mut self) {
        for w in &self.workspaces {
            w.session.send("stop", json!([]));
        }
    }
}

#[cfg(test)]
mod input_tests {
    use super::*;
    #[test]
    fn altgr_is_text_and_vim_control_keys_stay_control_keys() {
        assert_eq!(
            vim_key(&Keystroke::parse("ctrl-v").unwrap()).as_deref(),
            Some("<C-v>")
        );
        assert_eq!(vim_key(&Keystroke::parse("ctrl-alt-q").unwrap()), None);
        assert_eq!(
            vim_key(&Keystroke::parse("shift-enter").unwrap()).as_deref(),
            Some("<S-CR>")
        );
        assert_eq!(vim_key(&Keystroke::parse("a").unwrap()), None);
    }
}
