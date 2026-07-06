# ブラウザPythonエディタ 本実装 詳細設計

## 1. 目的

Trinket終了後も、イノベーター / イノベーターネクストのPython教材を継続できるブラウザ実行型エディタを提供する。

本設計は検証用PoC `/Users/noname/workspace/personal/trinket-oss/labs/browser-python-playground` の結果を踏まえ、Nuxt + Cloudflare Workers をベースに、既存の Cognito 認証基盤、既存API、既存DBを活用して本実装へ進むための設計を定義する。

## 2. 対象外

検証用PoC `/Users/noname/workspace/personal/trinket-oss/labs/browser-python-playground` で作成した下記は本番機能には含めない。

- Showcaseページ
- エクスポート確認用の「おもしろコード倉庫」
- 任意コードをURLに直接詰める共有
- localStorageだけに依存した恒久保存
- 無断の暗黙的async変換

ただし、同PoCで得た知見は実装方針へ反映する。

## 2.1 要件対応表

| 要件 | 本設計での対応 | 主な章 |
| --- | --- | --- |
| 画像などのファイル読み込み | プロジェクトに複数ファイルを持たせ、画像はランタイム起動前にPyodide FSまたはSkulpt assetsへ接続する | 6 |
| デフォルトへのリセット | `LessonTemplate.defaultFiles` と `StudentProject.templateVersionId` を持ち、テンプレートから復元する | 7 |
| 埋め込みリンク・外部出力 | editorあり/output-only/read-onlyを既存システムの権限・画面設計に沿って制御する | 8 |
| turtleサポート | turtle教材はPyodideではなくSkulptで実行する | 9 |
| 共有・提出URL | コード本体をURLへ含めず、DB上の `Share` / `Submission` を参照する | 11 |
| コード保存・復活 | サーバー保存を正本、localStorage/IndexedDBを補助退避として扱う | 10 |
| asyncio/無限ループ | 暗黙変換は標準化せず、実行前検査・警告・実行環境分離・移行支援ツールで対応する | 5.5, 15 |

## 3. 検証用PoCからの前提

### 3.1 Pygame

既存Pygame教材は Pyodide + pygame-ce でブラウザ実行できる見込みがある。

一方、既存Trinket形式のPygameコードは同期的な `while True` ループが多く、ブラウザのメインスレッドでそのまま実行するとフリーズリスクが高い。

暗黙的なasync変換は、教材の挙動を変えるリスクがあるため、本番では標準動作にしない。

### 3.2 Turtle

Innovator向けの別エクスポートでは turtle 利用が中心だった。

標準Pythonの `turtle` はブラウザ上のPyodideではそのまま扱いにくい。Trinket OSSも turtle は Skulpt 前提で実装されていたため、本実装でも turtle 教材は Skulpt 系ランタイムを使う方針が妥当。

### 3.3 画像素材

Pygame / turtle ともに、教材内で `"foo.png"` のような相対パス指定で画像を読むケースが多い。実行時には、プロジェクトに紐づく画像ファイルをランタイムのファイル解決へ接続する必要がある。

## 4. 技術構成

### 4.1 フロントエンド

- Nuxt
- CodeMirror 6
- Pyodide + pygame-ce
- Skulpt
- 実行結果表示用 canvas / turtle描画領域
- Cognito連携済みの既存ログイン状態を利用

### 4.2 デプロイ

- Cloudflare Workers
- Nuxt/Nitro の Cloudflare preset を使用
- 静的アセットは Workers Assets として配信
- SSRやサーバー側処理が必要な場合は Cloudflare Worker 上で実行

Cloudflare公式ドキュメントでは、NuxtをWorkersへデプロイする場合、WranglerがNuxtを検出し、`.output/server/index.mjs` と `.output/public` を使う構成を生成できる。`nodejs_compat` と observability の有効化も推奨されている。

### 4.3 既存システムとの連携

既存システムに Cognito / API / DB があり、モノレポ内の既存方針に則って開発する前提とする。

この設計書では、バックエンド連携方式、APIルーティング、認証middleware、DB接続方式を個別に決めない。移行先システムの既存設計に合わせる。

本エディタ側が既存基盤へ要求する契約は下記。

