use crate::persistence::write_json;
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

pub fn validate(mut value: Value, bundled: bool) -> Result<Value> {
    let text = |key: &str| {
        value[key]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 4000 && !s.contains('\0'))
    };
    let id = text("id").context("Missing language pack id")?;
    if value["schemaVersion"] != 1
        || !regex::Regex::new(r"^[a-z][a-z0-9-]{0,63}$")?.is_match(id)
        || !regex::Regex::new(r"^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$")?
            .is_match(text("version").unwrap_or(""))
        || text("title").is_none()
        || text("description").is_none()
        || !regex::Regex::new(r"^[a-zA-Z][a-zA-Z0-9_-]{0,63}$")?
            .is_match(text("serverName").unwrap_or(""))
    {
        bail!("Invalid language pack manifest")
    }
    let strings = |v: &Value| {
        v.as_array().is_some_and(|a| {
            !a.is_empty()
                && a.len() <= 100
                && a.iter().all(|s| {
                    s.as_str()
                        .is_some_and(|s| !s.is_empty() && s.len() <= 4000 && !s.contains('\0'))
                })
        })
    };
    let types = regex::Regex::new(r"^[a-zA-Z0-9_-]+$")?;
    if !strings(&value["filetypes"])
        || !value["filetypes"]
            .as_array()
            .unwrap()
            .iter()
            .all(|v| types.is_match(v.as_str().unwrap()))
    {
        bail!("Invalid language pack filetypes")
    }
    if let Some(adapter) = value.get("adapter")
        && (!bundled || ![json!("rust"), json!("typescript"), json!("deno")].contains(adapter))
    {
        bail!("Only bundled packs may select an adapter")
    }
    if value.get("command").is_some_and(|v| !strings(v)) {
        bail!("Invalid language server command")
    }
    if let Some(commands) = value.get("commands")
        && !commands.as_object().is_some_and(|o| {
            !o.is_empty()
                && o.iter()
                    .all(|(k, v)| ["win32", "linux"].contains(&k.as_str()) && strings(v))
        })
    {
        bail!("Invalid platform commands")
    }
    if value.get("adapter").is_none()
        && value.get("command").is_none()
        && value.get("commands").is_none()
    {
        bail!("Language pack has no server command")
    }
    if let Some(markers) = value.get("rootMarkers")
        && (!strings(markers)
            || markers.as_array().unwrap().iter().any(|v| {
                v.as_str()
                    .is_none_or(|s| s.contains(['/', '\\']) || s == "..")
            }))
    {
        bail!("Invalid root markers")
    }
    for field in ["settings", "initOptions"] {
        if value.get(field).is_some_and(|v| !v.is_object()) {
            bail!("Invalid {field}")
        }
    }
    if let Some(category) = value.get("category")
        && category != "language"
        && category != "other"
    {
        bail!("Invalid pack category")
    }
    if value.get("setup").is_some() && text("setup").is_none() {
        bail!("Invalid pack setup description")
    }
    if let Some(languages) = value.get("languages") {
        let valid_text = |value: &Value| {
            value
                .as_str()
                .is_some_and(|s| !s.is_empty() && s.len() <= 4000 && !s.contains('\0'))
        };
        if !languages.as_array().is_some_and(|items| {
            items.len() <= 30
                && items.iter().all(|item| {
                    item.is_object()
                        && [json!("tools"), json!("runtimes")].contains(&item["category"])
                        && ["id", "title", "mark", "extensions", "description"]
                            .iter()
                            .all(|key| valid_text(&item[key]))
                        && ["keywords", "requirement", "setup", "command"]
                            .iter()
                            .all(|key| item.get(key).is_none_or(valid_text))
                })
        }) {
            bail!("Invalid language pack descriptions")
        }
    }
    let allowed = [
        "schemaVersion",
        "id",
        "version",
        "title",
        "description",
        "category",
        "filetypes",
        "serverName",
        "command",
        "commands",
        "rootMarkers",
        "settings",
        "initOptions",
        "setup",
        "languages",
        "adapter",
    ];
    value
        .as_object_mut()
        .unwrap()
        .retain(|key, _| allowed.contains(&key.as_str()));
    value["bundled"] = json!(bundled);
    Ok(value)
}

