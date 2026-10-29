use crate::{
    backend::Session,
    grid::{Grid, array},
    persistence::{self, SavedWorkspace},
    rpc::Event,
    settings,
};
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs,
    path::Path,
    sync::{
        Arc,
        mpsc::{self, Receiver},
    },
    time::{Duration, Instant},
};

struct Client {
    session: Session,
    rx: Receiver<Event>,
    grid: Grid,
    sequence: usize,
    notifications: HashMap<String, Value>,
}
impl Client {
    fn start(
        root: &Path,
        data: &Path,
        terminal: bool,
        saved: Option<SavedWorkspace>,
    ) -> Result<Self> {
        let (tx, rx) = mpsc::channel();
        let mut settings = settings::defaults();
        settings["terminalShell"] = json!("cmd.exe");
        let mut client = Self {
            session: Session::start(
                root.into(),
                terminal,
                saved,
                settings,
                tx,
                Arc::new(|| {}),
                data.into(),
            ),
            rx,
            grid: Grid::default(),
            sequence: 0,
            notifications: HashMap::new(),
        };
        client.wait("ready")?;
        Ok(client)
    }
    fn wait(&mut self, tag: &str) -> Result<Value> {
        let deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < deadline {
            match self.rx.recv_timeout(Duration::from_millis(100)) {
                Ok(Event::Result(_, name, value)) if name == tag => return Ok(value),
                Ok(Event::Notify(_, method, args)) => self.notify(method, args),
                Ok(Event::Error(error)) => bail!("{error}"),
                Ok(Event::Closed(_)) => bail!("Neovim closed while waiting for {tag}"),
                _ => {}
            }
        }
        bail!("Timed out waiting for {tag}")
    }
    fn notify(&mut self, method: String, args: Value) {
        self.grid.notify(&method, &args);
        self.notifications.insert(method, args[0].clone());
    }
    fn wait_notify(&mut self, method: &str, ready: impl Fn(&Value) -> bool) -> Result<Value> {
        let deadline = Instant::now() + Duration::from_secs(45);
        while Instant::now() < deadline {
            if let Some(value) = self.notifications.get(method) {
                if value["status"] == "error" {
                    bail!("{method}: {}", value["output"]);
                }
                if ready(value) {
                    return Ok(value.clone());
                }
            }
            match self.rx.recv_timeout(Duration::from_millis(100)) {
                Ok(Event::Notify(_, method, args)) => self.notify(method, args),
                Ok(Event::Error(error)) => bail!("{error}"),
                Ok(Event::Closed(_)) => bail!("Neovim closed while waiting for {method}"),
                _ => {}
            }
        }
        bail!(
            "Timed out waiting for {method}: {:?}",
            self.notifications.get(method)
        )
    }
    fn call(&mut self, name: &str, args: Value) -> Result<Value> {
        self.sequence += 1;
        let tag = format!("check:{}", self.sequence);
        self.session.send_tag(name, args, &tag);
        self.wait(&tag)
    }
    fn lua(&mut self, code: &str, args: Value) -> Result<Value> {
        self.call("lua", json!([code, args]))
    }
}
impl Drop for Client {
    fn drop(&mut self) {
        self.session.send("input", json!(["<Esc>"]));
        self.session.send("stop", json!([]));
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(3) {
            if matches!(
                self.rx.recv_timeout(Duration::from_millis(50)),
                Ok(Event::Closed(_))
            ) {
                break;
            }
        }
    }
}

