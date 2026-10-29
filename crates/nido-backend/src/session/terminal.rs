use super::*;

pub fn available_shells() -> Vec<String> {
    ["auto", "pwsh", "powershell.exe", "cmd.exe", "wsl.exe"]
        .into_iter()
        .filter(|s| *s == "auto" || shell(s).is_ok())
        .map(str::to_owned)
        .collect()
}
fn shell(choice: &str) -> Result<Vec<String>> {
    if !["auto", "pwsh", "powershell.exe", "cmd.exe", "wsl.exe"].contains(&choice) {
        bail!("Invalid terminal shell")
    }
    let choices = if choice == "auto" {
        vec!["pwsh", "powershell.exe", "cmd.exe"]
    } else {
        vec![choice]
    };
    for name in choices {
        let mut dirs: Vec<PathBuf> =
            std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect();
        if let Some(p) = std::env::var_os("ProgramFiles") {
            dirs.push(PathBuf::from(p).join("PowerShell/7"));
        }
        if let Some(p) = std::env::var_os("SystemRoot") {
            let p = PathBuf::from(p);
            dirs.push(p.join("System32"));
            dirs.push(p.join("System32/WindowsPowerShell/v1.0"));
        }
        for dir in dirs {
            let path = dir.join(if name == "pwsh" { "pwsh.exe" } else { name });
            if path.is_file() {
                let mut args = vec![path.to_string_lossy().into_owned()];
                if name.contains("powershell") || name == "pwsh" {
                    args.push("-NoLogo".into());
                }
                return Ok(args);
            }
        }
    }
    bail!("Shell is not installed: {choice}")
}
pub(super) fn start_terminal(rpc: &Rpc, settings: &Value, remote: bool) -> Result<()> {
    let choice = settings["terminalShell"].as_str().unwrap_or("auto");
    let command = if remote { vec![] } else { shell(choice)? };
    rpc.lua(
        "require('nido_terminal').start(...)",
        json!([choice, command]),
    )?;
    for _ in 0..100 {
        if rpc.call("nvim_get_mode", json!([]))?["mode"] == "t" {
            return Ok(());
        }
        rpc.call("nvim_command", json!(["startinsert"]))?;
        thread::sleep(Duration::from_millis(10));
    }
    bail!("Terminal input did not become ready")
}
