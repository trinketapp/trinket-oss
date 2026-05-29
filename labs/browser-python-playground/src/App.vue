<template>
  <main :class="['shell', { embedded: isOutputOnly }]">
    <aside v-if="!isOutputOnly" class="sidebar">
      <a class="brand" href="/" aria-label="Python学習プレイグラウンド">
        <span class="mark">Py</span>
        <div>
          <h1>Python学習</h1>
          <p>ブラウザ実行環境</p>
        </div>
      </a>

      <nav class="nav-links" aria-label="主要ページ">
        <a href="/" :class="{ active: currentPage === 'playground' && mode !== 'turtle' }">Python/Pygame</a>
        <a href="/turtle" :class="{ active: currentPage === 'playground' && mode === 'turtle' }">Turtle</a>
        <a href="/archive" :class="{ active: currentPage === 'archive' }">倉庫</a>
        <a href="/capabilities" :class="{ active: currentPage === 'capabilities' }">できること</a>
        <a href="/samples" :class="{ active: currentPage === 'samples' }">Showcase</a>
      </nav>

      <template v-if="currentPage === 'playground'">
        <div class="segmented" role="tablist" aria-label="実行モード">
          <button data-testid="python-mode" :class="{ active: mode === 'python' }" @click="setMode('python')">Python</button>
          <button data-testid="pygame-mode" :class="{ active: mode === 'pygame' }" @click="setMode('pygame')">Pygame</button>
          <button data-testid="turtle-mode" :class="{ active: mode === 'turtle' }" @click="setMode('turtle')">Turtle</button>
        </div>

        <div class="actions">
          <button data-testid="run" class="primary" :disabled="isRunning || isLoading" @click="runCode">
            {{ runLabel }}
          </button>
          <button data-testid="reset" :disabled="isLoading" @click="resetRuntime">リセット</button>
          <button data-testid="save" @click="saveLocal">保存</button>
        </div>

        <p class="sharing-disabled" data-testid="sharing-disabled">
          共有URLと任意コード埋め込みは停止中です。
        </p>
      </template>
    </aside>

    <section v-if="currentPage === 'playground' || isEmbed" class="workspace">
      <div v-if="!isOutputOnly" class="editor-pane">
        <div class="pane-title">
          <span>{{ modeLabel }}</span>
          <span>{{ code.length }}文字</span>
        </div>
        <CodeEditor v-model="code" />
      </div>

      <div class="result-pane">
        <div v-if="!isOutputOnly" class="pane-title">
          <span>実行結果</span>
          <span>{{ statusLabel }}</span>
        </div>

        <div :class="['output-grid', `mode-${mode}`]">
          <div v-show="mode === 'pygame'" class="canvas-frame">
            <canvas ref="canvasRef" data-testid="pygame-canvas" id="canvas" width="640" height="420" />
          </div>
          <div
            v-show="mode === 'turtle'"
            ref="turtleRef"
            data-testid="skulpt-turtle"
            id="skulpt-turtle-output"
            class="turtle-frame"
          />
          <pre data-testid="console" class="console">{{ output || '準備完了' }}</pre>
        </div>
      </div>
    </section>

    <section v-else-if="currentPage === 'capabilities'" class="doc-page">
      <header class="page-header">
        <p class="eyebrow">Python / Pygame 対応範囲</p>
        <h2>ブラウザでできること、設計が必要なこと</h2>
        <p>
          このPoCはサーバー上でコードを実行せず、Pyodideとpygame-ceをブラウザ内で動かします。
          ホスティングは軽くできますが、OS機能や一部pygame機能にはブラウザ由来の制限があります。
        </p>
      </header>

      <div class="table-wrap">
        <table data-testid="capability-table" class="capability-table">
          <thead>
            <tr>
              <th>領域</th>
              <th>このPoCでできること</th>
              <th>できないこと / 設計が必要なこと</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in capabilityRows" :key="row.area">
              <th scope="row">{{ row.area }}</th>
              <td>{{ row.works }}</td>
              <td>{{ row.limits }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section v-else-if="currentPage === 'archive'" class="doc-page archive-page">
      <header class="page-header">
        <p class="eyebrow">Export Archive</p>
        <h2>Trinket おもしろコード倉庫</h2>
        <p>
          エクスポート済みのPython/Pygame/turtleを固定IDで一覧化しています。
          気になる教材を開いて、現在のブラウザ実行ランタイムで検証できます。
        </p>
      </header>

      <div class="archive-toolbar">
        <label>
          検索
          <input v-model="archiveSearch" data-testid="archive-search" type="search" placeholder="タイトル、shortCode、言語で検索" />
        </label>
        <label>
          種別
          <select v-model="archiveRuntime" data-testid="archive-runtime">
            <option value="all">すべて</option>
            <option value="pygame">Pygame</option>
            <option value="turtle">Turtle</option>
            <option value="python">Python</option>
          </select>
        </label>
      </div>

      <div class="archive-summary" data-testid="archive-summary">
        <span>全{{ archiveProjects.length }}件</span>
        <span>Pygame {{ archiveManifest?.runtimeCounts.pygame || 0 }}</span>
        <span>Turtle {{ archiveManifest?.runtimeCounts.turtle || 0 }}</span>
        <span>Python {{ archiveManifest?.runtimeCounts.python || 0 }}</span>
      </div>

      <div v-if="archiveError" class="archive-message">{{ archiveError }}</div>
      <div v-else-if="!archiveProjects.length" class="archive-message">倉庫データを読み込み中です。</div>

      <div v-else class="archive-layout">
        <div class="archive-list" data-testid="archive-list">
          <article
            v-for="project in filteredArchiveProjects"
            :key="project.id"
            class="archive-row"
            :class="{ active: selectedArchiveId === project.id }"
          >
            <button type="button" class="archive-main" @click="selectedArchiveId = project.id">
              <span class="archive-runtime" :data-runtime="project.runtime">{{ project.runtime }}</span>
              <strong>{{ project.name }}</strong>
              <small>{{ project.sourceLabel }} / {{ project.lang }} / {{ project.assetCount }} assets</small>
            </button>
            <a class="open-link" :href="buildArchiveOpenUrl(project)">開く</a>
          </article>
        </div>

        <aside class="archive-detail" data-testid="archive-detail">
          <p class="eyebrow">{{ selectedArchiveProject?.runtime || '-' }} / {{ selectedArchiveProject?.shortCode || '-' }}</p>
          <h3>{{ selectedArchiveProject?.name || '選択してください' }}</h3>
          <dl v-if="selectedArchiveProject" class="archive-meta">
            <div>
              <dt>元URL</dt>
              <dd><a :href="selectedArchiveProject.url" target="_blank" rel="noopener">{{ selectedArchiveProject.url }}</a></dd>
            </div>
            <div>
              <dt>行数</dt>
              <dd>{{ selectedArchiveProject.lineCount }}</dd>
            </div>
            <div>
              <dt>素材</dt>
              <dd>{{ selectedArchiveProject.assetCount }}</dd>
            </div>
            <div v-if="selectedArchiveProject.parseWarning">
              <dt>注意</dt>
              <dd>{{ selectedArchiveProject.parseWarning }}</dd>
            </div>
          </dl>
          <a v-if="selectedArchiveProject" class="primary archive-open" :href="buildArchiveOpenUrl(selectedArchiveProject)">エディタで開く</a>
        </aside>
      </div>
    </section>

    <section v-else class="doc-page">
      <header class="page-header">
        <p class="eyebrow">Showcase</p>
        <h2>Python基礎からpygame応用まで順に確認</h2>
        <p>
          一覧は軽く表示し、実際のiframe実行は選択中の1件だけに絞ります。教材ページへ貼る前に、
          Pythonの基本構文からpygameの描画・入力・応用まで段階的に動作を確認できます。
        </p>
      </header>

      <div class="showcase-layout">
        <div class="showcase-list" data-testid="showcase-list">
          <button
            v-for="sample in showcaseSamples"
            :key="sample.id"
            type="button"
            class="showcase-item"
            :class="{ active: selectedShowcaseId === sample.id }"
            :data-testid="`showcase-${sample.id}`"
            @click="selectedShowcaseId = sample.id"
          >
            <span>{{ sample.stage }}</span>
            <strong>{{ sample.title }}</strong>
            <small>{{ sample.category }} / {{ sample.level }}</small>
          </button>
        </div>

        <article class="showcase-detail" data-testid="showcase-detail">
          <div class="showcase-heading">
            <div>
              <p class="eyebrow">{{ selectedShowcase.category }} / {{ selectedShowcase.level }}</p>
              <h3>{{ selectedShowcase.title }}</h3>
            </div>
          </div>

          <p class="showcase-description">{{ selectedShowcase.description }}</p>

          <ul class="goal-list">
            <li v-for="goal in selectedShowcase.goals" :key="goal">{{ goal }}</li>
          </ul>

          <iframe
            :key="selectedShowcase.id"
            ref="sampleFrameRef"
            class="sample-frame"
            :src="selectedShowcase.src"
            :style="{ height: selectedShowcaseFrameHeight }"
            @load="resizeActiveShowcaseFrame"
            data-testid="active-showcase-frame"
            title="Python Showcase"
          />

          <div class="snippet-grid">
            <label>
              公式iframe
              <textarea class="snippet" readonly :value="selectedShowcase.iframe" />
            </label>
            <label>
              共有ページURL
              <textarea class="snippet" readonly :value="selectedShowcase.shareUrl" />
            </label>
          </div>
        </article>
      </div>
    </section>
  </main>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import CodeEditor from './components/CodeEditor.vue';
import skulptStdlibUrl from 'skulpt/dist/skulpt-stdlib.js?url';
import skulptRuntimeUrl from 'skulpt/dist/skulpt.min.js?url';

type Mode = 'python' | 'pygame' | 'turtle';
type Page = 'playground' | 'capabilities' | 'samples' | 'archive';
type ArchiveRuntimeFilter = Mode | 'all';

type ArchiveAsset = {
  name: string;
  path: string;
  kind: 'image' | 'audio' | 'file';
};

type ArchiveProject = {
  id: string;
  source: string;
  sourceLabel: string;
  name: string;
  shortCode: string;
  lang: string;
  runtime: Mode;
  url: string;
  created: string;
  lastUpdated: string;
  codePath: string;
  assetCount: number;
  assets: ArchiveAsset[];
  lineCount: number;
  parseWarning: string;
};

type ArchiveManifest = {
  generatedAt: string;
  projectCount: number;
  runtimeCounts: Record<Mode, number>;
  sourceCounts: Record<string, number>;
  projects: ArchiveProject[];
};

declare global {
  interface Window {
    loadPyodide?: (options: { indexURL: string }) => Promise<any>;
    Sk?: any;
  }
}

const pyodideVersion = '0.29.4';
const pyodideBaseUrl = `https://cdn.jsdelivr.net/pyodide/v${pyodideVersion}/full/`;

const pythonSample = `from statistics import mean

scores = [82, 91, 74, 88]
print("点数:", scores)
print("平均:", mean(scores))
`;

const pythonLoopSample = `for dan in range(2, 10):
    row = []
    for value in range(1, 10):
        row.append(dan * value)
    print(f"{dan}の段:", row)
`;

const pythonBranchSample = `score = 86

if score >= 90:
    rank = "S"
elif score >= 80:
    rank = "A"
elif score >= 70:
    rank = "B"
else:
    rank = "C"

print("点数:", score)
print("評価:", rank)
`;

const pythonFunctionSample = `def tax_included(price, rate=0.1):
    return int(price * (1 + rate))

prices = [980, 1200, 2500]

for price in prices:
    print(price, "円 ->", tax_included(price), "円")
`;

const pythonDictClassSample = `class Student:
    def __init__(self, name, scores):
        self.name = name
        self.scores = scores

    def average(self):
        return sum(self.scores) / len(self.scores)

students = [
    Student("Aoi", {"math": 88, "english": 92}.values()),
    Student("Ren", {"math": 76, "english": 84}.values()),
]

for student in students:
    print(student.name, "平均:", round(student.average(), 1))
`;

const pythonFileSample = `from pathlib import Path

path = Path("/tmp/memo.txt")
path.write_text("Pyodideの仮想ファイルです", encoding="utf-8")

print(path.read_text(encoding="utf-8"))
print("存在する?", path.exists())
`;

const pygameSample = `import asyncio
import pygame

pygame.init()
screen = pygame.display.set_mode((640, 420))
clock = pygame.time.Clock()

async def main():
    x = 60
    dx = 4

    while True:
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                return

        screen.fill((18, 22, 30))
        pygame.draw.rect(screen, (44, 52, 66), (0, 330, 640, 90))
        pygame.draw.circle(screen, (72, 184, 255), (x, 180), 32)
        pygame.draw.circle(screen, (255, 214, 102), (520, 90), 42)
        pygame.display.flip()

        x += dx
        if x > 590 or x < 50:
            dx *= -1

        clock.tick(60)
        await asyncio.sleep(0)

asyncio.run(main())
`;

const pygameDrawSample = `import asyncio
import pygame

pygame.init()
screen = pygame.display.set_mode((640, 420))

async def main():
    screen.fill((18, 22, 30))
    pygame.draw.rect(screen, (72, 184, 255), (80, 80, 180, 120))
    pygame.draw.circle(screen, (255, 214, 102), (430, 145), 70)
    pygame.draw.line(screen, (237, 98, 112), (80, 300), (560, 300), 8)
    pygame.display.flip()
    await asyncio.sleep(0)

asyncio.run(main())
`;

const pygameInputSample = `import asyncio
import pygame

pygame.init()
screen = pygame.display.set_mode((640, 420))
clock = pygame.time.Clock()

async def main():
    x, y = 320, 210

    while True:
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                return

        keys = pygame.key.get_pressed()
        if keys[pygame.K_LEFT]:
            x -= 5
        if keys[pygame.K_RIGHT]:
            x += 5
        if keys[pygame.K_UP]:
            y -= 5
        if keys[pygame.K_DOWN]:
            y += 5

        screen.fill((18, 22, 30))
        pygame.draw.circle(screen, (72, 184, 255), (x, y), 28)
        pygame.display.flip()
        clock.tick(60)
        await asyncio.sleep(0)

asyncio.run(main())
`;

const pygameCollisionSample = `import asyncio
import pygame

pygame.init()
screen = pygame.display.set_mode((640, 420))
clock = pygame.time.Clock()

async def main():
    player = pygame.Rect(80, 180, 48, 48)
    vx = 5
    target = pygame.Rect(440, 160, 90, 90)

    while True:
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                return

        player.x += vx
        if player.left < 40 or player.right > 600:
            vx *= -1

        hit = player.colliderect(target)
        screen.fill((18, 22, 30))
        pygame.draw.rect(screen, (72, 184, 255), player)
        pygame.draw.rect(screen, (237, 98, 112) if hit else (255, 214, 102), target)
        pygame.display.flip()
        clock.tick(60)
        await asyncio.sleep(0)

asyncio.run(main())
`;

const pygameParticleSample = `import asyncio
import math
import pygame

pygame.init()
screen = pygame.display.set_mode((640, 420))
clock = pygame.time.Clock()

async def main():
    tick = 0

    while True:
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                return

        screen.fill((13, 16, 23))
        for index in range(28):
            angle = tick * 0.035 + index * 0.45
            radius = 50 + index * 5
            x = 320 + math.cos(angle) * radius
            y = 210 + math.sin(angle) * radius * 0.55
            color = (72 + index * 5 % 120, 184, 255 - index * 4 % 140)
            pygame.draw.circle(screen, color, (int(x), int(y)), 6)

        pygame.display.flip()
        tick += 1
        clock.tick(60)
        await asyncio.sleep(0)

asyncio.run(main())
`;

const turtleSample = `from turtle import *

screen = Screen()
screen.setup(500, 300)
shape("turtle")
speed(4)
width(3)

penup()
setposition(-180, -90)
pendown()

pencolor("royalblue")
fillcolor("gold")
begin_fill()
for i in range(5):
    forward(140)
    right(144)
end_fill()

penup()
setposition(-40, 110)
pencolor("black")
write("Skulpt turtle", None, "center", "18pt bold")
`;

const query = new URLSearchParams(window.location.search);
const requestedShowcase = getShowcaseRuntime(query.get('sample'));
const requestedArchiveId = query.get('archive');
const isTurtleRoute = window.location.pathname === '/turtle';
const isEmbed = ref(query.get('embed') === '1' && Boolean(requestedShowcase));
const isReadOnlyShare = Boolean(requestedShowcase) && query.get('embed') !== '1';
const isOutputOnly = computed(() => isEmbed.value || isReadOnlyShare);
const currentPage = computed<Page>(() => {
  if (isEmbed.value) return 'playground';
  if (window.location.pathname === '/capabilities') return 'capabilities';
  if (window.location.pathname === '/samples') return 'samples';
  if (window.location.pathname === '/archive') return 'archive';
  return 'playground';
});

const initialMode = requestedShowcase?.mode || (isTurtleRoute ? 'turtle' : query.get('mode') === 'pygame' ? 'pygame' : 'python');
const mode = ref<Mode>(initialMode);
const code = ref(requestedShowcase?.code || getDefaultCode(initialMode));
const output = ref('');
const status = ref('idle');
const isLoading = ref(false);
const isRunning = ref(false);
const canvasRef = ref<HTMLCanvasElement | null>(null);
const turtleRef = ref<HTMLDivElement | null>(null);
const sampleFrameRef = ref<HTMLIFrameElement | null>(null);
const selectedShowcaseId = ref('py-print');
const selectedShowcaseFrameHeight = ref('520px');
const archiveManifest = ref<ArchiveManifest | null>(null);
const archiveProjects = ref<ArchiveProject[]>([]);
const selectedArchiveId = ref('');
const archiveSearch = ref('');
const archiveRuntime = ref<ArchiveRuntimeFilter>('all');
const archiveError = ref('');
const currentArchiveProject = ref<ArchiveProject | null>(null);

let pyodide: any = null;
let loadedPygame = false;
let skulptLoaded = false;
let mountedArchiveAssetProjectId = '';

const modeLabel = computed(() => {
  if (mode.value === 'pygame') return 'Pygame';
  if (mode.value === 'turtle') return 'Turtle / Skulpt';
  return 'Python';
});
const runLabel = computed(() => isLoading.value ? '読み込み中' : isRunning.value ? '実行中' : '実行');
const statusLabel = computed(() => {
  const labels: Record<string, string> = {
    idle: '待機中',
    starting: '開始中',
    'loading pyodide': 'Pyodide読み込み中',
    'loading pygame': 'pygame読み込み中',
    'loading skulpt': 'Skulpt読み込み中',
    running: '実行中',
    done: '完了',
    error: 'エラー',
    saved: '保存済み',
    copied: 'コピー済み',
    'ready to copy': 'コピーしてください'
  };
  return labels[status.value] || status.value;
});

const capabilityRows = [
  {
    area: 'Python文法',
    works: 'Pyodide 0.29.4上でCPython互換の基本文法を実行できます。',
    limits: 'ローカルのCPythonと完全に同じ挙動を保証するものではありません。'
  },
  {
    area: '標準ライブラリ',
    works: '`statistics` など、多くのPure Python標準ライブラリを使えます。',
    limits: 'subprocess、低レベルsocket、端末やデバイスに依存する機能はブラウザでは使えません。'
  },
  {
    area: '外部パッケージ',
    works: 'Pure Pythonパッケージは `micropip` で導入できる可能性があります。',
    limits: '任意のネイティブwheelは使えません。Pyodide対応wheelが必要です。'
  },
  {
    area: 'ファイル操作',
    works: 'Pyodideの仮想ファイルシステム上で一時ファイルを扱えます。',
    limits: 'ユーザーのPC上のファイルへ直接アクセスすることはできません。アップロードUIや保存APIが必要です。'
  },
  {
    area: '保存・共有',
    works: '手元保存はlocalStorageで扱えます。公式Showcaseは固定サンプルIDのURLで確認できます。',
    limits: 'ユーザー作成コードのURL共有は停止中です。公開共有には保存API、権限、通報/削除導線が必要です。'
  },
  {
    area: '実行分離',
    works: 'コードはユーザーのブラウザ内で動くため、サーバー側コード実行基盤は不要です。',
    limits: 'サーバー側で強く隔離されたマルチテナント実行環境とは性質が異なります。'
  },
  {
    area: 'Pygameパッケージ',
    works: 'Pyodide経由で `pygame-ce` を読み込み、canvasへ描画できます。',
    limits: 'すべてのデスクトップpygameコードがそのまま動くわけではありません。'
  },
  {
    area: 'Pygame描画',
    works: '2D図形、画面塗りつぶし、`display.flip()` を使った更新を確認済みです。',
    limits: 'ネイティブウィンドウ、複数ディスプレイ、GPU/SDL依存機能は対象外です。'
  },
  {
    area: 'Pygameループ',
    works: '`asyncio` を使い、ループ内で `await asyncio.sleep(0)` すればアニメーションできます。',
    limits: '同期的な `while True` はブラウザのイベントループを止めます。教材側の書き換えが必要です。'
  },
  {
    area: 'Turtle / Skulpt',
    works: 'Skulpt上で標準的なturtle描画をブラウザ内に表示できます。',
    limits: 'Trinket教材互換には `bgpic/addshape` の画像素材解決、`onkey`、`input()` などを追加検証する必要があります。'
  },
  {
    area: '入力イベント',
    works: 'canvasに紐づくキーボード/ポインターイベントは扱える可能性があります。',
    limits: 'ゲームパッド、IME、特殊デバイスなどは機能ごとに検証が必要です。'
  },
  {
    area: '音声',
    works: 'ブラウザ/SDLの条件次第で可能性はあります。',
    limits: 'このPoCでは未検証です。現時点では未対応として扱うのが安全です。'
  },
  {
    area: '埋め込み',
    works: '公式Showcaseだけ `sample=<id>` と `embed=1` でiframe表示できます。',
    limits: '任意コードのiframe埋め込みは停止中です。非公開教材、権限制御、不正利用対策、長期保存は別途バックエンド設計が必要です。'
  }
];

const showcaseSamples = computed(() => [
  createShowcaseSample({
    id: 'py-print',
    stage: '01',
    category: 'Python基礎',
    level: 'print / 変数',
    title: '出力と変数',
    description: '最初の教材として、値を変数に入れてprintで確認します。',
    goals: ['文字列・数値・リストの出力', '平均値を計算して標準出力へ表示', '公式Showcaseとしてiframe表示'],
    mode: 'python',
    code: pythonSample,
    height: 260
  }),
  createShowcaseSample({
    id: 'py-branch',
    stage: '02',
    category: 'Python基礎',
    level: 'if / elif / else',
    title: '条件分岐',
    description: '点数から評価を決める例で、条件分岐の流れを確認します。',
    goals: ['比較演算子の利用', '複数条件の評価順', '結果を変数に代入して出力'],
    mode: 'python',
    code: pythonBranchSample,
    height: 260
  }),
  createShowcaseSample({
    id: 'py-loop',
    stage: '03',
    category: 'Python基礎',
    level: 'for / list',
    title: 'ループとリスト',
    description: '九九の表を作りながら、ネストしたfor文とリスト操作を確認します。',
    goals: ['rangeの利用', 'リストへのappend', 'ネストしたループ'],
    mode: 'python',
    code: pythonLoopSample,
    height: 340
  }),
  createShowcaseSample({
    id: 'py-function',
    stage: '04',
    category: 'Python基礎',
    level: '関数',
    title: '関数と戻り値',
    description: '税込価格の計算を関数化して、引数と戻り値を確認します。',
    goals: ['defで関数を定義', 'デフォルト引数', '戻り値を使った繰り返し処理'],
    mode: 'python',
    code: pythonFunctionSample,
    height: 280
  }),
  createShowcaseSample({
    id: 'py-class',
    stage: '05',
    category: 'Python応用',
    level: 'dict / class',
    title: '辞書とクラス',
    description: 'データをまとめる方法として、辞書とクラスの使い分けを体験します。',
    goals: ['辞書の値を集計', 'classと__init__', 'メソッドで平均値を計算'],
    mode: 'python',
    code: pythonDictClassSample,
    height: 320
  }),
  createShowcaseSample({
    id: 'py-file',
    stage: '06',
    category: 'Python応用',
    level: '仮想ファイル',
    title: 'ブラウザ内ファイル操作',
    description: 'Pyodideの仮想ファイルシステムで、一時ファイルの読み書きを確認します。',
    goals: ['Pathでファイル作成', 'UTF-8文字列の読み書き', 'ブラウザ制限下のファイルI/O'],
    mode: 'python',
    code: pythonFileSample,
    height: 280
  }),
  createShowcaseSample({
    id: 'pg-draw',
    stage: '07',
    category: 'Pygame基礎',
    level: '図形描画',
    title: 'canvasへの基本描画',
    description: 'pygame-ceを使って、四角形・円・線をブラウザcanvasへ描画します。',
    goals: ['pygame.display.set_mode', 'draw.rect / draw.circle / draw.line', 'display.flipで反映'],
    mode: 'pygame',
    code: pygameDrawSample,
    height: 520
  }),
  createShowcaseSample({
    id: 'pg-animation',
    stage: '08',
    category: 'Pygame基礎',
    level: 'アニメーション',
    title: 'async対応のアニメーション',
    description: 'ブラウザを固めないpygameループの基本形を確認します。',
    goals: ['clock.tickでフレーム制御', 'await asyncio.sleep(0)', '位置更新と反射'],
    mode: 'pygame',
    code: pygameSample,
    height: 520
  }),
  createShowcaseSample({
    id: 'pg-input',
    stage: '09',
    category: 'Pygame基礎',
    level: 'キー入力',
    title: 'キーボード入力',
    description: 'canvasにフォーカスした状態で矢印キー入力を扱う例です。',
    goals: ['pygame.event.get', 'pygame.key.get_pressed', '入力に応じた座標更新'],
    mode: 'pygame',
    code: pygameInputSample,
    height: 520
  }),
  createShowcaseSample({
    id: 'pg-collision',
    stage: '10',
    category: 'Pygame応用',
    level: 'Rect / 当たり判定',
    title: '当たり判定',
    description: 'pygame.Rectを使って、2つの矩形の衝突状態を視覚化します。',
    goals: ['Rectで位置とサイズを管理', 'colliderectで衝突判定', '状態に応じた色変更'],
    mode: 'pygame',
    code: pygameCollisionSample,
    height: 520
  }),
  createShowcaseSample({
    id: 'pg-particles',
    stage: '11',
    category: 'Pygame応用',
    level: 'math / 表現',
    title: 'パーティクル表現',
    description: 'mathとループを組み合わせて、ゲーム演出の入口になる動きを作ります。',
    goals: ['sin/cosで座標を計算', '複数オブジェクトの一括描画', '時間経過によるアニメーション'],
    mode: 'pygame',
    code: pygameParticleSample,
    height: 520
  })
]);

const selectedShowcase = computed(() => {
  return showcaseSamples.value.find(sample => sample.id === selectedShowcaseId.value) || showcaseSamples.value[0];
});

const filteredArchiveProjects = computed(() => {
  const search = archiveSearch.value.trim().toLowerCase();
  return archiveProjects.value.filter(project => {
    const matchesRuntime = archiveRuntime.value === 'all' || project.runtime === archiveRuntime.value;
    const haystack = `${project.name} ${project.shortCode} ${project.lang} ${project.sourceLabel}`.toLowerCase();
    return matchesRuntime && (!search || haystack.includes(search));
  });
});

const selectedArchiveProject = computed(() => {
  return archiveProjects.value.find(project => project.id === selectedArchiveId.value) || filteredArchiveProjects.value[0] || null;
});

onMounted(async () => {
  window.addEventListener('message', handleEmbedMessage);

  if (currentPage.value === 'archive' || requestedArchiveId) {
    await loadArchiveManifest();
  }

  if (requestedArchiveId) {
    await loadArchiveProjectById(requestedArchiveId);
    return;
  }

  const reloadState = sessionStorage.getItem('browser-python-playground-reload');
  if (reloadState) {
    sessionStorage.removeItem('browser-python-playground-reload');
    try {
      const parsed = JSON.parse(reloadState);
      if (isMode(parsed.mode)) {
        mode.value = parsed.mode;
        code.value = parsed.code || code.value;
      }
    } catch {}
    return;
  }

  const saved = localStorage.getItem('browser-python-playground');
  if (!requestedShowcase && saved && currentPage.value === 'playground') {
    try {
      const parsed = JSON.parse(saved);
      if (isMode(parsed.mode)) {
        mode.value = parsed.mode;
        code.value = parsed.code || code.value;
      }
    } catch {}
  }

  if (isOutputOnly.value) {
    runCode();
  }
});

onBeforeUnmount(() => {
  window.removeEventListener('message', handleEmbedMessage);
});

function setMode(nextMode: Mode) {
  mode.value = nextMode;
  code.value = getDefaultCode(nextMode);
  output.value = '';
  status.value = 'idle';
  currentArchiveProject.value = null;
  mountedArchiveAssetProjectId = '';
}

async function runCode() {
  isRunning.value = true;
  output.value = '';
  status.value = 'starting';

  try {
    if (mode.value === 'turtle') {
      await runSkulptCode();
      status.value = 'done';
      return;
    }

    const runtime = await getPyodide();

    runtime.setStdout({ batched: (text: string) => appendOutput(text) });
    runtime.setStderr({ batched: (text: string) => appendOutput(text) });

    if (mode.value === 'pygame') {
      status.value = 'loading pygame';
      await loadPygame(runtime);
    }

    await mountArchiveAssets(runtime);
    status.value = 'running';
    await runtime.runPythonAsync(code.value);
    status.value = 'done';
  } catch (error: any) {
    appendOutput(error?.message || String(error));
    status.value = 'error';
  } finally {
    isRunning.value = false;
    emitEmbedHeight();
  }
}

async function runSkulptCode() {
  const Sk = await getSkulpt();
  if (!turtleRef.value) {
    throw new Error('Turtle output is not ready.');
  }

  turtleRef.value.innerHTML = '';
  status.value = 'running';

  Sk.configure({
    output: (text: string) => appendOutput(text),
    read: readSkulptBuiltin,
    inputfun: (prompt: string) => Promise.resolve(window.prompt(prompt || '') ?? ''),
    inputfunTakesPrompt: true,
    __future__: Sk.python3
  });

  Sk.TurtleGraphics = {
    ...(Sk.TurtleGraphics || {}),
    target: 'skulpt-turtle-output',
    width: 500,
    height: 300,
    animate: true,
    assets: (asset: string) => {
      return currentArchiveProject.value?.assets.find(item => item.name === asset)?.path;
    }
  };

  await Sk.misceval.asyncToPromise(() => {
    return Sk.importMainWithBody('<stdin>', false, prepareSkulptCode(code.value), true);
  });
}

function prepareSkulptCode(source: string) {
  const builtinShapes = 'arrow|blank|circle|classic|square|triangle|turtle';
  return source
    .replace(/^\s*(?:\w+\.)?addshape\([^\n]*\)\s*$/gm, '')
    .replace(new RegExp(`\\bshape\\((["'])(?!${builtinShapes}\\1)[^"']+\\1\\)`, 'g'), 'shape("turtle")')
    .replace(new RegExp(`\\bturtle\\.shape\\((["'])(?!${builtinShapes}\\1)[^"']+\\1\\)`, 'g'), 'turtle.shape("turtle")');
}

async function getSkulpt() {
  if (!skulptLoaded) {
    isLoading.value = true;
    status.value = 'loading skulpt';
    await loadScript(skulptRuntimeUrl);
    await loadScript(skulptStdlibUrl);
    skulptLoaded = true;
    isLoading.value = false;
  }

  if (!window.Sk) {
    throw new Error('Skulpt loader was not available.');
  }

  return window.Sk;
}

function readSkulptBuiltin(file: string) {
  const Sk = window.Sk;
  if (!Sk?.builtinFiles?.files?.[file]) {
    throw new Error(`File not found: ${file}`);
  }

  return Sk.builtinFiles.files[file];
}

async function getPyodide() {
  if (pyodide) return pyodide;

  isLoading.value = true;
  status.value = 'loading pyodide';

  await loadScript(`${pyodideBaseUrl}pyodide.js`);
  if (!window.loadPyodide) {
    throw new Error('Pyodide loader was not available.');
  }

  pyodide = await window.loadPyodide({ indexURL: pyodideBaseUrl });
  isLoading.value = false;
  return pyodide;
}

async function loadPygame(runtime: any) {
  if (loadedPygame) return;

  await runtime.loadPackage('pygame-ce');
  runtime._api._skip_unwind_fatal_error = true;

  if (!canvasRef.value) {
    throw new Error('Canvas is not ready.');
  }

  runtime.canvas.setCanvas2D(canvasRef.value);
  loadedPygame = true;
}

async function loadArchiveManifest() {
  if (archiveManifest.value) return archiveManifest.value;

  try {
    const response = await fetch('/trinket-archive/archive.json');
    if (!response.ok) throw new Error(`Archive manifest failed: ${response.status}`);
    const manifest = await response.json() as ArchiveManifest;
    archiveManifest.value = manifest;
    archiveProjects.value = manifest.projects;
    selectedArchiveId.value = manifest.projects[0]?.id || '';
    return manifest;
  } catch (error: any) {
    archiveError.value = error?.message || String(error);
    throw error;
  }
}

async function loadArchiveProjectById(id: string) {
  const manifest = await loadArchiveManifest();
  const project = manifest.projects.find(item => item.id === id);
  if (!project) {
    archiveError.value = `Archive project not found: ${id}`;
    return;
  }

  selectedArchiveId.value = project.id;
  archiveRuntime.value = project.runtime;
  currentArchiveProject.value = project;
  mountedArchiveAssetProjectId = '';

  const response = await fetch(project.codePath);
  if (!response.ok) {
    throw new Error(`Project code failed: ${response.status}`);
  }

  mode.value = project.runtime;
  code.value = await response.text();
  output.value = '';
  status.value = 'idle';
}

async function mountArchiveAssets(runtime: any) {
  const project = currentArchiveProject.value;
  if (!project || !project.assets.length || mountedArchiveAssetProjectId === project.id) return;

  const FS = runtime.FS;
  ensurePyodideDir(FS, '/assets');

  for (const asset of project.assets) {
    const response = await fetch(asset.path);
    if (!response.ok) continue;
    const data = new Uint8Array(await response.arrayBuffer());
    FS.writeFile(asset.name, data);
    FS.writeFile(`/assets/${asset.name}`, data);
  }

  mountedArchiveAssetProjectId = project.id;
}

function ensurePyodideDir(FS: any, dir: string) {
  try {
    FS.mkdir(dir);
  } catch {}
}

function resetRuntime() {
  if (isRunning.value) {
    sessionStorage.setItem('browser-python-playground-reload', JSON.stringify({
      mode: mode.value,
      code: code.value
    }));
    window.location.reload();
    return;
  }

  pyodide = null;
  loadedPygame = false;
  isLoading.value = false;
  isRunning.value = false;
  output.value = '';
  status.value = 'idle';

  const context = canvasRef.value?.getContext('2d');
  if (context && canvasRef.value) {
    context.clearRect(0, 0, canvasRef.value.width, canvasRef.value.height);
  }

  if (window.Sk?.TurtleGraphics?.reset) {
    window.Sk.TurtleGraphics.reset();
  }
  if (turtleRef.value) {
    turtleRef.value.innerHTML = '';
  }
}

function appendOutput(text: string) {
  output.value += `${text}\n`;
  emitEmbedHeight();
}

function saveLocal() {
  localStorage.setItem('browser-python-playground', JSON.stringify({
    mode: mode.value,
    code: code.value
  }));
  status.value = 'saved';
}

function createShowcaseSample(options: {
  id: string;
  stage: string;
  category: string;
  level: string;
  title: string;
  description: string;
  goals: string[];
  mode: Mode;
  code: string;
  height: number;
}) {
  const src = buildShowcaseUrl(options.id, true);
  const shareUrl = buildShowcaseUrl(options.id, false);
  return {
    ...options,
    src,
    shareUrl,
    iframe: `<iframe src="${src}" width="100%" height="${options.height}" frameborder="0" allowfullscreen></iframe>`
  };
}

function buildShowcaseUrl(sampleId: string, embed: boolean) {
  const url = new URL('/', window.location.origin);
  url.searchParams.set('sample', sampleId);
  if (embed) {
    url.searchParams.set('embed', '1');
  }
  return url.toString();
}

function handleEmbedMessage(event: MessageEvent) {
  const frame = sampleFrameRef.value;
  if (!frame || event.source !== frame.contentWindow) return;
  if (event.data?.type !== 'browser-python-playground:resize') return;

  const height = Number(event.data.height);
  if (!Number.isFinite(height) || height < 120) return;
  selectedShowcaseFrameHeight.value = `${Math.ceil(height)}px`;
}

function resizeActiveShowcaseFrame() {
  const frame = sampleFrameRef.value;
  if (!frame) return;

  try {
    const height = frame.contentDocument?.documentElement.scrollHeight;
    if (height) {
      selectedShowcaseFrameHeight.value = `${Math.ceil(height)}px`;
    }
  } catch {}
}

function emitEmbedHeight() {
  if (!isEmbed.value) return;

  nextTick(() => {
    const height = Math.max(
      document.documentElement.scrollHeight,
      document.body.scrollHeight
    );
    window.parent?.postMessage({
      type: 'browser-python-playground:resize',
      height
    }, window.location.origin);
  });
}

function buildArchiveOpenUrl(project: ArchiveProject) {
  const url = new URL(project.runtime === 'turtle' ? '/turtle' : '/', window.location.origin);
  url.searchParams.set('archive', project.id);
  if (project.runtime !== 'python') {
    url.searchParams.set('mode', project.runtime);
  }
  return url.toString();
}

function getShowcaseRuntime(sampleId: unknown): { mode: Mode; code: string } | null {
  switch (sampleId) {
    case 'py-print':
      return { mode: 'python', code: pythonSample };
    case 'py-branch':
      return { mode: 'python', code: pythonBranchSample };
    case 'py-loop':
      return { mode: 'python', code: pythonLoopSample };
    case 'py-function':
      return { mode: 'python', code: pythonFunctionSample };
    case 'py-class':
      return { mode: 'python', code: pythonDictClassSample };
    case 'py-file':
      return { mode: 'python', code: pythonFileSample };
    case 'pg-draw':
      return { mode: 'pygame', code: pygameDrawSample };
    case 'pg-animation':
      return { mode: 'pygame', code: pygameSample };
    case 'pg-input':
      return { mode: 'pygame', code: pygameInputSample };
    case 'pg-collision':
      return { mode: 'pygame', code: pygameCollisionSample };
    case 'pg-particles':
      return { mode: 'pygame', code: pygameParticleSample };
    default:
      return null;
  }
}

function getDefaultCode(nextMode: Mode) {
  if (nextMode === 'pygame') return pygameSample;
  if (nextMode === 'turtle') return turtleSample;
  return pythonSample;
}

function isMode(value: unknown): value is Mode {
  return value === 'python' || value === 'pygame' || value === 'turtle';
}

function loadScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (existing) {
      resolve();
      return;
    }

    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}