- ログイン中ユーザーを識別できること
- レッスン/教材/受講状態に紐づくプロジェクトを取得できること
- 生徒の編集コードとファイルを保存・復元できること
- 講師確認や提出に必要なスナップショットを扱えること
- 埋め込み/共有表示に必要なアクセス可否を判定できること

## 5. ランタイム設計

### 5.1 Runtime種別

プロジェクトごとに `runtime` を持つ。

```ts
type Runtime = 'python3' | 'pygame' | 'turtle'
```

| runtime | 実行基盤 | 主用途 |
| --- | --- | --- |
| `python3` | Pyodide | 通常Python 3 |
| `pygame` | Pyodide + pygame-ce | Python 3 + Pygame |
| `turtle` | Skulpt | イノベーター |

`pygame` runtime は Pyodide 上に `pygame-ce` を追加ロードしたものなので、Python 3としても動作する。実装上は `python3` と `pygame` を完全に別エンジンに分ける必要はなく、同じPyodideランタイムの「パッケージ追加あり/なし」として扱える。

ただし、教材・UI・事前検査の観点では `pygame` を区別する価値がある。Pygame教材では画像素材、canvas、イベントループ、同期無限ループ検査が必要になるため。

### 5.2 Python 3 / 標準ライブラリの対応範囲

Pyodideはブラウザ上で動くPython 3実行基盤であり、ロード直後はPython標準ライブラリを利用できる。ただし、WebAssembly/ブラウザ環境の制約を受ける。

期待できるもの:

- Python 3の基本文法
- `math`, `random`, `statistics`, `json`, `datetime`, `pathlib`, `collections`, `itertools` などの一般的な標準ライブラリ
- Pyodide仮想ファイルシステム内でのファイル読み書き
- Pyodideに同梱・対応しているパッケージの `loadPackage`
- Pure Python wheel の `micropip.install`

注意が必要なもの:

- `subprocess` などOSプロセス依存
- 低レベルsocketやローカルネットワーク依存
- ローカル端末/デバイス/ファイルシステムへの直接アクセス
- tkinterなどデスクトップGUI依存
- CPythonネイティブ拡張に依存し、Pyodide wheelがない外部パッケージ

したがって、Python 3教材はPyodideで概ね対応可能と見込むが、標準ライブラリでもブラウザ制約に触れるものは個別確認が必要。

### 5.3 実行環境の隔離

本番では、ユーザーコード実行がUI全体へ与える影響を明確に考慮する。

現時点での問題意識:

- 同期無限ループに入るとブラウザタブやエディタUIが固まる可能性がある
- Pygame/turtleはcanvasやDOMイベントと結びつくため、単純なWorker化だけでは扱いにくい可能性がある
- 実行停止をPythonコード内の協調処理だけに頼ると、固まったケースで復旧できない
- 埋め込み表示では、親アプリへ影響を広げない境界が必要

現時点の考え方:

- ユーザーコードはエディタ本体と何らかの境界で分離する
- 分離方式は本設計では確定しない
- 候補は sandbox iframe、Web Worker、またはその組み合わせ
- 少なくとも「停止/リセット時にランタイムを破棄して復旧できる」設計にする
- 最終方式はNuxt実装先、Pygame/turtleの描画方式、埋め込み要件を踏まえて決める

### 5.4 実行メッセージ

親画面からiframeへ送る。

```ts
type RunRequest = {
  type: 'run'
  runId: string
  runtime: Runtime
  files: ProjectFile[]
  entrypoint: 'main.py'
  options: {
    readOnly: boolean
    timeLimitMs?: number
  }
}
```

iframeから親画面へ返す。

```ts
type RunEvent =
  | { type: 'ready' }
  | { type: 'stdout'; runId: string; text: string }
  | { type: 'stderr'; runId: string; text: string }
  | { type: 'status'; runId: string; status: 'loading' | 'running' | 'done' | 'error' | 'stopped' }
  | { type: 'runtime-error'; runId: string; message: string; line?: number }
```

### 5.5 無限ループ対策

暗黙的なasync変換は標準機能にしない。

代わりに以下を実装する。

#### 実行前検査

ASTまたは軽量パーサで下記を検出する。

