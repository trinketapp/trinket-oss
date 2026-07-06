# Python学習プレイグラウンド PoC

Trinket OSSをそのまま運用する代わりに、ブラウザだけでPython/Pygameを動かす軽量構成を検証するPoCです。

## 構成

- Vue 3 + Vite
- Pyodide 0.29.4をjsDelivrから読み込み
- `pygame-ce` をPyodide経由で読み込み
- Skulpt 1.2.0でturtle実行を検証
- `localStorage` による手元保存
- ユーザー作成コードの共有URL・任意iframe埋め込みは停止中
- `/capabilities` でPython/Pygameの対応表を表示
- `/samples` で公式Showcaseを表示
- `/archive` でエクスポート済みTrinketコードの一覧を表示

## コマンド

```bash
npm install
npm run dev
npm run build
npm run preview
npm run test:e2e
```

開発サーバーは `http://127.0.0.1:3100/` で起動します。

## ページ

| パス | 内容 |
| --- | --- |
| `/` | 日本語UIのPython/Pygameエディタ |
| `/turtle` | Skulptを使ったturtleエディタ |
| `/archive` | エクスポート済みコードを眺めて固定IDで開く検証用リスト |
| `/capabilities` | Python/Pygameでできること・できないことの一覧 |
| `/samples` | Python基礎からpygame応用まで順に確認するShowcase |

## Showcase

`/samples` は教材用のShowcaseです。Pythonの出力、条件分岐、ループ、関数、クラス、仮想ファイル操作から、pygameの図形描画、アニメーション、入力、当たり判定、パーティクル表現まで順に並べています。

重くならないように、一覧ではサンプル名と学習ポイントだけを表示し、実際のiframeは選択中の1件だけを描画します。pygameサンプルを複数同時に起動しないため、教材ページで確認するときの負荷を抑えられます。

Showcaseのiframeは `sample=<id>` の固定サンプルだけを実行します。第三者が任意コードをURLへ詰めて共有できないように、`code` パラメータは読み込まない方針です。公開共有を再開する場合は、保存API、権限制御、通報/削除導線、監査ログを入れてから有効化します。

## Export Archive

`/archive` は `tmp/trinket-export-data` と `tmp/trinket-export-data(イノベーター)` から生成した静的な検証用一覧です。

```bash
npm run build:archive
```

生成先は `public/trinket-archive/` です。各プロジェクトは固定IDの `archive=<id>` でエディタへ読み込めます。Pygame素材はPyodideの仮想ファイルシステムへ配置し、turtle素材はSkulptの `TurtleGraphics.assets` へ渡します。

現時点のSkulpt npm版ではTrinketの画像shape登録が完全互換ではないため、`screen.addshape()` は検証時にスキップし、画像shapeは標準の `turtle` へフォールバックします。背景画像の `screen.bgpic()` は検証対象です。

## Pygameの前提

pygameはサーバーコンテナではなく、WebAssembly上のPyodide + pygame-ceとしてブラウザ内で動きます。ホスティングは軽くできますが、教材コードはブラウザのイベントループへ処理を返す必要があります。

```python
async def main():
    while True:
        ...
        await asyncio.sleep(0)

asyncio.run(main())
```

同期的な `while True` はブラウザを固めるため、教材側で上記の形へ寄せる必要があります。

## Turtleの前提

`/turtle` はSkulptでPython/turtleをブラウザ内実行します。まずは標準的な線描画、塗りつぶし、`write()` を確認するPoCです。

Trinket教材の本格移行では、次に `screen.bgpic()`、`screen.addshape()`、プロジェクト内 `assets/` の画像解決、`screen.onkey()`、`input()` の挙動を個別に検証します。Pygameとは別ランタイムとして扱い、教材種別に応じてPyodide/Skulptを切り替える前提です。

## デプロイ方針

現状は静的配信だけで動くため、Cloudflare PagesやVoid Cloudに載せやすい構成です。保存済みコード、複数ファイル、画像/音声素材、非公開教材が必要になった段階で、実行はブラウザ側に残したまま、D1/R2などの小さな保存APIを追加する方針が現実的です。

## Cloudflare Workers

Cloudflare Workers Static Assetsとしてデプロイする場合の設定です。

| 項目 | 値 |
| --- | --- |
| Worker name | `pygame-pf` |
| Build command | `npm run build` |
| Build output directory | `dist` |

SPAの直URLは `wrangler.jsonc` の `assets.not_found_handling = "single-page-application"` で処理します。

```bash
npm run deploy
```
