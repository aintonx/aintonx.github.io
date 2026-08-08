/**
 * ОСЕДАНИЕ РАСКЛАДКИ — что переезжает, пока страница ещё грузится.
 * ---------------------------------------------------------------------------
 * Сайт — один файл в 1.9 МБ. Браузер рисует первый экран задолго до того, как
 * доедет хвост документа, и правило, лежащее в конце, применяется уже ПОСЛЕ
 * первой отрисовки. Владелец видит это как «текст прыгает при загрузке».
 * Обычный стенд такое не ловит: он снимает кадр, когда всё уже осело.
 *
 * Проба отдаёт файл кусками с паузами, снимает срезы по ходу доезда и
 * сравнивает каждый с итоговым состоянием. Расхождение = элемент переехал
 * на глазах у посетителя.
 *
 *   node tools/settle.mjs                      # текущая версия, мобила
 *   SIZE=desktop node tools/settle.mjs         # десктоп
 *   PAGE=/tmp/старый.html node tools/settle.mjs   # КОНТРОЛЬ против старой
 *
 * Контроль обязателен: зелёный прогон на исправленном коде ничего не значит,
 * пока та же проба не поймала дефект на старой версии.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const КОРЕНЬ = path.resolve(new URL('..', import.meta.url).pathname);
const СТРАНИЦА = process.env.PAGE || path.join(КОРЕНЬ, 'index.html');
const ТИПЫ = { '.html':'text/html;charset=utf-8','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.woff2':'font/woff2','.json':'application/json','.mp4':'video/mp4' };
const КУСОК = Number(process.env.CHUNK || 180000);
const ПАУЗА = Number(process.env.CHUNK_MS || 90);

const сервер = createServer(async (req, res) => {
  let u = decodeURIComponent(req.url.split('?')[0]);
  if (u === '/') u = '/index.html';
  let тело;
  try { тело = await readFile(u === '/index.html' ? СТРАНИЦА : path.join(КОРЕНЬ, u)); }
  catch { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': ТИПЫ[path.extname(u)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  if (u !== '/index.html') { res.end(тело); return; }
  let i = 0;
  const лить = () => { if (i >= тело.length) { res.end(); return; }
    res.write(тело.subarray(i, i + КУСОК)); i += КУСОК; setTimeout(лить, ПАУЗА); };
  лить();
});
await new Promise((r) => сервер.listen(4333, r));

/* Первый экран отслеживается покадрово: только он виден в момент загрузки,
   и только его переезд владелец может заметить. */
const СЛЕД = () => {
  window.__след = []; let пред = null;
  const тик = () => {
    const t = document.querySelector('.hero-title'), l = document.querySelector('.hero-title-line'),
          s = document.querySelector('.hero-sub'), c = document.querySelector('.hero-cta');
    if (t && l && s) {
      const с = { t: Math.round(performance.now()),
        трекинг: getComputedStyle(t).letterSpacing,
        строка: Math.round(l.getBoundingClientRect().width),
        лидВысота: Math.round(s.getBoundingClientRect().height),
        верхГероя: Math.round(document.querySelector('.hero').getBoundingClientRect().top),
        кнопкиY: c ? Math.round(c.getBoundingClientRect().top) : -1 };
      const к = JSON.stringify(с).replace(/"t":\d+,/, '');
      if (к !== пред) { пред = к; window.__след.push(с); }
    }
    requestAnimationFrame(тик);
  };
  requestAnimationFrame(тик);
};

/* Остальная страница — срезами: узлы ниже первого экрана тоже переезжают,
   но это заметно только если посетитель успел до них долистать. */
const СНЯТЬ = () => {
  const цели = document.querySelectorAll('h1,h2,h3,.hero-title,.mname,.pname,.aw-name,.faq-q,.aw-title,.about-title,.faq-title,.cat-h2,.relic-title,.hero-sub,.faq-unlock-action');
  const из = [];
  цели.forEach((el, i) => {
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    /* Ключ — личность узла, а не номер: к концу загрузки узлов больше,
       индексы съезжают, и сравниваются разные элементы. */
    из.push({ i, ключ: el.tagName + '|' + (typeof el.className === 'string' ? el.className.trim() : '') + '|' + (el.textContent || '').trim().slice(0, 40),
      кто: el.tagName + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/)[0] : ''),
      текст: (el.textContent || '').trim().slice(0, 26),
      трекинг: cs.letterSpacing, кегль: cs.fontSize, вес: cs.fontWeight,
      семья: cs.fontFamily.split(',')[0].replace(/["']/g, ''), высотаСтроки: cs.lineHeight,
      ш: Math.round(r.width), в: Math.round(r.height) });
  });
  return из;
};

const brow = await chromium.launch();
const ctx = process.env.SIZE === 'desktop'
  ? await brow.newContext({ viewport: { width: 1440, height: 900 } })
  : await brow.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.addInitScript(СЛЕД);
page.goto('http://127.0.0.1:4333/index.html').catch(() => {});

const срезы = [];
for (const мс of [400, 300, 300, 400, 500, 600]) {
  await page.waitForTimeout(мс);
  try { срезы.push(await page.evaluate(СНЯТЬ)); } catch (_) {}
}
await page.waitForTimeout(12000);
const поздно = await page.evaluate(СНЯТЬ);
const след = await page.evaluate(() => window.__след);

console.log(`\n══ ${path.basename(СТРАНИЦА)} · ${process.env.SIZE || 'mobile'} ══\n`);
console.log('ПЕРВЫЙ ЭКРАН');
for (const з of след) console.log('  ', JSON.stringify(з));
const п = след[0] || {}, к = след[след.length - 1] || {};
const дрожь = ['трекинг', 'строка', 'лидВысота', 'верхГероя', 'кнопкиY'].filter((кл) => п[кл] !== к[кл]);
console.log(дрожь.length ? `  ⚠ переезжает по: ${дрожь.join(', ')}` : '  ✓ не двигался за всю загрузку');

const карта = new Map(поздно.map((z) => [z.ключ, z]));
const виден = new Set(); const рано = [];
for (const с of срезы) for (const у of с) if (!виден.has(у.ключ)) { виден.add(у.ключ); рано.push(у); }
let счёт = 0; const строки = [];
for (const р of рано) {
  const z = карта.get(р.ключ); if (!z) continue;
  const разн = [];
  for (const кл of ['трекинг', 'кегль', 'вес', 'семья', 'высотаСтроки']) if (р[кл] !== z[кл]) разн.push(`${кл}: ${р[кл]} → ${z[кл]}`);
  if (Math.abs(р.ш - z.ш) > 1) разн.push(`ширина: ${р.ш} → ${z.ш}`);
  if (Math.abs(р.в - z.в) > 1) разн.push(`высота: ${р.в} → ${z.в}`);
  if (разн.length) { счёт++; строки.push(`⚠ ${р.кто} «${р.текст}»\n    ${разн.join('\n    ')}`); }
}
console.log('\nВСЯ СТРАНИЦА');
console.log(строки.join('\n') || '  (ничего)');
console.log(`\nузлов, меняющих облик по ходу загрузки: ${счёт} из ${рано.length}`);
await brow.close(); сервер.close();