</script>

<style>
:root {
  color-scheme: dark;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #111318;
  color: #e8edf5;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
}

a {
  color: inherit;
  text-decoration: none;
}

button,
pre,
textarea,
table {
  font: inherit;
}

button {
  min-height: 38px;
  border: 1px solid #384152;
  border-radius: 6px;
  background: #1d2430;
  color: #e8edf5;
  cursor: pointer;
}

button:hover,
.nav-links a:hover {
  border-color: #6aa9ff;
}

button:disabled {
  cursor: default;
  opacity: .55;
}

.primary {
  background: #2f7df6;
  border-color: #2f7df6;
  color: white;
}

.shell {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  min-height: 100vh;
}

.shell.embedded {
  display: block;
  min-height: 100vh;
}

.sidebar {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 20px;
  border-right: 1px solid #252b36;
  background: #151922;
}

.brand {
  display: flex;
  align-items: center;
  gap: 12px;
}

.brand h1 {
  margin: 0;
  font-size: 18px;
  line-height: 1.2;
}

.brand p {
  margin: 2px 0 0;
  color: #9aa6b8;
  font-size: 13px;
}

.mark {
  display: inline-grid;
  place-items: center;
  width: 42px;
  height: 42px;
  border-radius: 8px;
  background: #f4c542;
  color: #17202c;
  font-weight: 800;
}

