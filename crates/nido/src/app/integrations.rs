use super::*;

impl Model {
    pub(super) fn run_update(&mut self, action: &str) {
        let data = self.data.clone();
        let tx = self.tx.clone();
        let repaint = self.repaint.clone();
        let action = action.to_owned();
        std::thread::spawn(move || {
            if let Err(error) =
                nido_backend::updater::run(&action, &data, tx.clone(), repaint.clone())
            {
                let _ = tx.send(Event::Error(format!("Update: {error:#}")));
                let _ = tx.send(Event::Result(
                    String::new(),
                    "update".into(),
                    json!({"status":"error"}),
                ));
                repaint();
            }
        });
    }

    pub(super) fn git_mutation(&self, action: &str, args: Value) {
        if let Some(i) = self.active_index() {
            self.workspaces[i]
                .session
                .send_tag("git", json!([action, args]), "gitMutation");
        }
    }

    pub(super) fn open_wsl(&mut self) {
        self.show_wsl = true;
        let tx = self.tx.clone();
        let repaint = self.repaint.clone();
        std::thread::spawn(move || {
            match nido_backend::wsl::distributions() {
                Ok(list) => {
                    let _ = tx.send(Event::Result(
                        String::new(),
                        "wslDistributions".into(),
                        json!(list),
                    ));
                }
                Err(error) => {
                    let _ = tx.send(Event::Error(error.to_string()));
                }
            }
            repaint();
        });
    }
}
