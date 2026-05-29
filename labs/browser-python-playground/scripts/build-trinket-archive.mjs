import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(appRoot, '..', '..');
const tmpRoot = path.join(repoRoot, 'tmp');
const outputRoot = path.join(appRoot, 'public', 'trinket-archive');

const sources = [
  {
    key: 'standard',
    label: 'Pygame/Python Export',
    rootName: 'trinket-export-data'
  },
  {
    key: 'innovator',
    label: 'Innovator Turtle Export',
    rootPrefix: 'trinket-export-data'
  }
];

const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const audioExtensions = new Set(['.wav', '.mp3', '.ogg', '.m4a']);

async function main() {
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(path.join(outputRoot, 'projects'), { recursive: true });

  const projects = [];
  for (const source of sources) {
    const sourceRoot = await findSourceRoot(source);
    if (!sourceRoot) continue;

    const langDirs = await safeReaddir(sourceRoot);
    for (const langDirent of langDirs) {
      if (!langDirent.isDirectory()) continue;
      const langDir = path.join(sourceRoot, langDirent.name);
      const projectDirs = await safeReaddir(langDir);
      for (const projectDirent of projectDirs) {
        if (!projectDirent.isDirectory()) continue;

        const projectDir = path.join(langDir, projectDirent.name);
        const mainPath = path.join(projectDir, 'main.py');
        const metadataPath = path.join(projectDir, 'metadata.json');
        if (!existsSync(mainPath)) continue;

        const code = await readFile(mainPath, 'utf8');
        const metadata = await readMetadata(metadataPath);
        const shortCode = metadata.shortCode || projectDirent.name.split('_').at(-1) || projectDirent.name;
        const id = `${source.key}-${langDirent.name}-${shortCode}`.replace(/[^a-zA-Z0-9_-]/g, '-');
        const runtime = detectRuntime(code, langDirent.name);
        const outputProjectDir = path.join(outputRoot, 'projects', id);
        const outputAssetDir = path.join(outputProjectDir, 'assets');
        await mkdir(outputProjectDir, { recursive: true });
        await writeFile(path.join(outputProjectDir, 'main.py'), code);

        const assets = [];
        const inputAssetDir = path.join(projectDir, 'assets');
        if (existsSync(inputAssetDir)) {
          await mkdir(outputAssetDir, { recursive: true });
          for (const asset of await safeReaddir(inputAssetDir)) {
            if (!asset.isFile()) continue;
            await cp(path.join(inputAssetDir, asset.name), path.join(outputAssetDir, asset.name));
            assets.push({
              name: asset.name,
              path: `/trinket-archive/projects/${id}/assets/${encodeURIComponent(asset.name)}`,
              kind: getAssetKind(asset.name)
            });
          }
        }

        projects.push({
          id,
          source: source.key,
          sourceLabel: source.label,
          name: metadata.name || projectDirent.name,
          shortCode,
          lang: metadata.lang || langDirent.name,
          runtime,
          url: metadata.url || '',
          created: metadata.created || '',
          lastUpdated: metadata.lastUpdated || '',
          codePath: `/trinket-archive/projects/${id}/main.py`,
          assetCount: assets.length,
          assets,
          lineCount: code.split(/\r?\n/).length,
          parseWarning: detectParseWarning(code)
        });
      }
    }
  }

  projects.sort((a, b) => {
    const runtimeOrder = { pygame: 0, turtle: 1, python: 2 };
    return runtimeOrder[a.runtime] - runtimeOrder[b.runtime] || a.name.localeCompare(b.name, 'ja');
  });

  const manifest = {
    generatedAt: new Date().toISOString(),
    projectCount: projects.length,
    runtimeCounts: countBy(projects, 'runtime'),
    sourceCounts: countBy(projects, 'source'),
    projects
  };

  await writeFile(path.join(outputRoot, 'archive.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${projects.length} projects to ${path.relative(appRoot, outputRoot)}`);
}

async function findSourceRoot(source) {
  if (source.rootName) {
    const exact = path.join(tmpRoot, source.rootName);
    return existsSync(exact) ? exact : null;
  }

  const entries = await safeReaddir(tmpRoot);
  const found = entries.find(entry => {
    return entry.isDirectory() &&
      entry.name.startsWith(source.rootPrefix) &&
      entry.name !== 'trinket-export-data';
  });
  return found ? path.join(tmpRoot, found.name) : null;
}

async function safeReaddir(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function readMetadata(metadataPath) {
  try {
    return JSON.parse(await readFile(metadataPath, 'utf8'));
  } catch {
    return {};
  }
}

function detectRuntime(code, lang) {
  if (/\bimport\s+pygame\b|\bfrom\s+pygame\s+import\b/.test(code) || lang === 'pygame') return 'pygame';
  if (/\bimport\s+turtle\b|\bfrom\s+turtle\s+import\b/.test(code)) return 'turtle';
  return 'python';
}

function getAssetKind(name) {
  const ext = path.extname(name).toLowerCase();
  if (imageExtensions.has(ext)) return 'image';
  if (audioExtensions.has(ext)) return 'audio';
  return 'file';
}

function detectParseWarning(code) {
  if (/^\s*print\s+["']/.test(code)) return 'python2_print';
  if (/if\s+#/.test(code) || /elif\s+#/.test(code)) return 'template_placeholder';
  return '';
}

function countBy(items, key) {
  return items.reduce((acc, item) => {
    acc[item[key]] = (acc[item[key]] || 0) + 1;
    return acc;
  }, {});
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
