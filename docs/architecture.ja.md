# Nidoのしくみ（コードの地図）

Nidoのコードを初めて読む人向けの案内です。「どのファイルが何をしているか」と「キーを押してから画面が変わるまでに何が起きるか」をまとめています。

## 全体像

Nidoは、3つのプログラムが協力して動いています。

```
┌──────────────────────────┐   IPC     ┌──────────────────────────┐  RPC（msgpack）  ┌──────────────────┐
│ レンダラー（画面）        │ ────────▶ │ メインプロセス            │ ───────────────▶ │ Neovim           │
│ React / Canvas            │ ◀──────── │ Electron / Node.js        │ ◀─────────────── │ （nvim --embed） │
│ src/renderer/src          │  イベント │ src/main                  │  通知（redraw等）│ resources/nido   │
└──────────────────────────┘           └──────────────────────────┘                  └──────────────────┘
        ▲      preload（src/preload）が橋渡しをする
```

| 役割               | 場所               | ひとことで                                                                     |
| ------------------ | ------------------ | ------------------------------------------------------------------------------ |
| **レンダラー**     | `src/renderer/src` | ウィンドウの中身。ReactでUIを作り、エディター部分はCanvasに自前で文字を描く    |
| **preload**        | `src/preload`      | レンダラーとメインプロセスをつなぐ窓口。`window.nido` というAPIを用意する      |
| **メインプロセス** | `src/main`         | Electronの本体。ウィンドウを作り、ワークスペースごとにNeovimを起動して管理する |
| **Neovim**         | `resources/nido`   | 実際の編集を担当する本物のNeovim。Nido専用の設定（Lua）で動く                  |
| **共有の型**       | `src/shared`       | 3者のあいだでやりとりするデータの形（TypeScriptの型）や翻訳文                  |

ポイントは、**文字の編集そのものはNeovimがやっていて、Nidoはその結果を画面に描いている**ということです。Vimの操作がそのまま使えるのはこのためです。

## 用語

- **ワークスペース**：開いているプロジェクトフォルダー1つ分。ワークスペースごとにNeovimが1つ起動します。
- **セッション（`Session`）**：メインプロセス側で、1つのNeovimプロセスを管理するクラス（`src/main/session.ts`）。
- **IPC**：Electronで、レンダラーとメインプロセスがメッセージをやりとりするしくみ。
- **RPC**：メインプロセスがNeovimの関数（`nvim_input` など）を呼び出すしくみ。Neovimの標準入出力を使って、msgpack形式でやりとりします。
- **redraw（再描画）イベント**：Neovimが「画面のこの行がこう変わった」と知らせてくるメッセージ。Neovimの「外部UI」機能（`:help ui`）の一部です。
- **グリッド**：Neovimの画面を、行×列のマス目として表したもの。

## アプリが起動するまで

1. **`src/main/index.ts`**：Electronが起動すると、ここが最初に動きます。保存されたウィンドウの大きさを読み、`BrowserWindow`（ウィンドウ）を作ります。
2. **`src/main/handlers.ts`**：レンダラーから呼ばれる窓口（`nido:◯◯` というIPC）をまとめて登録します。ファイル・Git・ワークスペースなどの窓口は、それぞれ `fileHandlers.ts`・`gitHandlers.ts`・`workspaceHandlers.ts` に分かれています。
3. ウィンドウに **`src/renderer/index.html`** が読み込まれ、**`src/renderer/src/main.tsx`** が `App` を描画します。
4. **`src/renderer/src/App.tsx`**：画面全体の部品（タイトルバー・サイドバー・エディター・ステータスバーなど）を組み立てます。
5. レンダラーが「前回のワークスペースを復元して」と頼むと（`restoreWorkspaces`）、メインプロセスが **`Session.create()`**（`src/main/session.ts`）でワークスペースごとにNeovimを起動します。
6. **`src/main/neovimProcess.ts`**：同梱の `nvim.exe` を `--embed`（画面を持たない、プログラムから操作するモード）で起動します。設定は `resources/nido/init.lua` だけを読み、ユーザー自身のNeovim設定は読みません。
7. 起動したら `resources/nido/session.lua` を実行し、Neovimからの通知をメインプロセスへ送るしかけを入れます。そのあと言語パック（`nido_language_packs.lua`）を適用して、言語サーバーを使えるようにします。

## キーを押してから画面が変わるまで

例として、エディターで `i` を押した場合です。

