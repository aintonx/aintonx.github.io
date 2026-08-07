/**
 * РЕВИЗОР ЯЗЫКА «ЛИНЗА»
 * ---------------------------------------------------------------------------
 * Проверяет ВЫЧИСЛЕННЫЕ стили в настоящем браузере, а не текст CSS.
 *
 * Почему так. Первая версия читала исходник и утонула в ложных срабатываниях:
 * в файле десятки слоёв-перекрытий, и правило `background: var(--red)` может
 * быть трижды перекрыто ниже. Статический разбор видит правило, но не видит,
 * что победило в каскаде, — и ругается на то, чего на экране нет. Ревизор,
 * который врёт, хуже отсутствующего: к нему перестают прислушиваться.
 *
 * Здесь наоборот: открываем зоны сайта и смотрим итоговые значения на живых
 * узлах. Что нашли — то пользователь и видит.
 *
 *   node tools/lens.mjs           отчёт
 *   node tools/lens.mjs --strict  выйти с ошибкой, если есть нарушения «важно»
 *
 * КАЖДАЯ ПРОВЕРКА РОДИЛАСЬ ИЗ РЕАЛЬНОЙ ПОЛОМКИ — сказано, из какой.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZONES, РАЗМЕРЫ } from './zones.mjs';
import { изолировать, подготовить, вишУжеВиден } from './stub.mjs';

const КОРЕНЬ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const СТРОГО = process.argv.includes('--strict');

/* Смотрим зоны, где живёт интерфейс: страница целиком плюс ключевые окна. */
const СМОТРИМ = ['catalog', 'relic', 'echo', 'donate', 'card', 'cart', 'checkout-3', 'echo-order'];

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

/** Проверки выполняются в странице: им нужен доступ к вычисленным стилям. */
const ПРОВЕРКИ = () => {
  const из = [];
  const имя = (el) => (el.id ? '#' + el.id : '') +
    (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '') ||
    el.tagName.toLowerCase();
  const виден = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && +s.opacity > 0.02;
  };
  const красный = (c) => {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c || '');
    if (!m) return false;
    const [r, g, b] = [+m[1], +m[2], +m[3]];
    if (/rgba\([^)]*,\s*0(\.0+)?\)$/.test(c)) return false;   // полностью прозрачный
    return r > 140 && g < 90 && b < 90;                        // красная зона палитры
  };

  /* 1. КРАСНЫЙ НА ДЕЙСТВИИ.
     Паспорт: красный означает только тревогу и запрет; главное действие —
     тёплое, подтверждённое — циановое.
     Откуда: кнопка конденсации пульсировала красным, чип каталога был
     красным вместо тёплого. */
  const ТРЕВОГА = /error|invalid|miss|danger|alert|denied|lock|fail|warn|stop|delete|remove|close|del-/i;
  document.querySelectorAll('button, a.cta-primary, a.cta-secondary, [role="button"], .mbtn, .pbtn, .chk-nav-btn').forEach((el) => {
    if (!виден(el)) return;
    const п = имя(el);
    if (ТРЕВОГА.test(п)) return;
    const s = getComputedStyle(el);
    if (красный(s.backgroundColor) || красный(s.borderTopColor)) {
      из.push({ вид: 'красный на действии', тяжесть: 'важно', где: п,
        что: 'фон ' + s.backgroundColor + ' · кромка ' + s.borderTopColor });
    }
  });

  /* 2. БЕСКОНЕЧНАЯ АНИМАЦИЯ.
     Откуда: у панели результата барабана висел shimmer infinite — градиент
     перекрашивался каждый кадр ВЕЧНО, уже после остановки барабана. На
     телефоне это постоянный расход батареи. Нашли только замером кадров. */
  document.querySelectorAll('*').forEach((el) => {
    for (const пс of [null, '::before', '::after']) {
      const s = getComputedStyle(el, пс || undefined);
      if (s.animationName === 'none' || s.animationIterationCount !== 'infinite') continue;
      if (!пс && !виден(el)) continue;
      из.push({ вид: 'бесконечная анимация', тяжесть: 'внимание',
        где: имя(el) + (пс || ''), что: s.animationName + ' · ' + s.animationDuration });
    }
  });

  /* 3. ДОРОГОЕ СВОЙСТВО В ПЕРЕХОДЕ НА СТЕКЛЕ.
     Правило проекта: внутри стекла двигать только transform и opacity.
     Откуда: переход между шагами заказа анимировал filter:blur на панели,
     которая сама стоит на backdrop-filter — каждый кадр пересчитывался весь
     слой, и это читалось как «рвано». */
  document.querySelectorAll('*').forEach((el) => {
    const s = getComputedStyle(el);
    const стекло = (s.backdropFilter && s.backdropFilter !== 'none') ||
                   (s.webkitBackdropFilter && s.webkitBackdropFilter !== 'none');
    if (!стекло || !виден(el)) return;
    const п = s.transitionProperty || '';
    if (/\bfilter\b|\bbackdrop-filter\b|\ball\b/.test(п)) {
      из.push({ вид: 'дорогое свойство на стекле', тяжесть: 'важно',
        где: имя(el), что: 'transition: ' + п.slice(0, 60) });
    }
  });

  /* 4. МИНУСОВОЙ ТРЕКИНГ НА ЗАГОЛОВКЕ.
     Откуда: у h1 стоял letter-spacing −0.432px. Интервал подобран под
     латиницу, у кириллицы другие боковые свесы — буквы съезжались
     неравномерно, строка «плыла». */
  document.querySelectorAll('h1, h2, h3').forEach((el) => {
    if (!виден(el)) return;
    const ls = getComputedStyle(el).letterSpacing;
    const v = parseFloat(ls);
    if (Number.isFinite(v) && v < -0.05) {
      из.push({ вид: 'минусовой трекинг на заголовке', тяжесть: 'внимание',
        где: имя(el), что: ls + ' · на кириллице буквы сходятся неравномерно' });
    }
  });

  return из;
};

