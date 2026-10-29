use super::*;

impl Model {
    pub(super) fn open_palette(&mut self, kind: &str) {
        self.panel.clear();
        self.palette = Some(Palette {
            kind: kind.into(),
            query: String::new(),
            items: json!([]),
            index: 0,
            focus: true,
            generation: 0,
        });
        self.refresh_palette();
    }

    pub(super) fn refresh_palette(&mut self) {
        let Some(p) = self.palette.as_mut() else {
            return;
        };
        self.palette_generation += 1;
        p.generation = self.palette_generation;
        p.index = 0;
        let kind = p.kind.clone();
        let query = p.query.clone();
        let tag = format!("palette:{}", p.generation);
        if kind == "files" {
            if let Some(i) = self.active_index() {
                self.workspaces[i]
                    .session
                    .send_tag("findFiles", json!([query]), &tag);
            }
        } else if kind == "symbols" {
            self.send("lua", json!(["return require('nido_symbols').find()", []]));
        }
    }

    pub(super) fn palette_items(&self) -> Vec<Value> {
        let Some(p) = &self.palette else {
            return vec![];
        };
        let query = p.query.to_lowercase();
        let items=match p.kind.as_str(){
            "commands"=>COMMANDS.iter().map(|(key,title,detail,action)|json!({"key":key,"title":self.tr(title),"detail":detail,"action":action})).collect::<Vec<_>>(),
            "files"=>array(&p.items).iter().map(|v|json!({"title":v["path"],"detail":"","path":v["path"]})).collect(),
            "buffers"=>self.active_index().map(|i|self.workspaces[i].buffers().iter().map(|v|json!({"title":v["name"],"detail":if v["modified"]==true{"modified"}else{""},"buffer":v["id"]})).collect()).unwrap_or_default(),
            "symbols"=>self.active_index().map(|i|array(&self.workspaces[i].state["symbols"]["items"]).iter().enumerate().map(|(index,v)|json!({"title":v["name"],"detail":v["kind"],"symbol":index+1})).collect()).unwrap_or_default(),
            "workspaces"=>self.workspaces.iter().filter(|w|w.parent.is_none()).map(|w|json!({"title":w.name(),"detail":w.session.root,"workspace":w.session.id})).collect(),
            "favorites"=>array(&self.favorites).iter().map(|v|json!({"title":v["name"],"detail":v["root"],"favorite":v})).collect(),
            _=>vec![]
        };
        items
            .into_iter()
            .filter(|item| {
                p.kind == "files"
                    || format!("{} {}", s(&item["title"]), s(&item["detail"]))
                        .to_lowercase()
                        .contains(&query)
            })
            .collect()
    }

    pub(super) fn activate_palette(&mut self, item: Value) {
        self.palette = None;
        self.focus_editor = true;
        if let Some(action) = item["action"].as_str() {
            self.execute(action);
        } else if let Some(path) = item["path"].as_str() {
            self.send("open", json!([path, 0, 1]));
        } else if item.get("buffer").is_some() {
            self.send("selectBuffer", json!([item["buffer"]]));
        } else if item.get("symbol").is_some() {
            if let Some(i) = self.active_index() {
                self.send(
                    "lua",
                    json!([
                        "require('nido_symbols').open(...)",
                        [
                            item["symbol"],
                            self.workspaces[i].state["symbols"]["version"]
                        ]
                    ]),
                );
            }
        } else if let Some(id) = item["workspace"].as_str() {
            self.active = id.into();
        } else if item.get("favorite").is_some() {
            let f = &item["favorite"];
            self.add_workspace(
                PathBuf::from(s(&f["root"])),
                f["kind"] == "terminal",
                None,
                None,
            );
        }
    }

    pub(super) fn palette_changed(&mut self) {
        if let Some(p) = &self.palette
            && p.kind == "commands"
            && p.query.chars().count() == 1
            && let Some(command) = COMMANDS.iter().find(|c| c.0 == p.query)
        {
            let action = command.3;
            self.palette = None;
            self.execute(action);
            return;
        }
        self.refresh_palette();
    }
}
