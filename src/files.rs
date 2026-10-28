use crate::rpc::Rpc;
use anyhow::{Context, Result, bail};
use regex::{Regex, RegexBuilder};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};

pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
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
    let root = plain_path(root);
    let path = plain_path(path);
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

pub fn entries(root: &Path, folder: &str) -> Result<Value> {
    let path = inside(root, folder, false)?;
    let mut entries = vec![];
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        if entry.file_name().eq_ignore_ascii_case(".git") {
            continue;
        }
        let path = entry.path();
        let Ok(actual) = path.canonicalize() else {
            continue;
        };
        if !actual.starts_with(root.canonicalize()?) {
            continue;
        }
        entries.push(json!({"name": entry.file_name().to_string_lossy(), "path": relative(root, &path), "directory": path.is_dir()}));
    }
    entries.sort_by_key(|e| {
        (
            !e["directory"].as_bool().unwrap_or(false),
            e["name"].as_str().unwrap_or("").to_lowercase(),
        )
    });
    Ok(json!(entries))
}

pub fn walk(root: &Path, scope: &str) -> Result<Vec<PathBuf>> {
    let start = inside(root, scope, false)?;
    let mut files = Vec::new();
    let walker = ignore::WalkBuilder::new(start)
        .hidden(false)
        .follow_links(false)
        .max_depth(Some(32))
        .filter_entry(|e| {
            !e.file_name().to_str().is_some_and(|n| {
                [
                    ".git",
                    "node_modules",
                    "target",
                    "dist",
                    "out",
                    ".next",
                    "build",
                ]
                .contains(&n)
            })
        })
        .build();
    for entry in walker {
        let entry = entry?;
        if entry.file_type().is_some_and(|t| t.is_file()) {
            files.push(entry.into_path());
        }
        if files.len() >= 20_000 {
            break;
        }
    }
    files.sort();
    Ok(files)
}

pub fn text(path: &Path) -> Result<String> {
    let mut data = Vec::new();
    fs::File::open(path)?
        .take(1_048_577)
        .read_to_end(&mut data)?;
    if data.len() > 1_048_576 || data.contains(&0) {
        bail!("Not a UTF-8 text file below 1 MB")
    }
    String::from_utf8(data).context("Not UTF-8 text")
}

pub fn matcher(query: &str, options: &Value) -> Result<Regex> {
    if query.is_empty() || query.len() > 4000 {
        bail!("Enter a search query up to 4000 bytes")
    }
    let mut source = if options["regex"].as_bool().unwrap_or(false) {
        query.to_owned()
    } else {
        regex::escape(query)
    };
    if options["wholeWord"].as_bool().unwrap_or(false) {
        source = format!(r"\b(?:{source})\b");
    }
    RegexBuilder::new(&source)
        .case_insensitive(!options["caseSensitive"].as_bool().unwrap_or(false))
        .size_limit(4 * 1024 * 1024)
        .build()
        .context("Invalid regular expression")
}

pub struct Search {
    pub token: String,
    pub matches: Vec<Value>,
    pub hashes: BTreeMap<String, String>,
    pub query: String,
    pub options: Value,
}
#[derive(Clone)]
pub struct Replacement {
    pub token: String,
    pub files: Vec<(String, String, String, usize)>,
}

pub fn search(root: &Path, query: &str, options: Value) -> Result<Search> {
    let regex = matcher(query, &options)?;
    let mut result = Search {
        token: uuid::Uuid::new_v4().to_string(),
        matches: vec![],
        hashes: BTreeMap::new(),
        query: query.into(),
        options,
    };
    let folder = result.options["folder"].as_str().unwrap_or("");
    for path in walk(root, folder)? {
        let Ok(content) = text(&path) else { continue };
        let name = relative(root, &path);
        for (line, source) in content.trim_start_matches('\u{feff}').lines().enumerate() {
            if let Some(found) = regex.find(source) {
                result
                    .hashes
                    .insert(name.clone(), digest(content.as_bytes()));
                result.matches.push(json!({"path": name, "line": line + 1, "column": found.start() + 1, "text": source.chars().take(500).collect::<String>()}));
                if result.matches.len() >= 201 {
                    return Ok(result);
                }
            }
        }
    }
    Ok(result)
}

impl Search {
    pub fn preview(
        &self,
        root: &Path,
        token: &str,
        replacement: &str,
        selected: &[usize],
    ) -> Result<Replacement> {
        if self.token != token || selected.is_empty() || selected.len() > 200 {
            bail!("Search results changed. Search again")
        }
        if replacement.len() > 4000 || replacement.contains(['\r', '\n', '\0']) {
            bail!("Enter a single-line replacement")
        }
        let regex = matcher(&self.query, &self.options)?;
        let mut groups: BTreeMap<String, BTreeSet<usize>> = BTreeMap::new();
        for &index in selected {
            let item = self
                .matches
                .get(index)
                .context("Search result no longer exists")?;
            groups
                .entry(item["path"].as_str().context("Invalid search path")?.into())
                .or_default()
                .insert(item["line"].as_u64().context("Invalid search line")? as usize);
        }
        let mut preview = Replacement {
            token: uuid::Uuid::new_v4().to_string(),
            files: vec![],
        };
        let mut bytes = 0;
        for (name, selected) in groups {
            let original = text(&inside(root, &name, false)?)?;
            if Some(&digest(original.as_bytes())) != self.hashes.get(&name) {
                bail!("Search results changed. Search again")
            }
            let mut count = 0;
            let mut changed = String::new();
            for (index, line) in original.split_inclusive('\n').enumerate() {
                if selected.contains(&(index + 1)) {
                    let (line, ending) = if let Some(body) = line.strip_suffix("\r\n") {
                        (body, "\r\n")
                    } else if let Some(body) = line.strip_suffix('\n') {
                        (body, "\n")
                    } else {
                        (line, "")
                    };
                    count += regex.find_iter(line).count();
                    let repl = if self.options["regex"].as_bool().unwrap_or(false) {
                        regex.replace_all(line, replacement)
                    } else {
                        regex.replace_all(line, regex::NoExpand(replacement))
                    };
                    changed.push_str(&repl);
                    changed.push_str(ending);
                } else {
                    changed.push_str(line);
                }
            }
            bytes += original.len() + changed.len();
            if bytes > 8 * 1024 * 1024 {
                bail!("Replacement preview is too large")
            }
            if changed != original {
                preview.files.push((name, original, changed, count));
            }
        }
        Ok(preview)
    }
}

