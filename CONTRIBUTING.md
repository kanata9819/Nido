# Contributing to Nido

Thanks for your interest in building Nido together! We welcome contributions from first-time and experienced open-source contributors alike.

You can participate in **English or Japanese**. You do not need to have every part of the codebase figured out before getting started.

## Ways to contribute

- Report bugs, including steps to reproduce and your Windows version.
- Suggest improvements to keyboard workflows and editor usability.
- Improve documentation, translations, tests, and accessibility.
- Fix focused problems or develop features after discussing their scope.

Browse the [issue tracker](https://github.com/kanata9819/Nido/issues). If there isn't an issue that fits, feel free to open one. For larger changes, please discuss the design before implementing it.

## Development environment

The supported environment documented for Nido is **Windows x64**. Please use Windows when following these steps.

You will need:

- Git
- Node.js and pnpm
- Windows PowerShell (the project runs `powershell` scripts)
- Internet access for the first dependency preparation

### Run locally

```powershell
git clone https://github.com/kanata9819/Nido.git
cd Nido
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` invokes the `prepare:neovim` script. It downloads and validates a pinned Windows Neovim distribution and debugging dependencies when needed, and prepares language resources. The first run can take longer than subsequent runs.

Language dependencies are reused while the package manifests, installed package metadata and Node.js version are unchanged and the required server files are present. Changing dependencies or deleting required files triggers a fresh `npm ci`. To force a clean reinstall when troubleshooting language tools, run `pnpm prepare:languages --force`.

### Useful commands

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm test:e2e
pnpm build:win
```

The end-to-end and Windows packaging tests can have additional environment requirements. Run the checks relevant to your change and explain anything you could not run in the PR.

### Testing on Linux or macOS

Nido itself runs on Windows, but most unit and renderer tests also run on Linux and macOS, which helps when you have no Windows machine at hand. Prepare the same pinned Neovim release for your platform, then run the tests:

```sh
pnpm install --frozen-lockfile
pnpm prepare:neovim:unix
pnpm test
pnpm test:renderer
```

`prepare:neovim:unix` downloads the Neovim release for your platform, checks its SHA256 and unpacks it into `resources/`. Tests that need PowerShell, Rust or the debugger still fail there; CI runs everything on Windows.

### Code layout

- `src/main/` — Electron main-process code.
    - `ipc/` — IPC handlers, one file per area (files, Git, history, workspaces, ...).
    - `session/` — one workspace's Neovim session and its parts (buffers, events, files, UI).
    - `workspace/` — workspace lifecycle (restore, sleep, wake), layout persistence and checkpoints.
    - `search/`, `git/`, `history/`, `languagePacks/`, `neovim/` — the features with those names.
    - `platform/` — OS integration: WSL, terminal shells, clipboard and the updater.
- `src/preload/` — the bridge between Electron and the UI.
- `src/renderer/src/` — React-based editor UI, grouped by feature. Each folder holds the
  components, hooks and plain logic of that feature.
    - `app/` — the root component, the overlay panel host, toasts and app-wide hooks.
    - `editor/` — the canvas editor, scrolling and cursor motion; `editor/popups/` holds
      completion, hover and diagnostic popups.
    - `grid/` — Neovim's screen grid and its canvas painter.
    - `explorer/`, `git/`, `search/`, `palette/`, `panels/`, `settings/`, `history/`,
      `workspace/`, `neovim/`, `keyboard/` — the features with those names.
    - `layout/` — the title bar, status bar, activity bar and file tabs.
    - `ui/` — small building blocks shared by features (icons, overlay motion, list navigation).
    - `styles/` — the global stylesheet and the UI themes. Each component's CSS module sits
      beside it. A rule that depends on the app's state, such as compact mode, reaches it
      through the global `nido-app` and `nido-body` classes.
    - `assets/` — the file and folder icons.
- `src/shared/` — shared interfaces and types.
- `tests/` — automated tests.
- `scripts/` — setup and development helpers.

## Proposing a change

1. Look for an existing issue. If your change is large or changes behavior significantly, open an issue to discuss it first.
2. Fork the repository and create a descriptive branch.
3. Keep the change focused and add or update tests when appropriate.
4. Run applicable checks, then open a pull request against `main`.
5. In the PR description, explain **what changed**, **why**, and **how you tested it**. Include screenshots for visible UI changes when useful.

We prefer constructive discussions and small, reviewable pull requests. Contributions may need revisions before merging.

## Reporting a bug

An actionable report ideally includes:

- Nido version or commit.
- Windows version and relevant environment details.
- Reproduction steps.
- Expected behavior and actual behavior.
- Logs or screenshots, with personal data and secrets removed.

## First contribution?

Documentation fixes, small usability improvements, and focused tests are great starting points. If you want help choosing an issue, open a discussion in an issue and say you're interested in contributing.

Thank you for helping make Nido better!
