use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Clone, Default, Serialize, Deserialize, Debug)]
pub struct SavedFile {
    pub path: String,
    pub line: usize,
    pub column: usize,
}
#[derive(Clone, Default, Serialize, Deserialize, Debug)]
pub struct SavedWorkspace {
    pub root: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub terminal: bool,
    pub files: Vec<SavedFile>,
    pub current: String,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Layout {
    pub version: u32,
    pub workspaces: Vec<SavedWorkspace>,
    pub active: usize,
    #[serde(default)]
    pub window: Value,
}
impl Default for Layout {
    fn default() -> Self {
        Self {
            version: 1,
            workspaces: vec![],
            active: 0,
            window: json!({}),
        }
    }
}

pub fn data_dir() -> PathBuf {
    if let Some(path) = std::env::var_os("NIDO_DATA_DIR") {
        return PathBuf::from(path);
    }
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("nido")
}

pub fn read_favorites(path: &Path) -> Result<Value> {
    if !path.exists() {
        return Ok(json!([]));
    }
    let value: Value = serde_json::from_slice(&fs::read(path)?)?;
    if !value.as_array().is_some_and(|items| {
        items.iter().all(|v| {
            v["root"]
                .as_str()
                .is_some_and(|s| Path::new(s).is_absolute())
                && v["name"].is_string()
                && ["editor", "terminal"].contains(&v["kind"].as_str().unwrap_or(""))
        })
    }) {
        bail!("Invalid favorites; the original file was preserved")
    }
    Ok(value)
}

pub fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    fs::create_dir_all(path.parent().context("Missing data directory")?)?;
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(&serde_json::to_vec(value)?)?;
        file.sync_all()?;
        fs::rename(&temp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn validate(layout: Layout) -> Result<Layout> {
    if layout.version != 1
        || layout.workspaces.iter().any(|w| {
            !Path::new(&w.root).is_absolute()
                || !["", "editor", "terminal"].contains(&w.kind.as_str())
                || w.files
                    .iter()
                    .any(|f| !Path::new(&f.path).is_absolute() || f.line == 0)
        })
    {
        bail!("Invalid saved workspace data; the original file was preserved")
    }
    Ok(layout)
}

pub fn read_layout(path: &Path) -> Result<Layout> {
    let read = |p: &Path| -> Result<Layout> { validate(serde_json::from_slice(&fs::read(p)?)?) };
    match read(path) {
        Ok(layout) => Ok(layout),
        Err(error) => {
            let backup = PathBuf::from(format!("{}.bak", path.display()));
            if let Ok(layout) = read(&backup) {
                return Ok(layout);
            }
            if !path.exists() && !backup.exists() {
                return Ok(Layout::default());
            }
            Err(error)
        }
    }
}

pub fn write_layout(path: &Path, layout: &Layout) -> Result<()> {
    validate(layout.clone())?;
    if let Ok(old) = fs::read(path)
        .and_then(|bytes| serde_json::from_slice::<Layout>(&bytes).map_err(std::io::Error::other))
        && validate(old.clone()).is_ok()
    {
        write_json(&PathBuf::from(format!("{}.bak", path.display())), &old)?;
    }
    write_json(path, layout)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn damaged_primary_does_not_destroy_backup() -> Result<()> {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::create_dir(&root)?;
        let path = root.join("workspaces.json");
        write_layout(&path, &Layout::default())?;
        write_layout(&path, &Layout::default())?;
        fs::write(&path, b"broken")?;
        assert_eq!(read_layout(&path)?.version, 1);
        fs::remove_dir_all(root)?;
        Ok(())
    }
    #[test]
    fn favorites_reject_invalid_paths_without_changing_the_file() -> Result<()> {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::create_dir(&root)?;
        let path = root.join("favorites.json");
        let invalid = br#"[{"root":"../outside","name":"bad","kind":"editor"}]"#;
        fs::write(&path, invalid)?;
        assert!(read_favorites(&path).is_err());
        assert_eq!(fs::read(&path)?, invalid);
        fs::remove_dir_all(root)?;
        Ok(())
    }
}
