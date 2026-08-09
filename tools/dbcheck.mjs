/* ═══════════════════════════════════════════════════════════════════
   СТЕНД ЗАПИСЕЙ В БАЗУ

   Проверяет то, что нельзя проверить глазами: доходит ли заполненная
   форма до сервера, в каком виде, и не показывает ли сайт «принято»,
   когда сервер отказал.

   Настоящую облачную функцию стенд не трогает. Вместо неё поднимается
   подставной сервер на 127.0.0.1, а запросы сайта к functions.yandexcloud.net
   перехватываются и заворачиваются на него. Поэтому прогон безопасен:
   ни одной строки в боевую базу не попадёт.

   Запуск:  npm run dbcheck
   ═══════════════════════════════════════════════════════════════════ */

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const КОРЕНЬ = '/Users/naboy/Documents/GitHub/aintonx.github.io';
const ТИПЫ = {'.html':'text/html;charset=utf-8','.css':'text/css','.js':'text/javascript',
  '.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp',
  '.woff2':'font/woff2','.json':'application/json','.mp4':'video/mp4'};

/* Что «база» приняла за прогон */
const принято = [];
/* Все перехваченные обращения — для разбора, если что-то не сошлось */
const все = [];
/* Как подставной сервер должен ответить: ok | fail */
let ответ = 'ok';

const сайт = createServer(async (rq, rs) => {
  let u = decodeURIComponent(rq.url.split('?')[0]);
  if (u === '/') u = '/index.html';
  let т;
  try { т = await readFile(path.join(КОРЕНЬ, u)); }
  catch { rs.writeHead(404); rs.end(); return; }
  rs.writeHead(200, {'Content-Type': ТИПЫ[path.extname(u)] || 'application/octet-stream', 'Cache-Control':'no-store'});
  rs.end(т);
});
await new Promise(r => сайт.listen(4500, r));

const b = await chromium.launch();
const ctx = await b.newContext({ viewport:{width:1440, height:900} });

/* Перехват: запрос до облака не доходит — отвечаем на него здесь же и
   записываем, что именно сайт собирался отправить. Боевая база и боевая
   функция при этом не затрагиваются вовсе. */
await ctx.route('**functions.yandexcloud.net/**', async (route) => {
  const req = route.request();
  const маршрут = new URL(req.url()).searchParams.get('route') || '';
  let данные = null;
  try { данные = JSON.parse(req.postData() || '{}'); } catch { данные = {сырое: req.postData()}; }
  все.push(req.method() + ' ' + маршрут + (req.postData() ? ' [есть тело]' : ''));
  if (/condensation|return|payment|reservation|echo|order/.test(маршрут)) принято.push({ маршрут, данные });
  /* Отвечаем по контракту каждого маршрута, иначе сайт справедливо
     отбракует ответ и до записи дело не дойдёт. Защитные маршруты
     отвечают «всё чисто» всегда — иначе форма не пройдёт проверку. */
  let тело;
  if (/antiabuse/.test(маршрут)) {
    тело = {ok:true, antiabuse:{ok:true}, captcha_required:false, blocked:false};
  } else if (/smartcaptcha/.test(маршрут)) {
    тело = {ok:true, captcha:{ok:true, status:'ok'}};
  } else if (ответ === 'fail') {
    тело = {ok:false, error:{code:'INTERNAL_ERROR', message:'Проверка отказа.'}};
  } else {
    тело = {ok:true, request_id:'test_' + маршрут.replace(/\W/g,'_'), status:'new'};
  }
  await route.fulfill({
    status: (ответ === 'fail' && !/antiabuse|smartcaptcha/.test(маршрут)) ? 500 : 200,
    contentType: 'application/json',
    headers: {'Access-Control-Allow-Origin':'*'},
    body: JSON.stringify(тело)
  });
});

const p = await ctx.newPage();
const ошибки = [];
p.on('console', m => { if (m.type() === 'error') ошибки.push(m.text().slice(0, 100)); });
await p.goto('http://127.0.0.1:4500/index.html', { waitUntil: 'load' });
await p.waitForTimeout(2600);

