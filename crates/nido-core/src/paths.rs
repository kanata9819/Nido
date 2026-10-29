use anyhow::{Context, Result, bail};
use std::path::{Component, Path, PathBuf};

pub fn normal_path(path: PathBuf) -> PathBuf {
    let path = path.canonicalize().unwrap_or(path);
    plain_path(&path)
}
fn plain_path(path: &Path) -> PathBuf {
    let name = path.to_string_lossy();
    if let Some(tail) = name.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{tail}"))
    } else if let Some(tail) = name.strip_prefix(r"\\?\") {
        PathBuf::from(tail)
    } else {
        path.to_path_buf()
    }
}
pub fn relative(root: &Path, path: &Path) -> String {
    let mut root = plain_path(root);
    let mut path = plain_path(path);
    if !path.starts_with(&root) {
        root = normal_path(root);
        path = normal_path(path);
    }
    path.strip_prefix(root)
        .unwrap_or(&path)
        .to_string_lossy()
        .replace('\\', "/")
}

pub fn inside(root: &Path, value: &str, new: bool) -> Result<PathBuf> {
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
    {
        bail!("Choose a relative path inside the workspace")
    }
    let root = root.canonicalize()?;
    let joined = root.join(path);
    let actual = if new {
        joined
            .parent()
            .context("Missing parent")?
            .canonicalize()?
            .join(joined.file_name().context("Missing filename")?)
    } else {
        joined.canonicalize()?
    };
    if !actual.starts_with(&root) {
        bail!("Path is outside this workspace")
    }
    Ok(actual)
}

pub fn writable(root: &Path, value: &str, new: bool) -> Result<PathBuf> {
    if value.is_empty()
        || Path::new(value)
            .components()
            .any(|c| c.as_os_str().eq_ignore_ascii_case(".git"))
    {
        bail!("Choose a path outside .git")
    }
    let path = inside(root, value, new)?;
    let canonical_root = root.canonicalize()?;
    if path == canonical_root
        || path
            .strip_prefix(&canonical_root)?
            .components()
            .any(|c| c.as_os_str().eq_ignore_ascii_case(".git"))
    {
        bail!("Cannot change the workspace root or .git")
    }
    if new && path.symlink_metadata().is_ok() {
        bail!("A file or folder already exists at that path")
    }
    Ok(path)
}
