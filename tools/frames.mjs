#!/usr/bin/env node
/**
 * КАДРЫ ИЗ ВИДЕО
 * ---------------------------------------------------------------------------
 * В системе нет ffmpeg, а посмотреть запись экрана нужно. Берём тот же
 * headless-браузер: он проигрывает файл, мы перематываем на нужные секунды и
 * снимаем кадр через canvas. Так видно, что именно дёргается, вместо догадок.
 *
 *   node tools/frames.mjs <файл.mov> <куда> [шаг_в_секундах]
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const файл = process.argv[2];
const куда = process.argv[3] || '/tmp/frames';
const шаг = Number(process.argv[4] || 1);
if (!файл) { console.error('нужен путь к видео'); process.exit(1); }

const папка = path.dirname(path.resolve(файл));
const имя = path.basename(файл);

/* Перемотка видео работает только через range-запросы: без них браузер не
   может встать на произвольную секунду, событие seeked не приходит и кадры
   не снимаются вовсе. Поэтому сервер обязан отвечать 206 Partial Content. */
const server = createServer(async (req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  try {
    const тело = await readFile(path.join(папка, u === '/' ? имя : u.slice(1)));
    const тип = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' };
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const от = m[1] ? parseInt(m[1], 10) : 0;
      const до = m[2] ? parseInt(m[2], 10) : тело.length - 1;
      res.writeHead(206, {
        ...тип,
        'Content-Range': `bytes ${от}-${до}/${тело.length}`,
        'Content-Length': до - от + 1,
      });
      res.end(тело.subarray(от, до + 1));
      return;
    }
    res.writeHead(200, { ...тип, 'Content-Length': тело.length });
    res.end(тело);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const база = `http://127.0.0.1:${server.address().port}/`;

await mkdir(куда, { recursive: true });
/* Записи с iPhone идут в HEVC, а открытая сборка Chromium проприетарные
   кодеки не несёт — кадры выходили пустыми. Берём настоящий Chrome из
   системы, он декодирует. */
const браузер = await chromium.launch({ channel: 'chrome' });
const page = await (await браузер.newContext({ viewport: { width: 1200, height: 900 } })).newPage();

await page.setContent(`<body style="margin:0;background:#000">
  <video id="v" src="${база}${encodeURIComponent(имя)}" muted playsinline></video>
  <canvas id="c" style="display:none"></canvas></body>`);

const длительность = await page.evaluate(() => new Promise((res) => {
  const v = document.getElementById('v');
  if (v.readyState >= 1) return res(v.duration);
  v.addEventListener('loadedmetadata', () => res(v.duration), { once: true });
  setTimeout(() => res(0), 20000);
}));

if (!длительность) {
  console.error('видео не открылось — формат не поддерживается браузером');
  await браузер.close(); server.close(); process.exit(1);
}
console.log(`длительность: ${длительность.toFixed(1)} с · шаг ${шаг} с`);

const снято = [];
for (let t = 0; t < длительность; t += шаг) {
  const data = await page.evaluate((время) => new Promise((res) => {
    const v = document.getElementById('v');
    const c = document.getElementById('c');
    const готово = () => {
      c.width = v.videoWidth; c.height = v.videoHeight;
      c.getContext('2d').drawImage(v, 0, 0);
      res(c.toDataURL('image/png'));
    };
    v.addEventListener('seeked', готово, { once: true });
    v.currentTime = время;
    setTimeout(() => res(null), 8000);
  }), t);
  if (!data) continue;
  const имяК = `${String(Math.round(t * 10)).padStart(5, '0')}.png`;
  await writeFile(path.join(куда, имяК), Buffer.from(data.split(',')[1], 'base64'));
  снято.push(имяК);
}

console.log(`кадров: ${снято.length} → ${куда}`);
await браузер.close();
server.close();
