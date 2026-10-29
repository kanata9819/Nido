use super::*;

pub(super) fn snapshot(rpc: &Rpc, root: &Path, terminal: bool) -> Result<Value> {
    if terminal {
        return Ok(json!({"root":root,"kind":"terminal","files":[],"current":""}));
    }
    let mut value = rpc.lua(SNAPSHOT, json!([]))?;
    value["root"] = json!(root);
    value["kind"] = json!("editor");
    if !value["files"].is_array() {
        value["files"] = json!([]);
    }
    if let Some(remote) = Remote::parse(root) {
        if let Some(current) = value["current"].as_str() {
            value["current"] = json!(remote.host(current));
        }
        for file in value["files"].as_array_mut().unwrap() {
            if let Some(path) = file["path"].as_str() {
                file["path"] = json!(remote.host(path));
            }
        }
    }
    Ok(value)
}

pub(super) fn open(rpc: &Rpc, path: &str, line: usize, column: usize) -> Result<()> {
    rpc.lua(
        r#"local path,line,column=...
require('nido_scroll').restore()
require('nido_eol').open(path)
if line>0 then
 vim.cmd.stopinsert();line=math.min(line,vim.api.nvim_buf_line_count(0))
 local text=vim.api.nvim_buf_get_lines(0,line-1,line,false)[1] or ''
 vim.api.nvim_win_set_cursor(0,{line,math.min(math.max(0,column-1),#text)})
 vim.cmd('normal! zvzz')
end"#,
        json!([path, line, column]),
    )?;
    Ok(())
}
pub(super) fn apply_settings(rpc: &Rpc, settings: &Value, terminal: bool) -> Result<()> {
    rpc.call(
        "nvim_set_option_value",
        json!([
            "clipboard",
            if settings["clipboardSharing"] == true {
                "unnamedplus"
            } else {
                ""
            },
            {}
        ]),
    )?;
    if !terminal {
        rpc.lua(
            r#"local s=vim.json.decode(...)
vim.go.relativenumber=s.relativeLineNumbers==true
vim.go.wrap=s.wordWrap==true
for _,win in ipairs(vim.api.nvim_list_wins()) do
 if vim.api.nvim_win_get_config(win).relative=='' then
  vim.wo[win].relativenumber=vim.go.relativenumber
  if vim.bo[vim.api.nvim_win_get_buf(win)].buftype=='' then vim.wo[win].wrap=vim.go.wrap end
 end
end
require('nido_sticky').set_method_separators(s.methodSeparators==true)
require('nido_editorconfig').set_enabled(s.editorConfig~=false)"#,
            json!([settings.to_string()]),
        )?;
    }
    Ok(())
}

pub(super) const SAVE: &str = r#"local command,format=...;local buffer=vim.api.nvim_get_current_buf();local failed=false
local ok,err=pcall(function()
 if format and #vim.lsp.get_clients({bufnr=buffer,method='textDocument/formatting'})>0 then failed=not pcall(vim.lsp.buf.format,{bufnr=buffer,async=false,timeout_ms=3000}) end
 if command=='write' then vim.api.nvim_buf_call(buffer,function() vim.cmd({cmd=command,mods={silent=true}}) end) else vim.cmd({cmd=command,mods={silent=true}}) end
end)
if ok and failed then vim.notify('Formatting failed. Your edits were saved without formatting.',vim.log.levels.WARN,{title='Format on save'}) end
return ok and '' or tostring(err)"#;
const SNAPSHOT: &str = r#"local files={}
for _,b in ipairs(vim.api.nvim_list_bufs()) do
 local name=vim.api.nvim_buf_get_name(b)
 if vim.bo[b].buflisted and vim.bo[b].buftype=='' and name~='' then
  local pos=vim.api.nvim_buf_get_mark(b,'"');local wins=vim.fn.win_findbuf(b)
  if #wins>0 then pos=vim.api.nvim_win_get_cursor(wins[1]);if wins[1]==vim.api.nvim_get_current_win() then pos=require('nido_scroll').cursor() or pos end end
  table.insert(files,{path=name,line=math.max(1,pos[1]),column=pos[2]})
 end
end
return {files=files,current=vim.api.nvim_buf_get_name(0)}"#;