const br = await chromium.launch();
const собрано = new Map();

for (const размер of РАЗМЕРЫ) {
  const ctx = await br.newContext({ viewport: { width: размер.width, height: размер.height }, colorScheme: 'dark' });
  const page = await ctx.newPage();
  await изолировать(page, база);
  await вишУжеВиден(page);
  await page.goto(база, { waitUntil: 'domcontentloaded' });
  await подготовить(page);

  for (const id of СМОТРИМ) {
    const зона = ZONES.find((z) => z.id === id);
    if (!зона) continue;
    try {
      if (зона.open) await зона.open(page);
      await page.waitForTimeout(250);
      const найдено = await page.evaluate(ПРОВЕРКИ);
      for (const н of найдено) {
        /* Один и тот же узел виден в нескольких зонах — не двоим. */
        const ключ = н.вид + '|' + н.где + '|' + н.что;
        if (!собрано.has(ключ)) собрано.set(ключ, { ...н, размеры: new Set() });
        собрано.get(ключ).размеры.add(размер.id);
      }
      if (зона.close) await зона.close(page);
    } catch (e) {
      console.warn('зона ' + id + ' (' + размер.id + '): ' + String(e.message || e).slice(0, 70));
    }
  }
  await ctx.close();
}
await br.close();
srv.close();

/* ── ОСОЗНАННЫЕ ИСКЛЮЧЕНИЯ ────────────────────────────────────────────────
   Ревизор, который ругается на то, что мы выбрали сами, быстро становится
   фоном — его перестают читать. Поэтому у каждого исключения есть ПРИЧИНА;
   без причины сюда добавлять нельзя. Пропало основание — строку убрать. */
const ИСКЛЮЧЕНИЯ = [
  { где: /cookie-banner-ok/, вид: 'красный на действии',
    почему: 'решение заказчика: красная заливка с белым текстом' },
  { где: /arch-seal-x|archSealBtn/, вид: 'красный на действии',
    почему: 'по эталону lens-terminals.html печать Архитектора красная' },
  { где: /architect-name/, вид: 'минусовой трекинг на заголовке',
    почему: 'в этом заголовке только «@aintonx» — латиница, сжатие на ней и задумано; проверка ловит кириллицу' },
];

const находки = [...собрано.values()].filter((н) => {
  const и = ИСКЛЮЧЕНИЯ.find((x) => x.вид === н.вид && x.где.test(н.где));
  if (и) { н._причина = и.почему; return false; }
  return true;
});
const прощено = [...собрано.values()].filter((н) => н._причина);
const ВЕС = { важно: 0, внимание: 1 };
находки.sort((a, b) => ВЕС[a.тяжесть] - ВЕС[b.тяжесть] || a.вид.localeCompare(b.вид));

console.log('ревизор «Линза» · зон осмотрено: ' + СМОТРИМ.length + ' × ' + РАЗМЕРЫ.length + '\n');
if (!находки.length) {
  console.log('нарушений не найдено');
} else {
  let текущий = '';
  for (const н of находки) {
    if (н.вид !== текущий) {
      текущий = н.вид;
      const сколько = находки.filter((x) => x.вид === текущий).length;
      console.log('\n── ' + текущий.toUpperCase() + ' · ' + н.тяжесть + ' (' + сколько + ')');
    }
    console.log('  ' + н.где.padEnd(38) + ' ' + н.что);
    console.log('  ' + ' '.repeat(38) + ' [' + [...н.размеры].join(', ') + ']');
  }
  const важных = находки.filter((н) => н.тяжесть === 'важно').length;
  console.log('\nвсего: ' + находки.length + ' · важно ' + важных +
    ' · внимание ' + (находки.length - важных));
}
if (прощено.length) {
  console.log('\n── ОСОЗНАННЫЕ ИСКЛЮЧЕНИЯ (' + прощено.length + ')');
  for (const н of прощено) console.log('  ' + н.где.padEnd(38) + ' ' + н._причина);
}

if (СТРОГО && находки.some((н) => н.тяжесть === 'важно')) process.exit(1);
