use crate::rpc::command;
use anyhow::{Context, Result, bail};
use std::{
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

#[derive(Clone, Debug)]
pub struct Remote {
    pub distribution: String,
    pub path: String,
}
impl Remote {
    pub fn parse(path: &Path) -> Option<Self> {
        let name = path.to_string_lossy().replace('/', "\\");
        let parts: Vec<_> = name
            .trim_start_matches(r"\\?\UNC\")
            .trim_start_matches('\\')
            .split('\\')
            .collect();
        if parts.len() < 2
            || !["wsl$", "wsl.localhost"].contains(&parts[0].to_ascii_lowercase().as_str())
        {
            return None;
        }
        let distribution = parts[1];
        if distribution.is_empty()
            || distribution.starts_with('-')
            || distribution.contains(['\0', '/', '\\'])
        {
            return None;
        }
        Some(Self {
            distribution: distribution.into(),
            path: format!("/{}", parts[2..].join("/")),
        })
    }
    pub fn command(&self, program: &str, args: &[&str]) -> Command {
        let mut c = command("wsl.exe");
        c.args([
            "--distribution",
            &self.distribution,
            "--cd",
            &self.path,
            "--exec",
            program,
        ])
        .args(args);
        c
    }
    pub fn run(&self, args: &[&str]) -> Result<String> {
        let (program, rest) = args.split_first().context("Missing WSL command")?;
        output(self.command(program, rest))
    }
    pub fn host(&self, path: &str) -> PathBuf {
        PathBuf::from(format!(
            "\\\\wsl.localhost\\{}{}",
            self.distribution,
            path.replace('/', "\\")
        ))
    }
    pub fn prepare(&self, resources: &Path) -> Result<(String, String, String)> {
        let script =
            std::fs::read_to_string(resources.join("nido/wsl-runtime.sh"))?.replace("\r\n", "\n");
        let mut child = self
            .command("sh", &["-s"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        child
            .stdin
            .take()
            .context("Missing setup input")?
            .write_all(script.as_bytes())?;
        let result = child.wait_with_output()?;
        if !result.status.success() {
            bail!(
                "WSL setup failed: {}",
                String::from_utf8_lossy(&result.stderr)
            )
        }
        let text = String::from_utf8(result.stdout)?;
        let get = |key: &str| -> Result<String> {
            let value = text
                .lines()
                .find_map(|l| l.strip_prefix(key))
                .context("WSL runtime path missing")?;
            if !value.starts_with('/') {
                bail!("Invalid WSL runtime path")
            }
            Ok(value.into())
        };
        let mounted = self.run(&["wslpath", "-a", "-u", &resources.to_string_lossy()])?;
        Ok((
            get("NIDO_NVIM=")?,
            get("NIDO_NODE=")?,
            mounted.trim().into(),
        ))
    }
}
pub fn editor_path(path: &Path, remote: Option<&Remote>) -> String {
    if remote.is_some()
        && let Some(actual) = Remote::parse(path)
    {
        return actual.path;
    }
    let name = path.to_string_lossy();
    name.strip_prefix("\\\\?\\").unwrap_or(&name).into()
}
pub fn output(mut c: Command) -> Result<String> {
    let result = c.output()?;
    if !result.status.success() {
        bail!("{}", String::from_utf8_lossy(&result.stderr).trim())
    }
    Ok(String::from_utf8_lossy(&result.stdout).trim_end().into())
}
pub fn distributions() -> Result<Vec<String>> {
    let output = command("wsl.exe").args(["--list", "--quiet"]).output()?;
    if !output.status.success() {
        bail!("WSL is unavailable")
    }
    let text = if output.stdout.contains(&0) {
        let wide: Vec<u16> = output
            .stdout
            .as_chunks::<2>()
            .0
            .iter()
            .map(|b| u16::from_le_bytes([b[0], b[1]]))
            .collect();
        String::from_utf16_lossy(&wide)
    } else {
        String::from_utf8_lossy(&output.stdout).into_owned()
    };
    Ok(text
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unc_paths_preserve_linux_case() {
        let r = Remote::parse(Path::new(r"\\wsl.localhost\Fedora\home\User\Code")).unwrap();
        assert_eq!(r.path, "/home/User/Code");
        assert_eq!(r.distribution, "Fedora");
        assert!(Remote::parse(Path::new(r"C:\dev")).is_none());
        assert_eq!(
            Remote::parse(Path::new(r"\\?\UNC\wsl.localhost\Fedora\home\User"))
                .unwrap()
                .path,
            "/home/User"
        );
    }
}