pub fn discover(resources: &Path, data: &Path) -> Result<Value> {
    let mut packs = vec![];
    let mut errors = vec![];
    let mut names = HashSet::new();
    let mut servers = HashSet::new();
    for (folder, bundled) in [
        (resources.join("nido/language-packs"), true),
        (data.join("language-packs"), false),
    ] {
        if !folder.exists() {
            continue;
        }
        let mut entries: Vec<_> = fs::read_dir(folder)?.collect::<std::io::Result<_>>()?;
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let path = if entry.path().is_dir() {
                entry.path().join("pack.json")
            } else if entry.path().extension().is_some_and(|e| e == "json") {
                entry.path()
            } else {
                continue;
            };
            let result = (|| -> Result<Value> {
                if fs::metadata(&path)?.len() > 128000 {
                    bail!("Language pack exceeds 128 KB")
                }
                let value = validate(serde_json::from_slice(&fs::read(path)?)?, bundled)?;
                if names.contains(value["id"].as_str().unwrap())
                    || servers.contains(value["serverName"].as_str().unwrap())
                {
                    bail!("Duplicate pack id or server name")
                }
                names.insert(value["id"].as_str().unwrap().to_owned());
                servers.insert(value["serverName"].as_str().unwrap().to_owned());
                Ok(value)
            })();
            match result {
                Ok(pack) => packs.push(pack),
                Err(error) => {
                    errors.push(format!("{}: {error}", entry.file_name().to_string_lossy()))
                }
            }
        }
    }
    let settings_path = data.join("language-packs-state.json");
    let settings = match read_settings(&settings_path) {
        Ok(settings) => settings,
        Err(error) => {
            errors.push(error.to_string());
            json!({"disabled":[]})
        }
    };
    Ok(
        json!({"packs":packs,"disabled":settings["disabled"].as_array().cloned().unwrap_or_default(),"errors":errors}),
    )
}
fn read_settings(path: &Path) -> Result<Value> {
    if !path.exists() {
        return Ok(json!({"version":1,"disabled":[]}));
    }
    let settings: Value = serde_json::from_slice(&fs::read(path)?)?;
    if !settings["disabled"]
        .as_array()
        .is_some_and(|items| items.iter().all(Value::is_string))
    {
        bail!("Invalid language pack settings; the original file was preserved")
    }
    Ok(settings)
}
pub fn set_enabled(data: &Path, id: &str, enabled: bool) -> Result<()> {
    let path = data.join("language-packs-state.json");
    if !discover(&crate::backend::resources()?, data)?["packs"]
        .as_array()
        .is_some_and(|items| items.iter().any(|p| p["id"] == id))
    {
        bail!("Unknown language pack")
    }
    let mut settings = read_settings(&path)?;
    let mut disabled = settings["disabled"].as_array().cloned().unwrap_or_default();
    disabled.retain(|v| v.as_str() != Some(id));
    if !enabled {
        disabled.push(json!(id));
    }
    settings["disabled"] = json!(disabled);
    write_json(&path, &settings)
}
pub fn install(data: &Path, source: &Path) -> Result<PathBuf> {
    if fs::metadata(source)?.len() > 128000 {
        bail!("Language pack exceeds 128 KB")
    }
    let mut pack = validate(serde_json::from_slice(&fs::read(source)?)?, false)?;
    if discover(&crate::backend::resources()?, data)?["packs"]
        .as_array()
        .is_some_and(|items| {
            items
                .iter()
                .any(|p| p["id"] == pack["id"] || p["serverName"] == pack["serverName"])
        })
    {
        bail!("A pack with this id or language server is already installed")
    }
    pack.as_object_mut().unwrap().remove("bundled");
    let path = data
        .join("language-packs")
        .join(format!("{}.json", pack["id"].as_str().unwrap()));
    fs::create_dir_all(path.parent().context("Missing pack folder")?)?;
    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)?;
    file.write_all(&serde_json::to_vec_pretty(&pack)?)?;
    file.sync_all()?;
    Ok(path)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn external_packs_cannot_inject_a_lua_adapter() {
        let p = json!({"schemaVersion":1,"id":"test","version":"1.0.0","title":"Test","description":"Test","filetypes":["rust"],"serverName":"test","adapter":"rust"});
        assert!(validate(p.clone(), false).is_err());
        assert!(validate(p, true).is_ok());
    }
}
