use super::*;

pub(super) fn check(root: &Path) -> Result<()> {
    let project = root.join("language-project");
    fs::create_dir(&project)?;
    fs::write(
        project.join("tsconfig.json"),
        "{\"compilerOptions\":{\"strict\":true}}",
    )?;
    fs::write(
        project.join("sample.ts"),
        "export function greet(name: string) { return name; }\nconst bad: number = 'wrong';\ngre\n",
    )?;
    let mut c = Client::start(&project, &root.join("language-data"), false, None)?;
    c.call("open", json!(["sample.ts", 3, 4]))?;
    ensure!(c.lua("return vim.wait(10000,function() for _,c in ipairs(vim.lsp.get_clients({bufnr=0})) do if c.initialized then return true end end return false end,50)",json!([]))? == true, "Bundled TypeScript language server did not attach");
    ensure!(
        c.lua(
            "return vim.wait(10000,function() return #vim.diagnostic.get(0)>0 end,50)",
            json!([])
        )? == true,
        "LSP diagnostics did not arrive"
    );
    let completion = c.lua("local p=vim.lsp.util.make_position_params(0,'utf-16'); local r=vim.lsp.buf_request_sync(0,'textDocument/completion',p,10000); for _,v in pairs(r or {}) do for _,i in ipairs((v.result or {}).items or v.result or {}) do if i.label=='greet' then return true end end end return false",json!([]))?;
    ensure!(completion == true, "TypeScript completion lost greet");
    c.call("input", json!(["Ae"]))?;
    // TextChangedI and feedkeys must return to Neovim's input loop between probes.
    let deadline = Instant::now() + Duration::from_secs(5);
    while c.lua("return vim.fn.pumvisible()==1", json!([]))? != true {
        ensure!(
            Instant::now() < deadline,
            "Automatic completion did not open after typing: {}",
            c.lua("return {mode=vim.fn.mode(),line=vim.api.nvim_get_current_line(),messages=vim.fn.execute('messages')}", json!([]))?
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    c.lua("vim.cmd.redraw(); return true", json!([]))?;
    ensure!(
        array(&c.grid.completion["items"])
            .iter()
            .any(|v| v[0].as_str().is_some_and(|s| s.contains("greet"))),
        "Completion popup did not reach the native grid"
    );
    c.call("input", json!(["<C-n>"]))?;
    c.call("input", json!(["<Tab><Esc>"]))?;
    ensure!(
        c.lua("return vim.api.nvim_get_current_line()", json!([]))?
            .as_str()
            .is_some_and(|s| s.starts_with("greet")),
        "Completion acceptance lost the selected item"
    );
    c.lua("return require('nido_symbols').find()", json!([]))?;
    let symbols = c.wait_notify("nido:symbols", |v| v["loading"] == false)?;
    ensure!(
        array(&symbols["items"])
            .iter()
            .any(|s| s["name"] == "greet"),
        "LSP document symbols were not delivered to the native client"
    );
    drop(c);
    println!("PASS: bundled TypeScript LSP, diagnostics, completion and document symbols");

    Ok(())
}
