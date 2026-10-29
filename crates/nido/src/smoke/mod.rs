use crate::grid::{Grid, array};
use anyhow::{Context, Result, bail, ensure};
use nido_backend::{rpc::Event, session::Session};
use nido_core::{
    persistence::{self, SavedWorkspace},
    settings,
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs,
    path::Path,
    sync::{
        Arc,
        mpsc::{self, Receiver},
    },
    time::{Duration, Instant},
};

mod client;
mod debug;
mod editor;
mod git;
mod language;
mod terminal;
use client::Client;

pub fn run() -> Result<()> {
    let root = std::env::temp_dir().join(format!("nido-rust-check-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&root)?;
    let result = check(&root);
    if result.is_ok() {
        fs::remove_dir_all(&root)?;
    } else {
        eprintln!("Failed check data preserved at {}", root.display());
    }
    result
}

fn check(root: &Path) -> Result<()> {
    let project = root.join("project");
    let data = root.join("data");
    editor::check(&project, &data)?;
    git::check(&project)?;
    terminal::check(&project, &data)?;
    crate::app::verify_ui(&project, &root.join("ui-data"))?;
    language::check(root)?;
    debug::check(root)?;
    Ok(())
}
