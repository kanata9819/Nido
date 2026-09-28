# Nido

Neovimベースの、キーボードで操作できるWindows用エディタ。
ワークスペース、ファイル検索、Git、ターミナル、Rust / TypeScriptのLSPに対応。

## 開発

Windows x64・Node.js 22以降・pnpmが必要です。Neovimは初回起動時に取得します。

```powershell
pnpm install
pnpm dev
```

## 主な操作

| キー                     | 操作                 |
| ------------------------ | -------------------- |
| Ctrl+Shift+N             | ワークスペースを開く |
| Ctrl+P                   | ファイル検索         |
| Ctrl+S                   | 保存                 |
| Ctrl+Shift+G             | Git                  |
| Ctrl+Shift+V（Markdown） | プレビュー           |
| Ctrl+@                   | ターミナル           |
| Space（Normalモード）    | 操作メニュー         |
| Space ,（Normalモード）  | 設定                 |

編集はVimの操作に対応。設定からEditorConfig・相対行番号などを切り替えられます。

## 言語サポート

- Rust：`rustup component add rust-analyzer rust-src rustfmt`
- TypeScript / JavaScript：プロジェクトのTypeScriptを優先し、なければ外部または同梱サーバーを使用。
- Git操作にはPATH上のGitが必要です。

## ビルド・テスト

```powershell
pnpm build:win  # Windowsインストーラー
pnpm test      # Neovim連携
pnpm test:e2e  # ビルド済みアプリの操作
```
