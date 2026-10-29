use super::*;

impl Model {
    pub(super) fn mode_shortcut(&mut self, key: &str) {
        if let Some(i) = self.active_index() {
            self.mode_pending = true;
            self.workspaces[i]
                .session
                .send("modeShortcut", json!([key]));
        }
    }

    pub(super) fn execute(&mut self, action: &str) {
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

    pub(super) fn show_panel(&mut self, panel: &str) {
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
}

pub(super) const COMMANDS: &[(&str, &str, &str, &str)] = &[
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
