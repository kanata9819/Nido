# Nido

Neovimの編集機能と、キーボードで操作できるデスクトップGUIを組み合わせたエディタの初版です。
上段のワークスペースタブはそれぞれ独立したNeovimプロセス、その内側のファイルタブは各セッションのバッファです。

## 起動

開発にはWindows x64、Node.js 22以降が必要です。
`pnpm dev` / `pnpm build` は初回に公式Neovim 0.11.5を取得し、固定SHA256で検証します。
Neovim本体・DLL・runtime一式を配布物に含めるため、利用者のNeovimインストールやPATH設定は不要です。

```powershell
cd C:\dev\00_experiments\Nido
pnpm install
pnpm dev
```

Electronの実行ファイルが未取得の場合は `node node_modules/electron/install.js` で取得できます。

## Windows配布

`pnpm build:unpack`で`dist/win-unpacked/nido.exe`、`pnpm build:win`でインストーラーを生成します。
展開版はフォルダ全体で配布してください。Neovimは`resources/nvim-win64`、専用設定は`resources/nido/init.lua`に配置されます。
ライセンスは`resources/nido/NEOVIM-LICENSE.txt`とNeovim runtimeの`doc/uganda.txt`に含まれます。
同梱版の対応OSは現在Windows x64のみです。

## 専用設定とLSP

専用設定の編集元は`resources/nido/init.lua`です。個人のinit.lua、プラグイン、ShaDaは読み込みません。
追加プラグインやプラグインマネージャーは同梱せず、Neovim標準機能を使います。
RustはPATH上の`rust-analyzer`があれば自動接続します。言語サーバーとRustツールチェーンは別途必要です。
LSP接続時は`gd`で定義、`gr`で参照、`K`で説明を表示します。`Ctrl+O`でジャンプ前へ戻れます。
コマンド・検索入力は現在Neovim標準の画面下部です。Reactによるコマンド欄・通知表示は今後の対応です。

## 操作

| キー                       | 操作                                                      |
| -------------------------- | --------------------------------------------------------- |
| Ctrl+Shift+N               | フォルダを選び、新しいワークスペースを開く                |
| Ctrl+Tab / Ctrl+Shift+Tab  | 次 / 前のワークスペース                                   |
| Alt+1 … Alt+9              | ワークスペースを直接選ぶ                                  |
| Ctrl+Shift+P               | すべてのコマンド                                          |
| Space（Normal時）          | キー操作メニュー                                          |
| Space w / f / b            | ワークスペース / ファイル検索 / 開いているファイル        |
| Space e                    | エクスプローラーに移動。j/kで上下、h/lで開閉、Enterで開く |
| Space n / x                | ワークスペースを開く / 閉じる                             |
| Space h / l                | ワークスペースタブを左 / 右に並べ替える                   |
| Space s / Ctrl+S           | 保存                                                      |
| Space d                    | ファイルタブを閉じる。未保存なら確認する                  |
| Space ,                    | 設定。文字サイズとサイドバー表示                          |
| Ctrl+P（Insert以外）       | ファイル名で検索                                          |
| Ctrl+Shift+V               | OSのクリップボードから貼り付け                            |
| Ctrl+V                     | Vim標準の矩形選択など                                     |
| Esc                        | メニューを閉じる / 編集に戻る / Normalへ戻る              |
| Ctrl+j / Ctrl+k または矢印 | 検索メニュー内の移動                                      |

編集はNeovimが担当するため、`/`、`:%s`、`:e`、`:w`、Undo、画面分割、`:tabnew`などを使えます。
新規ファイルは `:e filename`、名前のないバッファの保存は `:w filename` です。
ワークスペースを切り替えても、編集中の内容とUndo履歴はそれぞれのNeovimに残ります。

## 検証

```powershell
pnpm lint
pnpm build
pnpm test
pnpm test:e2e
pnpm start
```

`test`は実際のNeovimを2つ起動し、編集・日本語文字の保存・状態の分離・保存エラー・パス境界・描画グリッドを確認します。
`test:e2e`はビルド済みElectronを起動し、キーボードでの編集・保存・矩形選択・ワークスペース切り替え・エクスプローラー・未保存保護と画面更新を確認します。
テスト内のフォルダ選択と確認ダイアログの回答は自動化されています。Windowsネイティブダイアログのキー操作は別途確認対象です。

## 構成

- `src/main/session.ts`: Neovimの起動、RPC、ファイル操作、正常終了
- `src/main/index.ts`: Electronウィンドウ、確認ダイアログ、限定されたIPC
- `src/preload`: sandbox / contextIsolationを保ったGUI向けAPI
- `src/renderer/src/App.tsx`: ワークスペース、ファイルタブ、操作メニュー
- `src/renderer/src/Sidebar.tsx`: ファイル一覧
- `src/renderer/src/Editor.tsx` / `grid.ts`: Canvas描画、キー入力、IME確定文字
- `src/renderer/src/Nido.module.css`: ダークテーマとGUIの見た目

## 初版の範囲

- 同梱NeovimとNido専用設定で起動します。タブバー・ステータスバーはNido側が表示します。
- 通常終了時にプロジェクトの並び・選択中のプロジェクト・開いたファイル・各ファイルのカーソル位置を保存し、次回起動時に復元します。保存先はElectronのuserData内の`workspaces.json`です。削除されたファイルやフォルダはスキップして通知します。
- 終了時には未保存変更を確認します。未保存の本文・無名バッファ・Undo履歴・画面分割は復元対象外です。強制終了時は最後の通常終了時の状態に戻ります。
- ファイル検索は名前の検索です。全文検索・Gitパネル・言語サーバーのインストールUI・プラグイン管理はまだありません。
- ファイル検索は最大5,000件・12階層。依存関係やビルド出力の代表的なフォルダは除外します。
- IMEの確定イベントによる二重入力と日本語保存は自動テスト済みです。Windows IMEの候補位置・実際の変換操作は手動確認が必要です。
- 編集画面は初期のCanvas描画です。合字・複雑な文字組版・文書全体のスクリーンリーダー対応には追加実装が必要です。表示中の行はCanvasの説明として公開し、GUI操作部分はDOM要素で実装しています。
- インストーラーと自動更新は未検証です。現在は開発起動またはビルド後の起動で使用します。

コミットはまだ作成していません。