.nav-links,
.segmented,
.actions {
  display: grid;
  gap: 8px;
}

.nav-links a {
  min-height: 36px;
  display: flex;
  align-items: center;
  border: 1px solid #2b3342;
  border-radius: 6px;
  padding: 0 10px;
  color: #c6d0df;
  background: #111722;
}

.nav-links a.active {
  border-color: #3c4658;
  background: #263142;
  color: #ffffff;
}

.segmented {
  grid-template-columns: repeat(3, minmax(0, 1fr));
  padding: 4px;
  border: 1px solid #2b3342;
  border-radius: 8px;
  background: #111722;
}

.segmented button {
  border-color: transparent;
  background: transparent;
}

.segmented button.active {
  background: #283244;
  border-color: #3c4658;
}

.actions {
  grid-template-columns: 1fr 1fr 1fr;
}

.snippet {
  resize: vertical;
  border: 1px solid #2b3342;
  border-radius: 6px;
  padding: 10px;
  background: #0f131b;
  color: #d2dbea;
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  font-size: 12px;
  line-height: 1.5;
}

.sharing-disabled {
  margin: 0;
  border: 1px solid #354052;
  border-radius: 6px;
  padding: 10px;
  color: #b7c2d3;
  background: #101722;
  font-size: 13px;
  line-height: 1.5;
}

