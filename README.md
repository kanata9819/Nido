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
| Ctrl+Shift+X             | 対応言語・機能一覧   |
| Ctrl+Shift+V（Markdown） | プレビュー           |
| Ctrl+@                   | ターミナル           |
| Space（Normalモード）    | 操作メニュー         |
| Space ,（Normalモード）  | 設定                 |
| Alt+Shift+S              | Sticky Scrollに移動  |

編集はVimの操作に対応。設定からEditorConfig・相対行番号などを切り替えられます。

左の機能一覧ボタン、`Ctrl+Shift+X`、コマンドパレットの **Features / 機能一覧** から、**Languages / 対応言語** を確認できます。補完・診断・コード操作に対応する言語、プレビュー対応、色分けのみの対応を分けて表示し、Rustの導入コマンドも確認できます。言語名・拡張子で検索でき、ビルトイン機能一覧へはタブで切り替えます。ワークスペースを開く前でも利用でき、Escで編集画面に戻れます。

設定の **Language / 言語** で **English / 日本語** を選べます。UIはその場で切り替わり、再起動後も選択を維持します。初期値は英語です。メニュー・コマンド検索・操作ガイド・確認ダイアログも選択した言語で表示します。

Sticky Scrollは、現在の関数やクラスの見出しをエディタ上端に固定します。
クリックで見出しへ移動し、Shiftを押しながら重ねると終了行を表示・クリックできます。
`Alt+Shift+S`で見出しへフォーカスし、`j` / `k`とEnterで移動、Escで編集に戻れます。
設定の **Sticky Scroll** で有効・無効と最大表示行数（初期値5）を保存できます。

設定の **Theme** で **Dark Modern / Dark Modern (Acrylic)** を選べます。選択は保存され、編集中でも切り替えられます。
Dark Modern (Acrylic)はDark Modernの配色を保った半透明のパネルを使い、Windows 11 22H2以降ではネイティブのアクリル背景も適用します。
コード領域も背景が半透明になり、文字と選択範囲は濃さを保ちます。Dark Modernでは従来の不透明な描画を使います。

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
pnpm typecheck # TypeScript型チェック
pnpm lint      # ソースの静的解析
pnpm test      # Neovim連携・スクロール状態
pnpm test:e2e  # ビルド済みアプリの操作
pnpm exec playwright install chromium # レンダラーのテスト用ブラウザーを初回に準備
pnpm test:renderer # ChromiumでUIの状態遷移と非同期処理を検証（Electron/Neovim不要）
```

型チェックはTypeScript 7を使います。Lintが利用するTypeScript APIは、公式の互換パッケージでTypeScript 6を併用しています。

### Windows版の基本動作確認

Windows x64で次を実行すると、警告ゼロのLint・型チェック・配布用ビルド・単体テスト・レンダラーのテスト・実アプリの操作テストをまとめて確認できます。GitとRustのMSVCツールチェーン（C++ Build Toolsを含む）、`rust-analyzer`・`rust-src`・`rustfmt`が必要です。

```powershell
rustup component add rust-analyzer rust-src rustfmt
pnpm verify:windows
```

操作テスト26件は`dist/win-unpacked/nido.exe`を直接起動します。起動と同梱リソース、日本語・空白を含むパス、CRLFでの保存、貼り付けの入力順序、Windowsクリップボード、AltGrキーイベント、IMEの変換イベント、ワークスペースとファイル操作、Git、補完・診断・参照、ターミナル、Rustデバッグ、設定と終了・復元、100%・125%・150%表示を確認します。各テストには一時フォルダーと独立したプロファイルを使います。

ビルド済みの場合は`pnpm test:windows`だけでも実行できます。必須ケースの欠落・スキップ・未処理のレンダラー例外も失敗扱いです。Windows以外では成功扱いにせず、実行条件のエラーを返します。

PRとmainへのpushでGitHub Actionsの **Windows baseline** が実行され、リリースも同じ操作テストの成功後に公開されます。失敗時はActionsの`windows-baseline-reports`からレポートとログを取得できます。このセットは主要機能の回帰確認用で、実際のIME・キーボード配列やインストーラーによる更新は別途確認してください。

## アプリの更新

最初は `nido-0.2.2-setup.exe` でインストールしてください。タイトルバーの最小化ボタン左にある更新ボタンから、更新確認・ダウンロード・再起動を行えます。
起動後にも更新を確認します。ダウンロードや再起動はボタンを押すまで行いません。再起動前に未保存ファイルを確認し、ワークスペースを保存してNeovimを終了します。
開発版や `win-unpacked` の直接起動では更新を無効にしています。失敗時は既存の通知で理由を表示し、再試行できます。

更新元は公開リポジトリ `kanata9819/Nido` のGitHub Releasesです。
`package.json` のバージョンを上げて、その変更を含む `v0.2.2` のようなタグをpushすると、GitHub ActionsがWindows版をビルド・テストして公開します。
タグとバージョンが一致しなければ公開しません。インストーラー、`.blockmap`、`latest.yml` を同じReleaseへ配布し、Neovimや言語サーバーなどの同梱リソースもまとめて更新します。
ローカルの `pnpm build:win` は公開せず、インストーラーと更新情報を生成します。

Windowsのインストールでは、一時フォルダへの展開後、同じドライブならフォルダごと移動して二重のコピーを省きます。
別ドライブへのインストールや空でないインストール先では、コピーに切り替えます。
`pnpm test:installer` は隔離フォルダで移動・コピー・使用中ファイル・展開失敗を確認します。実際のインストール先やユーザー設定は変更しません。
展開後のフックは `patches/app-builder-lib@26.15.3.patch` で追加しています。electron-builderを更新する際も、このテストで移動処理が使われることを確認してください。

配布前の検証は `tests/update.spec.ts` にあります。ローカルHTTPサーバーから実際のインストーラーを取得し、ハッシュ検証・保存確認のキャンセル・保存後のインストーラー呼び出しを確認します。OSへのインストール実行はテストで置き換えています。
`dist/auto-update` にWindows版を生成した後、以下で実行できます。

```powershell
$env:NIDO_PACKAGED_EXE = "$PWD/dist/auto-update/win-unpacked/nido.exe"
$env:NIDO_UPDATER_FIXTURE = '1'
pnpm exec playwright test tests/update.spec.ts
```

## コードの責務

- `App.tsx`：画面全体の構成とパネル・フォーカスの連携。表示部品は `components/`、設定のセッション反映は `useSessionSettings.ts`。
- `Sidebar.tsx`：ツリー表示とリサイズ。ファイル一覧・展開・ファイル操作は `useExplorer.ts`、移動キーは `sidebarKeyboard.ts`。
- `Editor.tsx`：入力とエディタ領域。描画は `useEditorRendering.ts`、スクロールの送信待ち・描画待ちは `scroll.ts` の `ScrollQueue`。
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
