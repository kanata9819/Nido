use super::*;

impl Nido {
    pub(in crate::app::ui) fn history_panel(&self, cx: &Context<Self>) -> AnyElement {
        let mut list = column()
            .child(self.button(
                "time-refresh",
                self.model.tr("Refresh"),
                |this, _, _| this.model.send("history", json!(["list", {}])),
                cx,
            ))
            .child(s(&self.model.history["path"]).to_owned());
        for version in array(&self.model.history["versions"]) {
            let ago = nido_backend::history::now()
                .saturating_sub(version["timestamp"].as_u64().unwrap_or(0))
                / 1000;
            let id = version["id"].clone();
            list = list.child(
                self.button(
                    format!("time-{id}"),
                    format!(
                        "{} · {}s ago · {} lines",
                        s(&version["kind"]),
                        ago,
                        n(&version["lines"])
                    ),
                    move |this, _, _| {
                        this.model.send(
                            "history",
                            json!(["preview",{"path":this.model.history["path"],"id":id}]),
                        )
                    },
                    cx,
                )
                .when(
                    self.model.history_preview["version"]["id"] == version["id"],
                    |el| el.bg(rgb(0x29343c)),
                ),
            );
        }
        if self.model.history_preview.get("token").is_some() {
            list=list.child(self.button("time-restore",self.model.tr("Restore this version"),|this,_,_|this.model.send("history",json!(["restore",{"path":this.model.history_preview["path"],"id":this.model.history_preview["version"]["id"],"token":this.model.history_preview["token"]}])),cx))
                .child(self.model.tr("Restored content stays unsaved. Undo returns to the previous draft.")).child(diff(s(&self.model.history_preview["diff"])));
        }
        list.into_any_element()
    }
}
