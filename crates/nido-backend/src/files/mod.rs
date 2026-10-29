mod listing;
mod mutation;
mod search;
pub use listing::{entries, text, walk};
pub use mutation::mutate;
pub use search::{Replacement, Search, search};

use crate::rpc::Rpc;
use anyhow::{Context, Result, bail};
use regex::{Regex, RegexBuilder};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

use nido_core::paths::{inside, relative, writable};

pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
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
        fs::create_dir(root.join("alias-parent"))?;
        let alias = root.join("alias-parent").join("..");
        assert_eq!(
            relative(&alias, &root.join("one.txt").canonicalize()?),
            "one.txt"
        );
        let found = search(&alias, "Rust", json!({}))?;
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
