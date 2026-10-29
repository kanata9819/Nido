use gpui::{AssetSource, SharedString};
use std::borrow::Cow;
pub struct Assets;
impl AssetSource for Assets {
    fn load(&self, path: &str) -> anyhow::Result<Option<Cow<'static, [u8]>>> {
        Ok(Some(Cow::Borrowed(match path {
            "arrow-down-to-line.svg" => {
                include_bytes!("../../../resources/nido/icons/arrow-down-to-line.svg").as_slice()
            }
            "arrow-up-from-line.svg" => {
                include_bytes!("../../../resources/nido/icons/arrow-up-from-line.svg").as_slice()
            }
            "blocks.svg" => include_bytes!("../../../resources/nido/icons/blocks.svg").as_slice(),
            "braces.svg" => include_bytes!("../../../resources/nido/icons/braces.svg").as_slice(),
            "c.svg" => include_bytes!("../../../resources/nido/icons/c.svg").as_slice(),
            "check.svg" => include_bytes!("../../../resources/nido/icons/check.svg").as_slice(),
            "chevron-down.svg" => {
                include_bytes!("../../../resources/nido/icons/chevron-down.svg").as_slice()
            }
            "chevron-right.svg" => {
                include_bytes!("../../../resources/nido/icons/chevron-right.svg").as_slice()
            }
            "circle.svg" => include_bytes!("../../../resources/nido/icons/circle.svg").as_slice(),
            "copy.svg" => include_bytes!("../../../resources/nido/icons/copy.svg").as_slice(),
            "cplusplus.svg" => {
                include_bytes!("../../../resources/nido/icons/cplusplus.svg").as_slice()
            }
            "csharp.svg" => include_bytes!("../../../resources/nido/icons/csharp.svg").as_slice(),
            "css3.svg" => include_bytes!("../../../resources/nido/icons/css3.svg").as_slice(),
            "file-cog.svg" => {
                include_bytes!("../../../resources/nido/icons/file-cog.svg").as_slice()
            }
            "file-plus.svg" => {
                include_bytes!("../../../resources/nido/icons/file-plus.svg").as_slice()
            }
            "file-text.svg" => {
                include_bytes!("../../../resources/nido/icons/file-text.svg").as_slice()
            }
            "files.svg" => include_bytes!("../../../resources/nido/icons/files.svg").as_slice(),
            "folder-open.svg" => {
                include_bytes!("../../../resources/nido/icons/folder-open.svg").as_slice()
            }
            "folder-plus.svg" => {
                include_bytes!("../../../resources/nido/icons/folder-plus.svg").as_slice()
            }
            "folder.svg" => include_bytes!("../../../resources/nido/icons/folder.svg").as_slice(),
            "git-branch.svg" => {
                include_bytes!("../../../resources/nido/icons/git-branch.svg").as_slice()
            }
            "go.svg" => include_bytes!("../../../resources/nido/icons/go.svg").as_slice(),
            "history.svg" => include_bytes!("../../../resources/nido/icons/history.svg").as_slice(),
            "html5.svg" => include_bytes!("../../../resources/nido/icons/html5.svg").as_slice(),
            "javascript.svg" => {
                include_bytes!("../../../resources/nido/icons/javascript.svg").as_slice()
            }
            "keyboard.svg" => {
                include_bytes!("../../../resources/nido/icons/keyboard.svg").as_slice()
            }
            "leaf.svg" => include_bytes!("../../../resources/nido/icons/leaf.svg").as_slice(),
            "lua.svg" => include_bytes!("../../../resources/nido/icons/lua.svg").as_slice(),
            "minus.svg" => include_bytes!("../../../resources/nido/icons/minus.svg").as_slice(),
            "package.svg" => include_bytes!("../../../resources/nido/icons/package.svg").as_slice(),
            "pause.svg" => include_bytes!("../../../resources/nido/icons/pause.svg").as_slice(),
            "pencil.svg" => include_bytes!("../../../resources/nido/icons/pencil.svg").as_slice(),
            "play.svg" => include_bytes!("../../../resources/nido/icons/play.svg").as_slice(),
            "plus.svg" => include_bytes!("../../../resources/nido/icons/plus.svg").as_slice(),
            "python.svg" => include_bytes!("../../../resources/nido/icons/python.svg").as_slice(),
            "react.svg" => include_bytes!("../../../resources/nido/icons/react.svg").as_slice(),
            "refresh-cw.svg" => {
                include_bytes!("../../../resources/nido/icons/refresh-cw.svg").as_slice()
            }
            "rust.svg" => include_bytes!("../../../resources/nido/icons/rust.svg").as_slice(),
            "save.svg" => include_bytes!("../../../resources/nido/icons/save.svg").as_slice(),
            "search.svg" => include_bytes!("../../../resources/nido/icons/search.svg").as_slice(),
            "settings-2.svg" => {
                include_bytes!("../../../resources/nido/icons/settings-2.svg").as_slice()
            }
            "square-terminal.svg" => {
                include_bytes!("../../../resources/nido/icons/square-terminal.svg").as_slice()
            }
            "square.svg" => include_bytes!("../../../resources/nido/icons/square.svg").as_slice(),
            "star.svg" => include_bytes!("../../../resources/nido/icons/star.svg").as_slice(),
            "step-forward.svg" => {
                include_bytes!("../../../resources/nido/icons/step-forward.svg").as_slice()
            }
            "trash-2.svg" => include_bytes!("../../../resources/nido/icons/trash-2.svg").as_slice(),
            "typescript.svg" => {
                include_bytes!("../../../resources/nido/icons/typescript.svg").as_slice()
            }
            "x.svg" => include_bytes!("../../../resources/nido/icons/x.svg").as_slice(),
            _ => return Ok(None),
        })))
    }
    fn list(&self, _: &str) -> anyhow::Result<Vec<SharedString>> {
        Ok(vec![])
    }
}
