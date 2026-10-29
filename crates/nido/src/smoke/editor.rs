use super::*;

pub(super) fn check(project: &Path, data: &Path) -> Result<()> {
    fs::create_dir(project)?;
    fs::write(project.join("hello.txt"), "hello\n日本語\n")?;
    fs::write(project.join("other.txt"), "Rust\r\nRust\r\n")?;
    fs::write(project.join("README.md"), "# Nido\n\n**Native Rust**\n")?;
    let mut c = Client::start(project, data, false, None)?;
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
        let mut restored = Client::start(project, data, false, Some(saved))?;
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

    Ok(())
}
