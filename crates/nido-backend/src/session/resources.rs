use super::*;

pub fn resources() -> Result<PathBuf> {
    let mut choices = vec![];
    if let Some(path) = std::env::var_os("NIDO_RESOURCES") {
        choices.push(PathBuf::from(path));
    }
    if let Some(parent) = std::env::current_exe()?.parent() {
        choices.push(parent.join("resources"));
    }
    choices.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../resources"));
    choices
        .into_iter()
        .find(|p| p.join("nido/init.lua").is_file() && p.join("nvim-win64/bin/nvim.exe").is_file())
        .context("Bundled Neovim is missing. Run scripts/prepare-runtime.ps1")
}
