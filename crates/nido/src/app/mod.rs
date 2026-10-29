use crate::grid::{self, Grid, array, n, s};
use gpui::{Keystroke, Modifiers};
use nido_backend::{rpc::Event, session::Session};
use nido_core::{
    paths::normal_path,
    persistence::{self, Layout, SavedWorkspace},
    settings,
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

mod checks;
mod closing;
mod commands;
mod events;
mod explorer;
mod input;
mod integrations;
mod lifecycle;
mod palette;
mod ui;
mod workspaces;
pub use checks::run as verify_ui;
use commands::COMMANDS;
use explorer::tree_rows;
use input::InputEvent;
pub use ui::{run, verify_gui};
