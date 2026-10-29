use super::*;

fn decode(value: &[u8]) -> String {
    match value.split_first() {
        Some((0, bytes)) => String::from_utf16_lossy(
            &bytes
                .as_chunks::<2>()
                .0
                .iter()
                .map(|b| u16::from_le_bytes([b[0], b[1]]))
                .collect::<Vec<_>>(),
        ),
        Some((1, bytes)) => bytes.iter().map(|b| char::from(*b)).collect(),
        _ => String::from_utf8_lossy(value).into_owned(),
    }
}
pub(super) fn import_chromium(data: &Path) -> Result<Value> {
    let original = data.join("Local Storage/leveldb");
    if !original.join("CURRENT").is_file() {
        return Ok(json!({}));
    }
    // Open a private copy: LevelDB recovery must never modify Chromium's database.
    let copy = std::env::temp_dir().join(format!("nido-settings-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&copy)?;
    let result = (|| -> Result<Value> {
        for entry in fs::read_dir(&original)? {
            let entry = entry?;
            if entry.file_type()?.is_file() && entry.file_name() != "LOCK" {
                fs::copy(entry.path(), copy.join(entry.file_name()))?;
            }
        }
        let mut db = rusty_leveldb::DB::open(
            &copy,
            rusty_leveldb::Options {
                create_if_missing: false,
                ..Default::default()
            },
        )
        .map_err(|e| anyhow::anyhow!("{e}"))?;
        use rusty_leveldb::LdbIterator;
        let mut iter = db.new_iter().map_err(|e| anyhow::anyhow!("{e}"))?;
        let mut saved = json!({});
        while let Some((key, value)) = iter.next() {
            if key.first() != Some(&b'_') {
                continue;
            }
            let Some(separator) = key.iter().position(|b| *b == 0) else {
                continue;
            };
            let key = decode(&key[separator + 1..]);
            if let Some(key) = key.strip_prefix("nido.") {
                let value = decode(&value);
                saved[key] = serde_json::from_str(&value).unwrap_or_else(|_| json!(value));
            }
        }
        if saved.get("compactMode").is_none()
            && let Some(old) = saved.get("autoHideSessionTabs").cloned()
        {
            saved["compactMode"] = old;
        }
        Ok(saved)
    })();
    fs::remove_dir_all(&copy).context("Cannot remove temporary settings copy")?;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_chromium_latin1_and_utf16() {
        assert_eq!(decode(&[1, b'1', b'4']), "14");
        assert_eq!(decode(&[0, 0xe5, 0x65, 0x2c, 0x67]), "日本");
    }
    #[test]
    fn imports_a_private_chromium_copy_and_preserves_damaged_settings() -> Result<()> {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let leveldb = root.join("Local Storage/leveldb");
        fs::create_dir_all(&leveldb)?;
        {
            let mut db = rusty_leveldb::DB::open(&leveldb, rusty_leveldb::Options::default())
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            db.put(b"_file://\0\x01nido.fontSize", b"\x0119")
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            db.put(b"_file://\0\x01nido.autoHideSessionTabs", b"\x01true")
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            db.flush().map_err(|e| anyhow::anyhow!("{e}"))?;
        }
        let before = fs::read(leveldb.join("CURRENT"))?;
        let imported = load(&root)?;
        assert_eq!(imported["fontSize"], 19.0);
        assert_eq!(imported["compactMode"], true);
        assert_eq!(fs::read(leveldb.join("CURRENT"))?, before);
        save(&root, &imported)?;
        assert_eq!(load(&root)?["fontSize"], 19.0);
        fs::write(root.join("settings.json"), "damaged")?;
        assert!(save(&root, &defaults()).is_err());
        assert_eq!(fs::read_to_string(root.join("settings.json"))?, "damaged");
        fs::remove_dir_all(root)?;
        Ok(())
    }
}
