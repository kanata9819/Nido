mod manifest;
pub use manifest::validate;

use anyhow::{Context, Result, bail};
use nido_core::persistence::write_json;
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

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
    if !discover(&crate::session::resources()?, data)?["packs"]
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
    if discover(&crate::session::resources()?, data)?["packs"]
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