- `while True`
- `while 1`
- Pygameコード内の同期ループ
- `time.sleep()`
- `pygame.time.delay()`
- `asyncio` / `await asyncio.sleep(0)` の有無

#### 実行前ガード

危険と判定した場合:

- 生徒向け: 実行を止め、教材修正を促す
- 講師/管理者向け: 警告付きで検証実行を許可できるオプションを検討

文言例:

> このコードにはブラウザを停止させる可能性がある同期ループがあります。教材のPygameループをasync形式へ修正してください。

#### 実行中ガード

- 実行環境単位で停止できる「停止/リセット」ボタンを提供
- 実行開始から一定時間、stdout/status/canvas更新がない場合はハング候補として表示
- Pygameの長時間実行は正常なので、単純な時間制限だけで止めない

#### async変換の扱い

自動変換は本番の通常実行には入れない。

ただし、移行支援ツールとして下記は別機能で検討する。

- 変換候補の表示
- 変換後コードのプレビュー
- 講師/教材管理者が確認して保存

## 6. ファイル/画像読み込み

### 6.1 要件

外部で用意した `.png` などをプロジェクトに添付し、コードから相対パスで読み込めるようにする。

対象:

- イノベーターネクスト: Pygame sprite
- イノベーター: turtle `bgpic` / 教材画像

### 6.2 ファイル構造

プロジェクトは複数ファイルを持つ。

```ts
type ProjectFile = {
  id: string
  projectId: string
  path: string          // main.py, assets/player.png
  kind: 'code' | 'image' | 'audio' | 'text' | 'other'
  mimeType: string
  size: number
  storageKey?: string
  content?: string      // code/textのみ
}
```

### 6.3 ストレージ

優先:

- 既存システムのファイル保存API/DB/ストレージを利用

既存基盤にファイルストレージがない場合の候補:

- Cloudflare R2
- 既存AWS S3

DBにはメタデータのみ保存し、画像本体はオブジェクトストレージに置く。

### 6.4 ランタイムへの渡し方

#### Pyodide / Pygame

実行前にプロジェクトファイルをPyodide FSへ配置する。

- `main.py`
- `assets/foo.png`
- 互換のため必要に応じて `foo.png` もルートへ配置

既存Trinketコードは `pygame.image.load("foo.png")` が多いため、当面はルート配置互換を持つ。

#### Skulpt / Turtle

Skulptの読み込み関数と `TurtleGraphics.assets` で解決する。

- `screen.bgpic("foo.png")` は `assets/foo.png` のURLへ解決
- `screen.addshape("foo.png")` はTrinket互換差分があるため追加検証

## 7. デフォルトリセット

### 7.1 要件

生徒が編集したコードを、教材初期状態へ戻せる。

対象:

- イノベーター
- イノベーターネクスト

### 7.2 データ設計

プロジェクトには `templateVersionId` を持たせる。

```ts
type LessonTemplate = {
  id: string
  courseId: string
  lessonId: string
  version: number
  title: string
  runtime: Runtime
  defaultFiles: ProjectFile[]
}
```

生徒プロジェクトはテンプレートから作成される。

```ts
type StudentProject = {
  id: string
  ownerUserId: string
  lessonId: string
  templateVersionId: string
  title: string
  runtime: Runtime
  status: 'active' | 'submitted' | 'archived'
  updatedAt: string
}
```

### 7.3 挙動

- 「リセット」押下
- 確認ダイアログ表示
- 現在の編集内容を破棄
- `templateVersionId` の `defaultFiles` で上書き
- 必要ならリセット直前の内容を自動バックアップとして履歴に保存

推奨:

- 完全消失を避けるため、リセット前スナップショットを1世代保存する

## 8. 埋め込みリンク・外部出力

### 8.1 要件

ロボ団アプリへ埋め込めること。

表示モード:

- editorあり
- 実行結果のみ
- read-only

### 8.2 画面/リンク設計の考え方

具体的なURLパスやルーティングは、移行先モノレポの既存ルールに従う。この設計書では固定しない。

必要な表示入口は下記。

- 通常エディタ表示
- 埋め込み用エディタ表示
- 実行結果のみの表示
- 共有/提出スナップショット表示

