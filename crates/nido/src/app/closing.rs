use super::*;

impl Model {
    pub(super) fn request_close(&mut self, quit: bool) {
        if self.closing.is_some() {
            return;
        }
        let ids: BTreeSet<_> = self
            .workspaces
            .iter()
            .filter(|w| {
                quit || w.session.id == self.active || w.parent.as_deref() == Some(&self.active)
            })
            .map(|w| w.session.id.clone())
            .collect();
        if ids.is_empty() {
            if quit {
                if self.install_after_close {
                    self.install_after_close = false;
                    if let Err(error) = nido_backend::updater::install(&self.data) {
                        self.error(format!("Update: {error:#}"));
                        return;
                    }
                }
                self.exit_allowed = true;
            }
            return;
        }
        for w in &self.workspaces {
            if ids.contains(&w.session.id) && !w.closed {
                w.session.send("input", json!(["<Esc>"]));
                w.session.send_tag("modified", json!([]), "closeProbe");
            }
        }
        self.closing = Some(Closing {
            waiting: self
                .workspaces
                .iter()
                .filter(|w| ids.contains(&w.session.id) && !w.closed)
                .map(|w| w.session.id.clone())
                .collect(),
            ids,
            modified: false,
            stage: "probing".into(),
            quit,
        });
    }

    pub(super) fn close_snapshots(&mut self) {
        if let Some(close) = self.closing.as_mut() {
            close.stage = "snapshots".into();
            close.waiting = self
                .workspaces
                .iter()
                .filter(|w| close.ids.contains(&w.session.id) && !w.closed)
                .map(|w| w.session.id.clone())
                .collect();
            for w in &self.workspaces {
                if close.waiting.contains(&w.session.id) {
                    w.session.send_tag("snapshot", json!([]), "closeSnapshot");
                }
            }
        }
    }

    pub(super) fn close_choice(&mut self, choice: &str) {
        if self.closing.is_none() {
            return;
        }
        match choice {
            "cancel" => {
                self.closing = None;
                self.install_after_close = false;
                self.focus_editor = true;
            }
            "discard" => self.close_snapshots(),
            "save" => {
                let close = self.closing.as_mut().unwrap();
                close.stage = "saving".into();
                close.waiting = self
                    .workspaces
                    .iter()
                    .filter(|w| {
                        close.ids.contains(&w.session.id) && !w.session.terminal && !w.closed
                    })
                    .map(|w| w.session.id.clone())
                    .collect();
                for w in &self.workspaces {
                    if close.waiting.contains(&w.session.id) {
                        w.session.send_tag("save", json!(["wall"]), "closeSave");
                    }
                }
            }
            _ => {}
        }
    }
}
