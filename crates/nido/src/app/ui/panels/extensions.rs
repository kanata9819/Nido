use super::*;

impl Nido {
    pub(in crate::app::ui) fn extensions_panel(&self, cx: &Context<Self>) -> AnyElement {
        let mut list = column().child(
            row()
                .child(self.button(
                    "packs-reload",
                    self.model.tr("Reload"),
                    |this, _, _| this.reload_packs(),
                    cx,
                ))
                .child(self.button(
                    "packs-install",
                    self.model.tr("Install language pack"),
                    |this, _, _| {
                        let tx = this.model.tx.clone();
                        let data = this.model.data.clone();
                        let repaint = this.model.repaint.clone();
                        std::thread::spawn(move || {
                            if let Some(path) = rfd::FileDialog::new()
                                .add_filter("Language pack", &["json"])
                                .pick_file()
                            {
                                let event = match nido_backend::packs::install(&data, &path) {
                                    Ok(_) => Event::Result(
                                        String::new(),
                                        "installedPack".into(),
                                        Value::Null,
                                    ),
                                    Err(e) => Event::Error(format!("Language pack: {e:#}")),
                                };
                                let _ = tx.send(event);
                                repaint();
                            }
                        });
                    },
                    cx,
                )),
        );
        for error in array(&self.model.extensions["errors"]) {
            list = list.child(s(error).to_owned());
        }
        for pack in array(&self.model.extensions["packs"]) {
            let id = s(&pack["id"]).to_owned();
            let value = id.clone();
            let checked = !array(&self.model.extensions["disabled"])
                .iter()
                .any(|v| v == &id);
            let mut card = column()
                .p_2()
                .border_1()
                .border_color(rgb(0x303840))
                .rounded(px(5.))
                .child(
                    self.button(
                        format!("pack-{id}"),
                        "",
                        move |this, _, _| match nido_backend::packs::set_enabled(
                            &this.model.data,
                            &value,
                            !checked,
                        ) {
                            Ok(()) => this.reload_packs(),
                            Err(error) => this.model.error(error.to_string()),
                        },
                        cx,
                    )
                    .child(icon(if checked { "check" } else { "square" }, 15.))
                    .child(s(&pack["title"]).to_owned()),
                )
                .child(s(&pack["description"]).to_owned());
            if let Some(runtime) = array(&self.model.extensions["runtime"])
                .iter()
                .find(|p| p["id"] == id)
            {
                card = card.child(format!(
                    "{} {}",
                    s(&runtime["status"]),
                    s(&runtime["message"])
                ));
            }
            if let Some(setup) = pack["setup"].as_str() {
                card = card.child(setup.to_owned());
            }
            for language in array(&pack["languages"]) {
                card = card
                    .child(s(&language["title"]).to_owned())
                    .child(s(&language["description"]).to_owned())
                    .child(s(&language["requirement"]).to_owned());
            }
            list = list.child(card);
        }
        list.into_any_element()
    }

    pub(in crate::app::ui) fn reload_packs(&self) {
        for w in &self.model.workspaces {
            w.session.send("reloadPacks", json!([]));
        }
        self.model.send("packs", json!([]));
    }
}