.workspace {
  display: grid;
  grid-template-columns: minmax(320px, 1fr) minmax(320px, 1fr);
  height: 100vh;
  min-height: 100vh;
  grid-column: 2;
  grid-row: 1;
  overflow: hidden;
}

.embedded .workspace {
  display: block;
  min-height: 100vh;
}

.editor-pane,
.result-pane {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.editor-pane {
  border-right: 1px solid #252b36;
}

.pane-title {
  display: flex;
  justify-content: space-between;
  align-items: center;
  min-height: 42px;
  padding: 0 14px;
  border-bottom: 1px solid #252b36;
  color: #aab5c6;
  font-size: 13px;
}

.code-editor {
  flex: 1;
  width: 100%;
  min-height: 0;
  background: #0f131b;
  overflow: hidden;
}

.output-grid {
  display: grid;
  grid-template-rows: minmax(220px, 360px) minmax(120px, 1fr);
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: #111318;
}

.output-grid.mode-python {
  grid-template-rows: minmax(120px, 1fr);
}

.canvas-frame {
  display: grid;
  place-items: center;
  padding: 14px;
  border-bottom: 1px solid #252b36;
  background: #171c25;
}

.turtle-frame {
  display: block;
  width: min(100%, 500px);
  min-height: 300px;
  margin: 14px auto;
  overflow: hidden;
  border: 1px solid #30394a;
  border-radius: 6px;
  background: #f7f9fc;
}

.canvas-frame canvas {
  width: min(100%, 640px);
  aspect-ratio: 64 / 42;
  height: auto;
  border: 1px solid #30394a;
  border-radius: 6px;
  background: #0b0e13;
}

.turtle-frame canvas {
  display: block;
  max-width: 100%;
  border: 0;
  background: transparent;
}

.console {
  min-height: 0;
  margin: 0;
  padding: 16px;
  overflow: auto;
  white-space: pre-wrap;
  color: #dce6f7;
  background: #0b0e13;
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  font-size: 13px;
  line-height: 1.55;
}

.doc-page {
  grid-column: 2;
  min-width: 0;
  padding: 32px;
}

.page-header {
  max-width: 880px;
  margin-bottom: 24px;
}

.eyebrow {
  margin: 0 0 8px;
  color: #79b8ff;
  font-size: 13px;
  font-weight: 700;
}

.page-header h2 {
  margin: 0 0 12px;
  font-size: 28px;
  line-height: 1.25;
}

.page-header p {
  margin: 0;
  color: #b7c2d3;
  line-height: 1.7;
}

.table-wrap {
  overflow-x: auto;
  border: 1px solid #2b3342;
  border-radius: 8px;
}

.capability-table {
  width: 100%;
  border-collapse: collapse;
  min-width: 860px;
  background: #111722;
}

.capability-table th,
.capability-table td {
  border-bottom: 1px solid #2b3342;
  padding: 14px;
  text-align: left;
  vertical-align: top;
  line-height: 1.6;
}

.capability-table thead th {
  color: #dce6f7;
  background: #1a2230;
  font-size: 13px;
}

.capability-table tbody th {
  width: 160px;
  color: #ffffff;
}

.capability-table td {
  color: #c3cedd;
}

.archive-toolbar {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) 180px;
  gap: 12px;
  margin-bottom: 14px;
}

