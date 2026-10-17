# Language packs

Nido loads Rust, TypeScript/JavaScript and Deno through the same language-pack registry used for additional languages. The built-in packs are enabled by default. Existing syntax highlighting remains available even when a language pack is disabled.

Open **Features → Language packs** with `Ctrl+Shift+X`. You can install a pack, enable or disable it, reload packs, or open the pack folder. Changes apply to open workspaces without reopening files or discarding unsaved edits, and enabled/disabled choices survive a restart. Language-server status is shown for the current workspace. A server starts when a matching file in a matching project is opened.

## Add a language

Install the language server separately on the machine where the workspace lives. For example, this pack connects to `gopls` already available on PATH:

```json
{
    "schemaVersion": 1,
    "id": "go",
    "version": "1.0.0",
    "title": "Go",
    "description": "Completion, diagnostics and navigation for Go.",
    "filetypes": ["go", "gomod", "gowork"],
    "serverName": "gopls",
    "command": ["gopls"],
    "rootMarkers": ["go.work", "go.mod", ".git"],
    "setup": "Install gopls and make it available on PATH."
}
```

Save this as `go.json` and select it with **Install language pack**. Alternatively, place it in the folder opened by **Open pack folder**, then choose **Reload language packs**. That folder also accepts subdirectories containing `pack.json`. Pack IDs and server names must be unique; additional packs cannot replace built-in packs.

The pack describes a connection to an LSP server. Nido and Neovim provide the completion menu, diagnostics, hover, rename, formatting and navigation shared by every language. Actual capabilities depend on the connected server. A language pack does not install a compiler, runtime, server or debugger.

## Configuration

- `schemaVersion`: currently `1`.
- `id`, `version`, `title`, `description`: identity and display information. Version is a three-part version such as `1.0.0`.
- `filetypes`: Neovim filetype names, rather than filename extensions. Existing Neovim file detection and syntax highlighting are reused.
- `serverName`: unique name for the LSP client.
- `command`: executable and separate arguments; no shell command string. `${node}` expands to Nido's Node runtime.
- `commands`: optional platform-specific arrays under `win32` and `linux`, overriding `command`.
- `rootMarkers`: optional project marker filenames. A server starts only when a marker exists in an ancestor directory. Without markers, the workspace root is used.
- `settings`, `initOptions`: optional LSP settings and initialization options.
- `setup`: optional setup instructions shown in the manager.
- `languages`: optional catalog entries with `id`, `title`, `mark`, `category` (`tools` or `runtimes`), `extensions`, `description`, and optional `keywords`, `requirement`, `setup`, `command`.

For WSL workspaces, the same installed pack is used, while commands and dependencies are resolved inside that WSL distribution. Use PATH-based commands or a `commands.linux` entry, rather than a Windows absolute path. Built-in TypeScript continues to use Nido's Linux Node runtime; Deno/TypeScript project selection and Rust toolchain discovery are preserved.

Nido uses a compatible Neovim 0.11.x installation or its private pinned 0.11.5 runtime. Newer system versions currently fall back to the private runtime because their external highlight-state UI is not supported.

Built-in adapters live beside their manifests under `resources/nido/language-packs/`. Only built-in packs can select an adapter; additional packs are declarative JSON. Malformed packs are listed as errors while valid packs continue loading. The manager stores manifests in the Nido user-data `language-packs` folder and preferences in `language-packs-state.json`.
