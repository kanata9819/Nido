use super::*;
use anyhow::{Result, bail, ensure};
use eframe::App;

struct Headless {
    app: Nido,
    context: egui::Context,
    frame: eframe::Frame,
    time: f64,
}
impl Headless {
    fn pump(&mut self, mut events: Vec<egui::Event>, modifiers: egui::Modifiers) {
        self.time += 1.0 / 60.0;
        self.app.logic(&self.context, &mut self.frame);
        events.insert(0, egui::Event::ModifiersChanged(modifiers));
        let input = egui::RawInput {
            screen_rect: Some(Rect::from_min_size(Pos2::ZERO, Vec2::new(1280.0, 900.0))),
            time: Some(self.time),
            events,
            focused: true,
            ..Default::default()
        };
        let mut output = self
            .context
            .run_ui(input, |ui| self.app.ui(ui, &mut self.frame));
        assert!(!output.shapes.is_empty(), "Native UI stopped painting");
        output.textures_delta.clear();
    }
    fn until(&mut self, label: &str, ready: impl Fn(&Nido) -> bool) -> Result<()> {
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(15) {
            self.pump(vec![], egui::Modifiers::NONE);
            if ready(&self.app) {
                return Ok(());
            }
            if let Some((error, _)) = self.app.notifications.last() {
                bail!("{label}: {error}")
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        bail!(
            "Native UI timed out: {label}; palette={:?}, mode={}, pending={}, queued={}, file={:?}, focus={:?}",
            self.app.palette.as_ref().map(|p| (&p.kind, &p.query)),
            self.app.workspaces[0].state["mode"],
            self.app.mode_pending,
            self.app.queued_input.len(),
            self.app
                .file_request
                .as_ref()
                .map(|f| (&f.workspace, &f.action, &f.target)),
            self.context.memory(|m| m.focused())
        )
    }
    fn key(&mut self, key: Key, modifiers: egui::Modifiers) {
        self.pump(
            vec![egui::Event::Key {
                key,
                physical_key: Some(key),
                pressed: true,
                repeat: false,
                modifiers,
            }],
            modifiers,
        );
        self.pump(
            vec![egui::Event::Key {
                key,
                physical_key: Some(key),
                pressed: false,
                repeat: false,
                modifiers,
            }],
            modifiers,
        );
    }
}

pub fn run(project: &Path, data: &Path) -> Result<()> {
    let context = egui::Context::default();
    let cc = eframe::CreationContext::_new_kittest(context.clone());
    let mut empty = Nido::load(&cc, data.join("empty"));
    empty.request_close(true);
    ensure!(empty.exit_allowed, "An empty window could not quit");
    let mut app = Nido::load(&cc, data.into());
    app.add_workspace(project.into(), false, None, None);
    let mut ui = Headless {
        app,
        context,
        frame: eframe::Frame::_new_kittest(),
        time: 0.0,
    };
    ui.until("attach", |a| a.workspaces[0].ready)?;
    ui.app.send("open", json!(["hello.txt", 1, 1]));
    ui.until("open", |a| a.workspaces[0].current().ends_with("hello.txt"))?;
    ui.key(Key::I, egui::Modifiers::NONE);
    ui.pump(vec![egui::Event::Text("i".into())], egui::Modifiers::NONE);
    ui.until("insert", |a| a.workspaces[0].state["mode"] == "i")?;
    ui.pump(
        vec![egui::Event::Ime(egui::ImeEvent::Preedit {
            text: "日本語".into(),
            active_range_chars: None,
        })],
        egui::Modifiers::NONE,
    );
    ensure!(
        ui.app.preedit == "日本語",
        "Preedit was not visible immediately"
    );
    ui.pump(
        vec![egui::Event::Ime(egui::ImeEvent::Commit(
            "Rust日本語".into(),
        ))],
        egui::Modifiers::NONE,
    );
    ui.key(Key::Escape, egui::Modifiers::NONE);
    ui.until("IME commit", |a| {
        a.workspaces[0].grid.description().contains("Rust日本語")
    })?;
    ui.key(Key::S, egui::Modifiers::CTRL);
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
    ui.key(Key::Enter, egui::Modifiers::NONE);
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
    ui.pump(vec![], egui::Modifiers::NONE);

    ui.pump(
        vec![egui::Event::Text(" ".into()), egui::Event::Text("f".into())],
        egui::Modifiers::NONE,
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
        &ui.context,
        &id,
        &format!("palette:{old_generation}"),
        json!([{"path":"stale.txt"}]),
    );
    ensure!(
        array(&ui.app.palette.as_ref().unwrap().items).is_empty(),
        "An old file search populated the new palette"
    );
    ui.key(Key::Escape, egui::Modifiers::NONE);
    ensure!(ui.app.palette.is_none(), "Escape did not close palette");
    ui.app.toggle_terminal();
    ui.until("paired terminal", |a| {
        a.workspaces.len() == 2 && a.workspaces[1].ready
    })?;
    ensure!(
        ui.app.input_index() == Some(1),
        "Terminal toggle did not focus terminal"
    );
    ui.key(Key::K, egui::Modifiers::CTRL);
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
    ui.key(Key::K, egui::Modifiers::CTRL);
    ui.app.show_panel("search");
    ui.app.search_query = "Native".into();
    ui.app
        .send("search", json!(["Native", ui.app.search_options]));
    ui.until("search panel", |a| a.search_results.get("token").is_some())?;
    let id = ui.app.active.clone();
    let token = ui.app.search_results["token"].clone();
    ui.app.result(
        &ui.context,
        &id,
        "search",
        json!({"query":"old query","options":ui.app.search_options,"token":"stale","matches":[]}),
    );
    ensure!(
        ui.app.search_results["token"] == token,
        "Stale search result replaced current results"
    );
    ui.app.show_panel("settings");
    ui.pump(vec![], egui::Modifiers::NONE);
    ui.app.panel.clear();
    ui.app.focus_editor = true;
    ui.pump(vec![], egui::Modifiers::NONE);
    ui.pump(
        vec![egui::Event::Text("iUnsaved".into())],
        egui::Modifiers::NONE,
    );
    ui.key(Key::Escape, egui::Modifiers::NONE);
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
    ui.key(Key::Escape, egui::Modifiers::NONE);
    ensure!(
        ui.app.closing.is_none(),
        "Cancel did not preserve running sessions"
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
        "PASS: headless native UI painting, IME commit, save, ordered leader/palette input, paired terminal focus, search/settings panels and unsaved close/cancel"
    );
    Ok(())
}
