#!/usr/bin/env node
/**
 * ВАЛИДАТОР ЦЕЛОСТНОСТИ index.html
 * ---------------------------------------------------------------------------
 * Сайт — один файл на 39 тысяч строк: 44 блока стилей и 49 блоков скриптов,
 * без сборки и без линтеров. Любая правка вносится вслепую, и ни один
 * инструмент её не проверяет. Этот скрипт — сеть снизу.
 *
 * Ловит:
 *   1. незакрытый /* в блоке стилей — самая коварная поломка: всё, что после,
 *      молча проглатывается, страница выглядит «почти нормально»;
 *   2. дисбаланс фигурных скобок в стилях;
 *   3. синтаксические ошибки в любом инлайновом скрипте;
 *   4. повторяющиеся id — на них держится вся машинерия сайта;
 *   5. дисбаланс парных тегов style/script.
 *
 * Скобки и комментарии считаются посимвольным разбором с учётом строк и
 * комментариев, а не регуляркой: в CSS полно кавычек и скобок внутри
 * значений, и наивный счёт даёт ложные срабатывания.
 *
 * Запуск:  node tools/validate.mjs [путь]
 * Код 0 — чисто, 1 — есть находки.
 */
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import path from 'node:path';

const FILE = process.argv[2] || path.join(process.cwd(), 'index.html');
const problems = [];

let src;
try {
  src = readFileSync(FILE, 'utf8');
} catch (e) {
  console.error(`не смог прочитать ${FILE}: ${e.message}`);
  process.exit(1);
}

/** Номер строки по смещению — чтобы сообщение можно было открыть кликом. */
const lineAt = (offset) => src.slice(0, offset).split('\n').length;

/* ── 1–2. СТИЛИ: комментарии и скобки ─────────────────────────────────── */
/**
 * Посимвольный разбор CSS. Возвращает {openComment, depth}: где остался
 * незакрытый комментарий и с какой глубиной скобок закончился блок.
 */
function scanCss(css) {
  let depth = 0;
  let commentStart = -1;
  let i = 0;
  /* Комментарий с ПЕРЕКОСОМ фигурных скобок значит, что правку сделали
     неаккуратно и в комментарий втянуло начало правила. Именно так
     выглядела поломка, ради которой этот скрипт написан: «…янтарь{».
     Сбалансированные скобки внутри комментария — обычное дело, в них
     приводят примеры кода, и трогать их нельзя. */
  const swallowed = [];
  while (i < css.length) {
    const two = css.slice(i, i + 2);
    if (commentStart >= 0) {
      if (two === '*/') {
        const body = css.slice(commentStart + 2, i);
        // Комментарии CSS не вкладываются: потерянный закрывающий маркер не
        // даёт синтаксической ошибки — комментарий просто тянется до
        // следующего и съедает по дороге живые правила. Файл выглядит целым,
        // а стилей уже нет. Признак — второй открывающий маркер внутри тела
        // комментария: в нормальном коде так не пишут.
        if (body.includes('/*')) swallowed.push(commentStart);
        else {
          const opens = (body.match(/\{/g) || []).length;
          const closes = (body.match(/\}/g) || []).length;
          if (opens !== closes) swallowed.push(commentStart);
        }
        commentStart = -1;
        i += 2;
        continue;
      }
      i++; continue;
    }
    if (two === '/*') { commentStart = i; i += 2; continue; }
    const ch = css[i];
    // строки в значениях (шрифты, content, url) могут содержать скобки
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < css.length && css[i] !== quote) {
        if (css[i] === '\\') i++;
        i++;
      }
      i++; continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  return { commentStart, depth, swallowed };
}