1. **レンダラー**：`src/renderer/src/hooks/useEditorInput.ts` がキー入力を受け取り、`window.nido.input(id, keys)` を呼びます。`Esc` や `Ctrl` を使うキーは、`src/renderer/src/keyboard.ts` の `vimKey()` でNeovimのキー表記（`<Esc>`・`<C-d>` など）に変換されます。
2. **preload**：`src/preload/index.ts` が、それを `nido:input` というIPCとしてメインプロセスに送ります。
3. **メインプロセス**：`handlers.ts` の `handle('input', …)` が受け取り、該当する `Session` の `input()` を呼びます。実際の処理は `sessionInteraction.ts` で、Neovimに `nvim_input` をRPCで送ります。
4. **Neovim**：キーを処理してインサートモードに入り、「画面のこの部分が変わった」という `redraw` 通知を返します。
5. **メインプロセス**：`src/main/sessionEvents.ts` が `redraw` 通知を受け取り、1フレーム分がそろってから `nido:event` としてレンダラーへ送ります（中途半端な状態を描かないため）。
6. **レンダラー**：`src/renderer/src/nidoEvents.ts` がイベントを受け取り、`useEditorRendering.ts` が **`Grid.apply()`**（`src/renderer/src/grid.ts`）でマス目を更新します。
7. **描画**：`src/renderer/src/gridCanvas.ts` が、変わった行だけをCanvasに描き直します。

## ディレクトリの案内

### `src/main`（メインプロセス）

| ファイル                                   | 役割                                                                              |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| `index.ts`                                 | 起動の入口。ウィンドウ作成と自動アップデートの準備                                |
| `handlers.ts`                              | IPCの窓口をまとめて登録する。送り主のチェックもここ                               |
| `*Handlers.ts`                             | 分野ごとのIPCの窓口（ファイル、Git、ワークスペース、履歴、言語パックなど）        |
| `session.ts`                               | 1つのNeovimを管理する `Session` クラス。仕事の中身は `session*.ts` に分担している |
| `neovimProcess.ts`                         | Neovimプロセスの起動（Windows版とWSL版）                                          |
| `sessionClient.ts`                         | NeovimとのRPC通信。Neovimが終了したとき、待っている呼び出しを確実に終わらせる     |
| `sessionEvents.ts`                         | Neovimからの通知を受け取り、まとめてレンダラーに送る                              |
| `sessionInteraction.ts`                    | キー入力・クリック・スクロールなど、操作をNeovimに伝える                          |
| `sessionFiles.ts` / `sessionBuffers.ts`    | ファイルを開く・保存する、タブ（バッファ）の操作                                  |
| `git.ts`                                   | Gitの操作                                                                         |
| `persistence.ts` / `sessionPersistence.ts` | ワークスペースやウィンドウの状態を保存・復元する                                  |
| `localHistory.ts` / `historyService.ts`    | 編集タイムマシン（編集履歴の記録と復元）                                          |
| `updater.ts`                               | 自動アップデート                                                                  |
| `wsl.ts`                                   | WSL（Windows上のLinux）のフォルダーを開く処理                                     |

### `src/renderer/src`（画面）

| ファイル・フォルダー            | 役割                                                                  |
| ------------------------------- | --------------------------------------------------------------------- |
| `main.tsx`                      | Reactの入口                                                           |
| `App.tsx`                       | 画面全体の組み立てと、ワークスペースの切り替え                        |
| `Editor.tsx`                    | エディター1つ分。Canvasと、キー入力を受け取る見えないテキスト欄を持つ |
| `grid.ts`                       | Neovimの画面をマス目として持つ。`redraw` イベントを反映する           |
| `gridCanvas.ts`                 | マス目をCanvasに描く                                                  |
| `editorScroll.ts` / `scroll.ts` | なめらかなスクロールの計算                                            |
| `nidoEvents.ts`                 | メインプロセスからのイベントを、必要な部品に配る                      |
| `components/`                   | 画面の部品（サイドバー、補完メニュー、通知など）                      |
| `hooks/`                        | Reactのフック。部品の状態や処理をまとめたもの                         |
| `i18n.ts`                       | 日本語・英語の切り替え                                                |

### `resources/nido`（Neovim側）

| ファイル・フォルダー          | 役割                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------- |
| `init.lua`                    | Nido専用のNeovim設定                                                             |
| `session.lua`                 | Neovimの出来事（編集・スクロールなど）をメインプロセスへ知らせる                 |
| `lua/nido_*.lua`              | 機能ごとのLua。補完、診断、Gitの差分表示、スティッキースクロール、デバッガーなど |
| `lua/nido_language_packs.lua` | 言語パック（TypeScript・Rust・Denoなど）を読み込み、言語サーバーを起動する       |
| `language-packs/`             | 言語パックごとの設定とアダプター                                                 |

### `tests`

| 種類                            | 実行方法                  | 中身                                              |
| ------------------------------- | ------------------------- | ------------------------------------------------- |
| `*.test.ts`                     | `pnpm test`               | Node.jsのテスト。本物のNeovimを起動するものも多い |
| `*.spec.ts`                     | `pnpm test:renderer` など | Playwrightのテスト。ブラウザーで画面を確かめる    |
| `windows/` と一部の `*.spec.ts` | `pnpm test:windows`       | ビルドしたNidoを起動して、実際に操作するテスト    |

## 読み始めるなら

1. `src/main/index.ts` → `src/main/session.ts` の `create()`：起動の流れ
2. `src/preload/index.ts`：レンダラーから呼べる機能の一覧
3. `src/renderer/src/Editor.tsx` → `grid.ts` の `apply()`：画面に文字が出るまで
