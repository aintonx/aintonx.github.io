/**
 * ПЛАВНОСТЬ БАРАБАНА АТРИБУТОВ
 * ---------------------------------------------------------------------------
 * Считает, сколько кадров барабан пропускает: от вызова launchAttrDrum до
 * полной остановки замеряются промежутки между кадрами. Кадр длиннее 32мс —
 * пропущенный (при 60 к/с норма 16.7мс).
 *
 * Нужен, чтобы «работает с тормозами» стало числом: сколько именно кадров
 * потеряно, где — на появлении секции или на вращении.
 *
 *   node tools/drum.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZONES } from './zones.mjs';
import { изолировать, подготовить } from './stub.mjs';

const КОРЕНЬ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srv = createServer(async (req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  try {
    const b = await readFile(path.join(КОРЕНЬ, u === '/' ? 'index.html' : u.slice(1)));
    res.writeHead(200, {
      'Content-Type': u.endsWith('.css') ? 'text/css' : u.endsWith('.js') ? 'text/javascript' : 'text/html',
      'Cache-Control': 'no-store',
    });
    res.end(b);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const база = `http://127.0.0.1:${srv.address().port}/`;

const br = await chromium.launch();
/* Замедляем процессор: на настольной машине барабан не тормозит ни у кого,
   а жалоба пришла с телефона. Множитель 4 приближает к мобильному классу. */
const ctx = await br.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

await изолировать(page, база);
await page.goto(база, { waitUntil: 'domcontentloaded' });
await подготовить(page);
await ZONES.find((z) => z.id === 'checkout-3').open(page);

const итог = await page.evaluate(async () => {
  const кадры = [];
  let идём = true;
  let прошлый = performance.now();
  (function тик(t) {
    кадры.push(t - прошлый);
    прошлый = t;
    if (идём) requestAnimationFrame(тик);
  })(performance.now());

  const t0 = performance.now();
  window.launchAttrDrum();
  await new Promise((r) => setTimeout(r, 6000));
  идём = false;

  const узлов = document.querySelectorAll('#chkBody .attr-drum-item').length;
  const пропущено = кадры.filter((d) => d > 32).length;
  const тяжёлые = кадры.filter((d) => d > 50).length;
  const худший = Math.round(Math.max(...кадры));
  /* Раскладываем кадры по фазам: появление секции (0–800мс), вращение
     (до 2200мс — момент остановки первой колонки), остановка колонок
     (2200–3800мс), покой. Так видно, ЧТО именно тормозит. */
  const фазы = { появление: [0, 800], вращение: [800, 2200], остановка: [2200, 4300], покой: [4300, 1e9] };
  const поФазам = {};
  for (const имя of Object.keys(фазы)) поФазам[имя] = { кадров: 0, пропущено: 0, худший: 0 };
  let часы = 0;
  for (const d of кадры) {
    часы += d;
    for (const [имя, [a, b]] of Object.entries(фазы)) {
      if (часы >= a && часы < b) {
        поФазам[имя].кадров++;
        if (d > 32) поФазам[имя].пропущено++;
        if (d > поФазам[имя].худший) поФазам[имя].худший = Math.round(d);
        break;
      }
    }
  }

  return {
    узловВЛентах: узлов,
    кадровВсего: кадры.length,
    пропущено,
    тяжёлыхБольше50мс: тяжёлые,
    худшийКадрМс: худший,
    среднийМс: +(кадры.reduce((a, b) => a + b, 0) / кадры.length).toFixed(1),
    поФазам,
    выбрано: document.querySelectorAll('#chkBody .attr-drum-item.selected').length,
    времяДоКонцаМс: Math.round(performance.now() - t0),
  };
});

console.log(JSON.stringify(итог, null, 2));
await br.close();
srv.close();