impl Replacement {
    pub fn apply(&self, root: &Path, rpc: &Rpc, token: &str) -> Result<Value> {
        if token != self.token {
            bail!("Replacement preview changed")
        }
        // Check every target before touching any buffer; replacements remain undoable edits.
        for (name, before, _, _) in &self.files {
            if text(&writable(root, name, false)?)? != *before {
                bail!("A file changed. Search again")
            }
        }
        let remote = crate::wsl::Remote::parse(root);
        let args: Vec<Value> = self.files.iter().map(|(name,before,after,_)| {
            let path = root.join(name);
            json!({"path": crate::wsl::editor_path(&path, remote.as_ref()), "before": before, "after": after})
        }).collect();
        rpc.lua(
            "return require('nido_replacement').apply(...)",
            json!([args]),
        )?;
        Ok(
            json!({"files": self.files.len(), "count": self.files.iter().map(|f| f.3).sum::<usize>()}),
        )
    }
}

pub fn mutate(root: &Path, rpc: &Rpc, action: &str, name: &str, target: &str) -> Result<()> {
    if action == "createFile" || action == "createDirectory" {
        let path = writable(root, name, true)?;
        if action == "createFile" {
            fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(path)?
                .flush()?;
        } else {
            fs::create_dir(path)?;
        }
        return Ok(());
    }
    let source = writable(root, name, false)?;
    let remote = crate::wsl::Remote::parse(root);
    let editor_source = crate::wsl::editor_path(&source, remote.as_ref());
    let affected = rpc.lua(
        r#"local path = ...; local result = {}
for _, b in ipairs(vim.api.nvim_list_bufs()) do
 local name = vim.api.nvim_buf_get_name(b)
 if name == path or name:sub(1,#path+1) == path .. '/' or name:sub(1,#path+1) == path .. '\\' then
  if vim.bo[b].modified then error('Save unsaved changes first') end
  table.insert(result, {id=b, name=name})
 end
end
return result"#,
        json!([editor_source]),
    )?;
    if action == "delete" {
        if let Some(remote) = crate::wsl::Remote::parse(&source) {
            remote.run(&["gio", "trash", "--", &remote.path])?;
        } else {
            trash::delete(&source)?;
        }
        for item in affected.as_array().into_iter().flatten() {
            rpc.call("nvim_buf_delete", json!([item["id"], {"force": false}]))?;
        }
    } else {
        let dest = writable(root, target, true)?;
        if dest.starts_with(&source) {
            bail!("Cannot place a folder inside itself")
        }
        match action {
            "copy" => copy_tree(&source, &dest)?,
            "rename" => {
                fs::rename(&source, &dest)?;
                let destination = crate::wsl::editor_path(&dest, remote.as_ref());
                for item in affected.as_array().into_iter().flatten() {
                    let old = item["name"].as_str().unwrap_or_default();
                    let new = format!("{}{}", destination, &old[editor_source.len()..]);
                    rpc.call("nvim_buf_set_name", json!([item["id"], new]))?;
                }
            }
            _ => bail!("Unknown file action"),
        }
    }
    Ok(())
}

fn copy_tree(source: &Path, destination: &Path) -> Result<()> {
    if source.symlink_metadata()?.file_type().is_symlink() {
        bail!("Copy symbolic links separately")
    }
    if source.is_dir() {
        fs::create_dir(destination)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy_tree(&entry.path(), &destination.join(entry.file_name()))?;
        }
    } else {
        let mut input = fs::File::open(source)?;
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)?;
        std::io::copy(&mut input, &mut output)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prevents_path_escape_and_git_mutations() -> Result<()> {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::create_dir(&root)?;
        assert!(inside(&root, "../escape", false).is_err());
        assert!(writable(&root, ".GIT/config", true).is_err());
        fs::write(root.join("one.txt"), "日本語 Rust\r\nRust\r\n")?;
        let found = search(&root, "Rust", json!({}))?;
        let preview = found.preview(&root, &found.token, "$literal", &[0])?;
        assert_eq!(preview.files[0].2, "日本語 $literal\r\nRust\r\n");
        let found = search(&root, "Rust$", json!({"regex":true}))?;
        let preview = found.preview(&root, &found.token, "Native", &[0, 1])?;
        assert_eq!(preview.files[0].2, "日本語 Native\r\nNative\r\n");
        fs::write(root.join("one.txt"), "changed")?;
        assert!(found.preview(&root, &found.token, "x", &[0]).is_err());
        fs::remove_dir_all(root)?;
        Ok(())
    }
}
