use super::*;

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
