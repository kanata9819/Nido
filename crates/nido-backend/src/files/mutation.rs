use super::*;

pub fn mutate(root: &Path, rpc: &Rpc, action: &str, name: &str, target: &str) -> Result<()> {
    if action == "createFile" || action == "createDirectory" {
        let path = writable(root, name, true)?;
        if action == "createFile" {
            fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(path)?
                .flush()?;
        } else {
            fs::create_dir(path)?;
        }
        return Ok(());
    }
    let source = writable(root, name, false)?;
    let remote = crate::wsl::Remote::parse(root);
    let editor_source = crate::wsl::editor_path(&source, remote.as_ref());
    let affected = rpc.lua(
        r#"local path = ...; local result = {}
for _, b in ipairs(vim.api.nvim_list_bufs()) do
 local name = vim.api.nvim_buf_get_name(b)
 if name == path or name:sub(1,#path+1) == path .. '/' or name:sub(1,#path+1) == path .. '\\' then
  if vim.bo[b].modified then error('Save unsaved changes first') end
  table.insert(result, {id=b, name=name})
 end
end
return result"#,
        json!([editor_source]),
    )?;
    if action == "delete" {
        if let Some(remote) = crate::wsl::Remote::parse(&source) {
            remote.run(&["gio", "trash", "--", &remote.path])?;
        } else {
            trash::delete(&source)?;
        }
        for item in affected.as_array().into_iter().flatten() {
            rpc.call("nvim_buf_delete", json!([item["id"], {"force": false}]))?;
        }
    } else {
        let dest = writable(root, target, true)?;
        if dest.starts_with(&source) {
            bail!("Cannot place a folder inside itself")
        }
        match action {
            "copy" => copy_tree(&source, &dest)?,
            "rename" => {
                fs::rename(&source, &dest)?;
                let destination = crate::wsl::editor_path(&dest, remote.as_ref());
                for item in affected.as_array().into_iter().flatten() {
                    let old = item["name"].as_str().unwrap_or_default();
                    let new = format!("{}{}", destination, &old[editor_source.len()..]);
                    rpc.call("nvim_buf_set_name", json!([item["id"], new]))?;
                }
            }
            _ => bail!("Unknown file action"),
        }
    }
    Ok(())
}

fn copy_tree(source: &Path, destination: &Path) -> Result<()> {
    if source.symlink_metadata()?.file_type().is_symlink() {
        bail!("Copy symbolic links separately")
    }
    if source.is_dir() {
        fs::create_dir(destination)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy_tree(&entry.path(), &destination.join(entry.file_name()))?;
        }
    } else {
        let mut input = fs::File::open(source)?;
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)?;
        std::io::copy(&mut input, &mut output)?;
    }
    Ok(())
}
