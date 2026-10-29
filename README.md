# Nido

Neovimベースの、キーボードで操作するコードエディタ。
アプリ本体とGUIはRust / GPUIで動作します。

**キーボードですべての操作が完結する。**

Vimの操作を土台に、編集・検索・ファイル操作・ターミナルまで、キーボードから手を離さずに。

## 対応OS

Windows x64。Neovim、Luaによる編集機能、言語サーバー、デバッガーは外部ツールとして利用します。
WSL接続用のランタイムも維持しています。

## 開発

MSVC C++ビルドツール、Windows SDK、Node.js/npmが必要です。
Rustは`rust-toolchain.toml`で1.99.1、GPUIは0.2.2に固定しています。
Node.jsはTypeScript言語サーバーの取得・実行に使います。

Cargo workspaceの構成・各クレートの責務は[ソース構成](docs/rust-workspace.md)にまとめています。

```powershell
./scripts/prepare-runtime.ps1
cargo run --locked
# 指定フォルダーを開く
cargo run --locked -- C:\dev\project
```

`Space`でコマンド、`Space f` / `Ctrl+P`でファイル、`Ctrl+H`でエクスプローラー、
`Ctrl+Shift+F`で全文検索、`Ctrl+S`で保存、`Ctrl+Shift+2`でターミナル、
`Ctrl+K`でエディターへ戻ります。クリップボード貼り付けは`Ctrl+Shift+V`です。

## 検証・配布

```powershell
cargo fmt --all -- --check
cargo clippy --workspace --locked --all-targets -- -D warnings
cargo test --workspace --locked
cargo run --locked -- --smoke-test
cargo run --locked -- --ui-smoke-test
# NSISのmakensis.exeが必要
./scripts/package-windows.ps1
./scripts/test-package.ps1
```

配布物は`dist/release`、展開済みアプリは`dist/native/nido.exe`に生成されます。
スモークテストは一時フォルダーで実行し、利用中のワークスペースを変更しません。
`--ui-smoke-test`は実際のGPUIウィンドウを開いて、描画・入力・各パネル・終了を確認します。

設定・ワークスペース・お気に入り・Time Machineは従来と同じ`%APPDATA%/nido`を利用します。
開発用に分離する場合は`NIDO_DATA_DIR`を指定してください。
アプリはNeovimのユーザー設定を読み込まず、同梱の設定を使います。

移植範囲と検証の詳細は[移行記録](docs/rust-migration.md)、
言語サーバー追加は[Language packs](docs/language-packs.md)を参照してください。
