use crate::{
    files, git,
    history::History,
    packs,
    rpc::{self, Event, Rpc},
    wsl::{Remote, editor_path},
};
use anyhow::{Context, Result, bail};
use nido_core::{paths, persistence::SavedWorkspace};
use notify::Watcher;
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex, mpsc::Sender},
    thread,
    time::{Duration, Instant},
};

#[derive(Clone, Debug)]
pub struct Action {
    pub name: String,
    pub args: Value,
    pub tag: String,
}
impl Action {
    pub fn new(name: &str, args: Value) -> Self {
        Self {
            name: name.into(),
            args,
            tag: name.into(),
        }
    }
}
type Queue = Arc<(Mutex<VecDeque<Action>>, Condvar)>;
#[derive(Clone)]
pub struct Session {
    pub id: String,
    pub root: PathBuf,
    pub terminal: bool,
    queue: Queue,
}

mod editor;
mod queries;
mod resources;
mod terminal;
mod worker;
use editor::{SAVE, apply_settings, open, snapshot};
use queries::read_worker;
pub use resources::resources;
pub use terminal::available_shells;
use terminal::start_terminal;

impl Session {
    pub fn start(
        root: PathBuf,
        terminal: bool,
        saved: Option<SavedWorkspace>,
        settings: Value,
        events: Sender<Event>,
        repaint: Arc<dyn Fn() + Send + Sync>,
        data: PathBuf,
    ) -> Self {
        let session = Self {
            id: uuid::Uuid::new_v4().to_string(),
            root: paths::normal_path(root),
            terminal,
            queue: Arc::new((Mutex::new(VecDeque::new()), Condvar::new())),
        };
        let worker = session.clone();
        thread::spawn(move || {
            let result = worker.run(saved, settings, events.clone(), repaint.clone(), data);
            if let Err(error) = result {
                let _ = events.send(Event::Error(format!(
                    "{}: {error:#}",
                    worker.root.display()
                )));
            }
            let _ = events.send(Event::Closed(worker.id));
            repaint();
        });
        session
    }
    pub fn send(&self, name: &str, args: Value) {
        self.send_tag(name, args, name);
    }
    pub fn send_tag(&self, name: &str, args: Value, tag: &str) {
        let (lock, wake) = &*self.queue;
        lock.lock().unwrap().push_back(Action {
            name: name.into(),
            args,
            tag: tag.into(),
        });
        wake.notify_one();
    }
}
