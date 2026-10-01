# Azami

`colors/azami.vim` is based on the user's
`%LOCALAPPDATA%/nvim/colors/azami.vim` (2026-09-26).

Its dependency, `lua/vscode`, is vendored from the locally installed
`%LOCALAPPDATA%/nvim-data/lazy/vscode.nvim/lua/vscode`.
Upstream: https://github.com/Mofiqul/vscode.nvim
License: `licenses/vscode.nvim-LICENSE.md` (MIT).

Nido loads this bundled copy, not the user's personal configuration.
Nido adds compatibility mappings for native syntax and LSP tokens. Rust macro
names use Dark Modern's semantic macro blue; builtin derive names such as
`Debug` and `Clone` keep its type green.
`init.lua` maps native Rust keywords and LSP namespace/type groups to Azami's
existing groups. Nido's mode badges and cursor-row borders remain GUI settings.
