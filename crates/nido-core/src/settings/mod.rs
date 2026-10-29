mod chromium;
use chromium::import_chromium;

use crate::persistence::write_json;
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{fs, path::Path};

pub fn defaults() -> Value {
    json!({
        "language":"en","theme":"dark","historyEnabled":true,"wordWrap":false,
        "methodSeparators":false,"stickyScroll":true,"stickyScrollMaxLines":5,
        "terminalShell":"auto","editorConfig":true,"relativeLineNumbers":false,
        "sidebar":true,"activityBarPosition":"left","compactMode":false,
        "animations":true,"smoothCursor":false,"smoothBlink":false,
        "scrollFollowCursor":true,"formatOnSave":true,"clipboardSharing":false,
        "fontFamily":"Cascadia Code","fontWeight":350,"fontSize":14.0,
        "lineHeight":1.5,"sidebarWidth":243.0
    })
}
pub fn load(data: &Path) -> Result<Value> {
    let path = data.join("settings.json");
    let mut value = defaults();
    let saved = if path.exists() {
        serde_json::from_slice::<Value>(&fs::read(path)?)?
    } else {
        import_chromium(data)?
    };
    if !saved.is_object() {
        bail!("Invalid settings; the original file was preserved")
    }
    if let Some(map) = saved.as_object() {
        for (key, saved) in map {
            if value[key].is_boolean() && saved.is_boolean()
                || value[key].is_number() && saved.is_number()
                || value[key].is_string() && saved.is_string()
            {
                value[key] = saved.clone();
            }
        }
    }
    for (key, min, max) in [
        ("fontSize", 8.0, 40.0),
        ("lineHeight", 1.0, 2.5),
        ("sidebarWidth", 160.0, 480.0),
        ("fontWeight", 100.0, 900.0),
        ("stickyScrollMaxLines", 1.0, 10.0),
    ] {
        let number = value[key].as_f64().unwrap_or(min).clamp(min, max);
        value[key] = json!(number);
    }
    Ok(value)
}

pub fn save(data: &Path, value: &Value) -> Result<()> {
    let path = data.join("settings.json");
    if path.exists()
        && !serde_json::from_slice::<Value>(&fs::read(&path)?).is_ok_and(|v| v.is_object())
    {
        bail!("Invalid settings; the original file was preserved")
    }
    write_json(&data.join("settings.json"), value)
}
