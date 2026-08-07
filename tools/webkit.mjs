/**
 * ПРОВЕРКА В НАСТОЯЩЕМ WEBKIT
 * ---------------------------------------------------------------------------
 * Часть дефектов сайта живёт ТОЛЬКО в движке Safari, и Chromium показывает по
 * ним честный ноль. Так было дважды подряд: крестик в чек-боксе, который
 * «съезжает» на телефоне и стоит ровно на настольном браузере, и осциллограф,
 * который в Chromium двигался, а в Safari оживал только при прокрутке.
 * Замер в Chromium в таких случаях не доказывает ничего — он лишь создаёт
 * ложную уверенность.
 *
 * Здесь тот же сайт открывается в WebKit из поставки Playwright. Это тот же
 * движок, что в Safari, поэтому расхождения воспроизводятся и становятся
 * числом.
 *
 *   node tools/webkit.mjs           # обе пробы в WebKit и в Chromium
 *   node tools/webkit.mjs webkit    # только WebKit
 */
import { webkit, chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { изолировать, подготовить, вишУжеВиден } from './stub.mjs';

const КОРЕНЬ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/* Контрольный прогон: PAGE=<путь> подсовывает другую версию страницы вместо
   рабочей. Имя переменной ЛАТИНИЦЕЙ — zsh не принимает кириллицу в именах
   переменных окружения и падает ещё до запуска node. Нужен, чтобы отличить «правка помогла» от «дефекта и не было» —
   без контроля проба на исправленном коде доказывает ровно ничего.
   Рабочее дерево при этом не трогаем: никаких stash и переключений. */
const СТРАНИЦА = process.env.PAGE ? path.resolve(process.env.PAGE) : path.join(КОРЕНЬ, 'index.html');
const srv = createServer(async (q, r) => {
  const u = decodeURIComponent(q.url.split('?')[0]);
  try {
    const b = await readFile(u === '/' ? СТРАНИЦА : path.join(КОРЕНЬ, u.slice(1)));
    r.writeHead(200, {
      'Content-Type': u.endsWith('.css') ? 'text/css' : u.endsWith('.js') ? 'text/javascript' : 'text/html',
      'Cache-Control': 'no-store',
    });
    r.end(b);
  } catch { r.writeHead(404).end(); }
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const база = `http://127.0.0.1:${srv.address().port}/`;

/** Сколько пикселей отличается между двумя снимками одного узла. */
function различий(a, b) {
  const x = PNG.sync.read(a), y = PNG.sync.read(b);
  if (x.width !== y.width || x.height !== y.height) return -1;
  let n = 0;
  for (let i = 0; i < x.data.length; i += 4) {
    if (x.data[i] !== y.data[i] || x.data[i + 1] !== y.data[i + 1] || x.data[i + 2] !== y.data[i + 2]) n++;
  }
  return n;
}

async function проба(движок, имя) {
  const br = await движок.launch();
  const ctx = await br.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: имя === 'chromium' });
  const page = await ctx.newPage();
  await изолировать(page, база);
  await вишУжеВиден(page);
  await page.goto(база, { waitUntil: 'load' });
  await подготовить(page);
  await page.locator('#echo').scrollIntoViewIfNeeded();
  await page.waitForTimeout(1400);

  /* ── ЛУЧ ИДЁТ САМ ────────────────────────────────────────────────────
     Ключевое условие пробы: страницу НЕ трогаем. Ни прокрутки, ни кликов,
     ни движения мыши — только ожидание. Прежний дефект как раз в том и
     состоял, что картинка обновлялась лишь когда её пачкало чужое
     действие: без этого запрета проба прошла бы на сломанном коде. */
  const луч = page.locator('#echoBeam');
  const кадры = [];
  for (let i = 0; i < 5; i++) {
    кадры.push(await луч.screenshot());
    await page.waitForTimeout(220);
  }
  const шаги = [];
  for (let i = 1; i < кадры.length; i++) шаги.push(различий(кадры[i - 1], кадры[i]));

  /* ── КРЕСТИК В ЧЕК-БОКСЕ ─────────────────────────────────────────────
     Меряем смещение центра знака от центра коробки: до отметки, сразу
     после клика (середина перехода) и после. Любое ненулевое значение —
     тот самый съезд. */
  const чекбоксы = await page.evaluate(async () => {
    const п = (мс) => new Promise((r) => setTimeout(r, мс));
    const ц = (el) => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
    const д = (a, b) => [+(a[0] - b[0]).toFixed(2), +(a[1] - b[1]).toFixed(2)];

    /* Видимые чек-боксы живут на третьем шаге формы Эхо — до него надо
       дойти. Проба на скрытых узлах возвращала пустой список и молча
       ничего не проверяла. */
    const ta = document.getElementById('echoTextInput');
    if (ta) { ta.value = 'проба'; ta.dispatchEvent(new Event('input', { bubbles: true })); }
    window.openEchoOrder(); await п(900);
    const форма = document.querySelector('#echoOrderBody form');
    if (!форма) return [{ ошибка: 'форма Эхо не собралась' }];
    форма.querySelector('.chk-nav-next').click(); await п(900);
    const имя = document.getElementById('echoOrderName');
    if (имя) { имя.value = 'Иван'; имя.dispatchEvent(new Event('input', { bubbles: true })); }
    const коробки2 = [...форма.querySelectorAll('.chk-step')];
    коробки2[1].querySelector('.chk-nav-next').click(); await п(1000);

    const итог = [];
    for (const box of коробки2[2].querySelectorAll('.chk-consent-box, .echo-reveal-check')) {
      const знак = box.querySelector('.cb-mark');
      const вход = box.previousElementSibling;
      if (!знак || !box.getBoundingClientRect().width) continue;
      const до = д(ц(знак), ц(box));
      вход.click(); await п(40);
      const вХоде = д(ц(знак), ц(box));
      await п(320);
      const после = д(ц(знак), ц(box));
      итог.push({
        вход: вход.id || '—', до, вХоде, после,
        ровно: !до[0] && !до[1] && !вХоде[0] && !вХоде[1] && !после[0] && !после[1],
        transform: getComputedStyle(знак).transform,
        знак: getComputedStyle(знак).width + '×' + getComputedStyle(знак).height,
        коробка: getComputedStyle(box).width + '×' + getComputedStyle(box).height,
      });
    }
    return итог;
  });

  await br.close();
  return {
    движок: имя,
    лучБезКасанийСтраницы: { различияМеждуКадрами: шаги, идёт: шаги.every((n) => n > 200) },
    чекбоксы,
  };
}

const какие = process.argv[2];
const вывод = [];
if (какие !== 'chromium') вывод.push(await проба(webkit, 'webkit'));
if (какие !== 'webkit') вывод.push(await проба(chromium, 'chromium'));
console.log(JSON.stringify(вывод, null, 2));
srv.close();
