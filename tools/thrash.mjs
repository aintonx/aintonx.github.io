/**
 * СКОЛЬКО РАЗ ФОРМА ЗАСТАВЛЯЕТ БРАУЗЕР ПЕРЕСЧИТАТЬ РАСКЛАДКУ
 * ---------------------------------------------------------------------------
 * Настоящую iOS-клавиатуру здесь не воспроизвести — в headless-браузере её
 * нет. Но механизмы, которые на неё реагируют, слушают blur/focusout и
 * beforeinput, а не iOS. Значит цикл «фокус → уход фокуса» их запускает, и
 * можно ПОСЧИТАТЬ, сколько записей в раскладку они при этом делают.
 *
 * Это измеримая величина вместо догадок о рывках: каждая запись overflowY,
 * scrollTop или window.scrollTo в момент, когда система анимирует клавиатуру,
 * — это принудительный пересчёт, то есть потенциальный видимый рывок.
 *
 *   node tools/thrash.mjs
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
const ctx = await br.newContext({
  viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3,
});
const page = await ctx.newPage();
await изолировать(page, база);
await page.goto(база, { waitUntil: 'domcontentloaded' });
await подготовить(page);
await ZONES.find((z) => z.id === 'checkout-2').open(page);

/* Перехват ставим ДО касания поля: часть записей случается уже на фокусе. */
await page.evaluate(() => {
  const panel = document.getElementById('chkModalPanel');
  window.__записи = [];
  window.__t0 = performance.now();
  const пиши = (что) => window.__записи.push({ что, t: Math.round(performance.now() - window.__t0) });

  /* Стили ловим наблюдателем, а не подменой свойства: у CSSStyleDeclaration
     в Chromium нет СОБСТВЕННОГО дескриптора overflowY — подмена молча не
     ставилась, и первая версия этой пробы показывала честный ноль на пустом
     месте. Наблюдатель по атрибуту style ловит любую запись. */
  let прошлыйStyle = panel.getAttribute('style') || '';
  new MutationObserver(() => {
    const s = panel.getAttribute('style') || '';
    if (s !== прошлыйStyle) { пиши('style: «' + прошлыйStyle + '» → «' + s + '»'); прошлыйStyle = s; }
  }).observe(panel, { attributes: true, attributeFilter: ['style'] });

  /* Заодно считаем, сколько раз вообще срабатывают обработчики ухода фокуса */
  document.addEventListener('focusout', () => пиши('focusout'), true);
  document.addEventListener('blur', () => пиши('blur(capture)'), true);

  const ed = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  Object.defineProperty(panel, 'scrollTop', {
    set(v) { пиши('scrollTop=' + Math.round(v)); ed.set.call(this, v); },
    get() { return ed.get.call(this); }, configurable: true,
  });
  const st = window.scrollTo.bind(window);
  window.scrollTo = function (...a) { пиши('window.scrollTo'); return st(...a); };
});

/* Настоящий тап, а не focus(): часть обработчиков завязана на touchstart. */
await page.locator('#chkPhone').tap();
await page.waitForTimeout(200);
const фокусНа = await page.evaluate(() => document.activeElement && document.activeElement.id);

/* Имитируем автоподстановку контакта: пачка insertText + перенос фокуса —
   ровно та сигнатура, по которой срабатывает заморозка прокрутки. */
await page.evaluate(() => {
  const p = document.getElementById('chkPhone');
  for (let i = 0; i < 4; i++) {
    p.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: '9', bubbles: true }));
    p.value += '9';
    p.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: '9', bubbles: true }));
  }
});
await page.waitForTimeout(250);
const послеАвтозаполнения = await page.evaluate(() => window.__записи.length);

/* Прокрутка формы во время набора НЕ должна закрывать клавиатуру.
   Раньше свайп больше 22px принудительно снимал фокус: пользователь мотал
   форму к следующему полю, а клавиатура захлопывалась и лист менял высоту. */
const панель = page.locator('#chkModalPanel');
const короб = await панель.boundingBox();
await page.touchscreen.tap(короб.x + короб.width / 2, короб.y + короб.height / 2).catch(() => {});
await page.locator('#chkPhone').tap();
await page.waitForTimeout(150);
await панель.hover({ position: { x: короб.width / 2, y: короб.height / 2 } }).catch(() => {});
await page.evaluate(() => {
  const p = document.getElementById('chkModalPanel');
  const точка = (y) => ({ clientX: 100, clientY: y, identifier: 1, target: p });
  const событие = (тип, y) => new TouchEvent(тип, {
    bubbles: true, cancelable: true,
    touches: тип === 'touchend' ? [] : [new Touch(точка(y))],
    changedTouches: [new Touch(точка(y))],
  });
  p.dispatchEvent(событие('touchstart', 400));
  p.dispatchEvent(событие('touchmove', 320));   // свайп 80px — заметно больше порога 22
  p.dispatchEvent(событие('touchend', 320));
});
await page.waitForTimeout(120);
const фокусПослеСвайпа = await page.evaluate(() => document.activeElement && document.activeElement.id);

/* КОНТРОЛЬ: тот же свайп с отключённым владельцем. Нужен, чтобы отличить
   «правка сработала» от «свайп и так ничего не делал». */
await page.locator('#chkPhone').tap();
await page.waitForTimeout(150);
const фокусПослеСвайпаБезВладельца = await page.evaluate(() => {
  const был = window.__ewKbdOwned;
  window.__ewKbdOwned = () => false;
  const p = document.getElementById('chkModalPanel');
  const точка = (y) => ({ clientX: 100, clientY: y, identifier: 1, target: p });
  const событие = (тип, y) => new TouchEvent(тип, {
    bubbles: true, cancelable: true,
    touches: тип === 'touchend' ? [] : [new Touch(точка(y))],
    changedTouches: [new Touch(точка(y))],
  });
  p.dispatchEvent(событие('touchstart', 400));
  p.dispatchEvent(событие('touchmove', 320));
  p.dispatchEvent(событие('touchend', 320));
  window.__ewKbdOwned = был;
  return document.activeElement && document.activeElement.id;
});

await page.evaluate(() => document.getElementById('chkPhone').blur());
await page.waitForTimeout(1500);

const итог = await page.evaluate(() => ({ всего: window.__записи.length, записи: window.__записи }));
console.log(JSON.stringify({
  фокусНа, послеАвтозаполнения,
  фокусПослеСвайпа,
  фокусПослеСвайпаБезВладельца,
  свайпНеЗакрылКлавиатуру: фокусПослеСвайпа === "chkPhone",
  контрольСвайпЗакрывал: фокусПослеСвайпаБезВладельца !== "chkPhone",
  ...итог,
}, null, 2));

await br.close();
srv.close();
