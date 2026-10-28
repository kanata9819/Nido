use crate::{
    files::digest,
    persistence::write_json,
    rpc::Rpc,
    wsl::{Remote, editor_path},
};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

static WRITING: OnceLock<Mutex<()>> = OnceLock::new();
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn key(path: &str) -> String {
    let normalized = if let Some(remote) = Remote::parse(Path::new(path)) {
        format!(
            "wsl://{}{}",
            remote.distribution.to_lowercase(),
            remote.path
        )
    } else {
        path.trim_start_matches(r"\\?\")
            .replace('\\', "/")
            .to_lowercase()
    };
    digest(normalized.as_bytes())
}
pub fn token(snapshot: &Value) -> String {
    format!(
        "{}:{}:{}:{}",
        snapshot["buffer"],
        snapshot["tick"],
        snapshot["fileformat"].as_str().unwrap_or("unix"),
        snapshot["endOfLine"].as_bool().unwrap_or(false)
    )
}

pub struct History {
    directory: PathBuf,
}
impl History {
    pub fn new(data: &Path) -> Self {
        Self {
            directory: data.join("time-machine"),
        }
    }
    fn read(&self, path: &str) -> Result<Value> {
        let destination = self.directory.join(format!("{}.json", key(path)));
        if !destination.exists() {
            return Ok(json!({"version":1,"path":path,"revisions":[]}));
        }
        if fs::metadata(&destination)?.len() > 8 * 1024 * 1024 {
            bail!("Local history exceeds storage limit")
        }
        let data: Value = serde_json::from_slice(&fs::read(destination)?)?;
        if data["version"] != 1
            || key(data["path"].as_str().unwrap_or("")) != key(path)
            || !data["revisions"].as_array().is_some_and(|items| {
                items.len() <= 20
                    && items.iter().all(|v| {
                        v["id"]
                            .as_str()
                            .is_some_and(|s| uuid::Uuid::parse_str(s).is_ok())
                            && v["timestamp"].as_u64().is_some_and(|n| n > 0)
                            && ["saved", "draft", "restored"]
                                .contains(&v["kind"].as_str().unwrap_or(""))
                            && v["text"]
                                .as_str()
                                .is_some_and(|s| s.len() <= 1_048_576 && !s.contains('\0'))
                            && v["endOfLine"].is_boolean()
                            && ["unix", "dos", "mac"]
                                .contains(&v["fileformat"].as_str().unwrap_or(""))
                    })
            })
        {
            bail!("Local history is damaged; existing history was preserved")
        }
        Ok(data)
    }
    pub fn list(&self, path: &str) -> Result<Value> {
        Ok(self.read(path)?["revisions"].clone())
    }
    pub fn record(&self, path: &str, content: &Value, kind: &str) -> Result<()> {
        let _lock = WRITING
            .get_or_init(Mutex::default)
            .lock()
            .map_err(|_| anyhow::anyhow!("History writer failed"))?;
        let text = content["text"].as_str().context("Missing history text")?;
        if text.len() > 1_048_576 || text.lines().count() > 20_000 || text.contains('\0') {
            bail!("Time Machine supports text files up to 1 MB and 20,000 lines")
        }
        let mut data = self.read(path)?;
        let revisions = data["revisions"]
            .as_array_mut()
            .context("Invalid history")?;
        if revisions.first().is_some_and(|p| {
            ["text", "fileformat", "endOfLine"]
                .iter()
                .all(|k| p[k] == content[k])
        }) {
            return Ok(());
        }
        let revision = json!({"id":uuid::Uuid::new_v4().to_string(),"timestamp":now(),"kind":kind,"text":text,"endOfLine":content["endOfLine"],"fileformat":content["fileformat"],"bytes":text.len(),"lines":text.lines().count().max(1)});
        revisions.insert(0, revision);
        revisions.truncate(20);
        while serde_json::to_vec(&data)?.len() > 8 * 1024 * 1024 {
            data["revisions"].as_array_mut().unwrap().pop();
        }
        fs::create_dir_all(&self.directory)?;
        let destination = self.directory.join(format!("{}.json", key(path)));
        write_json(&destination, &data)?;
        let mut entries: Vec<_> = fs::read_dir(&self.directory)?
            .filter_map(|e| e.ok())
            .filter(|e| {
                let name = e.file_name();
                let name = name.to_string_lossy();
                name.len() == 69
                    && name.ends_with(".json")
                    && name[..64].bytes().all(|b| b.is_ascii_hexdigit())
            })
            .map(|e| {
                let meta = e.metadata()?;
                Ok((e.path(), meta.len(), meta.modified()?))
            })
            .collect::<std::io::Result<_>>()?;
        entries.sort_by_key(|e| e.2);
        let mut total: u64 = entries.iter().map(|e| e.1).sum();
        let mut count = entries.len();
        for (path, bytes, _) in entries {
            if total <= 64 * 1024 * 1024 && count <= 200 {
                break;
            }
            if path != destination {
                fs::remove_file(path)?;
                total -= bytes;
                count -= 1;
            }
        }
        Ok(())
    }
    pub fn capture(&self, rpc: &Rpc, root: &Path, tokens: &mut Value) -> Result<()> {
        let mode = rpc.call("nvim_get_mode", json!([]))?;
        if mode["blocking"] == true || mode["mode"].as_str().unwrap_or("").starts_with('r') {
            return Ok(());
        }
        let changed = rpc.lua(
            "return require('nido_history').changed(...)",
            json!([tokens]),
        )?;
        for snapshot in changed.as_array().into_iter().flatten() {
            let name = snapshot["path"].as_str().context("Missing history path")?;
            let path = if let Some(remote) = Remote::parse(root) {
                remote.host(name).to_string_lossy().into_owned()
            } else {
                name.into()
            };
            if snapshot["modified"] == true
                && self.list(&path)?.as_array().is_none_or(Vec::is_empty)
                && let Ok(original) = fs::read_to_string(&path)
            {
                let format = if original.contains("\r\n") {
                    "dos"
                } else {
                    "unix"
                };
                self.record(&path,&json!({"text":original.replace("\r\n","\n"),"endOfLine":original.ends_with('\n'),"fileformat":format}),"saved")?;
            }
            self.record(
                &path,
                snapshot,
                if snapshot["modified"] == true {
                    "draft"
                } else {
                    "saved"
                },
            )?;
            let next = json!([
                snapshot["buffer"],
                snapshot["tick"],
                snapshot["fileformat"],
                snapshot["endOfLine"]
            ]);
            let list = tokens.as_array_mut().context("Invalid history tokens")?;
            list.retain(|t| t[0] != snapshot["buffer"]);
            list.push(next);
        }
        Ok(())
    }
    pub fn action(&self, rpc: &Rpc, root: &Path, action: &str, args: &Value) -> Result<Value> {
        let snapshot = rpc.lua("return require('nido_history').current()", json!([]))?;
        if let Some(error) = snapshot["error"].as_str() {
            bail!("{error}")
        }
        let name = snapshot["path"].as_str().context("Open a named file")?;
        let remote = Remote::parse(root);
        let path = remote
            .as_ref()
            .map(|r| r.host(name).to_string_lossy().into_owned())
            .unwrap_or_else(|| name.into());
        self.record(
            &path,
            &snapshot,
            if snapshot["modified"] == true {
                "draft"
            } else {
                "saved"
            },
        )?;
        let versions = self.list(&path)?;
        if action == "list" {
            return Ok(json!({"path":path,"versions":versions}));
        }
        if args["path"].as_str() != Some(path.as_str()) {
            bail!("The active file changed. Reopen Time Machine")
        }
        let revision = versions
            .as_array()
            .and_then(|a| a.iter().find(|v| v["id"] == args["id"]))
            .context("History version is unavailable")?;
        if action == "preview" {
            let diff = rpc.lua(
                "return require('nido_history').diff(...)",
                json!([revision["text"], snapshot["text"]]),
            )?;
            return Ok(
                json!({"path":path,"version":revision,"token":token(&snapshot),"diff":diff,"identical":revision["text"]==snapshot["text"]}),
            );
        }
        if action == "restore" {
            if args["token"].as_str() != Some(token(&snapshot).as_str()) {
                bail!("The file changed. Refresh the preview before restoring")
            }
            let restored = rpc.lua(
                "return require('nido_history').restore(...)",
                json!([
                    editor_path(Path::new(&path), remote.as_ref()),
                    args["token"],
                    revision
                ]),
            )?;
            if let Some(error) = restored["error"].as_str() {
                bail!("{error}")
            }
            self.record(&path, &restored, "restored")?;
            return Ok(json!({"restored":true}));
        }
        bail!("Unknown history action")
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stores_compatible_revisions_and_rejects_corruption() -> Result<()> {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let history = History::new(&dir);
        let file = dir.join("日本語.txt").to_string_lossy().into_owned();
        let content = json!({"text":"hello\n","endOfLine":true,"fileformat":"dos"});
        history.record(&file, &content, "saved")?;
        history.record(&file, &content, "draft")?;
        assert_eq!(history.list(&file)?.as_array().unwrap().len(), 1);
        fs::write(
            history.directory.join(format!("{}.json", key(&file))),
            "broken",
        )?;
        assert!(history.record(&file, &content, "draft").is_err());
        fs::remove_dir_all(dir)?;
        Ok(())
    }
}
