#!/usr/bin/env node
/**
 * СТЕНД КАДРОВ И ВИЗУАЛЬНОЙ РЕГРЕССИИ
 * ---------------------------------------------------------------------------
 * Зачем: панель предпросмотра в редакторе не перерисовывает содержимое ниже
 * первого экрана — середину сайта проверять было нечем, и правки в ней шли
 * вслепую, по замерам. Здесь настоящий headless-браузер: он прокручивает к
 * нужному узлу и снимает именно его, поэтому видно всё.
 *
 * Главное — не сами кадры, а сравнение с эталоном. Блок, закрытый с эталонным
 * кадром, больше не разъезжается незаметно от правки в соседнем месте.
 *
 *   node tools/shots.mjs --baseline   снять эталоны (после того как блок принят)
 *   node tools/shots.mjs              снять текущее состояние
 *   node tools/shots.mjs --diff       сравнить текущее с эталоном
 *   node tools/shots.mjs --zone catalog --size mobile   только одна зона
 *
 * Кадры лежат в tools/shots/ (в .gitignore), эталоны — в tools/baseline/
 * и версионируются вместе с кодом.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { ZONES, РАЗМЕРЫ } from './zones.mjs';

const КОРЕНЬ = process.cwd();
const args = process.argv.slice(2);
const режим = args.includes('--baseline') ? 'baseline' : args.includes('--diff') ? 'diff' : 'current';
/* indexOf вернёт -1, если флага нет, и args[0] окажется соседним флагом —
   поэтому сначала проверяем наличие. */
const значение = (флаг) => {
  const i = args.indexOf(флаг);
  return i >= 0 ? args[i + 1] || null : null;
};
const однаЗона = значение('--zone');
const одинРазмер = значение('--size');

const ПАПКА = {
  baseline: path.join(КОРЕНЬ, 'tools', 'baseline'),
  current: path.join(КОРЕНЬ, 'tools', 'shots', 'current'),
  diff: path.join(КОРЕНЬ, 'tools', 'shots', 'diff'),
};

/* ── Свой статический сервер ───────────────────────────────────────────────
   Не полагаемся на dev-сервер редактора: он отдавал кеш, из-за чего я
   однажды полдня сверял замеры со старой сборкой. Здесь каждый запрос
   читает файл с диска. */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.mp4': 'video/mp4',
};

function поднятьСервер() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const url = decodeURIComponent(req.url.split('?')[0]);
      const rel = url === '/' ? '/index.html' : url;
      const file = path.join(КОРЕНЬ, rel);
      if (!file.startsWith(КОРЕНЬ)) { res.writeHead(403).end(); return; }
      try {
        const body = await readFile(file);
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        res.end(body);
      } catch {
        res.writeHead(404).end('нет файла');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, порт: server.address().port }));
  });
}

/* ── Заморозка движения ────────────────────────────────────────────────────
   На сайте много живого: осциллограф Эхо, таймер наблюдения, волна записи,
   дышащие точки статуса. Без остановки два прогона подряд дают разные кадры,
   и регрессия тонет в собственном шуме. Замораживаем ПОСЛЕ того, как зона
   открылась, — иначе не отработают анимации появления. */
async function заморозить(page) {
  await page.addStyleTag({
    content: `*, *::before, *::after {
      animation-play-state: paused !important;
      animation-delay: -1ms !important;
      transition: none !important;
      caret-color: transparent !important;
    }`,
  }).catch(() => {});
  await page.evaluate(() => {
    // Обрываем rAF-циклы: канвасы и осциллографы рисуют именно через них
    window.requestAnimationFrame = () => 0;
    // и таймеры — часы наблюдения, бегущие строки терминала
    const макс = setTimeout(() => {}, 0);
    for (let i = 0; i <= макс; i++) { clearTimeout(i); clearInterval(i); }
  }).catch(() => {});
  await page.waitForTimeout(250);
}

/* Заведомо живые области: часы наблюдения, осциллографы, волна записи,
   сканер конденсации, пульсирующие точки. Их значение меняется от прогона к
   прогону по существу, а не из-за правок, поэтому на кадре они закрываются
   плашкой. Всё остальное сравнивается попиксельно. */
const ЖИВОЕ = [
  '.obs-big', '.obs-eq', '.obs-wave', '.obs-row',
  '.beam', '#echoBeam', '.wave', '.fr',
  '.cond-barcode', '.donate-pulse', '.sys-dot', '.g-dot', '.dot',
  '.attr-drum-strip', '.echo-aura-drum-strip',
  // выпавшие значения барабанов — содержимое, а не вёрстка
  '#resObolochka', '#resNit', '#resSled', '#resGender',
  '#echoAuraDrumName', '#echoAuraDrumDesc',
  // метка документа набирается глитч-анимацией по буквам
  '.legal-modal-label',
];

async function маски(page) {
  const из = [];
  for (const sel of ЖИВОЕ) {
    const loc = page.locator(sel);
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < n; i++) из.push(loc.nth(i));
  }
  return из;
}

