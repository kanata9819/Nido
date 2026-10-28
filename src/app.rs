use crate::{
    backend::Session,
    files::normal_path,
    grid::{self, Grid, array, n, s},
    persistence::{self, Layout, SavedWorkspace},
    rpc::Event,
    settings,
};
use eframe::egui::{
    self, Align, Align2, Color32, FontId, Id, Key, Layout as UiLayout, Pos2, Rect, RichText, Sense,
    Vec2,
};
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
pub struct Nido {
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
    queued_input: Vec<egui::Event>,
    exit_allowed: bool,
    install_after_close: bool,
    restore_valid: bool,
    translations: Value,
    last_persist: Instant,
    settings_before: Value,
    preedit: String,
    font_input: String,
    shells: Vec<String>,
    acrylic: bool,
    input_modifiers: egui::Modifiers,
}
impl Nido {
    pub fn new(cc: &eframe::CreationContext<'_>) -> Self {
        Self::load(cc, persistence::data_dir())
    }
    fn load(cc: &eframe::CreationContext<'_>, data: PathBuf) -> Self {
        let (tx, rx) = mpsc::channel();
        let ctx = cc.egui_ctx.clone();
        let repaint: Arc<dyn Fn() + Send + Sync> = Arc::new(move || ctx.request_repaint());
        let loaded = settings::load(&data);
        let mut notifications = vec![];
        let settings = match loaded {
            Ok(v) => v,
            Err(e) => {
                notifications.push((format!("Settings: {e:#}"), Instant::now()));
                settings::defaults()
            }
        };
        configure_style(&cc.egui_ctx, &settings);
        let acrylic = crate::platform::backdrop(cc, settings["theme"] == "acrylic");
        load_fonts(&cc.egui_ctx, &settings);
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
            font_input: s(&settings["fontFamily"]).to_owned(),
            shells: crate::backend::available_shells(),
            acrylic,
            input_modifiers: egui::Modifiers::NONE,
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
    fn events(&mut self, ctx: &egui::Context) {
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
                Event::Result(id, tag, value) => self.result(ctx, &id, &tag, value),
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
                    if !self.persist(ctx) {
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
                        ctx.send_viewport_cmd(egui::ViewportCommand::Close);
                    } else {
                        if !self.workspaces.iter().any(|w| w.session.id == self.active) {
                            self.active = self
                                .workspaces
                                .iter()
                                .find(|w| w.parent.is_none())
                                .map(|w| w.session.id.clone())
                                .unwrap_or_default();
                        }
                        self.persist(ctx);
                        self.focus_editor = true;
                    }
                }
                _ => {}
            }
        }
    }
    fn result(&mut self, ctx: &egui::Context, id: &str, tag: &str, value: Value) {
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
        let _ = ctx;
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
    fn persist(&mut self, ctx: &egui::Context) -> bool {
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
        let viewport = ctx.input(|i| i.viewport().clone());
        let size = viewport
            .inner_rect
            .map(|r| r.size())
            .unwrap_or(Vec2::new(1440.0, 940.0));
        let layout = Layout {
            version: 1,
            workspaces,
            active,
            window: json!({"width":size.x.round(),"height":size.y.round(),"maximized":viewport.maximized.unwrap_or(false)}),
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

fn configure_style(ctx: &egui::Context, settings: &Value) {
    let mut visuals = egui::Visuals::dark();
    visuals.panel_fill = Color32::from_rgb(25, 30, 35);
    visuals.window_fill = Color32::from_rgb(30, 36, 42);
    visuals.extreme_bg_color = Color32::from_rgb(20, 25, 30);
    visuals.selection.bg_fill = Color32::from_rgb(62, 80, 94);
    visuals.override_text_color = Some(Color32::from_rgb(214, 220, 226));
    ctx.set_visuals(visuals);
    ctx.style_mut_of(egui::Theme::Dark, |style| {
        style.spacing.item_spacing = Vec2::new(8.0, 5.0);
        style.spacing.button_padding = Vec2::new(8.0, 5.0);
        style.animation_time = if settings["animations"] == false {
            0.0
        } else {
            0.15
        };
    });
}
fn load_fonts(ctx: &egui::Context, settings: &Value) {
    let mut fonts = egui::FontDefinitions::default();
    let family = s(&settings["fontFamily"]);
    static DATABASE: std::sync::OnceLock<fontdb::Database> = std::sync::OnceLock::new();
    let database = DATABASE.get_or_init(|| {
        let mut db = fontdb::Database::new();
        db.load_system_fonts();
        db
    });
    let names: Vec<_> = family
        .split(',')
        .map(|s| fontdb::Family::Name(s.trim().trim_matches(['\'', '"'])))
        .chain([
            fontdb::Family::Name("Cascadia Code"),
            fontdb::Family::Name("Consolas"),
            fontdb::Family::Monospace,
        ])
        .collect();
    let weight = settings["fontWeight"].as_f64().unwrap_or(350.0) as u16;
    for (name, bold, italic) in [
        ("editor", false, false),
        ("editor-bold", true, false),
        ("editor-italic", false, true),
        ("editor-bold-italic", true, true),
    ] {
        let weight = if bold {
            weight.saturating_add(250).min(900)
        } else {
            weight
        };
        let font = if Path::new(family).is_file() {
            fs::read(family).ok().map(egui::FontData::from_owned)
        } else {
            database
                .query(&fontdb::Query {
                    families: &names,
                    weight: fontdb::Weight(weight),
                    style: if italic {
                        fontdb::Style::Italic
                    } else {
                        fontdb::Style::Normal
                    },
                    ..Default::default()
                })
                .and_then(|id| {
                    database.with_face_data(id, |data, index| {
                        let mut font = egui::FontData::from_owned(data.to_vec());
                        font.index = index;
                        font
                    })
                })
        };
        if let Some(mut font) = font {
            font.tweak.coords.push(b"wght", weight as f32);
            fonts.font_data.insert(name.into(), Arc::new(font));
        }
    }
    if fonts.font_data.contains_key("editor") {
        fonts
            .families
            .entry(egui::FontFamily::Monospace)
            .or_default()
            .insert(0, "editor".into());
    }
    for (name, path) in [
        ("japanese", r"C:\Windows\Fonts\YuGothM.ttc"),
        ("japanese-ui", r"C:\Windows\Fonts\YuGothR.ttc"),
        ("emoji", r"C:\Windows\Fonts\seguiemj.ttf"),
        ("symbols", r"C:\Windows\Fonts\seguisym.ttf"),
    ] {
        if let Ok(bytes) = fs::read(path) {
            fonts
                .font_data
                .insert(name.into(), egui::FontData::from_owned(bytes).into());
            for family in [egui::FontFamily::Monospace, egui::FontFamily::Proportional] {
                fonts.families.entry(family).or_default().push(name.into());
            }
        }
    }
    let fallback = fonts.families[&egui::FontFamily::Monospace].clone();
    for name in ["editor-bold", "editor-italic", "editor-bold-italic"] {
        let mut names = fallback.clone();
        if fonts.font_data.contains_key(name) {
            names.insert(0, name.into());
        }
        fonts
            .families
            .insert(egui::FontFamily::Name(name.into()), names);
    }
    ctx.set_fonts(fonts);
}

impl eframe::App for Nido {
    fn logic(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.events(ctx);
    }
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let ctx = ui.ctx().clone();
        if ctx.input(|i| i.viewport().close_requested()) && !self.exit_allowed {
            ctx.send_viewport_cmd(egui::ViewportCommand::CancelClose);
            self.request_close(true);
        }
        self.keyboard(&ctx);
        if self.closing.is_some() {
            ui.disable();
        }
        if self.exit_allowed {
            ctx.send_viewport_cmd(egui::ViewportCommand::Close);
        }
        egui::Panel::top("workspaces")
            .resizable(false)
            .show(ui, |ui| self.workspace_tabs(ui));
        egui::Panel::bottom("status")
            .resizable(false)
            .show(ui, |ui| self.status_bar(ui));
        if self.settings["activityBarPosition"] == "top" {
            egui::Panel::top("navigation-top")
                .resizable(false)
                .show(ui, |ui| {
                    ui.horizontal(|ui| self.navigation(ui));
                });
        } else {
            egui::Panel::left("navigation-left")
                .exact_size(47.0)
                .resizable(false)
                .show(ui, |ui| {
                    self.navigation(ui);
                });
        }
        if self.settings["sidebar"] != false && self.active_index().is_some() {
            let width = self.settings["sidebarWidth"].as_f64().unwrap_or(243.0) as f32;
            let result = egui::Panel::left("explorer")
                .default_size(width)
                .size_range(160.0..=480.0)
                .show(ui, |ui| self.explorer(ui));
            self.settings["sidebarWidth"] = json!(result.response.rect.width());
        }
        if self.terminal_visible
            && let Some(index) = self
                .workspaces
                .iter()
                .position(|w| w.parent.as_deref() == Some(&self.active))
        {
            egui::Panel::bottom("terminal")
                .default_size(260.0)
                .size_range(100.0..=700.0)
                .show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.strong(self.workspaces[index].name());
                        if ui.button(self.tr("Restart shell")).clicked() {
                            self.workspaces[index]
                                .session
                                .send("restartTerminal", json!([]));
                        }
                        if ui.button("×").clicked() {
                            self.terminal_visible = false;
                            self.focus_editor = true;
                        }
                    });
                    self.editor(ui, index, true);
                });
        }
        if !self.panel.is_empty() {
            egui::Panel::right("content-panel")
                .default_size(540.0)
                .size_range(320.0..=1000.0)
                .show(ui, |ui| self.side_panel(ui));
        }
        egui::CentralPanel::default()
            .frame(egui::Frame::NONE)
            .show(ui, |ui| {
                if let Some(index) = self.active_index() {
                    self.buffer_tabs(ui, index);
                    self.editor(ui, index, false);
                } else {
                    self.welcome(ui);
                }
            });
        self.palette_ui(&ctx);
        self.file_request_ui(&ctx);
        self.close_ui(&ctx);
        self.wsl_ui(&ctx);
        self.information_ui(&ctx);
        self.notification_ui(&ctx);
        if self.settings != self.settings_before {
            if self.settings["theme"] != self.settings_before["theme"] {
                self.acrylic =
                    crate::platform::backdrop(_frame, self.settings["theme"] == "acrylic");
            }
            let changed_font = self.settings["fontFamily"] != self.settings_before["fontFamily"]
                || self.settings["fontWeight"] != self.settings_before["fontWeight"];
            if let Err(error) = settings::save(&self.data, &self.settings) {
                self.error(format!("Settings: {error}"));
            }
            if changed_font {
                load_fonts(&ctx, &self.settings);
            }
            configure_style(&ctx, &self.settings);
            for w in &self.workspaces {
                w.session.send("settings", self.settings.clone());
            }
            self.settings_before = self.settings.clone();
        }
        if self.last_persist.elapsed() > Duration::from_secs(5) {
            self.persist(&ctx);
        }
        ctx.request_repaint_after(Duration::from_secs(1));
    }
    fn on_exit(&mut self, _gl: Option<&eframe::glow::Context>) {
        for workspace in &self.workspaces {
            workspace.session.send("stop", json!([]));
        }
    }
    fn clear_color(&self, _: &egui::Visuals) -> [f32; 4] {
        if self.acrylic {
            [0.0; 4]
        } else {
            [0.07, 0.07, 0.07, 1.0]
        }
    }
}