const styleRe = /<style([^>]*)>([\s\S]*?)<\/style>/g;
let m;
let styleCount = 0;
while ((m = styleRe.exec(src))) {
  styleCount++;
  const attrs = m[1];
  const css = m[2];
  const bodyStart = m.index + m[0].indexOf('>') + 1;
  const idMatch = /id="([^"]+)"/.exec(attrs);
  const label = idMatch ? `#${idMatch[1]}` : `блок ${styleCount}`;
  const { commentStart, depth, swallowed } = scanCss(css);
  for (const at of swallowed) {
    problems.push({
      где: `${FILE}:${lineAt(bodyStart + at)}`,
      что: `правило проглочено комментарием (${label}) — потерян закрывающий */, стили ниже молча не применяются`,
    });
  }
  if (commentStart >= 0) {
    problems.push({
      где: `${FILE}:${lineAt(bodyStart + commentStart)}`,
      что: `незакрытый /* в стилях (${label}) — всё, что ниже него, браузер проглотит`,
    });
  }
  if (depth !== 0) {
    problems.push({
      где: `${FILE}:${lineAt(bodyStart)}`,
      что: `скобки в стилях не сходятся (${label}): перекос ${depth > 0 ? '+' : ''}${depth}`,
    });
  }
}

/* ── 3. СКРИПТЫ: синтаксис ────────────────────────────────────────────── */
/* vm.Script вместо `node --check`: тот же разбор, но без 49 запусков
   процесса — хук должен отрабатывать мгновенно, иначе им перестают
   пользоваться. */
const scriptRe = /<script([^>]*)>([\s\S]*?)<\/script>/g;
let scriptCount = 0;
let scriptChecked = 0;
while ((m = scriptRe.exec(src))) {
  scriptCount++;
  const attrs = m[1];
  const code = m[2];
  if (/\bsrc=/.test(attrs)) continue;              // внешний файл
  if (/type=["'](?!text\/javascript|module)/.test(attrs)) continue; // ld+json и прочее
  if (!code.trim()) continue;
  const bodyStart = m.index + m[0].indexOf('>') + 1;
  const idMatch = /id="([^"]+)"/.exec(attrs);
  const label = idMatch ? `#${idMatch[1]}` : `блок ${scriptCount}`;
  scriptChecked++;
  try {
    new Script(code, { filename: `${FILE} (${label})` });
  } catch (e) {
    problems.push({
      где: `${FILE}:${lineAt(bodyStart)}`,
      что: `синтаксическая ошибка в скрипте (${label}): ${e.message}`,
    });
  }
}

/* ── 4. ПОВТОРЯЮЩИЕСЯ id ──────────────────────────────────────────────── */
/* На id держится вся машинерия: getElementById, барабаны, шаги чекаута.
   Дубль означает, что половина обработчиков молча уйдёт не туда. */
const seen = new Map();
const idRe = /\sid="([^"]+)"/g;
while ((m = idRe.exec(src))) {
  const id = m[1];
  if (seen.has(id)) {
    problems.push({
      где: `${FILE}:${lineAt(m.index)}`,
      что: `повторяющийся id="${id}" (первый — строка ${lineAt(seen.get(id))})`,
    });
  } else {
    seen.set(id, m.index);
  }
}

/* ── 5. ПАРНОСТЬ ТЕГОВ ────────────────────────────────────────────────── */
const pairs = [['<style', '</style>'], ['<script', '</script>']];
for (const [open, close] of pairs) {
  const a = src.split(open).length - 1;
  const b = src.split(close).length - 1;
  if (a !== b) {
    problems.push({ где: FILE, что: `${open}…${close}: ${a} против ${b}` });
  }
}

/* ── ОТЧЁТ ────────────────────────────────────────────────────────────── */
const summary = `стилей ${styleCount} · скриптов проверено ${scriptChecked} из ${scriptCount} · id ${seen.size}`;

if (!problems.length) {
  console.log(`✓ целостность в порядке — ${summary}`);
  process.exit(0);
}

console.error(`✗ находок: ${problems.length} — ${summary}\n`);
for (const p of problems) {
  console.error(`  ${p.где}\n    ${p.что}\n`);
}
process.exit(1);
