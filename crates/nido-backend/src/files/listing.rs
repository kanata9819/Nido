use super::*;

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