impl Nido {
    fn workspace_tabs(&mut self, ui: &mut egui::Ui) {
        ui.horizontal(|ui| {
            ui.label(
                RichText::new("Nido")
                    .strong()
                    .color(Color32::from_rgb(154, 192, 176)),
            );
            ui.separator();
            let tabs: Vec<_> = self
                .workspaces
                .iter()
                .filter(|w| w.parent.is_none())
                .map(|w| (w.session.id.clone(), w.name(), w.ready))
                .collect();
            if self.settings["compactMode"] != true || tabs.len() > 1 {
                for (id, name, ready) in tabs {
                    let title = if ready { name } else { format!("◌ {name}") };
                    if ui.selectable_label(self.active == id, title).clicked() {
                        self.active = id;
                        self.terminal_focused = false;
                        self.focus_editor = true;
                        self.explorer_focus = false;
                        self.panel.clear();
                    }
                }
            }
            if ui
                .button("＋")
                .on_hover_text(self.tr("New workspace"))
                .clicked()
            {
                self.open_folder(false);
            }
            if ui
                .button("⌘")
                .on_hover_text(self.tr("Command palette"))
                .clicked()
            {
                self.open_palette("commands");
            }
            if !self.active.is_empty()
                && ui
                    .button("×")
                    .on_hover_text(self.tr("Close workspace"))
                    .clicked()
            {
                self.request_close(false);
            }
        });
    }
    fn navigation(&mut self, ui: &mut egui::Ui) {
        for (icon, label, action) in [
            ("▤", "Explorer", "explorer"),
            ("⌕", "Search in files", "search"),
            ("⑂", "Source control", "git"),
            ("▷", "Debugger", "debug"),
            ("◫", "Extensions", "extensions"),
            ("◷", "Time Machine", "history"),
            ("⚙", "Settings", "settings"),
        ] {
            let response = ui.add_sized(
                [31.0, 32.0],
                egui::Button::new(RichText::new(icon).size(20.0)).selected(self.panel == action),
            );
            if response.on_hover_text(self.tr(label)).clicked() {
                if action == "explorer" {
                    self.settings["sidebar"] = json!(true);
                    self.explorer_focus = true;
                    self.panel.clear();
                } else {
                    self.show_panel(action);
                }
            }
        }
    }
    fn status_bar(&mut self, ui: &mut egui::Ui) {
        let state = self
            .active_index()
            .map(|i| self.workspaces[i].state.clone())
            .unwrap_or_default();
        ui.horizontal(|ui| {
            let mode = s(&state["mode"]);
            let label = match mode.chars().next() {
                Some('i') => "INSERT",
                Some('v' | 'V' | '\u{16}') => "VISUAL",
                Some('c') => "COMMAND",
                Some('t') => "TERMINAL",
                _ => "NORMAL",
            };
            ui.label(
                RichText::new(label)
                    .strong()
                    .color(Color32::from_rgb(165, 198, 180)),
            );
            if ui
                .small_button(format!("⑂ {}", s(&self.git["branch"])))
                .clicked()
            {
                self.show_panel("git");
            }
            ui.label(s(&state["lsp"]));
            ui.label(s(&state["lspProgress"]));
            ui.with_layout(UiLayout::right_to_left(Align::Center), |ui| {
                if ui.small_button(s(&state["lineEnding"])).clicked() {
                    self.open_palette("commands");
                }
                ui.label(s(&state["filetype"]));
                ui.label(format!(
                    "{}:{}",
                    state["line"].as_u64().unwrap_or(1),
                    state["column"].as_u64().unwrap_or(1)
                ));
                if ui.small_button("! Problems").clicked() {
                    self.show_panel("problems");
                }
                if ui.small_button("Terminal").clicked() {
                    self.toggle_terminal();
                }
            });
        });
    }
    fn buffer_tabs(&mut self, ui: &mut egui::Ui, index: usize) {
        let current = self.workspaces[index].state["current"].clone();
        let buffers = self.workspaces[index].buffers().to_vec();
        egui::ScrollArea::horizontal()
            .id_salt("buffer-tabs")
            .show(ui, |ui| {
                ui.horizontal(|ui| {
                    for buffer in buffers {
                        let path = Path::new(s(&buffer["name"]));
                        let name = path
                            .file_name()
                            .unwrap_or(path.as_os_str())
                            .to_string_lossy();
                        let label = format!(
                            "{}{}",
                            if name.is_empty() { "[No Name]" } else { &name },
                            if buffer["modified"] == true {
                                " ●"
                            } else {
                                ""
                            }
                        );
                        let selected = buffer["id"] == current;
                        let response = ui
                            .selectable_label(selected, label)
                            .on_hover_text(path.to_string_lossy());
                        if response.clicked() {
                            self.workspaces[index]
                                .session
                                .send("selectBuffer", json!([buffer["id"]]));
                            self.focus_editor = true;
                            self.explorer_focus = false;
                        }
                        response.context_menu(|ui| {
                            if ui.button(self.tr("Close file")).clicked() {
                                self.workspaces[index]
                                    .session
                                    .send("closeBuffer", json!([buffer["id"], false]));
                                ui.close();
                            }
                        });
                    }
                });
            });
    }
    fn editor(&mut self, ui: &mut egui::Ui, index: usize, terminal: bool) {
        let id = Id::new(("editor", self.workspaces[index].session.id.clone()));
        let rect = ui.available_rect_before_wrap();
        let response = ui.interact(rect, id, Sense::click_and_drag());
        ui.allocate_rect(rect, Sense::hover());
        if response.clicked() {
            self.explorer_focus = false;
            self.terminal_focused = terminal;
            ui.memory_mut(|m| m.request_focus(id));
        }
        if self.focus_editor
            && self.palette.is_none()
            && self.file_request.is_none()
            && !self.explorer_focus
            && Some(index) == self.input_index()
        {
            ui.memory_mut(|m| m.request_focus(id));
            self.focus_editor = false;
        }
        let focused = ui.memory(|m| m.has_focus(id));
        let size = self.settings["fontSize"].as_f64().unwrap_or(14.0) as f32;
        let line_height = self.settings["lineHeight"].as_f64().unwrap_or(1.5) as f32;
        let cell = Grid::metrics(ui, size, line_height);
        let cols = (rect.width() / cell.x).floor().max(2.0) as usize;
        let rows = (rect.height() / cell.y).floor().max(2.0) as usize;
        let w = &mut self.workspaces[index];
        if w.ready && (cols, rows) != w.size {
            w.size = (cols, rows);
            w.session.send("resize", json!([cols, rows]));
        }
        w.grid.scroll_cursor = grid::screen_cursor(&w.state["scrollCursor"]);
        let cursor = w
            .grid
            .paint(ui, rect, cell, focused, &self.settings, self.acrylic);
        response.widget_info(|| {
            egui::WidgetInfo::labeled(egui::WidgetType::TextEdit, true, w.grid.description())
        });
        if focused && self.palette.is_none() && self.file_request.is_none() {
            ui.ctx().output_mut(|o| {
                o.ime = Some(egui::output::IMEOutput {
                    purpose: egui::IMEPurpose::Normal,
                    rect,
                    cursor_rect: cursor,
                    should_interrupt_composition: false,
                })
            });
            if !self.preedit.is_empty() {
                ui.painter().rect_filled(
                    Rect::from_min_size(
                        cursor.left_top(),
                        Vec2::new(self.preedit.chars().count() as f32 * cell.x, cell.y),
                    ),
                    0.0,
                    Color32::from_rgb(40, 47, 55),
                );
                ui.painter().text(
                    cursor.left_top(),
                    Align2::LEFT_TOP,
                    &self.preedit,
                    FontId::monospace(size),
                    Color32::WHITE,
                );
            }
        }
        if response.hovered() {
            for event in ui.input(|i| i.events.clone()) {
                if let egui::Event::MouseWheel { unit, delta, .. } = event {
                    let scale = match unit {
                        egui::MouseWheelUnit::Point => 1.0,
                        egui::MouseWheelUnit::Line => cell.y * 3.0,
                        egui::MouseWheelUnit::Page => rect.height(),
                    };
                    w.session.send(
                        "scroll",
                        json!([-delta.y * scale / cell.y, -delta.x * scale / cell.x]),
                    );
                }
            }
            if let Some(pos) = response.interact_pointer_pos() {
                let row = ((pos.y - rect.top()) / cell.y).floor().max(0.0) as usize;
                let col = ((pos.x - rect.left()) / cell.x).floor().max(0.0) as usize;
                if response.clicked() {
                    let sticky_rows: Vec<_> = array(&w.grid.sticky["scopes"])
                        .iter()
                        .filter(|s| s["top"].as_i64().unwrap_or(0) < 0)
                        .take(
                            self.settings["stickyScrollMaxLines"]
                                .as_f64()
                                .unwrap_or(5.0) as usize,
                        )
                        .collect();
                    if let Some(scope) = sticky_rows.get(row) {
                        w.session.send(
                            "lua",
                            json!([
                                "return require('nido_sticky').jump(...)",
                                [
                                    w.grid.sticky["window"],
                                    w.grid.sticky["buffer"],
                                    scope["line"]
                                ]
                            ]),
                        );
                    } else {
                        w.session
                            .send("mouse", json!(["left", "press", "", 1, row, col]));
                        w.session
                            .send("mouse", json!(["left", "release", "", 1, row, col]));
                    }
                }
                if response.dragged() {
                    w.session
                        .send("mouse", json!(["left", "drag", "", 1, row, col]));
                }
            }
        }
        let commands = w.grid.commands.clone();
        let messages = w.grid.messages.clone();
        let completion = w.grid.completion.clone();
        if !w.ready {
            ui.painter().text(
                rect.center(),
                Align2::CENTER_CENTER,
                if w.closed {
                    "Neovim stopped. Close and reopen this workspace."
                } else {
                    "Connecting to Neovim…"
                },
                FontId::proportional(16.0),
                Color32::GRAY,
            );
        }
        if let Some((_, command)) = commands.last_key_value() {
            let text = format!(
                "{}{}{}",
                s(&command[2]),
                s(&command[3]),
                grid::chunks(&command[0])
            );
            let pos = rect.left_bottom() - Vec2::new(-12.0, cell.y + 12.0);
            ui.painter().rect_filled(
                Rect::from_min_size(pos, Vec2::new((rect.width() - 24.0).max(1.0), cell.y + 6.0)),
                4.0,
                Color32::from_rgb(36, 44, 53),
            );
            ui.painter().text(
                pos + Vec2::new(5.0, 2.0),
                Align2::LEFT_TOP,
                text,
                FontId::monospace(size),
                Color32::WHITE,
            );
        } else if let Some(message) = messages.last() {
            ui.painter().text(
                rect.left_bottom() - Vec2::new(-8.0, cell.y + 4.0),
                Align2::LEFT_TOP,
                message,
                FontId::monospace(size),
                Color32::from_rgb(204, 183, 154),
            );
        }
        if completion.is_object() {
            let pos = Pos2::new(
                (rect.left() + n(&completion["column"]) as f32 * cell.x)
                    .min(rect.right() - 250.0)
                    .max(rect.left()),
                (rect.top() + (n(&completion["row"]) + 1) as f32 * cell.y)
                    .min(rect.bottom() - 160.0)
                    .max(rect.top()),
            );
            let session = self.workspaces[index].session.clone();
            egui::Area::new(Id::new(("completion", index)))
                .order(egui::Order::Foreground)
                .fixed_pos(pos)
                .show(ui.ctx(), |ui| {
                    egui::Frame::popup(ui.style()).show(ui, |ui| {
                        ui.set_width(300.0);
                        egui::ScrollArea::vertical()
                            .max_height(180.0)
                            .show(ui, |ui| {
                                for (i, item) in array(&completion["items"]).iter().enumerate() {
                                    let label =
                                        format!("{} {}  {}", s(&item[1]), s(&item[0]), s(&item[2]));
                                    if ui
                                        .selectable_label(
                                            completion["selected"].as_i64() == Some(i as i64),
                                            label,
                                        )
                                        .clicked()
                                    {
                                        session.send(
                                            "rpc",
                                            json!([
                                                "nvim_select_popupmenu_item",
                                                [i, true, true, {}]
                                            ]),
                                        );
                                    }
                                }
                            });
                    });
                });
        }
    }
    fn welcome(&mut self, ui: &mut egui::Ui) {
        ui.with_layout(UiLayout::top_down(Align::Center), |ui| {
            ui.add_space((ui.available_height() * 0.23).max(30.0));
            ui.heading(RichText::new("Nido").size(38.0));
            ui.label(self.tr("Open a local or WSL workspace"));
            ui.add_space(20.0);
            if ui.button(self.tr("New workspace")).clicked() {
                self.open_folder(false);
            }
            if ui.button(self.tr("New terminal workspace")).clicked() {
                self.open_folder(true);
            }
            if ui.button(self.tr("Connect to WSL")).clicked() {
                self.open_wsl();
            }
            ui.add_space(20.0);
            let favorites = array(&self.favorites).to_vec();
            for favorite in favorites {
                if ui
                    .button(s(&favorite["name"]))
                    .on_hover_text(s(&favorite["root"]))
                    .clicked()
                {
                    self.add_workspace(
                        PathBuf::from(s(&favorite["root"])),
                        favorite["kind"] == "terminal",
                        None,
                        None,
                    );
                }
            }
            ui.add_space(18.0);
            ui.label("Ctrl+Shift+N  Open workspace     Ctrl+Shift+P  Commands");
        });
    }
}

