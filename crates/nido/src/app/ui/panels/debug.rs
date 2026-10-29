use super::*;

impl Nido {
    pub(in crate::app::ui) fn debug_panel(&self, cx: &Context<Self>) -> AnyElement {
        let debug = self
            .model
            .active_index()
            .map(|i| self.model.workspaces[i].state["debug"].clone())
            .unwrap_or_default();
        let mut controls = row();
        for (label, action) in [
            ("F5", "start"),
            ("Stop", "stop"),
            ("Pause", "pause"),
            ("F10", "over"),
            ("F11", "into"),
            ("Out", "out"),
            ("F9", "breakpoint"),
        ] {
            controls = controls.child(self.button(
                format!("debug-{action}"),
                label,
                move |this, _, _| this.model.send("debug", json!([action, 0])),
                cx,
            ));
        }
        let mut list = column().child(controls).child(format!(
            "{}  {}",
            s(&debug["status"]),
            s(&debug["location"])
        ));
        for (i, target) in array(&debug["targets"]).iter().enumerate() {
            list = list.child(self.button(
                format!("debug-target-{i}"),
                s(&target["name"]).to_owned(),
                move |this, _, _| this.model.send("debug", json!(["launch", i + 1])),
                cx,
            ));
        }
        for (i, variable) in array(&debug["variables"]).iter().enumerate() {
            let v = variable.clone();
            let prefix = if v["expandable"] == true {
                if v["expanded"] == true { "▾" } else { "▸" }
            } else {
                " "
            };
            list = list.child(self.button(
                format!("variable-{i}"),
                format!(
                    "{}{} {} = {}",
                    "  ".repeat(n(&v["depth"]).min(30)),
                    prefix,
                    s(&v["name"]),
                    s(&v["value"])
                ),
                move |this, _, _| {
                    if v["expandable"] == true {
                        this.model.send("debug", json!(["variable", v["id"]]));
                    }
                },
                cx,
            ));
        }
        list.child(
            div()
                .font_family("Consolas")
                .whitespace_normal()
                .child(s(&debug["output"]).to_owned()),
        )
        .into_any_element()
    }
}
