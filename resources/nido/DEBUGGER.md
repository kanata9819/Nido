# Rust debugging

Nido bundles CodeLLDB 1.12.3 (Windows x64) and nvim-dap commit
`9e848e09a697ee95302a3ef2dd43fd6eb709e570`. These are downloaded from their official
GitHub releases/repository by `scripts/prepare-debugger.ps1`, with SHA-256 checks.
The original distribution files and licenses are retained in `resources/debug`.

- CodeLLDB: https://github.com/vadimcn/codelldb (MIT; bundled LLVM/Python have their own licenses)
- nvim-dap: https://github.com/mfussenegger/nvim-dap (GPL-3.0; source and LICENSE.txt bundled)

Install a working Rust toolchain and Windows linker, open a Cargo project, and save
your edits before starting. F9 toggles a source breakpoint. F5 builds Cargo binary
targets using the dev profile and starts debugging, or continues a stopped program.
For multiple binaries, choose the target in the Debug panel. F10 steps over,
F11 steps into, Shift+F11 steps out, and Shift+F5 stops. The panel also has Pause.
Breakpoints are session-local; restart Nido to clear them.

Rust runnable lenses appear above main functions, tests and test modules. Place
the cursor inside the target and press gR to run or gD to debug in Normal mode.
The command menu also exposes Run Rust at cursor and Debug Rust at cursor.
Rust-analyzer supplies the Cargo target, test filter, arguments and environment.
Runs stream output to the same panel and Shift+F5 stops them.

The panel shows local variable summaries, the current source location, build and
debugger messages, and the last 200 lines of terminal output. Source stopping uses
Neovim signs and a highlighted line. The debugger is isolated per workspace.

F5 starts Cargo binary targets without arguments; gD uses the selected runnable,
including individual tests and test modules. launch.json, expandable object
fields, watches and interactive stdin are
not yet exposed by Nido. All debug executables run locally with your permissions.
Custom dev profiles must retain debug information for source stepping.

Run `pnpm test:debug` for an actual Rust build, breakpoint, step into/out/over,
local-variable and process-output test. No personal Neovim plugins are loaded.