impl Nido {
    fn keyboard(&mut self, ctx: &egui::Context) {
        if !ctx.input(|i| i.focused) {
            self.preedit.clear();
            return;
        }
        if self.closing.is_some() {
            if ctx.input(|i| i.key_pressed(Key::Escape))
                && self.closing.as_ref().is_some_and(|c| c.stage == "prompt")
            {
                self.closing = None;
                self.install_after_close = false;
                self.focus_editor = true;
            }
            return;
        }
        let mut events = if self.mode_pending {
            vec![]
        } else {
            std::mem::take(&mut self.queued_input)
        };
        events.extend(ctx.input(|i| i.events.clone()));
        if !self.mode_pending {
            // Replayed keys must also reach a palette opened by the asynchronous mode check.
            ctx.input_mut(|i| i.events = events.clone());
        }
        let mut committed = None;
        for event in events {
            if self.mode_pending {
                self.queued_input.push(event);
                continue;
            }
            if let egui::Event::ModifiersChanged(modifiers) = event {
                self.input_modifiers = modifiers;
                continue;
            }
            if let egui::Event::Key {
                key,
                pressed: true,
                modifiers,
                ..
            } = &event
            {
                let ctrl = modifiers.ctrl && !modifiers.alt && !modifiers.mac_cmd;
                if key == &Key::Escape {
                    if self.palette.take().is_some() {
                        self.focus_editor = true;
                        continue;
                    }
                    if self.file_request.take().is_some() {
                        self.focus_editor = true;
                        continue;
                    }
                    if self.show_wsl {
                        self.show_wsl = false;
                        continue;
                    }
                    if !self.hover.is_empty() || !self.diagnostics.is_null() {
                        self.hover.clear();
                        self.diagnostics = Value::Null;
                        continue;
                    }
                    if !self.panel.is_empty() {
                        self.panel.clear();
                        self.focus_editor = true;
                        continue;
                    }
                    if self.explorer_focus {
                        self.explorer_focus = false;
                        self.focus_editor = true;
                        continue;
                    }
                }
                if self.palette.is_some() || self.file_request.is_some() || self.show_wsl {
                    continue;
                }
                if ctrl && self.preedit.is_empty() {
                    let action = match (*key, modifiers.shift) {
                        (Key::N, true) => Some("new"),
                        (Key::P, true) => Some("commands"),
                        (Key::F, true) => Some("search"),
                        (Key::G, true) => Some("git"),
                        (Key::M, true) => Some("problems"),
                        (Key::H, true) => Some("history"),
                        (Key::O, true) => Some("symbols"),
                        (Key::X, true) => Some("extensions"),
                        (Key::D, true) => Some("debug"),
                        (Key::S, false)
                            if self.input_index() == self.active_index()
                                && self
                                    .active_index()
                                    .is_some_and(|i| !self.workspaces[i].session.terminal) =>
                        {
                            Some("save")
                        }
                        (Key::Backtick, _) => Some("terminal"),
                        (Key::Num2, true) => Some("terminal"),
                        (Key::H, false) => Some("explorer"),
                        (Key::J, false) => Some("debug"),
                        (Key::K, false)
                            if self.terminal_focused
                                || self.explorer_focus
                                || !self.panel.is_empty() =>
                        {
                            Some("focusEditor")
                        }
                        (Key::L, false) => Some("focusEditor"),
                        (Key::R, true) => Some("restartTerminal"),
                        (Key::Tab, false) => Some("nextWorkspace"),
                        (Key::Tab, true) => Some("previousWorkspace"),
                        _ => None,
                    };
                    if let Some(action) = action {
                        self.execute(action, ctx);
                        continue;
                    }
                    if *key == Key::P
                        && self.palette.is_none()
                        && self.file_request.is_none()
                        && self.input_index() == self.active_index()
                        && self
                            .active_index()
                            .is_some_and(|i| !self.workspaces[i].session.terminal)
                    {
                        self.mode_shortcut("<C-p>");
                        continue;
                    }
                }
                if modifiers.alt
                    && !modifiers.ctrl
                    && let Some(digit) = key
                        .name()
                        .parse::<usize>()
                        .ok()
                        .filter(|n| (1..=9).contains(n))
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
                    continue;
                }
                if self.palette.is_none() && self.file_request.is_none() && self.closing.is_none() {
                    let debug = match (*key, modifiers.shift) {
                        (Key::F5, false) => Some("start"),
                        (Key::F5, true) => Some("stop"),
                        (Key::F9, false) => Some("breakpoint"),
                        (Key::F10, false) => Some("over"),
                        (Key::F11, false) => Some("into"),
                        (Key::F11, true) => Some("out"),
                        _ => None,
                    };
                    if let Some(action) = debug {
                        self.send("debug", json!([action, 0]));
                        continue;
                    }
                }
            }
            if self.palette.is_some()
                || self.file_request.is_some()
                || self.show_wsl
                || self.closing.is_some()
            {
                continue;
            }
            if self.explorer_focus {
                self.explorer_key(&event);
                continue;
            }
            let focused = ctx.memory(|m| m.focused());
            let editor = self
                .input_index()
                .map(|i| Id::new(("editor", self.workspaces[i].session.id.clone())));
            if focused.is_some() && focused != editor {
                continue;
            }
            match event {
                egui::Event::Ime(egui::ImeEvent::Preedit { text, .. }) => self.preedit = text,
                egui::Event::Ime(egui::ImeEvent::Commit(text)) => {
                    self.preedit.clear();
                    self.input(&text.replace('<', "<LT>"));
                    committed = Some(text);
                }
                egui::Event::Ime(egui::ImeEvent::DeleteSurrounding {
                    before_chars,
                    after_chars,
                }) => {
                    self.input(&format!(
                        "{}{}",
                        "<BS>".repeat(before_chars.min(10_000)),
                        "<Del>".repeat(after_chars.min(10_000))
                    ));
                }
                egui::Event::Text(text) if self.preedit.is_empty() => {
                    if committed.as_ref() == Some(&text) {
                        committed = None;
                        continue;
                    }
                    if [" ", "H", "L"].contains(&text.as_str())
                        && self.input_index() == self.active_index()
                        && self.active_index().is_some_and(|i| {
                            !self.workspaces[i].session.terminal
                                && self.workspaces[i].grid.commands.is_empty()
                        })
                    {
                        self.mode_shortcut(&text);
                    } else {
                        self.input(&text.replace('<', "<LT>"));
                    }
                }
                egui::Event::Key {
                    key,
                    pressed: true,
                    modifiers,
                    ..
                } if self.preedit.is_empty() => {
                    if let Some(key) = vim_key(key, modifiers) {
                        self.input(&key);
                    }
                }
                egui::Event::Copy => self.input("<C-c>"),
                egui::Event::Cut => self.input("<C-x>"),
                egui::Event::Paste(text) => {
                    if self.input_modifiers.shift {
                        if let Some(i) = self.input_index() {
                            self.workspaces[i].session.send("paste", json!([text]));
                        }
                    } else {
                        self.input("<C-v>");
                    }
                }
                _ => {}
            }
        }
    }
    fn mode_shortcut(&mut self, key: &str) {
        if let Some(i) = self.active_index() {
            self.mode_pending = true;
            self.workspaces[i]
                .session
                .send("modeShortcut", json!([key]));
        }
    }
    fn execute(&mut self, action: &str, ctx: &egui::Context) {
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
            "minimize" => ctx.send_viewport_cmd(egui::ViewportCommand::Minimized(true)),
            "maximize" => ctx.send_viewport_cmd(egui::ViewportCommand::Maximized(
                !ctx.input(|i| i.viewport().maximized.unwrap_or(false)),
            )),
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
    fn palette_ui(&mut self, ctx: &egui::Context) {
        if self.palette.is_none() {
            return;
        }
        let items = self.palette_items();
        let mut activate = None;
        let mut changed = false;
        egui::Modal::new(Id::new("palette")).show(ctx, |ui| {
            ui.set_width(630.0);
            let enter = ui.input(|i| i.key_pressed(Key::Enter));
            let p = self.palette.as_mut().unwrap();
            let query_id = Id::new("palette-query");
            if p.focus {
                ui.memory_mut(|m| m.request_focus(query_id));
                p.focus = false;
            }
            let response = ui.add(
                egui::TextEdit::singleline(&mut p.query)
                    .id(query_id)
                    .hint_text(format!("{}…", p.kind))
                    .desired_width(f32::INFINITY),
            );
            changed = response.changed();
            let down = ui.input_mut(|i| {
                i.consume_key(egui::Modifiers::NONE, Key::ArrowDown)
                    || i.consume_key(egui::Modifiers::CTRL, Key::J)
            });
            let up = ui.input_mut(|i| {
                i.consume_key(egui::Modifiers::NONE, Key::ArrowUp)
                    || i.consume_key(egui::Modifiers::CTRL, Key::K)
            });
            if down {
                p.index = (p.index + 1).min(items.len().saturating_sub(1));
            }
            if up {
                p.index = p.index.saturating_sub(1);
            }
            if enter {
                activate = items.get(p.index).cloned();
            }
            egui::ScrollArea::vertical()
                .max_height(440.0)
                .show(ui, |ui| {
                    for (index, item) in items.iter().enumerate() {
                        let label = format!("{}  {}", s(&item["key"]), s(&item["title"]));
                        let response = ui
                            .selectable_label(index == p.index, label)
                            .on_hover_text(s(&item["detail"]));
                        if index == p.index && (down || up) {
                            response.scroll_to_me(Some(Align::Center));
                        }
                        if response.clicked() {
                            activate = Some(item.clone());
                        }
                    }
                });
            if items.is_empty() {
                ui.label("No results");
            }
        });
        if changed {
            if self.palette.as_ref().is_some_and(|p| p.kind == "commands") {
                let query = &self.palette.as_ref().unwrap().query;
                if query.chars().count() == 1
                    && let Some(command) = COMMANDS.iter().find(|c| c.0 == query.as_str())
                {
                    let action = command.3;
                    self.palette = None;
                    self.execute(action, ctx);
                    return;
                }
            }
            self.refresh_palette();
        }
        if let Some(item) = activate {
            self.palette = None;
            self.focus_editor = true;
            if let Some(action) = item["action"].as_str() {
                self.execute(action, ctx);
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
    fn explorer(&mut self, ui: &mut egui::Ui) {
        let Some(i) = self.active_index() else { return };
        let current = self.workspaces[i].current();
        if current != self.workspaces[i].last_file {
            self.workspaces[i].last_file = current.clone();
            let root = &self.workspaces[i].session.root;
            let path = if let Some(remote) = crate::wsl::Remote::parse(root) {
                remote.host(&current)
            } else {
                PathBuf::from(&current)
            };
            if let Ok(relative) = path.strip_prefix(root) {
                self.workspaces[i].reveal_file =
                    Some(relative.to_string_lossy().replace('\\', "/"));
                let mut folders = vec![];
                let mut parent = relative.parent();
                while let Some(folder) = parent {
                    let name = folder.to_string_lossy().replace('\\', "/");
                    if !name.is_empty() {
                        folders.push(name);
                    }
                    parent = folder.parent();
                }
                for folder in folders {
                    self.expand_folder(i, &folder);
                }
            }
        }
        ui.horizontal(|ui| {
            ui.strong(self.tr("Explorer"));
            if ui.small_button("＋").on_hover_text("New file").clicked() {
                self.file_request = Some(FileRequest {
                    workspace: self.active.clone(),
                    action: "createFile".into(),
                    source: String::new(),
                    target: String::new(),
                    focus: true,
                });
            }
            if ui.small_button("↻").clicked() {
                self.workspaces[i]
                    .session
                    .send_tag("files", json!([""]), "files:");
            }
        });
        ui.label(
            RichText::new(self.workspaces[i].name())
                .small()
                .color(Color32::GRAY),
        );
        ui.separator();
        let rows = tree_rows(&self.workspaces[i], "", 0);
        if let Some(path) = &self.workspaces[i].reveal_file
            && let Some(index) = rows.iter().position(|(entry, _)| entry["path"] == *path)
        {
            self.workspaces[i].selected = index;
            self.workspaces[i].reveal_selected = true;
            self.workspaces[i].reveal_file = None;
        }
        let mut action = None;
        egui::ScrollArea::both()
            .id_salt(("tree", i))
            .show(ui, |ui| {
                for (index, (entry, depth)) in rows.iter().enumerate() {
                    let name = s(&entry["name"]);
                    let path = s(&entry["path"]);
                    let folder = entry["directory"] == true;
                    let expanded = self.workspaces[i].expanded.contains(path);
                    let selected = self.workspaces[i].selected == index && self.explorer_focus;
                    let icon = if folder {
                        if expanded { "▾" } else { "▸" }
                    } else {
                        "·"
                    };
                    let label = format!("{}{} {}", "  ".repeat(*depth), icon, name);
                    let response = ui.selectable_label(
                        selected || (!self.explorer_focus && self.workspaces[i].selected == index),
                        label,
                    );
                    if response.clicked() {
                        self.explorer_focus = true;
                        self.workspaces[i].selected = index;
                        action = Some(("open".to_owned(), entry.clone()));
                    }
                    if self.workspaces[i].selected == index && self.workspaces[i].reveal_selected {
                        response.scroll_to_me(Some(Align::Center));
                        self.workspaces[i].reveal_selected = false;
                    }
                    response.context_menu(|ui| {
                        for (label, kind) in [
                            ("New file", "createFile"),
                            ("New folder", "createDirectory"),
                            ("Rename", "rename"),
                            ("Copy", "copy"),
                            ("Delete", "delete"),
                        ] {
                            if ui.button(self.tr(label)).clicked() {
                                self.workspaces[i].selected = index;
                                action = Some((kind.into(), entry.clone()));
                                ui.close();
                            }
                        }
                    });
                }
            });
        if let Some((action, entry)) = action {
            self.tree_action(i, &action, &entry);
        }
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
    fn explorer_key(&mut self, event: &egui::Event) {
        let Some(i) = self.active_index() else { return };
        let rows = tree_rows(&self.workspaces[i], "", 0);
        let Some((entry, _)) = rows.get(self.workspaces[i].selected).cloned() else {
            return;
        };
        let key = match event {
            egui::Event::Text(text) => text.as_str(),
            egui::Event::Key {
                key: Key::ArrowDown,
                pressed: true,
                ..
            } => "j",
            egui::Event::Key {
                key: Key::ArrowUp,
                pressed: true,
                ..
            } => "k",
            egui::Event::Key {
                key: Key::ArrowRight,
                pressed: true,
                ..
            } => "l",
            egui::Event::Key {
                key: Key::ArrowLeft,
                pressed: true,
                ..
            } => "h",
            egui::Event::Key {
                key: Key::Enter,
                pressed: true,
                ..
            } => "enter",
            egui::Event::Key {
                key: Key::Delete,
                pressed: true,
                ..
            } => "delete",
            _ => return,
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
fn vim_key(key: Key, m: egui::Modifiers) -> Option<String> {
    if m.ctrl && m.alt {
        return None;
    }
    let special = match key {
        Key::Escape => Some("Esc"),
        Key::Enter => Some("CR"),
        Key::Backspace => Some("BS"),
        Key::Tab => Some("Tab"),
        Key::Delete => Some("Del"),
        Key::Insert => Some("Insert"),
        Key::ArrowUp => Some("Up"),
        Key::ArrowDown => Some("Down"),
        Key::ArrowLeft => Some("Left"),
        Key::ArrowRight => Some("Right"),
        Key::Home => Some("Home"),
        Key::End => Some("End"),
        Key::PageUp => Some("PageUp"),
        Key::PageDown => Some("PageDown"),
        Key::F1 => Some("F1"),
        Key::F2 => Some("F2"),
        Key::F3 => Some("F3"),
        Key::F4 => Some("F4"),
        Key::F5 => Some("F5"),
        Key::F6 => Some("F6"),
        Key::F7 => Some("F7"),
        Key::F8 => Some("F8"),
        Key::F9 => Some("F9"),
        Key::F10 => Some("F10"),
        Key::F11 => Some("F11"),
        Key::F12 => Some("F12"),
        Key::Space if m.ctrl => Some("Space"),
        _ => None,
    };
    if special.is_none() && !m.ctrl && !m.alt && !m.mac_cmd {
        return None;
    }
    let name = special
        .map(str::to_owned)
        .unwrap_or_else(|| key.name().to_lowercase());
    let mut prefix = String::new();
    if m.ctrl {
        prefix.push_str("C-");
    }
    if m.alt {
        prefix.push_str("A-");
    }
    if m.mac_cmd {
        prefix.push_str("D-");
    }
    if m.shift {
        prefix.push_str("S-");
    }
    Some(format!("<{prefix}{name}>"))
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

impl Nido {
    fn side_panel(&mut self, ui: &mut egui::Ui) {
        ui.horizontal(|ui| {
            ui.heading(self.tr(match self.panel.as_str() {
                "git" => "Source control",
                "gitHistory" => "Git history",
                "settings" => "Settings",
                "extensions" => "Extensions",
                "history" => "Time Machine",
                "search" => "Search in files",
                "debug" => "Debugger",
                "references" => "References",
                "problems" => "Problems",
                "markdown" => "Markdown preview",
                _ => "Nido",
            }));
            if ui.button("×").clicked() {
                self.panel.clear();
                self.focus_editor = true;
            }
        });
        ui.separator();
        match self.panel.as_str() {
            "settings" => self.settings_ui(ui),
            "git" => self.git_ui(ui),
            "gitHistory" => self.git_history_ui(ui),
            "search" => self.search_ui(ui),
            "history" => self.history_ui(ui),
            "debug" => self.debug_ui(ui),
            "extensions" => self.extensions_ui(ui),
            "references" | "problems" => self.locations_ui(ui),
            "markdown" => {
                if ui.button(self.tr("Refresh")).clicked() {
                    self.send("markdown", json!([]));
                }
                egui::ScrollArea::both().show(ui, |ui| render_markdown(ui, &self.markdown));
            }
            _ => {}
        }
    }
    fn settings_ui(&mut self, ui: &mut egui::Ui) {
        egui::ScrollArea::vertical().show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.label(self.tr("Language"));
                let mut language = s(&self.settings["language"]).to_owned();
                egui::ComboBox::from_id_salt("language")
                    .selected_text(&language)
                    .show_ui(ui, |ui| {
                        ui.selectable_value(&mut language, "en".into(), "English");
                        ui.selectable_value(&mut language, "ja".into(), "日本語");
                    });
                self.settings["language"] = json!(language);
            });
            ui.horizontal(|ui| {
                ui.label(self.tr("Theme"));
                let mut theme = s(&self.settings["theme"]).to_owned();
                egui::ComboBox::from_id_salt("theme")
                    .selected_text(&theme)
                    .show_ui(ui, |ui| {
                        ui.selectable_value(&mut theme, "dark".into(), "Dark");
                        ui.selectable_value(&mut theme, "acrylic".into(), "Acrylic");
                    });
                self.settings["theme"] = json!(theme);
            });
            ui.label(self.tr("Font family"));
            if ui.text_edit_singleline(&mut self.font_input).lost_focus() {
                self.settings["fontFamily"] = json!(self.font_input);
            }
            ui.small("Font family name or .ttf/.ttc path");
            for (key, title, min, max) in [
                ("fontSize", "Font size", 8.0, 40.0),
                ("fontWeight", "Font weight", 100.0, 900.0),
                ("lineHeight", "Line height", 1.0, 2.5),
                ("stickyScrollMaxLines", "Sticky Scroll max lines", 1.0, 10.0),
            ] {
                let mut value = self.settings[key].as_f64().unwrap_or(min);
                if ui
                    .add(egui::Slider::new(&mut value, min..=max).text(self.tr(title)))
                    .changed()
                {
                    self.settings[key] = json!(value);
                }
            }
            for (key, title) in [
                ("relativeLineNumbers", "Relative line numbers"),
                ("wordWrap", "Word wrap"),
                ("stickyScroll", "Sticky Scroll"),
                ("methodSeparators", "Method separators"),
                ("editorConfig", "EditorConfig"),
                ("formatOnSave", "Format on save"),
                ("clipboardSharing", "Share OS clipboard"),
                ("historyEnabled", "Time Machine"),
                ("sidebar", "Show sidebar"),
                ("compactMode", "Compact mode"),
                ("animations", "Animations"),
                ("smoothCursor", "Smooth cursor"),
                ("smoothBlink", "Smooth cursor blink"),
                ("scrollFollowCursor", "Scroll follows cursor"),
            ] {
                let mut enabled = self.settings[key] == true;
                if ui.checkbox(&mut enabled, self.tr(title)).changed() {
                    self.settings[key] = json!(enabled);
                }
            }
            let mut position = s(&self.settings["activityBarPosition"]).to_owned();
            egui::ComboBox::from_id_salt("activity-position")
                .selected_text(self.tr(if position == "top" {
                    "Above Explorer"
                } else {
                    "Left edge"
                }))
                .show_ui(ui, |ui| {
                    ui.selectable_value(&mut position, "left".into(), self.tr("Left edge"));
                    ui.selectable_value(&mut position, "top".into(), self.tr("Above Explorer"));
                });
            self.settings["activityBarPosition"] = json!(position);
            let mut shell = s(&self.settings["terminalShell"]).to_owned();
            egui::ComboBox::from_id_salt("terminal-shell")
                .selected_text(&shell)
                .show_ui(ui, |ui| {
                    for choice in &self.shells {
                        ui.selectable_value(&mut shell, choice.clone(), choice);
                    }
                });
            self.settings["terminalShell"] = json!(shell);
            ui.separator();
            ui.label(format!("Nido {} · Rust", env!("CARGO_PKG_VERSION")));
            ui.label(format!("Update: {}", s(&self.update["status"])));
            let action = match s(&self.update["status"]) {
                "available" => "download",
                "downloaded" => "install",
                _ => "check",
            };
            if ui
                .add_enabled(
                    !["checking", "downloading", "installing"].contains(&s(&self.update["status"])),
                    egui::Button::new(self.tr(match action {
                        "download" => "Download update",
                        "install" => "Install update",
                        _ => "Check for updates",
                    })),
                )
                .clicked()
            {
                if action == "install" {
                    self.install_after_close = true;
                    self.request_close(true);
                } else {
                    self.run_update(action);
                }
            }
            if self.update["status"] == "downloading" {
                ui.add(
                    egui::ProgressBar::new(
                        self.update["percent"].as_f64().unwrap_or(0.0) as f32 / 100.0,
                    )
                    .show_percentage(),
                );
            }
        });
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
    fn git_ui(&mut self, ui: &mut egui::Ui) {
        ui.horizontal(|ui| {
            if ui.button(self.tr("Refresh")).clicked() {
                self.send("git", json!(["status", []]));
            }
            if ui.button(self.tr("Stage all")).clicked() {
                self.git_mutation("stageAll", json!([]));
            }
            if ui.button(self.tr("Branches")).clicked()
                && let Some(i) = self.active_index()
            {
                self.workspaces[i]
                    .session
                    .send_tag("git", json!(["branches", []]), "gitBranches");
            }
            if ui.button(self.tr("History")).clicked() {
                self.show_panel("gitHistory");
            }
        });
        ui.label(format!("⑂ {}", s(&self.git["branch"])));
        let branch_list = array(&self.branches).to_vec();
        for branch in branch_list {
            ui.horizontal(|ui| {
                if ui
                    .selectable_label(branch["current"] == true, s(&branch["name"]))
                    .clicked()
                {
                    self.git_mutation("switch", json!([branch["name"], false]));
                    self.branches = Value::Null;
                }
            });
        }
        if !self.branches.is_null() && ui.button(self.tr("New branch")).clicked() {
            self.file_request = Some(FileRequest {
                workspace: self.active.clone(),
                action: "gitBranch".into(),
                source: String::new(),
                target: String::new(),
                focus: true,
            });
        }
        let hint = self.tr("Commit message");
        let response = ui.add(
            egui::TextEdit::multiline(&mut self.commit)
                .desired_rows(2)
                .hint_text(hint),
        );
        if ui.button(self.tr("Commit")).clicked()
            || (response.has_focus() && ui.input(|i| i.modifiers.ctrl && i.key_pressed(Key::Enter)))
        {
            self.git_mutation("commit", json!([self.commit]));
        }
        let changes = array(&self.git["changes"]).to_vec();
        egui::ScrollArea::vertical()
            .max_height(230.0)
            .show(ui, |ui| {
                for change in changes {
                    ui.horizontal(|ui| {
                        let staged = change["staged"] == true;
                        if ui.small_button(if staged { "−" } else { "＋" }).clicked() {
                            self.git_mutation("stage", json!([change["path"], !staged]));
                        }
                        let response = ui.selectable_label(
                            false,
                            format!(
                                "{} {} {}",
                                if staged { "●" } else { "○" },
                                s(&change["status"]),
                                s(&change["path"])
                            ),
                        );
                        if response.clicked()
                            && let Some(i) = self.active_index()
                        {
                            self.workspaces[i].session.send_tag(
                                "git",
                                json!(["diff", [change["path"], staged]]),
                                "gitDiff",
                            );
                        }
                        if response.double_clicked() {
                            self.send("openGit", json!([change["path"]]));
                            self.focus_editor = true;
                        }
                    });
                }
            });
        ui.separator();
        diff_ui(ui, &self.diff);
    }
    fn git_mutation(&self, action: &str, args: Value) {
        if let Some(i) = self.active_index() {
            self.workspaces[i]
                .session
                .send_tag("git", json!([action, args]), "gitMutation");
        }
    }
    fn git_history_ui(&mut self, ui: &mut egui::Ui) {
        if ui.button(self.tr("Refresh")).clicked() {
            self.send("git", json!(["history", [0]]));
        }
        let commits = array(&self.git_history["commits"]).to_vec();
        egui::ScrollArea::vertical()
            .max_height(240.0)
            .show(ui, |ui| {
                for commit in commits {
                    let hash = s(&commit["hash"]);
                    if ui
                        .selectable_label(
                            self.selected_commit == hash,
                            format!("{}  {}", &hash[..hash.len().min(8)], s(&commit["message"])),
                        )
                        .on_hover_text(format!("{}\n{}", s(&commit["author"]), s(&commit["date"])))
                        .clicked()
                    {
                        self.selected_commit = hash.into();
                        self.send("git", json!(["commitFiles", [hash]]));
                    }
                }
            });
        if ui.button("Next 50 commits").clicked() {
            let skip = self.git_history["skip"].as_u64().unwrap_or(0) + 50;
            if let Some(i) = self.active_index() {
                self.workspaces[i].session.send_tag(
                    "git",
                    json!(["history", [skip]]),
                    "gitHistory",
                );
            }
            self.git_history["skip"] = json!(skip);
        }
        let files = array(&self.commit_files).to_vec();
        for file in files {
            if ui.button(s(&file)).clicked() {
                self.send("git", json!(["commitDiff", [self.selected_commit, file]]));
            }
        }
        ui.separator();
        diff_ui(ui, &self.diff);
    }
    fn search_ui(&mut self, ui: &mut egui::Ui) {
        let hint = self.tr("Search in files");
        let enter_pressed = ui.input(|i| i.key_pressed(Key::Enter));
        let response = ui.add(
            egui::TextEdit::singleline(&mut self.search_query)
                .hint_text(hint)
                .desired_width(f32::INFINITY),
        );
        let enter = (response.has_focus() || response.lost_focus()) && enter_pressed;
        let mut changed = response.changed();
        ui.horizontal(|ui| {
            for (key, label) in [
                ("caseSensitive", "Aa"),
                ("wholeWord", "Word"),
                ("regex", ".*"),
            ] {
                let mut enabled = self.search_options[key] == true;
                if ui.toggle_value(&mut enabled, label).changed() {
                    self.search_options[key] = json!(enabled);
                    changed = true;
                }
            }
        });
        let mut folder = s(&self.search_options["folder"]).to_owned();
        changed |= ui
            .add(egui::TextEdit::singleline(&mut folder).hint_text(self.tr("Search folder")))
            .changed();
        self.search_options["folder"] = json!(folder);
        if ui.button(self.tr("Search")).clicked() || enter {
            changed = true;
            self.send("search", json!([self.search_query, self.search_options]));
        }
        if changed {
            self.search_results = Value::Null;
            self.replacement_preview = Value::Null;
            self.search_selected.clear();
        }
        let hint = self.tr("Replace with");
        if ui
            .add(egui::TextEdit::singleline(&mut self.replacement).hint_text(hint))
            .changed()
        {
            self.replacement_preview = Value::Null;
        }
        if ui
            .add_enabled(
                self.search_results["token"].is_string() && !self.search_selected.is_empty(),
                egui::Button::new(self.tr("Preview replacement")),
            )
            .clicked()
        {
            self.send(
                "previewReplacement",
                json!([
                    self.search_results["token"],
                    self.replacement,
                    self.search_selected.iter().copied().collect::<Vec<_>>()
                ]),
            );
        }
        if self.search_results["truncated"] == true {
            ui.colored_label(
                Color32::YELLOW,
                "Showing first 200 matching lines. Narrow the search.",
            );
        }
        let results = array(&self.search_results["matches"])
            .iter()
            .take(200)
            .cloned()
            .collect::<Vec<_>>();
        egui::ScrollArea::vertical()
            .max_height(260.0)
            .show(ui, |ui| {
                for (index, item) in results.iter().enumerate() {
                    ui.horizontal(|ui| {
                        let mut selected = self.search_selected.contains(&index);
                        if ui.checkbox(&mut selected, "").changed() {
                            self.replacement_preview = Value::Null;
                            if selected {
                                self.search_selected.insert(index);
                            } else {
                                self.search_selected.remove(&index);
                            }
                        }
                        if ui
                            .button(format!(
                                "{}:{}  {}",
                                s(&item["path"]),
                                n(&item["line"]),
                                s(&item["text"])
                            ))
                            .clicked()
                        {
                            self.send("open", json!([item["path"], item["line"], item["column"]]));
                            self.focus_editor = true;
                        }
                    });
                }
            });
        if self.replacement_preview.is_object() {
            ui.separator();
            if ui.button(self.tr("Apply replacement")).clicked() {
                self.send(
                    "applyReplacement",
                    json!([self.replacement_preview["token"]]),
                );
            }
            ui.small("Replacements become unsaved, undoable buffer edits.");
            let files = array(&self.replacement_preview["files"]).to_vec();
            egui::ScrollArea::both().show(ui, |ui| {
                for file in files {
                    ui.strong(format!(
                        "{} · {} matches",
                        s(&file["path"]),
                        n(&file["count"])
                    ));
                    let before = s(&file["before"]);
                    let after = s(&file["after"]);
                    let diff = similar::TextDiff::from_lines(before, after)
                        .unified_diff()
                        .context_radius(3)
                        .to_string();
                    diff_lines(ui, &diff);
                }
            });
        }
    }
    fn history_ui(&mut self, ui: &mut egui::Ui) {
        if ui.button(self.tr("Refresh")).clicked() {
            self.send("history", json!(["list", {}]));
        }
        ui.label(s(&self.history["path"]));
        let versions = array(&self.history["versions"]).to_vec();
        egui::ScrollArea::vertical()
            .max_height(210.0)
            .show(ui, |ui| {
                for version in versions {
                    let timestamp = version["timestamp"].as_u64().unwrap_or(0);
                    let ago = crate::history::now().saturating_sub(timestamp) / 1000;
                    let label = format!(
                        "{} · {}s ago · {} lines",
                        s(&version["kind"]),
                        ago,
                        n(&version["lines"])
                    );
                    if ui
                        .selectable_label(
                            self.history_preview["version"]["id"] == version["id"],
                            label,
                        )
                        .clicked()
                    {
                        self.send(
                            "history",
                            json!(["preview",{"path":self.history["path"],"id":version["id"]}]),
                        );
                    }
                }
            });
        if self.history_preview.get("token").is_some() {
            if ui.button(self.tr("Restore this version")).clicked() {
                self.send("history",json!(["restore",{"path":self.history_preview["path"],"id":self.history_preview["version"]["id"],"token":self.history_preview["token"]}]));
            }
            ui.small(
                self.tr("Restored content stays unsaved. Undo returns to the previous draft."),
            );
            diff_ui(ui, s(&self.history_preview["diff"]));
        }
    }
    fn debug_ui(&mut self, ui: &mut egui::Ui) {
        let Some(i) = self.active_index() else { return };
        let debug = self.workspaces[i].state["debug"].clone();
        ui.horizontal_wrapped(|ui| {
            for (label, action) in [
                ("▷ F5", "start"),
                ("□", "stop"),
                ("Ⅱ", "pause"),
                ("↷ F10", "over"),
                ("↓ F11", "into"),
                ("↑", "out"),
                ("● F9", "breakpoint"),
            ] {
                if ui.button(label).clicked() {
                    self.send("debug", json!([action, 0]));
                }
            }
        });
        ui.label(format!(
            "{}  {}",
            s(&debug["status"]),
            s(&debug["location"])
        ));
        for (index, target) in array(&debug["targets"]).iter().enumerate() {
            if ui.button(s(&target["name"])).clicked() {
                self.send("debug", json!(["launch", index + 1]));
            }
        }
        egui::ScrollArea::vertical()
            .max_height(260.0)
            .show(ui, |ui| {
                for variable in array(&debug["variables"]) {
                    let prefix = if variable["expandable"] == true {
                        if variable["expanded"] == true {
                            "▾"
                        } else {
                            "▸"
                        }
                    } else {
                        " "
                    };
                    let label = format!(
                        "{}{} {} = {}",
                        "  ".repeat(n(&variable["depth"]).min(30)),
                        prefix,
                        s(&variable["name"]),
                        s(&variable["value"])
                    );
                    if ui
                        .selectable_label(false, label)
                        .on_hover_text(s(&variable["type"]))
                        .clicked()
                        && variable["expandable"] == true
                    {
                        self.send("debug", json!(["variable", variable["id"]]));
                    }
                }
            });
        ui.separator();
        egui::ScrollArea::both()
            .stick_to_bottom(true)
            .show(ui, |ui| {
                ui.monospace(s(&debug["output"]));
            });
    }
    fn locations_ui(&mut self, ui: &mut egui::Ui) {
        let Some(index) = self.active_index() else {
            return;
        };
        let state = self.workspaces[index].state.clone();
        let references = self.panel == "references";
        let list = if references {
            state["references"].clone()
        } else {
            json!({"items":state["problems"]})
        };
        if list["loading"] == true {
            ui.spinner();
        }
        if let Some(error) = list["error"].as_str().filter(|s| !s.is_empty()) {
            ui.colored_label(Color32::YELLOW, error);
        }
        egui::ScrollArea::both().show(ui,|ui|{for(i,item)in array(&list["items"]).iter().enumerate(){let label=format!("{}:{}:{}\n{}",s(&item["path"]),n(&item["line"]),n(&item["column"]),if references{s(&item["text"])}else{s(&item["message"])});let response=ui.button(label);if response.clicked(){
            if references{self.send("lua",json!(["require('nido_references').open(...)",[i+1,list["version"]]]));}
            else{let path=s(&item["path"]);self.send("lua",json!(["local p,l,c=...;require('nido_scroll').restore();require('nido_eol').open(p);l=math.min(l,vim.api.nvim_buf_line_count(0));local text=vim.api.nvim_buf_get_lines(0,l-1,l,false)[1]or'';vim.api.nvim_win_set_cursor(0,{l,math.min(c-1,#text)});vim.cmd('normal! zvzz')",[path,item["line"],item["column"]]]));}
            self.focus_editor=true;
        }}});
    }
    fn extensions_ui(&mut self, ui: &mut egui::Ui) {
        ui.horizontal(|ui| {
            if ui.button(self.tr("Reload")).clicked() {
                for w in &self.workspaces {
                    w.session.send("reloadPacks", json!([]));
                }
                self.send("packs", json!([]));
            }
            if ui.button(self.tr("Install language pack")).clicked() {
                let tx = self.tx.clone();
                let data = self.data.clone();
                let repaint = self.repaint.clone();
                std::thread::spawn(move || {
                    if let Some(path) = rfd::FileDialog::new()
                        .add_filter("Language pack", &["json"])
                        .pick_file()
                    {
                        match crate::packs::install(&data, &path) {
                            Ok(_) => {
                                let _ = tx.send(Event::Result(
                                    String::new(),
                                    "installedPack".into(),
                                    Value::Null,
                                ));
                            }
                            Err(e) => {
                                let _ = tx.send(Event::Error(format!("Language pack: {e:#}")));
                            }
                        }
                        repaint();
                    }
                });
            }
        });
        for error in array(&self.extensions["errors"]) {
            ui.colored_label(Color32::YELLOW, s(error));
        }
        let packs = array(&self.extensions["packs"]).to_vec();
        egui::ScrollArea::vertical().show(ui, |ui| {
            for pack in packs {
                ui.group(|ui| {
                    let id = s(&pack["id"]);
                    let mut enabled = !array(&self.extensions["disabled"]).iter().any(|v| v == id);
                    if ui.checkbox(&mut enabled, s(&pack["title"])).changed() {
                        match crate::packs::set_enabled(&self.data, id, enabled) {
                            Ok(()) => {
                                for w in &self.workspaces {
                                    w.session.send("reloadPacks", json!([]));
                                }
                                self.send("packs", json!([]));
                            }
                            Err(e) => self.error(e.to_string()),
                        }
                    }
                    ui.label(s(&pack["description"]));
                    let runtime = array(&self.extensions["runtime"])
                        .iter()
                        .find(|p| p["id"] == pack["id"]);
                    if let Some(runtime) = runtime {
                        ui.small(format!(
                            "{} {}",
                            s(&runtime["status"]),
                            s(&runtime["message"])
                        ));
                    }
                    if let Some(setup) = pack["setup"].as_str() {
                        ui.label(setup);
                    }
                    for language in array(&pack["languages"]) {
                        ui.strong(s(&language["title"]));
                        ui.label(s(&language["description"]));
                        ui.label(s(&language["requirement"]));
                    }
                });
            }
        });
    }
    fn file_request_ui(&mut self, ctx: &egui::Context) {
        if self.file_request.is_none() {
            return;
        }
        let mut submit = false;
        let mut cancel = false;
        egui::Modal::new(Id::new("file-operation")).show(ctx, |ui| {
            let enter = ui.input(|i| i.key_pressed(Key::Enter));
            submit = enter;
            let request = self.file_request.as_mut().unwrap();
            ui.label(format!("{}: {}", request.action, request.source));
            if request.action == "delete" {
                ui.label("Move this file or folder to the trash?");
            } else {
                let edit_id = Id::new("file-operation-path");
                if request.focus {
                    ui.memory_mut(|m| m.request_focus(edit_id));
                    request.focus = false;
                }
                ui.add(
                    egui::TextEdit::singleline(&mut request.target)
                        .id(edit_id)
                        .desired_width(400.0),
                );
            }
            ui.horizontal(|ui| {
                submit |= ui.button("OK").clicked();
                cancel = ui.button("Cancel").clicked();
            });
        });
        if cancel {
            self.file_request = None;
            self.focus_editor = true;
        }
        if submit {
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
                let path = if request.action == "createFile" || request.action == "createDirectory"
                {
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
    fn close_ui(&mut self, ctx: &egui::Context) {
        let Some(close) = self.closing.as_ref() else {
            return;
        };
        if close.stage != "prompt" {
            egui::Modal::new(Id::new("unsaved")).show(ctx, |ui| {
                ui.label("Closing workspace…");
            });
            return;
        }
        let mut choice = None;
        egui::Modal::new(Id::new("unsaved")).show(ctx, |ui| {
            ui.heading(self.tr("Unsaved changes"));
            ui.label(self.tr("Save your changes before closing?"));
            ui.horizontal(|ui| {
                if ui.button(self.tr("Save all")).clicked() {
                    choice = Some("save");
                }
                if ui.button(self.tr("Discard")).clicked() {
                    choice = Some("discard");
                }
                if ui.button(self.tr("Cancel")).clicked() {
                    choice = Some("cancel");
                }
            });
        });
        match choice {
            Some("cancel") => {
                self.closing = None;
                self.install_after_close = false;
                self.focus_editor = true;
            }
            Some("discard") => self.close_snapshots(),
            Some("save") => {
                let close = self.closing.as_mut().unwrap();
                close.stage = "saving".into();
                close.waiting = self
                    .workspaces
                    .iter()
                    .filter(|w| close.ids.contains(&w.session.id) && !w.session.terminal)
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
    fn wsl_ui(&mut self, ctx: &egui::Context) {
        if !self.show_wsl {
            return;
        }
        let mut connect = false;
        egui::Window::new(self.tr("Connect to WSL"))
            .anchor(Align2::CENTER_CENTER, Vec2::ZERO)
            .collapsible(false)
            .show(ctx, |ui| {
                egui::ComboBox::from_id_salt("wsl-distro")
                    .selected_text(&self.wsl_choice)
                    .show_ui(ui, |ui| {
                        for distro in array(&self.wsl_list) {
                            ui.selectable_value(&mut self.wsl_choice, s(distro).into(), s(distro));
                        }
                    });
                ui.add(
                    egui::TextEdit::singleline(&mut self.wsl_path).hint_text("/home/you/project"),
                );
                connect = ui.button("Connect").clicked();
            });
        if connect {
            if !self.wsl_path.starts_with('/')
                || !array(&self.wsl_list).iter().any(|v| v == &self.wsl_choice)
            {
                self.error("Choose a distribution and an absolute Linux path");
            } else {
                let remote = crate::wsl::Remote {
                    distribution: self.wsl_choice.clone(),
                    path: self.wsl_path.clone(),
                };
                let root = remote.host(&remote.path);
                if root.is_dir() {
                    self.show_wsl = false;
                    self.add_workspace(root, false, None, None);
                } else {
                    self.error("The Linux folder is unavailable");
                }
            }
        }
    }
    fn information_ui(&mut self, ctx: &egui::Context) {
        if !self.hover.is_empty() {
            let mut open = true;
            egui::Window::new(self.tr("Type information"))
                .id(Id::new("hover"))
                .open(&mut open)
                .default_width(600.0)
                .show(ctx, |ui| {
                    egui::ScrollArea::both()
                        .max_height(500.0)
                        .show(ui, |ui| render_markdown(ui, &self.hover));
                });
            if !open {
                self.hover.clear();
            }
        }
        if self.diagnostics.is_array() {
            let mut open = true;
            egui::Window::new(self.tr("Diagnostic information"))
                .id(Id::new("diagnostic-info"))
                .open(&mut open)
                .default_width(600.0)
                .show(ctx, |ui| {
                    egui::ScrollArea::vertical().show(ui, |ui| {
                        for item in array(&self.diagnostics) {
                            ui.strong(format!("{} {}", s(&item["source"]), s(&item["code"])));
                            ui.label(s(&item["message"]));
                            ui.separator();
                        }
                    });
                });
            if !open {
                self.diagnostics = Value::Null;
            }
        }
    }
    fn notification_ui(&mut self, ctx: &egui::Context) {
        self.notifications
            .retain(|(_, time)| time.elapsed() < Duration::from_secs(30));
        if self.notifications.is_empty() {
            return;
        }
        egui::Area::new(Id::new("notifications"))
            .anchor(Align2::RIGHT_BOTTOM, Vec2::new(-16.0, -40.0))
            .order(egui::Order::Tooltip)
            .show(ctx, |ui| {
                ui.set_width(440.0);
                let mut remove = None;
                for (index, (text, _)) in self.notifications.iter().enumerate() {
                    egui::Frame::popup(ui.style()).show(ui, |ui| {
                        ui.horizontal(|ui| {
                            ui.label(text);
                            if ui.small_button("×").clicked() {
                                remove = Some(index);
                            }
                        });
                    });
                }
                if let Some(index) = remove {
                    self.notifications.remove(index);
                }
            });
    }
}

fn diff_ui(ui: &mut egui::Ui, source: &str) {
    egui::ScrollArea::both()
        .id_salt("diff")
        .show(ui, |ui| diff_lines(ui, source));
}
fn diff_lines(ui: &mut egui::Ui, source: &str) {
    for line in source.lines() {
        let color = if line.starts_with('+') {
            Color32::from_rgb(135, 188, 148)
        } else if line.starts_with('-') {
            Color32::from_rgb(220, 135, 140)
        } else if line.starts_with("@@") {
            Color32::from_rgb(133, 176, 208)
        } else {
            Color32::from_rgb(200, 207, 214)
        };
        ui.add(
            egui::Label::new(RichText::new(line).monospace().color(color))
                .wrap_mode(egui::TextWrapMode::Extend),
        );
    }
}
fn render_markdown(ui: &mut egui::Ui, source: &str) {
    use pulldown_cmark::{Event as M, Tag, TagEnd};
    let mut text = String::new();
    let mut heading = false;
    let mut code = false;
    let mut links = vec![];
    let flush = |ui: &mut egui::Ui, text: &mut String, heading: bool, code: bool| {
        if !text.is_empty() {
            let text = std::mem::take(text);
            if heading {
                ui.heading(text);
            } else if code {
                ui.monospace(text);
            } else {
                ui.label(text);
            }
        }
    };
    for event in pulldown_cmark::Parser::new_ext(source, pulldown_cmark::Options::all()) {
        match event {
            M::Start(Tag::Heading { .. }) => heading = true,
            M::Start(Tag::CodeBlock(_)) => code = true,
            M::Start(Tag::Link { dest_url, .. }) => {
                let url = dest_url.into_string();
                if url.starts_with("https://") || url.starts_with("http://") {
                    links.push(url);
                }
            }
            M::Start(Tag::Item) => text.push_str("• "),
            M::Text(value) | M::Code(value) => text.push_str(&value),
            M::SoftBreak | M::HardBreak => text.push('\n'),
            M::End(
                TagEnd::Paragraph
                | TagEnd::Item
                | TagEnd::Heading(_)
                | TagEnd::CodeBlock
                | TagEnd::TableRow,
            ) => {
                flush(ui, &mut text, heading, code);
                heading = false;
                code = false;
            }
            M::Rule => {
                flush(ui, &mut text, heading, code);
                ui.separator();
            }
            _ => {}
        }
    }
    flush(ui, &mut text, heading, code);
    for link in links {
        ui.hyperlink_to(&link, &link);
    }
}

#[path = "ui_check.rs"]
mod ui_check;
pub use ui_check::run as verify_ui;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn altgr_is_text_and_vim_control_keys_stay_control_keys() {
        let mut mods = egui::Modifiers::CTRL;
        mods.alt = true;
        assert!(vim_key(Key::Q, mods).is_none());
        assert_eq!(
            vim_key(Key::V, egui::Modifiers::CTRL).as_deref(),
            Some("<C-v>")
        );
        assert_eq!(
            vim_key(Key::Tab, egui::Modifiers::SHIFT).as_deref(),
            Some("<S-Tab>")
        );
    }
}