/* ── Съёмка ──────────────────────────────────────────────────────────────── */
async function снять() {
  const { server, порт } = await поднятьСервер();
  const базовый = `http://127.0.0.1:${порт}/`;
  const куда = ПАПКА[режим === 'baseline' ? 'baseline' : 'current'];
  await mkdir(куда, { recursive: true });

  const браузер = await chromium.launch();
  const снято = [];
  const пропущено = [];

  for (const размер of РАЗМЕРЫ) {
    if (одинРазмер && размер.id !== одинРазмер) continue;
    const ctx = await браузер.newContext({
      viewport: { width: размер.width, height: размер.height },
      deviceScaleFactor: 1,
      colorScheme: 'dark',
      reducedMotion: 'reduce',   // движение выключено: кадры должны быть повторяемыми
    });

    for (const зона of ZONES) {
      if (однаЗона && зона.id !== однаЗона) continue;
      if (зона.только && зона.только !== размер.id) continue;

      const page = await ctx.newPage();
      const ошибки = [];
      /* SmartCaptcha ругается, что 127.0.0.1 не в списке разрешённых хостов —
         это ожидаемо для локального стенда и к качеству вёрстки отношения не
         имеет. Глушим только её, всё остальное должно быть видно. */
      const шум = /SmartCaptcha.*allowed hosts/i;
      page.on('pageerror', (e) => { if (!шум.test(e.message)) ошибки.push(e.message); });
      page.on('console', (m) => { if (m.type() === 'error' && !шум.test(m.text())) ошибки.push(m.text()); });

      /* Барабаны атрибутов и Ауры тянут значения из Math.random — без
         фиксации каждый прогон выдаёт другие слова, и регрессия ругается на
         содержимое вместо вёрстки. Подменяем до загрузки страницы. */
      await page.addInitScript(() => {
        let s = 42;
        Math.random = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
      });

      try {
        // ?v= — против любого кеширования на стороне страницы
        await page.goto(`${базовый}?v=${Date.now()}`, { waitUntil: 'load', timeout: 30000 });
        await page.evaluate(() => {
          // Загрузочная шторка мешает съёмке — снимаем её сразу
          document.documentElement.classList.remove('ew-first-boot-pending');
          document.getElementById('ewFirstBoot')?.remove();
        });
        await page.waitForTimeout(600);

        if (зона.open) await зона.open(page);

        await заморозить(page);

        const узел = page.locator(зона.sel).first();
        if (!(await узел.count())) { пропущено.push(`${зона.id}/${размер.id}: нет узла ${зона.sel}`); await page.close(); continue; }
        await узел.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(400);

        const имя = `${зона.id}--${размер.id}.png`;
        await узел.screenshot({
          path: path.join(куда, имя),
          timeout: 15000,
          mask: await маски(page),
          maskColor: '#ff00ff',
        });
        снято.push({ имя, зона: зона.имя, ошибки });
      } catch (e) {
        пропущено.push(`${зона.id}/${размер.id}: ${e.message.split('\n')[0]}`);
      }
      await page.close();
    }
    await ctx.close();
  }

  await браузер.close();
  server.close();

  console.log(`\nснято кадров: ${снято.length} → ${path.relative(КОРЕНЬ, куда)}`);
  const сОшибками = снято.filter((s) => s.ошибки.length);
  if (сОшибками.length) {
    console.log('\nошибки в консоли страницы:');
    for (const s of сОшибками) console.log(`  ${s.имя}: ${s.ошибки[0]}`);
  }
  if (пропущено.length) {
    console.log(`\nпропущено (${пропущено.length}):`);
    for (const p of пропущено) console.log('  ' + p);
  }
  return снято.length;
}

/* ── Сравнение с эталоном ────────────────────────────────────────────────── */
async function сравнить() {
  if (!existsSync(ПАПКА.baseline)) {
    console.error('эталонов ещё нет — сначала `npm run shots:baseline`');
    process.exit(1);
  }
  await mkdir(ПАПКА.diff, { recursive: true });
  const эталоны = (await readdir(ПАПКА.baseline)).filter((f) => f.endsWith('.png'));
  const расхождения = [];
  const шум = [];
  let совпало = 0;

  for (const имя of эталоны) {
    const путьТек = path.join(ПАПКА.current, имя);
    if (!existsSync(путьТек)) { расхождения.push({ имя, что: 'нет текущего кадра' }); continue; }
    const a = PNG.sync.read(await readFile(path.join(ПАПКА.baseline, имя)));
    const b = PNG.sync.read(await readFile(путьТек));
    if (a.width !== b.width || a.height !== b.height) {
      расхождения.push({ имя, что: `размер ${a.width}×${a.height} → ${b.width}×${b.height}` });
      continue;
    }
    const diff = new PNG({ width: a.width, height: a.height });
    const пикселей = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1 });
    /* Порог на сглаживание: разные прогоны дают единицы пикселей по краям
       глифов и теней. Это не изменение вёрстки, но и молчать о нём нельзя —
       выносим отдельным списком. */
    const ПОРОГ_ШУМА = 40;
    if (пикселей > 0) {
      await writeFile(path.join(ПАПКА.diff, имя), PNG.sync.write(diff));
      const доля = ((пикселей / (a.width * a.height)) * 100).toFixed(2);
      const запись = { имя, что: `${пикселей} пикселей (${доля}%)`, файл: path.join('tools/shots/diff', имя) };
      if (пикселей <= ПОРОГ_ШУМА) шум.push(запись); else расхождения.push(запись);
    } else совпало++;
  }

  if (шум.length) {
    console.log(`\nмелкий шум сглаживания (${шум.length}): ` + шум.map((s) => s.имя).join(', '));
  }
  console.log(`\nсовпало: ${совпало} из ${эталоны.length}`);
  if (!расхождения.length) { console.log('значимых визуальных изменений нет'); return 0; }
  console.log(`\nразошлось: ${расхождения.length}`);
  for (const р of расхождения) {
    console.log(`  ${р.имя} — ${р.что}${р.файл ? `\n    карта различий: ${р.файл}` : ''}`);
  }
  return расхождения.length;
}

/* ── Запуск ──────────────────────────────────────────────────────────────── */
if (режим === 'diff') {
  const n = await сравнить();
  process.exit(n ? 1 : 0);
} else {
  await снять();
  if (режим === 'baseline') console.log('\nэталоны обновлены — теперь любое расхождение будет видно');
}