.archive-toolbar label {
  display: grid;
  gap: 6px;
  color: #aab5c6;
  font-size: 13px;
}

.archive-toolbar input,
.archive-toolbar select {
  min-height: 38px;
  border: 1px solid #2b3342;
  border-radius: 6px;
  padding: 0 10px;
  background: #101722;
  color: #e8edf5;
}

.archive-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
}

.archive-summary span {
  border: 1px solid #2b3342;
  border-radius: 6px;
  padding: 6px 10px;
  background: #111722;
  color: #c3cedd;
  font-size: 13px;
}

.archive-layout {
  display: grid;
  grid-template-columns: minmax(320px, 1fr) 320px;
  gap: 18px;
  align-items: start;
}

.archive-list {
  display: grid;
  gap: 6px;
  max-height: calc(100vh - 230px);
  overflow: auto;
  border: 1px solid #2b3342;
  border-radius: 8px;
  padding: 8px;
  background: #101722;
}

.archive-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  align-items: stretch;
}

.archive-main {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 3px 10px;
  min-height: 62px;
  padding: 9px;
  text-align: left;
}

.archive-main strong,
.archive-main small {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.archive-main small {
  color: #9aa6b8;
  font-size: 12px;
}

.archive-row.active .archive-main {
  border-color: #6aa9ff;
  background: #1b2940;
}

.archive-runtime {
  grid-row: span 2;
  align-self: center;
  min-width: 58px;
  border-radius: 6px;
  padding: 5px 7px;
  text-align: center;
  color: #0f131b;
  background: #f4c542;
  font-size: 11px;
  font-weight: 800;
  text-transform: uppercase;
}

.archive-runtime[data-runtime="pygame"] {
  background: #72b7ff;
}

.archive-runtime[data-runtime="turtle"] {
  background: #74d99f;
}

.archive-detail {
  position: sticky;
  top: 24px;
  border: 1px solid #2b3342;
  border-radius: 8px;
  padding: 16px;
  background: #151922;
}

.archive-detail h3 {
  margin: 0 0 14px;
  font-size: 20px;
  line-height: 1.3;
}

.archive-meta {
  display: grid;
  gap: 10px;
  margin: 0 0 16px;
}

.archive-meta div {
  display: grid;
  gap: 3px;
}

.archive-meta dt {
  color: #8f9caf;
  font-size: 12px;
}

.archive-meta dd {
  min-width: 0;
  margin: 0;
  color: #d8e2f2;
  overflow-wrap: anywhere;
  font-size: 13px;
  line-height: 1.5;
}

.archive-open {
  display: inline-flex;
  align-items: center;
  width: 100%;
  min-height: 38px;
  border: 1px solid #2f7df6;
  border-radius: 6px;
  padding: 0 12px;
  justify-content: center;
  color: #ffffff;
}

.archive-message {
  border: 1px solid #2b3342;
  border-radius: 8px;
  padding: 16px;
  background: #111722;
  color: #c3cedd;
}

.showcase-layout {
  display: grid;
  grid-template-columns: minmax(260px, 360px) minmax(0, 1fr);
  gap: 18px;
  align-items: start;
}

.showcase-list {
  display: grid;
  gap: 8px;
  max-height: calc(100vh - 64px);
  overflow: auto;
  position: sticky;
  top: 24px;
}

.showcase-item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 4px 10px;
  width: 100%;
  min-height: 72px;
  padding: 10px;
  text-align: left;
}

