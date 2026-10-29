use super::*;

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
