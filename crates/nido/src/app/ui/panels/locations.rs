use super::*;

impl Nido {
    pub(in crate::app::ui) fn locations_panel(&self, cx: &Context<Self>) -> AnyElement {
        let state = self
            .model
            .active_index()
            .map(|i| self.model.workspaces[i].state.clone())
            .unwrap_or_default();
        let references = self.model.panel == "references";
        let list = if references {
            state["references"].clone()
        } else {
            json!({"items":state["problems"]})
        };
        let mut content = column();
        if list["loading"] == true {
            content = content.child("Loading…");
        }
        if let Some(error) = list["error"].as_str() {
            content = content.child(error.to_owned());
        }
        for (i, item) in array(&list["items"]).iter().enumerate() {
            let item = item.clone();
            let version = list["version"].clone();
            content=content.child(self.button(format!("location-{i}"),format!("{}:{}:{}  {}",s(&item["path"]),n(&item["line"]),n(&item["column"]),if references{s(&item["text"])}else{s(&item["message"])}),move|this,window,cx|{
                if references {this.model.send("lua",json!(["require('nido_references').open(...)",[i+1,version]]));}
                else {this.model.send("lua",json!(["local p,l,c=...;require('nido_scroll').restore();require('nido_eol').open(p);l=math.min(l,vim.api.nvim_buf_line_count(0));local text=vim.api.nvim_buf_get_lines(0,l-1,l,false)[1]or'';vim.api.nvim_win_set_cursor(0,{l,math.min(c-1,#text)});vim.cmd('normal! zvzz')",[item["path"],item["line"],item["column"]]]));}
                this.model.focus_editor=true;this.tick(window,cx);
            },cx));
        }
        content.into_any_element()
    }
}