.showcase-item span {
  grid-row: span 2;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 6px;
  background: #283244;
  color: #dce6f7;
  font-weight: 800;
  font-size: 12px;
}

.showcase-item strong {
  min-width: 0;
  font-size: 14px;
}

.showcase-item small {
  min-width: 0;
  color: #9aa6b8;
  font-size: 12px;
}

.showcase-item.active {
  border-color: #6aa9ff;
  background: #1b2940;
}

.showcase-detail {
  border: 1px solid #2b3342;
  border-radius: 8px;
  background: #151922;
  overflow: hidden;
}

.showcase-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 16px;
  border-bottom: 1px solid #2b3342;
}

.showcase-heading h3 {
  margin: 0 0 8px;
  font-size: 20px;
}

.open-link {
  flex: none;
  display: inline-flex;
  align-items: center;
  min-height: 36px;
  border: 1px solid #384152;
  border-radius: 6px;
  padding: 0 12px;
  background: #1d2430;
  color: #e8edf5;
  font-size: 13px;
}

.showcase-description {
  margin: 0;
  padding: 16px 16px 0;
  color: #b7c2d3;
  line-height: 1.6;
}

.goal-list {
  display: grid;
  gap: 6px;
  margin: 12px 16px 16px;
  padding-left: 18px;
  color: #c3cedd;
  font-size: 13px;
  line-height: 1.55;
}

