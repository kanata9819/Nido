# Rust / GPUIへの移行

`replace-to-rust`ブランチで、アプリ本体とGUIをRustへ置き換えています。
GUIはGPUI 0.2.2に固定し、Rustも`rust-toolchain.toml`で1.99.1に固定しています。
Electron、React、TypeScript製のアプリコードとビルド工程は削除済みです。
移行前の実装はコミット`7f09252950203f649754696604ad282dfdac76d7`で参照できます。

Neovim、Luaによる編集機能、言語サーバー、CodeLLDBは引き続き外部ツールです。
同梱Node.jsはTypeScript言語サーバー用です。

## 構成

| 担当 | 実装 |
| --- | --- |
| 設定、保存、お気に入り、パス検証 | `crates/nido-core/src` |
| Neovim、ターミナル、MessagePack-RPC | `crates/nido-backend/src/session`、`rpc.rs` |
| ファイル、検索、一括置換、Git | `crates/nido-backend/src/files`、`git.rs` |
| Time Machine、拡張、WSL、更新 | `crates/nido-backend/src`の各モジュール |
| ワークスペース状態、操作、未保存確認、復元 | `crates/nido/src/app`のModelと各責務のモジュール |
| ウィンドウ、タイトルバー、各パネル、フォーカス | `crates/nido/src/app/ui`、`ui/panels`、GPUI |
| Neovimのセル、描画、エディターIME | `crates/nido/src/grid`、`app/ui/grid_view`、GPUI / Direct3D |
| パレットなどのテキスト入力、選択、IME | `crates/nido/src/text_input` |
| Windows UI Automation | `crates/nido/src/accessibility.rs`、AccessKit |
| アイコン | `crates/nido/src/assets.rs`、`resources/nido/icons` |

依存の向き、モジュールの探し方、検証対象は[ソース構成](rust-workspace.md)を参照してください。

TS版を基準に、配色、余白、ワークスペースタブ、ファイルタブ、ナビゲーション、
エクスプローラー、ステータスバー、パレット、パネル、アイコンを再実装しています。
CSSは使わず、GPUIのレイアウトと描画で近づけています。ピクセル単位の一致は未検証です。

ワークスペースごとの独立したNeovimと、内側のファイルバッファの構成を維持しています。
バックエンドからの通知でGUIを更新し、変更のないグリッドの文字レイアウトは再利用します。
GPUIにも再描画はあります。性能の優劣は実測前には断定していません。

移植範囲はエディター、ターミナル、パレット、エクスプローラー、検索と置換、Git、
補完・診断・参照・シンボル、デバッガー、言語パック、設定、お気に入り、復元、
Time Machine、Markdownプレビュー、更新確認です。
GPUIのネイティブIMEインターフェースを使い、エディターと検索欄の未確定文字を扱います。
WindowsではAccessKitでボタン、テキスト欄、エディターの値と操作を公開します。

## 既存データ

保存先は従来どおり`%APPDATA%/nido`です。`NIDO_DATA_DIR`で分離できます。
バージョン1のワークスペースJSON、履歴、言語パックを読み込みます。
旧Electronの設定はLocal StorageのLevelDBを一時コピーして取り込み、元のDBを変更しません。

破損した設定・お気に入り・ワークスペース・履歴を空データで上書きしないようにしています。
一括置換はディスク内容と未保存状態を照合し、履歴復元とともにUndoできる編集として適用します。
終了と更新前には未保存バッファを確認します。ファイル操作先はワークスペースに固定しています。

## ビルドと配布

Windows x64向けです。開発・起動手順はルートのREADMEを参照してください。
固定Rustのrust-analyzerとrust-srcも導入し、Rustファイルの言語機能に使います。

`scripts/prepare-runtime.ps1`が固定バージョンのNeovim、Node、TypeScript LSP、CodeLLDBを準備します。
取得アーカイブはSHA-256で照合します。
`scripts/package-windows.ps1`はCRTを静的リンクした実行ファイル、NSISインストーラー、
ポータブルZIP、チェックサム、旧クライアント向け`latest.yml`を生成します。
外部ツールに必要なVC++ランタイムDLLと、依存ライブラリ・アイコンのライセンスも同梱します。

インストーラーは従来のインストール先と登録を使います。起動中のアプリの上書きを拒否し、
旧Electronの既知の配布ファイルを除去します。ユーザーデータはインストール先の外に保ちます。
パッケージ検証は`/NOINTEGRATION`と専用フォルダーを使い、実際の利用環境へ登録しません。
公開前には既存リリースより新しいCargoバージョンへ更新してください。

## 検証

```powershell
cargo fmt --all -- --check
cargo clippy --workspace --locked --all-targets -- -D warnings
cargo test --workspace --locked
cargo run --locked -- --smoke-test
cargo run --locked -- --ui-smoke-test
./scripts/package-windows.ps1
./scripts/test-package.ps1
```

単体テストはパス境界、検索・置換、RPC、設定取り込み、保存データ、履歴、言語パック、
グリッドのUnicodeとレイアウト再利用、WSL、更新URL、入力キー、アクセシビリティIDを対象にします。

`--smoke-test`は一時データで実Neovimの編集・保存・未保存保護・復元・履歴、Git、
ターミナル、Modelのパレット応答順序・操作対象・終了確認、同梱TypeScript LSPの診断・補完、
CodeLLDBのビルド・ブレークポイント・変数・ステップ・続行を検証します。

`--ui-smoke-test`は実際のGPUIウィンドウを開き、グリッド描画、合成IMEの未確定文字と確定、
候補位置、保存、パレットのフォーカスとIME、全パネルの描画、保護された終了経路を検証します。
合成IMEイベントと、物理キーボード・日本語IMEによる実機入力は別の証拠です。

`test-package.ps1`は新規導入、旧Electron配布物を模した上書き更新、インストール済みアプリの
両スモークテスト、無関係のファイルを残すアンインストールを検証します。
Windows CIにもGPUIの実ウィンドウ検証を追加しています。リモートCIはpush後の確認が必要です。

2026-10-29のローカル結果：fmt、Clippy、単体テスト14件、両スモークテスト、最終配布物の生成、
新規導入・上書き更新・実行・アンインストールが成功しました。実ウィンドウではアイコン、
ファイル選択、パレット、Windows UI Automation経由の検索欄操作も確認しています。
固定Rustではビルドできますが、依存する`proc-macro-error2 2.0.1`の将来互換警告は残っています。

## 残る手動確認

- 日本語IMEの実機入力・再変換、複数DPI・モニター、スクリーンリーダーによる一連の編集。
- 長時間利用、TS版との入力遅延・CPU/GPU負荷の比較。
- WSLの実ディストリビューション接続と、公開サーバーからの実ダウンロード更新。
- Markdownは簡易プレビューです。画像・HTMLを描画せず、表・文字装飾を簡略化しています。
- macOS・Linuxの配布と、削除済みElectron向けPlaywrightテストの再実行は対象外です。

過去の調査資料は[ドキュメント一覧](README.md)を参照してください。
