# Nido

Neovimの編集機能と、キーボードで操作できるデスクトップGUIを組み合わせたエディタの初版です。
上段のワークスペースタブはそれぞれ独立したNeovimプロセス、その内側のファイルタブは各セッションのバッファです。

## 起動

Node.js 22以降と、PATHに登録されたNeovim 0.11以降が必要です。
実行ファイルを指定する場合は、環境変数 `NIDO_NVIM` にnvim.exeのパスを設定してください。

```powershell
cd C:\dev\00_experiments\Nido
pnpm install
pnpm dev
```

Electronの実行ファイルが未取得の場合は `node node_modules/electron/install.js` で取得できます。

## 操作

| キー | 操作 |
| --- | --- |
| Ctrl+Shift+N | フォルダを選び、新しいワークスペースを開く |
| Ctrl+Tab / Ctrl+Shift+Tab | 次 / 前のワークスペース |
| Alt+1 … Alt+9 | ワークスペースを直接選ぶ |
| Ctrl+Shift+P | すべてのコマンド |
| Space（Normal時） | キー操作メニュー |
| Space w / f / b | ワークスペース / ファイル検索 / 開いているファイル |
| Space e | エクスプローラーに移動。j/kで上下、h/lで開閉、Enterで開く |
| Space n / x | ワークスペースを開く / 閉じる |
| Space h / l | ワークスペースタブを左 / 右に並べ替える |
| Space s / Ctrl+S | 保存 |
| Space d | ファイルタブを閉じる。未保存なら確認する |
| Space , | 設定。文字サイズとサイドバー表示 |
| Ctrl+P（Insert以外） | ファイル名で検索 |
| Ctrl+Shift+V | OSのクリップボードから貼り付け |
| Ctrl+V | Vim標準の矩形選択など |
| Esc | メニューを閉じる / 編集に戻る / Normalへ戻る |
| Ctrl+j / Ctrl+k または矢印 | 検索メニュー内の移動 |

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

- `--clean`で起動します。既存のinit.luaやプラグイン設定は変更せず、読み込みもしません。
- アプリ終了後のワークスペース復元は未実装です。終了時には未保存変更を確認します。
- ファイル検索は名前の検索です。全文検索・Gitパネル・LSP設定・プラグイン管理はまだありません。
- ファイル検索は最大5,000件・12階層。依存関係やビルド出力の代表的なフォルダは除外します。
- IMEの確定イベントによる二重入力と日本語保存は自動テスト済みです。Windows IMEの候補位置・実際の変換操作は手動確認が必要です。
- 編集画面は初期のCanvas描画です。合字・複雑な文字組版・文書全体のスクリーンリーダー対応には追加実装が必要です。表示中の行はCanvasの説明として公開し、GUI操作部分はDOM要素で実装しています。
- インストーラーと自動更新は未検証です。現在は開発起動またはビルド後の起動で使用します。

コミットはまだ作成していません。