### 8.3 埋め込み制御

共有/埋め込みには、既存システムの権限モデルに接続できるアクセスポリシーを持たせる。

```ts
type SharePolicy = {
  editable: boolean
  outputOnly: boolean
  expiresAt?: string
}
```

この設計書では、公開範囲やロール定義は決めない。既存システム側のコース、クラス、レッスン、ユーザー権限に従って判定する。

必要な制御:

- 編集可否
- 実行可否
- output-only表示
- 共有/提出スナップショットの閲覧可否
- 埋め込み元アプリの許可

### 8.4 セキュリティ

- iframeを使う場合は `sandbox` 属性を検討する
- 親画面との通信は `postMessage` の origin を検証
- 任意URLから任意コードを読み込ませない
- 共有URLはDB上の `shareId` を参照するだけにする

## 9. Turtleサポート

### 9.1 方針

turtle教材はSkulptを使う。

対象API:

- `from turtle import *`
- `import turtle`
- `Screen()`
- `screen.setup()`
- `screen.bgpic()`
- `screen.addshape()`
- `shape()`
- `forward/fd`
- `backward`
- `left/lt`
- `right/rt`
- `setposition/goto/setpos`
- `penup/pendown`
- `pencolor/color/fillcolor`
- `begin_fill/end_fill`
- `xcor/ycor`
- `write`
- `screen.onkey/listen`

### 9.2 追加検証が必要な点

- npm版SkulptとTrinket OSS内Skulptの差分
- `screen.addshape("image.png")` の画像shape登録
- `screen.bgpic()` の画像表示
- `screen.onkey()` のフォーカス制御
- `input()` とコンソールUI

検証用PoC `/Users/noname/workspace/personal/trinket-oss/labs/browser-python-playground` では `bgpic` は確認できたが、npm版Skulptの `addshape` はTrinket互換ではなかった。Trinket OSSのSkulpt実装を再利用するか、npm版に互換レイヤーを足すか判断が必要。

## 10. コード保存・復活

### 10.1 要件

URL生成に依存せず、生徒ごとにコードを確実に保存し、次回レッスンで復活できる。

### 10.2 保存方式

推奨はサーバー保存を主、ローカル保存を補助にする。

| 保存先 | 役割 |
| --- | --- |
| サーバーDB | 正本 |
| オブジェクトストレージ | 画像/音声など |
| localStorage / IndexedDB | 自動退避・通信断対策 |

### 10.3 自動保存

- 編集後 debounce 1〜3秒で下書き保存
- 実行時にも保存
- ページ離脱前に未保存警告
- 保存状態をUI表示

状態:

- 保存済み
- 保存中
- 未保存
- オフライン退避中
- 保存失敗

### 10.4 バージョン履歴

最低限:

- 最新版
- 直前保存
- 提出時スナップショット
- リセット前スナップショット

余裕があれば:

- 時系列履歴
- 講師が過去版を復元

## 11. 共有・提出

### 11.1 共有URL

共有URLはコード本体を含めない。

```ts
type Share = {
  id: string
  projectId: string
  createdBy: string
  accessPolicyRef: string
  snapshotVersionId: string
  outputOnly: boolean
  editable: boolean
  expiresAt?: string
}
```

共有URLの具体的なパスは、移行先システムのルーティング規約に従う。

### 11.2 提出

提出は共有とは分ける。

```ts
type Submission = {
  id: string
  projectId: string
  studentUserId: string
  lessonId: string
  submittedVersionId: string
  status: 'submitted' | 'reviewed' | 'returned'
  submittedAt: string
  reviewedAt?: string
  reviewerUserId?: string
}
```

講師は提出一覧から、提出時点のスナップショットを確認する。

## 12. 必要なAPI/データ操作

具体的なAPIパス、HTTPメソッド、サーバー連携構成、認証middlewareは移行先モノレポの既存設計に従う。この設計書では固定しない。

本エディタ機能として必要になるデータ操作は下記。

### 12.1 プロジェクト

- レッスン/受講状態に紐づくプロジェクトの取得
- テンプレートから生徒プロジェクトを作成
- プロジェクトメタデータの更新
- プロジェクトのアーカイブまたは削除

