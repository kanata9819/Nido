use super::*;
use anyhow::{Result, bail, ensure};

struct Headless {
    app: Model,
}
impl Headless {
    fn pump(&mut self, events: Vec<InputEvent>, _: Modifiers) {
        self.app.pump();
        for event in events {
            match event {
                InputEvent::Key(key) => {
                    self.app.key(&key, true);
                }
                InputEvent::Text(text) => self.app.text(&text),
            }
        }
        self.app.pump();
    }
    fn until(&mut self, label: &str, ready: impl Fn(&Model) -> bool) -> Result<()> {
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(15) {
            self.pump(vec![], Modifiers::none());
            if ready(&self.app) {
                return Ok(());
            }
            if let Some((error, _)) = self.app.notifications.last() {
                bail!("{label}: {error}");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        bail!(
            "Native UI state timed out: {label}; pending={}, palette={:?}",
            self.app.mode_pending,
            self.app.palette.as_ref().map(|p| (&p.kind, &p.query))
        )
    }
    fn key(&mut self, key: &str, modifiers: Modifiers) {
        self.pump(
            vec![InputEvent::Key(Keystroke {
                key: key.into(),
                modifiers,
                key_char: None,
            })],
            modifiers,
        );
    }
}
pub fn run(project: &Path, data: &Path) -> Result<()> {
    let mut empty = Model::load(data.join("empty"), Arc::new(|| {}));
    empty.request_close(true);
    ensure!(empty.exit_allowed, "An empty window could not quit");
    let mut app = Model::load(data.into(), Arc::new(|| {}));
    app.add_workspace(project.into(), false, None, None);
    let mut ui = Headless { app };
    ui.until("attach", |a| a.workspaces[0].ready)?;
    ui.app.send("open", json!(["hello.txt", 1, 1]));
    ui.until("open", |a| a.workspaces[0].current().ends_with("hello.txt"))?;
    ui.key("i", Modifiers::none());
    ui.pump(vec![InputEvent::Text("i".into())], Modifiers::none());
    ui.until("insert", |a| a.workspaces[0].state["mode"] == "i")?;
    ui.app.preedit = "日本語".into();
    ensure!(
        ui.app.preedit == "日本語",
        "Preedit was not visible immediately"
    );
    ui.app.preedit.clear();
    ui.app.text("Rust日本語");
    ui.key("escape", Modifiers::none());
    ui.until("IME commit", |a| {
        a.workspaces[0].grid.description().contains("Rust日本語")
    })?;
    ui.key(
        "s",
        Modifiers {
            control: true,
            ..Modifiers::none()
        },
    );
    ui.until("save", |a| {
        a.workspaces[0]
            .buffers()
            .iter()
            .all(|b| b["modified"] == false)
    })?;
    ensure!(
        fs::read_to_string(project.join("hello.txt"))?.contains("Rust日本語"),
        "Native UI save lost committed Japanese text"
    );
    let first = ui.app.active.clone();
    let other = project.join("other-workspace");
    fs::create_dir(&other)?;
    ui.app.file_request = Some(FileRequest {
        workspace: first.clone(),
        action: "createFile".into(),
        source: String::new(),
        target: "dialog-target.txt".into(),
        focus: true,
    });
    let other_id = ui.app.add_workspace(other.clone(), false, None, None);
    ui.until("file dialog workspace", |a| {
        a.workspaces
            .iter()
            .any(|w| w.session.id == other_id && w.ready)
    })?;
    ui.key("enter", Modifiers::none());
    ui.until("bound file operation", |_| {
        project.join("dialog-target.txt").is_file()
    })?;
    ensure!(
        !other.join("dialog-target.txt").exists(),
        "File operation changed the wrong workspace"
    );
    ui.app.request_close(false);
    ui.until("close second workspace", |a| {
        a.closing.is_none() && a.workspaces.len() == 1
    })?;
    ensure!(
        ui.app.active == first,
        "Closing the second workspace lost the first"
    );
    ui.app.focus_editor = true;
    ui.pump(vec![], Modifiers::none());

    ui.pump(
        vec![InputEvent::Text(" ".into()), InputEvent::Text("f".into())],
        Modifiers::none(),
    );
    ui.until("ordered leader keys", |a| {
        a.palette.as_ref().is_some_and(|p| p.kind == "files")
    })?;
    ui.until("file palette", |a| {
        a.palette
            .as_ref()
            .is_some_and(|p| !array(&p.items).is_empty())
    })?;
    let old_generation = ui.app.palette.as_ref().unwrap().generation;
    ui.app.open_palette("buffers");
    ensure!(ui.app.palette.as_ref().unwrap().generation > old_generation);
    let id = ui.app.active.clone();
    ui.app.result(
        &id,
        &format!("palette:{old_generation}"),
        json!([{"path":"stale.txt"}]),
    );
    ensure!(
        array(&ui.app.palette.as_ref().unwrap().items).is_empty(),
        "An old file search populated the new palette"
    );
    ui.key("escape", Modifiers::none());
    ensure!(ui.app.palette.is_none(), "Escape did not close palette");
    ui.app.toggle_terminal();
    ui.until("paired terminal", |a| {
        a.workspaces.len() == 2 && a.workspaces[1].ready
    })?;
    ensure!(
        ui.app.input_index() == Some(1),
        "Terminal toggle did not focus terminal"
    );
    ui.key(
        "k",
        Modifiers {
            control: true,
            ..Modifiers::none()
        },
    );
    ensure!(
        ui.app.input_index() == Some(0),
        "Ctrl+K did not return to editor"
    );
    ui.app.workspaces[1]
        .session
        .send("input", json!(["exit<CR>"]));
    ui.until("terminal exit", |a| {
        a.workspaces.len() == 1 && !a.terminal_visible
    })?;
    ui.app.toggle_terminal();
    ui.until("terminal reopen", |a| {
        a.workspaces.len() == 2 && a.workspaces[1].ready
    })?;
    ui.key(
        "k",
        Modifiers {
            control: true,
            ..Modifiers::none()
        },
    );
    ui.app.show_panel("search");
    ui.app.search_query = "Native".into();
    ui.app
        .send("search", json!(["Native", ui.app.search_options]));
    ui.until("search panel", |a| a.search_results.get("token").is_some())?;
    let id = ui.app.active.clone();
    let token = ui.app.search_results["token"].clone();
    ui.app.result(
        &id,
        "search",
        json!({"query":"old query","options":ui.app.search_options,"token":"stale","matches":[]}),
    );
    ensure!(
        ui.app.search_results["token"] == token,
        "Stale search result replaced current results"
    );
    ui.app.show_panel("settings");
    ui.pump(vec![], Modifiers::none());
    ui.app.panel.clear();
    ui.app.focus_editor = true;
    ui.pump(vec![], Modifiers::none());
    ui.pump(vec![InputEvent::Text("iUnsaved".into())], Modifiers::none());
    ui.key("escape", Modifiers::none());
    ui.until("unsaved marker", |a| {
        a.workspaces[0]
            .buffers()
            .iter()
            .any(|b| b["modified"] == true)
    })?;
    ui.app.request_close(true);
    ui.until("close confirmation", |a| {
        a.closing.as_ref().is_some_and(|c| c.stage == "prompt")
    })?;
    ensure!(!ui.app.exit_allowed, "Quit skipped unsaved confirmation");
    ui.key("escape", Modifiers::none());
    ensure!(
        ui.app.closing.is_none(),
        "Cancel did not preserve running sessions"
    );
    ui.app.close_choice("save");
    ensure!(
        ui.app.closing.is_none(),
        "Stale close action must be ignored"
    );
    ui.app.send("save", json!(["wall"]));
    ui.until("save all", |a| {
        a.workspaces[0]
            .buffers()
            .iter()
            .all(|b| b["modified"] == false)
    })?;
    ui.app.request_close(true);
    ui.until("clean shutdown", |a| a.exit_allowed)?;
    ensure!(
        persistence::read_layout(&data.join("workspaces.json"))?.workspaces[0].terminal,
        "Paired terminal state was not saved"
    );
    println!(
        "PASS: headless native UI state, IME commit, save, ordered leader/palette input, paired terminal focus, search/settings panels and unsaved close/cancel"
    );
    Ok(())
}