pub fn run() -> Result<()> {
    let root = std::env::temp_dir().join(format!("nido-rust-check-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&root)?;
    let result = check(&root);
    if result.is_ok() {
        fs::remove_dir_all(&root)?;
    } else {
        eprintln!("Failed check data preserved at {}", root.display());
    }
    result
}

fn check(root: &Path) -> Result<()> {
    let data = root.join("data");
    let project = root.join("project");
    fs::create_dir(&project)?;
    fs::write(project.join("hello.txt"), "hello\n日本語\n")?;
    fs::write(project.join("other.txt"), "Rust\r\nRust\r\n")?;
    fs::write(project.join("README.md"), "# Nido\n\n**Native Rust**\n")?;
    let mut c = Client::start(&project, &data, false, None)?;
    c.call("resize", json!([80, 24]))?;
    c.call("open", json!(["hello.txt", 1, 1]))?;
    c.call("history", json!(["list", {}]))?;
    c.call("input", json!(["iRust 日本語<Esc>"]))?;
    c.call("save", json!(["write"]))?;
    ensure!(
        fs::read_to_string(project.join("hello.txt"))?.starts_with("Rust 日本語hello"),
        "Unicode edit/save mismatch"
    );
    c.lua("vim.cmd.redraw();return true", json!([]))?;
    ensure!(
        c.grid.rows == 24 && c.grid.columns == 80,
        "Native grid size mismatch"
    );
    ensure!(
        c.grid.description().contains("Rust 日本語hello"),
        "Grid lost Unicode text"
    );
    let journal = fs::read_dir(data.join("time-machine"))?
        .filter_map(|e| e.ok())
        .find(|entry| {
            entry.path().extension().is_some_and(|e| e == "json")
                && fs::read(entry.path())
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                    .is_some_and(|v| v["path"].as_str().is_some_and(|s| s.ends_with("hello.txt")))
        })
        .context("Missing history journal")?
        .path();
    let good_journal = fs::read(&journal)?;
    fs::write(&journal, b"damaged")?;
    c.call("input", json!(["gg0iHistory <Esc>"]))?;
    c.call("save", json!(["write"]))?;
    ensure!(
        fs::read_to_string(project.join("hello.txt"))?.starts_with("History "),
        "Damaged history blocked document saving"
    );
    ensure!(
        fs::read(&journal)? == b"damaged",
        "Damaged history was overwritten"
    );
    fs::write(&journal, good_journal)?;

    // A pending Vim command must keep accepting input while a deferred RPC waits.
    c.call("input", json!(["r"]))?;
    c.session.send_tag("snapshot", json!([]), "pendingSnapshot");
    std::thread::sleep(Duration::from_millis(120));
    c.session.send("input", json!(["X"]));
    c.wait("pendingSnapshot")?;
    c.call("save", json!(["write"]))?;

    let found = c.call("search", json!(["Rust$",{"regex":true}]))?;
    ensure!(
        array(&found["matches"]).len() == 2,
        "Regex search did not find CRLF lines"
    );
    let preview = c.call(
        "previewReplacement",
        json!([found["token"], "Native", [0, 1]]),
    )?;
    let current = c.lua("return vim.api.nvim_get_current_buf()", json!([]))?;
    let applied = c.call("applyReplacement", json!([preview["token"]]))?;
    ensure!(applied["count"] == 2, "Replacement count mismatch");
    ensure!(
        c.lua("return vim.api.nvim_get_current_buf()", json!([]))? == current,
        "Replacement changed active file"
    );
    ensure!(
        fs::read_to_string(project.join("other.txt"))? == "Rust\r\nRust\r\n",
        "Replacement wrote to disk without saving"
    );
    c.call("save", json!(["wall"]))?;
    ensure!(
        fs::read_to_string(project.join("other.txt"))? == "Native\r\nNative\r\n",
        "Replacement changed line endings"
    );
    ensure!(
        c.call("applyReplacement", json!([preview["token"]]))
            .is_err(),
        "Replacement could be applied twice"
    );
    let found = c.call("search", json!(["Native", {}]))?;
    let selected = array(&found["matches"])
        .iter()
        .position(|m| m["path"] == "other.txt")
        .context("Search lost replacement target")?;
    c.call(
        "previewReplacement",
        json!([found["token"], "Changed", [selected]]),
    )?;
    let buffers = c.call("buffers", json!([]))?;
    let other = array(&buffers)
        .iter()
        .find(|b| b["name"].as_str().is_some_and(|s| s.ends_with("other.txt")))
        .context("Replaced file is missing from open buffers")?["id"]
        .clone();
    c.call("selectBuffer", json!([other]))?;
    c.call("input", json!(["iUnsaved <Esc>"]))?;
    c.lua("return vim.fn.mode(1)", json!([]))?;
    let preview = c.call(
        "previewReplacement",
        json!([found["token"], "Changed", [selected]]),
    )?;
    ensure!(
        c.call("applyReplacement", json!([preview["token"]]))
            .is_err(),
        "Replacement overwrote an unsaved buffer"
    );
    c.call("save", json!(["wall"]))?;

    c.call("fileAction", json!(["createDirectory", "folder", ""]))?;
    c.call("fileAction", json!(["createFile", "folder/new.txt", ""]))?;
    c.call(
        "fileAction",
        json!(["copy", "folder/new.txt", "folder/copy.txt"]),
    )?;
    c.call(
        "fileAction",
        json!(["rename", "folder/copy.txt", "folder/renamed.txt"]),
    )?;
    ensure!(
        project.join("folder/renamed.txt").is_file(),
        "Explorer rename/copy failed"
    );
    ensure!(
        c.call("fileAction", json!(["createFile", "../escape.txt", ""]))
            .is_err(),
        "Explorer escaped workspace root"
    );
    c.call("open", json!(["hello.txt", 2, 1]))?;
    let snapshot = c.call("snapshot", json!([]))?;
    let saved: SavedWorkspace = serde_json::from_value(snapshot.clone())?;
    let layout = persistence::Layout {
        workspaces: vec![saved.clone()],
        ..Default::default()
    };
    persistence::write_layout(&data.join("workspaces.json"), &layout)?;
    ensure!(
        persistence::read_layout(&data.join("workspaces.json"))?.workspaces[0]
            .files
            .len()
            == 2,
        "Workspace persistence lost files"
    );
    {
        let mut restored = Client::start(&project, &data, false, Some(saved))?;
        let value = restored.call("snapshot", json!([]))?;
        ensure!(
            array(&value["files"]).len() == 2 && value["current"] == snapshot["current"],
            "Workspace restore lost active file"
        );
        ensure!(
            array(&value["files"]).iter().any(|f| f["line"] == 2),
            "Workspace restore lost cursor position"
        );
    }
    let versions = c.call("history", json!(["list", {}]))?;
    let first = array(&versions["versions"])
        .last()
        .context("Time Machine lost disk baseline")?;
    let args = json!({"path":versions["path"],"id":first["id"]});
    let preview = c.call("history", json!(["preview", args]))?;
    c.call("input", json!(["iChanged <Esc>"]))?;
    c.lua("return vim.fn.mode(1)", json!([]))?;
    ensure!(
        c.call(
            "history",
            json!(["restore",{"path":versions["path"],"id":first["id"],"token":preview["token"]}])
        )
        .is_err(),
        "Time Machine accepted a stale preview"
    );
    let preview = c.call("history", json!(["preview", args]))?;
    c.call(
        "history",
        json!(["restore",{"path":versions["path"],"id":first["id"],"token":preview["token"]}]),
    )?;
    ensure!(
        c.call("modified", json!([]))? == true,
        "History restore must stay unsaved"
    );
    c.call("save", json!(["wall"]))?;
    c.call("open", json!(["README.md", 1, 1]))?;
    ensure!(
        c.call("markdown", json!([]))?
            .as_str()
            .is_some_and(|s| s.contains("Native Rust")),
        "Markdown preview did not read current buffer"
    );
    ensure!(
        array(&c.call("packs", json!([]))?["packs"]).len() >= 3,
        "Bundled language packs are missing"
    );
    println!(
        "PASS: Neovim RPC/grid, Unicode edit/save, pending commands, CRLF search/replacement, unsaved protection, explorer, restore, Time Machine, Markdown and language packs"
    );
    drop(c);

    crate::git::run(&project, &["init", "-q"])?;
    crate::git::run(&project, &["config", "user.name", "Nido native test"])?;
    crate::git::run(
        &project,
        &["config", "user.email", "native-test@example.invalid"],
    )?;
    crate::git::run(&project, &["config", "commit.gpgsign", "false"])?;
    ensure!(
        crate::git::action(&project, "diff", &json!(["README.md", false]))?
            .as_str()
            .is_some_and(|s| s.contains("+# Nido")),
        "Untracked Git diff is empty"
    );
    crate::git::action(&project, "stage", &json!(["README.md", true]))?;
    ensure!(
        array(&crate::git::action(&project, "status", &json!([]))?["changes"])
            .iter()
            .any(|v| v["path"] == "README.md" && v["staged"] == true),
        "Git staging failed"
    );
    crate::git::action(&project, "stage", &json!(["README.md", false]))?;
    crate::git::action(&project, "stageAll", &json!([]))?;
    crate::git::action(&project, "commit", &json!(["Native smoke fixture"]))?;
    ensure!(
        array(&crate::git::action(&project.join("folder"), "history", &json!([0]))?["commits"])
            .len()
            == 1,
        "Git history from a subfolder failed"
    );
    crate::git::action(&project, "switch", &json!(["native-check", true]))?;
    println!(
        "PASS: Git untracked diff, unborn staging/unstaging, commit, branch and history from a subfolder"
    );
    {
        let mut terminal = Client::start(&project, &data, true, None)?;
        terminal.call("input", json!(["echo NIDO_NATIVE_TERMINAL<CR>"]))?;
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if terminal
                .lua(
                    "return table.concat(vim.api.nvim_buf_get_lines(0,0,-1,false),'\\n')",
                    json!([]),
                )?
                .as_str()
                .is_some_and(|s| s.matches("NIDO_NATIVE_TERMINAL").count() >= 2)
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        ensure!(
            terminal
                .lua(
                    "return table.concat(vim.api.nvim_buf_get_lines(0,0,-1,false),'\\n')",
                    json!([])
                )?
                .as_str()
                .is_some_and(|s| s.matches("NIDO_NATIVE_TERMINAL").count() >= 2),
            "Native terminal did not execute input"
        );
        terminal.call("restartTerminal", json!([]))?;
        ensure!(
            terminal.call("modified", json!([]))? == false,
            "Terminal falsely reports unsaved files"
        );
    }
    println!("PASS: terminal input, output, restart and close");
    crate::app::verify_ui(&project, &root.join("ui-data"))?;
    language_and_debug(root)?;
    Ok(())
}

fn language_and_debug(root: &Path) -> Result<()> {
    let project = root.join("language-project");
    fs::create_dir(&project)?;
    fs::write(
        project.join("tsconfig.json"),
        "{\"compilerOptions\":{\"strict\":true}}",
    )?;
    fs::write(
        project.join("sample.ts"),
        "export function greet(name: string) { return name; }\nconst bad: number = 'wrong';\ngre\n",
    )?;
    let mut c = Client::start(&project, &root.join("language-data"), false, None)?;
    c.call("open", json!(["sample.ts", 3, 4]))?;
    ensure!(c.lua("return vim.wait(10000,function() for _,c in ipairs(vim.lsp.get_clients({bufnr=0})) do if c.initialized then return true end end return false end,50)",json!([]))? == true, "Bundled TypeScript language server did not attach");
    ensure!(
        c.lua(
            "return vim.wait(10000,function() return #vim.diagnostic.get(0)>0 end,50)",
            json!([])
        )? == true,
        "LSP diagnostics did not arrive"
    );
    let completion = c.lua("local p=vim.lsp.util.make_position_params(0,'utf-16'); local r=vim.lsp.buf_request_sync(0,'textDocument/completion',p,10000); for _,v in pairs(r or {}) do for _,i in ipairs((v.result or {}).items or v.result or {}) do if i.label=='greet' then return true end end end return false",json!([]))?;
    ensure!(completion == true, "TypeScript completion lost greet");
    c.call("input", json!(["Ae"]))?;
    // TextChangedI and feedkeys must return to Neovim's input loop between probes.
    let deadline = Instant::now() + Duration::from_secs(5);
    while c.lua("return vim.fn.pumvisible()==1", json!([]))? != true {
        ensure!(
            Instant::now() < deadline,
            "Automatic completion did not open after typing: {}",
            c.lua("return {mode=vim.fn.mode(),line=vim.api.nvim_get_current_line(),messages=vim.fn.execute('messages')}", json!([]))?
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    c.lua("vim.cmd.redraw(); return true", json!([]))?;
    ensure!(
        array(&c.grid.completion["items"])
            .iter()
            .any(|v| v[0].as_str().is_some_and(|s| s.contains("greet"))),
        "Completion popup did not reach the native grid"
    );
    c.call("input", json!(["<C-n>"]))?;
    c.call("input", json!(["<Tab><Esc>"]))?;
    ensure!(
        c.lua("return vim.api.nvim_get_current_line()", json!([]))?
            .as_str()
            .is_some_and(|s| s.starts_with("greet")),
        "Completion acceptance lost the selected item"
    );
    c.lua("return require('nido_symbols').find()", json!([]))?;
    let symbols = c.wait_notify("nido:symbols", |v| v["loading"] == false)?;
    ensure!(
        array(&symbols["items"])
            .iter()
            .any(|s| s["name"] == "greet"),
        "LSP document symbols were not delivered to the native client"
    );
    drop(c);
    println!("PASS: bundled TypeScript LSP, diagnostics, completion and document symbols");

    let project = root.join("debug-project");
    fs::create_dir_all(project.join("src"))?;
    fs::write(
        project.join("Cargo.toml"),
        "[package]\nname=\"nido_native_debug_check\"\nversion=\"0.1.0\"\nedition=\"2024\"\n",
    )?;
    fs::write(
        project.join("src/main.rs"),
        "fn double(x: i32) -> i32 {\n    x * 2\n}\nfn main() {\n    let number = 21;\n    let answer = double(number);\n    println!(\"answer={answer}\");\n}\n",
    )?;
    let mut c = Client::start(
        &project.join("src/.."),
        &root.join("debug-data"),
        false,
        None,
    )?;
    ensure!(
        c.session.root == crate::files::normal_path(project.clone()),
        "Debugger workspace root was not canonicalized"
    );
    c.call("open", json!(["src/main.rs", 6, 5]))?;
    c.call("debug", json!(["breakpoint", 0]))?;
    c.call("debug", json!(["start", 0]))?;
    let paused = c.wait_notify("nido:debug", |v| {
        v["status"] == "paused" && !array(&v["variables"]).is_empty()
    })?;
    ensure!(
        array(&paused["variables"])
            .iter()
            .any(|v| v["name"] == "number" && v["value"] == "21"),
        "Debugger variables were not delivered"
    );
    c.call("debug", json!(["into", 0]))?;
    c.wait_notify("nido:debug", |v| {
        v["location"]
            .as_str()
            .is_some_and(|s| s.ends_with("main.rs:2"))
    })?;
    c.call("debug", json!(["out", 0]))?;
    c.wait_notify("nido:debug", |v| {
        v["location"]
            .as_str()
            .is_some_and(|s| s.ends_with("main.rs:6"))
    })?;
    c.call("debug", json!(["start", 0]))?;
    c.wait_notify("nido:debug", |v| v["status"] == "finished")?;
    ensure!(
        c.call("modified", json!([]))? == false,
        "Debugger output was treated as unsaved source"
    );
    println!("PASS: CodeLLDB build, breakpoint, variables, step into/out and continue");
    Ok(())
}
