use super::*;

pub(super) fn check(project: &Path, data: &Path) -> Result<()> {
    {
        let mut terminal = Client::start(project, data, true, None)?;
        terminal.call("input", json!(["echo NIDO_NATIVE_TERMINAL<CR>"]))?;
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if terminal
                .lua(
                    "return table.concat(vim.api.nvim_buf_get_lines(0,0,-1,false),'\\n')",
                    json!([]),
                )?
                .as_str()
                .is_some_and(|s| s.matches("NIDO_NATIVE_TERMINAL").count() >= 2)
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        ensure!(
            terminal
                .lua(
                    "return table.concat(vim.api.nvim_buf_get_lines(0,0,-1,false),'\\n')",
                    json!([])
                )?
                .as_str()
                .is_some_and(|s| s.matches("NIDO_NATIVE_TERMINAL").count() >= 2),
            "Native terminal did not execute input"
        );
        terminal.call("restartTerminal", json!([]))?;
        ensure!(
            terminal.call("modified", json!([]))? == false,
            "Terminal falsely reports unsaved files"
        );
    }
    println!("PASS: terminal input, output, restart and close");
    Ok(())
}
