use super::*;

pub(super) fn check(root: &Path) -> Result<()> {
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
        c.session.root == nido_core::paths::normal_path(project.clone()),
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