const строка = (т) => '  ' + т;
let провалов = 0;
const проверка = (имя, условие, факт) => {
  console.log(строка((условие ? '✓ ' : '✗ ') + имя.padEnd(52) + (факт === undefined ? '' : факт)));
  if (!условие) провалов++;
};

const заполнить = async (предмет, почта) => p.evaluate(({предмет, почта}) => {
  /* Форма конденсации — переписка, а не обычная форма: согласие лежит в
     <template id="condAgreeTpl"> и попадает в разметку репликой, когда
     человек доходит до этого шага. Воспроизводим ровно это состояние. */
  const t = document.getElementById('condAgreeTpl');
  if (t && !document.getElementById('preorderConsent')) {
    document.querySelector('.cond-glass, #preorderFormBlock, body').appendChild(t.content.cloneNode(true));
  }
  document.getElementById('preorderItem').value = предмет;
  document.getElementById('preorderContact').value = почта;
  const c = document.getElementById('preorderConsent');
  if (c) { c.checked = true; c.dispatchEvent(new Event('change', {bubbles:true})); }
  if (typeof validatePreorderForm === 'function') validatePreorderForm();
  return !!c;
}, {предмет, почта});

/* ── 1. Режим и флаги ────────────────────────────────────────────── */
console.log('\n══ 1. РЕЖИМ И РАЗРЕШЕНИЯ');
const режим = await p.evaluate(() => ({
  режим: _apGetApiMode(),
  записиРазрешены: _apBusinessApiAllowed(),
  конденсация: _apRoutePlan('condensationCreate').enabled,
  возврат: _apRoutePlan('returnCreate').enabled,
  платёж: _apRoutePlan('paymentCreate').enabled,
  резерв: _apRoutePlan('reservationCreate').enabled,
  эхо: _apRoutePlan('echoCreate').enabled
}));
проверка('режим production', режим.режим === 'production', режим.режим);
проверка('записи разрешены', режим.записиРазрешены === true);
проверка('маршрут заявки на конденсацию открыт', режим.конденсация === true);
проверка('маршрут заявки на возврат открыт', режим.возврат === true);
проверка('платёжный маршрут ЗАКРЫТ', режим.платёж === false);
проверка('резерв реликвии ЗАКРЫТ', режим.резерв === false);
проверка('Эхо ЗАКРЫТО', режим.эхо === false);

/* ── 2. Платёжный маршрут отказывает даже при прямом вызове ──────── */
console.log('\n══ 2. ПРЕДОХРАНИТЕЛЬ ПЛАТЕЖЕЙ');
const попытка = await p.evaluate(async () => {
  try { await aperturaFetch('paymentCreate', {flow:'test', amount:1, currency:'RUB'}); return 'ПРОШЛО'; }
  catch (e) { return e && e.code ? e.code : String(e && e.message || e); }
});
проверка('прямой вызов оплаты отклонён', попытка === 'ROUTE_DISABLED', попытка);
проверка('в «базу» ничего не легло от оплаты', принято.length === 0, 'записей: ' + принято.length);

/* ── 3. Заявка на конденсацию доходит до сервера ─────────────────── */
console.log('\n══ 3. ЗАЯВКА НА КОНДЕНСАЦИЮ');
const естьГалочка = await заполнить('Плюшевый заяц из детства', 'test@echoworld.space');
проверка('галочка согласия появилась в разметке', естьГалочка === true);
await p.evaluate(() => submitPreorder());
await p.waitForTimeout(2500);

const заявка = принято.find(з => з.маршрут.includes('condensation'));
проверка('запрос ушёл на сервер', !!заявка, заявка ? заявка.маршрут : 'не ушёл');
if (заявка) {
  const д = заявка.данные;
  проверка('предмет передан', д.item === 'Плюшевый заяц из детства', д.item);
  проверка('почта передана', д.email === 'test@echoworld.space', д.email);
  проверка('согласие передано', д.consent === true, String(д.consent));
  проверка('версия схемы указана', д.schema === 'echoworld.condensation.request.v1', д.schema);
  проверка('черновик для сверки есть', !!д.requestDraftId, д.requestDraftId);
}

