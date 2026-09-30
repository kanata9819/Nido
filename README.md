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

Rustの`main`・テスト・テストモジュールにはRun / Debugの案内を表示します。
対象のコード内にカーソルを置き、Normalモードで`gR`（実行）／`gD`（デバッグ）。
操作メニューからも検索できます。ファイルを保存してから実行してください。
結果は下部パネル、ブレークポイントは`F9`、停止は`Shift+F5`です。

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

## コードの責務

- `App.tsx`：画面全体の構成とパネル・フォーカスの連携。表示部品は `components/`、設定のセッション反映は `useSessionSettings.ts`。
- `Sidebar.tsx`：ツリー表示とリサイズ。ファイル一覧・展開・ファイル操作は `useExplorer.ts`、移動キーは `sidebarKeyboard.ts`。
- `GitBrowser.tsx`：Git画面の状態とデータ取得。リストは `GitBrowserList.tsx`、詳細は `GitDetails.tsx`、キー操作は `useGitBrowserKeyboard.ts`。
- `Session`：Neovimプロセスと入力・終了の管理。通知と描画フレームは `SessionEvents`、ファイル操作は `SessionFiles`。
- `handlers.ts`：IPCの送信元検証とエディタ操作。ワークスペースの保存・復元・終了は `workspaceHandlers.ts`、Git操作は `gitHandlers.ts`。

## コードを読む順番

まず画面側の入口を読み、そこで呼ぶ処理をたどると、操作と結果をつなげやすくなります。
以下の画面側ファイルは `src/renderer/src/`、Neovim・IPC側は `src/main/` にあります。

- **エクスプローラのキー操作**：`Sidebar.tsx` → `sidebarKeyboard.ts`。表示中の行から選択位置を調べ、キーに応じた移動量を足し、移動先を画面内に表示します。
- **ファイルの作成・移動**：`useExplorer.ts` → `components/ExplorerCommands.tsx` → `handlers.ts` → `sessionFiles.ts`。選択から操作先を決め、ダイアログで入力を受け、メインプロセスでファイルを操作します。
- **Git画面**：`components/GitBrowser.tsx` → `GitBrowserList.tsx` / `GitDetails.tsx`。`view` は `changes`・`history`・`branches` のいずれか。取得先を調べたい場合は `gitHandlers.ts` を読みます。
- **エディタの描画**：`session.ts` → `sessionEvents.ts` → `hooks/useEditorRendering.ts`。Neovimの通知を受け、`flush` までの描画命令を一つのフレームにまとめ、画面側へ送ります。スクロール中は行と端数の位置をまとめて反映します。
