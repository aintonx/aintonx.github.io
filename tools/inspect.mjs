#!/usr/bin/env node
/**
 * ОСМОТР ЗОНЫ В НАСТОЯЩЕМ БРАУЗЕРЕ
 * ---------------------------------------------------------------------------
 * Открывает нужную зону сайта тем же способом, что и стенд кадров, и выполняет
 * в ней ваше выражение. Нужен, чтобы смотреть вычисленные стили и разметку там,
 * куда панель предпросмотра не достаёт, — то есть почти везде ниже первого
 * экрана.
 *
 *   node tools/inspect.mjs catalog "document.querySelectorAll('.pcard-power').length"
 *   node tools/inspect.mjs card --size mobile "getComputedStyle(document.querySelector('.mhead-close')).width"
 *   node tools/inspect.mjs checkout-3 --shot /tmp/шаг3.png "1"
 *
 * Выражение вычисляется внутри страницы; результат печатается как JSON.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ZONES, РАЗМЕРЫ } from './zones.mjs';
import { изолировать, подготовить, вишУжеВиден } from './stub.mjs';

const КОРЕНЬ = process.cwd();
const args = process.argv.slice(2);
const значение = (флаг) => { const i = args.indexOf(флаг); return i >= 0 ? args[i + 1] : null; };

const идЗоны = args[0];
const размерId = значение('--size') || 'desktop';
const кадр = значение('--shot');
const выражение = args[args.length - 1];

const зона = ZONES.find((z) => z.id === идЗоны);
const размер = РАЗМЕРЫ.find((r) => r.id === размерId);
if (!зона || !размер) {
  console.error(`зона «${идЗоны}» или размер «${размерId}» не найдены`);
  console.error('зоны: ' + ZONES.map((z) => z.id).join(', '));
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.mp4': 'video/mp4',
};

const server = createServer(async (req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(КОРЕНЬ, u === '/' ? '/index.html' : u);
  try {
    if (!file.startsWith(КОРЕНЬ)) { res.writeHead(403).end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch { if (!res.headersSent) res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const базовый = `http://127.0.0.1:${server.address().port}/`;

const браузер = await chromium.launch();
const page = await (await браузер.newContext({
  viewport: { width: размер.width, height: размер.height }, colorScheme: 'dark',
})).newPage();

await изолировать(page, базовый);
  await вишУжеВиден(page);

const ошибки = [];
page.on('pageerror', (e) => ошибки.push(e.message));

await page.goto(`${базовый}?v=${Date.now()}`, { waitUntil: 'load', timeout: 30000 });
await подготовить(page);

if (зона.open) await зона.open(page);
await page.waitForTimeout(400);

try {
  const итог = await page.evaluate(async (код) => {
    // await — чтобы выражение могло вернуть Promise и дождаться анимации
    const r = await eval(код);
    return JSON.parse(JSON.stringify(r === undefined ? null : r));
  }, выражение);
  console.log(JSON.stringify(итог, null, 2));
} catch (e) {
  console.error('выражение не выполнилось: ' + e.message.split('\n')[0]);
}

if (кадр) {
  const узел = page.locator(зона.sel).first();
  await узел.scrollIntoViewIfNeeded().catch(() => {});
  await узел.screenshot({ path: кадр, timeout: 20000 });
  console.error(`кадр: ${кадр}`);
}
if (ошибки.length) console.error('ошибки страницы: ' + ошибки[0]);

await браузер.close();
server.close();