/* ── 4. Отказ сервера не должен показывать успех ─────────────────── */
console.log('\n══ 4. ПОВЕДЕНИЕ ПРИ ОТКАЗЕ СЕРВЕРА');
ответ = 'fail';
const былоЗаписей = принято.length;
await p.reload({ waitUntil: 'load' });
await p.waitForTimeout(2600);
await заполнить('Проверка отказа', 'fail@echoworld.space');
await p.evaluate(() => submitPreorder());
await p.waitForTimeout(2500);
const приОтказе = await p.evaluate(() => ({
  окноОшибки: !!document.querySelector('.ap-console-overlay.open'),
  кнопкаЖива: !(document.getElementById('preorderBtn') || {}).disabled
}));
проверка('запрос всё же был отправлен', принято.length > былоЗаписей);
проверка('показано окно ошибки, а не успех', приОтказе.окноОшибки === true);
проверка('кнопка снова доступна', приОтказе.кнопкаЖива === true);

/* ── 5. Заявка на возврат ────────────────────────────────────────── */
console.log('\n══ 5. ЗАЯВКА НА ВОЗВРАТ');
ответ = 'ok';
await p.reload({ waitUntil: 'load' });
await p.waitForTimeout(2600);
const былоДоВозврата = принято.length;
await p.evaluate(() => {
  openReturnModal();
  const з = (ид, зн) => { const э = document.getElementById(ид); if (э) { э.value = зн; э.dispatchEvent(new Event('input', {bubbles:true})); } };
  з('returnName', 'Антон');
  з('returnEmail', 'return@echoworld.space');
  з('returnArtifactId', 'ECH-0001');
  з('returnOrderId', 'EW-2026-0007');
  з('returnReason', 'Реликвия пришла с трещиной на подставке.');
  const c = document.getElementById('returnConsent');
  if (c) { c.checked = true; c.dispatchEvent(new Event('change', {bubbles:true})); }
});
await p.waitForTimeout(400);
await p.evaluate(() => submitReturnForm(new Event('submit')));
await p.waitForTimeout(2500);

const возврат = принято.slice(былоДоВозврата).find(з => з.маршрут.includes('return'));
проверка('запрос ушёл на сервер', !!возврат, возврат ? возврат.маршрут : 'не ушёл');
if (возврат) {
  const д = возврат.данные;
  проверка('имя передано', д.name === 'Антон', д.name);
  проверка('почта передана', д.contact && д.contact.email === 'return@echoworld.space', д.contact && д.contact.email);
  проверка('артикул передан', д.artifact_id === 'ECH-0001', д.artifact_id);
  проверка('номер заказа передан', д.order_id === 'EW-2026-0007', д.order_id);
  проверка('причина передана', (д.description || '').startsWith('Реликвия пришла'), (д.description || '').slice(0, 24));
  проверка('согласие передано', д.consent === true, String(д.consent));
  проверка('версия схемы указана', д.schema === 'echoworld.return.request.v1', д.schema);
}

console.log('\n══ ИТОГ');
console.log(строка('записей принято «базой»: ' + принято.length));
принято.forEach(з => console.log(строка('  · ' + з.маршрут)));
console.log(строка('всего обращений к облаку перехвачено: ' + все.length));
все.forEach(о => console.log(строка('  · ' + о)));
console.log(строка('ошибок в консоли браузера: ' + ошибки.length));
ошибки.slice(0,3).forEach(о => console.log(строка('  · ' + о)));
console.log(строка(провалов === 0 ? '\n  ВСЁ СОШЛОСЬ' : '\n  ПРОВАЛОВ: ' + провалов));

await b.close(); сайт.close();
process.exit(провалов === 0 ? 0 : 1);