.sample-frame {
  display: block;
  width: 100%;
  border: 0;
  border-top: 1px solid #2b3342;
  border-bottom: 1px solid #2b3342;
  background: #0b0e13;
}

.snippet-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  padding: 16px;
}

.snippet-grid label {
  display: grid;
  gap: 8px;
  color: #aab5c6;
  font-size: 13px;
}

.snippet-grid .snippet {
  width: 100%;
  min-height: 96px;
  resize: vertical;
}

@media (max-width: 1100px) {
  .archive-layout,
  .showcase-layout,
  .snippet-grid {
    grid-template-columns: 1fr;
  }

  .archive-detail,
  .showcase-list {
    max-height: none;
    position: static;
  }
}

@media (max-width: 900px) {
  .shell {
    grid-template-columns: 1fr;
  }

  .sidebar {
    border-right: 0;
    border-bottom: 1px solid #252b36;
  }

  .workspace,
  .doc-page {
    grid-template-columns: 1fr;
    grid-column: 1;
    grid-row: auto;
  }

  .workspace {
    height: auto;
    min-height: 100vh;
    overflow: visible;
  }

  .code-editor {
    min-height: 420px;
  }

  .doc-page {
    padding: 24px 16px;
  }

  .editor-pane {
    border-right: 0;
    border-bottom: 1px solid #252b36;
  }

  .archive-toolbar {
    grid-template-columns: 1fr;
  }
}
</style>
