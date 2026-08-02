/**
 * ПРОСТОЙ СЕРВЕР САЙТА ДЛЯ ПРОВЕРКИ НА iOS-СИМУЛЯТОРЕ
 * ---------------------------------------------------------------------------
 * Симулятор делит сеть с Mac, поэтому 127.0.0.1 из него виден. Отдаём файлы
 * без кеша, чтобы правка была видна сразу после перезагрузки страницы.
 *
 *   node tools/serve.mjs [порт]      # по умолчанию 4173
 *
 * В отличие от стенда кадров здесь НЕТ подмены запросов к Apertura: на
 * симуляторе проверяется живое поведение, включая настоящую загрузку каталога.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const КОРЕНЬ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ПОРТ = Number(process.argv[2] || 4173);

const ТИПЫ = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

createServer(async (req, res) => {
  const путь = decodeURIComponent(req.url.split('?')[0]);
  const файл = путь === '/' ? 'index.html' : путь.slice(1);
  /* Не выпускаем за пределы папки сайта */
  const полный = path.resolve(КОРЕНЬ, файл);
  if (!полный.startsWith(КОРЕНЬ)) { res.writeHead(403).end(); return; }
  try {
    const тело = await readFile(полный);
    res.writeHead(200, {
      'Content-Type': ТИПЫ[path.extname(полный).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    });
    res.end(тело);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('нет такого файла');
  }
}).listen(ПОРТ, '0.0.0.0', () => {
  console.log(`сайт на http://127.0.0.1:${ПОРТ}/  (для симулятора — этот же адрес)`);
});
