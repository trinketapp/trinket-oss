import { expect, test } from '@playwright/test';

test.describe('browser Python playground', () => {
  test('uses Japanese navigation and exposes the capability table', async ({ page }) => {
    await page.goto('/capabilities');

    await expect(page.getByRole('heading', { name: 'ブラウザでできること、設計が必要なこと' })).toBeVisible();
    await expect(page.getByTestId('capability-table')).toContainText('Python文法');
    await expect(page.getByTestId('capability-table')).toContainText('Pygameループ');
    await expect(page.getByTestId('capability-table')).toContainText('Turtle / Skulpt');
    await expect(page.getByTestId('capability-table')).toContainText('同期的な `while True`');
  });

  test('shows a lazy showcase and renders only the selected embed', async ({ page }) => {
    await page.goto('/samples');

    await expect(page.getByRole('heading', { name: 'Python基礎からpygame応用まで順に確認' })).toBeVisible();
    await expect(page.getByTestId('showcase-list')).toContainText('出力と変数');
    await expect(page.getByTestId('showcase-list')).toContainText('当たり判定');
    await expect(page.getByTestId('showcase-list')).toContainText('パーティクル表現');
    await expect(page.locator('textarea.snippet').first()).toHaveValue(/<iframe/);
    await expect(page.locator('textarea.snippet').first()).toHaveValue(/sample=py-print/);
    await expect(page.locator('textarea.snippet').first()).toHaveValue(/embed=1/);
    await expect(page.locator('iframe.sample-frame')).toHaveCount(1);
    await expect(page.getByTestId('showcase-detail')).not.toContainText('公式サンプルを開く');

    await page.getByTestId('showcase-pg-draw').click();
    await expect(page.getByTestId('showcase-detail')).toContainText('canvasへの基本描画');
    await expect(page.getByTestId('active-showcase-frame')).toHaveAttribute('src', /sample=pg-draw/);
    await expect(page.locator('iframe.sample-frame')).toHaveCount(1);

    await expect.poll(async () => {
      return page.getByTestId('active-showcase-frame').evaluate((frame: HTMLIFrameElement) => frame.clientHeight);
    }).toBeGreaterThan(300);
  });

  test('opens sample share pages as read-only output', async ({ page }) => {
    await page.goto('/?sample=py-print');

    await expect(page.getByTestId('editor')).toHaveCount(0);
    await expect(page.getByTestId('run')).toHaveCount(0);
    await expect(page.getByTestId('console')).toContainText('点数: [82, 91, 74, 88]', { timeout: 90_000 });
  });

  test('renders a readable CodeMirror editor with line numbers and completion', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByTestId('editor')).toBeVisible();
    await expect(page.locator('.cm-gutters')).toBeVisible();
    await expect.poll(async () => {
      return page.locator('.cm-lineNumbers .cm-gutterElement').evaluateAll(elements => {
        return elements.map(element => element.textContent?.trim()).includes('1');
      });
    }).toBe(true);
    await expect(page.locator('.cm-content')).toContainText('from statistics import mean');

    await page.locator('.cm-content').click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.type('pri');
    await expect(page.locator('.cm-tooltip-autocomplete')).toBeVisible();
    await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('print');
  });

  test('runs regular Python and prints stdout', async ({ page }) => {
    await page.goto('/');

    await page.getByTestId('run').click();

    await expect(page.getByTestId('console')).toContainText('点数: [82, 91, 74, 88]', { timeout: 90_000 });
    await expect(page.getByTestId('console')).toContainText('平均: 83.75');
  });

  test('disables arbitrary code sharing and ignores code URL payloads', async ({ page }) => {
    const encoded = Buffer.from('print("untrusted")', 'utf8').toString('base64');
    await page.goto(`/?mode=python&code=${encodeURIComponent(encoded)}`);

    await expect(page.getByTestId('sharing-disabled')).toContainText('共有URLと任意コード埋め込みは停止中です。');
    await expect(page.getByTestId('share-url')).toHaveCount(0);
    await expect(page.getByTestId('embed-code')).toHaveCount(0);
    await expect(page.locator('.cm-content')).toContainText('from statistics import mean');
    await expect(page.locator('.cm-content')).not.toContainText('untrusted');
  });

  test('loads pygame-ce and draws to the canvas', async ({ page }) => {
    await page.goto('/');

    await page.getByTestId('pygame-mode').click();
    await page.getByTestId('run').click();

    await expect(page.getByTestId('run')).toContainText(/読み込み中|実行中/, { timeout: 90_000 });
    await expect(page.getByTestId('pygame-canvas')).toBeVisible();

    await expect.poll(async () => {
      return page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="pygame-canvas"]');
        if (!canvas) return 0;
        const context = canvas.getContext('2d');
        if (!context) return 0;
        const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let coloredPixels = 0;
        for (let index = 0; index < data.length; index += 4) {
          if (data[index] || data[index + 1] || data[index + 2]) coloredPixels++;
        }
        return coloredPixels;
      });
    }, {
      timeout: 120_000,
      message: 'pygame canvas should contain rendered pixels'
    }).toBeGreaterThan(1000);
  });

  test('opens the Skulpt turtle editor and renders turtle graphics', async ({ page }) => {
    await page.goto('/turtle');

    await expect(page.getByTestId('turtle-mode')).toHaveClass(/active/);
    await expect(page.locator('.cm-content')).toContainText('from turtle import');

    await page.getByTestId('run').click();
    await expect(page.getByTestId('skulpt-turtle')).toBeVisible();

    await expect.poll(async () => {
      return page.evaluate(() => {
        const host = document.querySelector('[data-testid="skulpt-turtle"]');
        const canvases = [...(host?.querySelectorAll('canvas') || [])];
        if (!canvases.length) return 0;
        let coloredPixels = 0;
        for (const canvas of canvases) {
          const context = canvas.getContext('2d');
          if (!context) continue;
          const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
          for (let index = 0; index < data.length; index += 4) {
            if (data[index] || data[index + 1] || data[index + 2]) coloredPixels++;
          }
        }
        return coloredPixels;
      });
    }, {
      timeout: 30_000,
      message: 'Skulpt turtle canvas should contain rendered pixels'
    }).toBeGreaterThan(1000);
  });

  test('shows exported projects in the archive and opens fixed project ids', async ({ page }) => {
    const manifestResponse = await page.request.get('/trinket-archive/archive.json');
    test.skip(!manifestResponse.ok(), 'Archive fixture is generated locally with npm run build:archive.');

    await page.goto('/archive');

    await expect(page.getByRole('heading', { name: 'Trinket おもしろコード倉庫' })).toBeVisible();
    await expect(page.getByTestId('archive-summary')).toContainText('全625件');
    await expect(page.getByTestId('archive-summary')).toContainText('Pygame 213');
    await expect(page.getByTestId('archive-summary')).toContainText('Turtle 99');

    await page.getByTestId('archive-runtime').selectOption('turtle');
    await expect(page.getByTestId('archive-list')).toContainText('A Turtle in Space');

    await page.goto('/turtle?archive=innovator-python-1133000f11');
    await expect(page.locator('.cm-content')).toContainText('screen.bgpic("M01_mission.jpeg")');
    await page.getByTestId('run').click();
    await expect(page.getByTestId('console')).toContainText('オムライス', { timeout: 30_000 });

    await page.goto('/?archive=standard-pygame-799fc57fd0fe&mode=pygame');
    await expect(page.getByTestId('pygame-mode')).toHaveClass(/active/);
    await expect(page.locator('.cm-content')).toContainText('pg.image.load("nezubotto.png")');
  });
});