### 12.2 ファイル/素材

- プロジェクト内ファイル一覧の取得
- `main.py` などコードファイルの保存
- 画像/音声などバイナリアセットの保存
- ファイル名変更、削除
- 実行時に必要なURLまたはバイナリ取得

### 12.3 リセット

- 対象プロジェクトの現在状態を必要に応じて履歴保存
- 紐づくテンプレートのデフォルトファイルで復元
- リセット後のプロジェクト状態を返す

### 12.4 共有

- 共有用識別子の発行
- 共有対象のスナップショット固定
- 共有設定の更新/無効化
- 共有表示時の閲覧可否判定

### 12.5 提出

- 生徒プロジェクトの提出
- 提出時点のスナップショット固定
- レッスン単位の提出一覧取得
- 提出内容の確認・レビュー状態更新

### 12.6 認証・認可

- Cognitoで認証済みのユーザーを識別
- 既存システムの権限モデルで、プロジェクト/提出/共有/埋め込みへのアクセス可否を判定
- 本設計書ではロール名や権限表は定義しない

## 13. Nuxt/Workers実装方針

### 13.1 Nuxt構成

移行先はモノレポで管理される前提のため、ディレクトリ構成は既存規約に従う。この設計書では固定しない。

エディタ機能として必要になるUI単位は下記。

- コードエディタ
- ファイル/素材一覧
- 実行結果ビュー
- 実行ランタイム境界
- 保存状態表示
- リセット操作
- 共有/提出操作
- 埋め込み/output-only表示

### 13.2 Cloudflare設定

方針:

- `compatibility_date` を設定
- `nodejs_compat` を有効化
- observability を有効化
- secretsはWrangler secretsまたは既存CI/CDのSecret管理を使う
- Worker内でリクエスト単位の状態をグローバル変数に置かない

### 13.3 環境変数

例:

```txt
NUXT_PUBLIC_APP_ORIGIN
EXISTING_API_BASE_URL
COGNITO_USER_POOL_ID
COGNITO_CLIENT_ID
COGNITO_ISSUER
ASSET_STORAGE_MODE
```

機密値はクライアントに公開しない。

## 14. 移行方針

### Phase 1: 基盤

- Nuxtプロジェクト作成
- Cognitoログイン連携
- 既存API/DB/Cognitoとの接続
- プロジェクト読み込み/保存
- CodeMirrorエディタ

### Phase 2: ランタイム

- Pyodide通常Python
- Pyodide + pygame-ce
- Skulpt turtle
- 実行環境の分離
- 停止/リセット

### Phase 3: 教材運用

- テンプレートから生徒プロジェクト作成
- デフォルトリセット
- 自動保存
- 復元
- 提出
- 講師確認

### Phase 4: 埋め込み/共有

- output-only embed
- read-only share
- ロボ団アプリ連携
- 共有権限

### Phase 5: 移行支援

- 既存Trinketコードの一括取り込み
- Pygame同期ループ検査
- async修正候補の提示
- turtle互換APIの拡充

## 15. 検討事項

### asyncio

- 暗黙変換は本番通常実行には入れない
- 教材改修を正とする
- 危険コード検出と実行ガードを先に入れる
- 変換は移行支援ツールとして分離する

### turtle

- npm版Skulptで不足するTrinket互換をどう補うか
- Trinket OSS由来のSkulpt/turtle実装を再利用できるか
- `addshape` と画像shapeをどこまで互換にするか

### 保存

- 既存DBのスキーマに合わせるか、新規テーブルを追加するか
- ファイル本体の保存先
- 自動保存頻度
- 履歴保持期間

### 埋め込み

- ロボ団アプリとの認証連携方式
- iframe許可ドメイン
- output-only時の共有権限

## 16. 参考

- Cloudflare Workers Nuxt guide: https://developers.cloudflare.com/workers/frameworks/framework-guides/nuxt/
- Nuxt Cloudflare deployment: https://nuxt.com/deploy/cloudflare
- Trinket OSS内Skulpt設定: `public/js/skulpt/wrapper.js`
- 検証用PoC: `/Users/noname/workspace/personal/trinket-oss/labs/browser-python-playground`
