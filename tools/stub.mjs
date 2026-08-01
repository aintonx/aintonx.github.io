/**
 * ИЗОЛЯЦИЯ СТРАНИЦЫ ОТ ВНЕШНЕГО МИРА
 * ---------------------------------------------------------------------------
 * Один общий перехватчик для стенда кадров и для осмотра — чтобы оба видели
 * ровно одно и то же состояние сайта.
 *
 * Зачем вообще: сайт при загрузке ходит в Apertura (каталог, брони, статусы).
 * С чужого origin эти запросы не проходят, и сайт честно переключается в
 * аварийный режим — ставит orderingLimited, вешает поверх карточки табличку
 * «сигнал нестабилен» и запрещает заказ. Для проверки вёрстки это негодное
 * состояние: половина интерфейса просто не показывается.
 *
 * Поэтому отвечаем сами: коротко, успешно и всегда одинаково. Пустые списки
 * ничего не переопределяют — реликвии остаются такими, как описаны в самом
 * index.html, — а ok:true снимает аварийный режим. Кадры при этом
 * повторяемы, что и нужно регрессии.
 *
 * Всё остальное наружу (метрика, капча, шрифты, подсказки адреса) режется:
 * оно только шумит, тормозит и делает кадры непредсказуемыми.
 */
const ВРЕМЯ = '2026-01-01T00:00:00.000Z';

/** Ответ Apertura на любой маршрут: успех и пустота. */
function ответApertura(url) {
  const тело = { ok: true, server_time: ВРЕМЯ, stale: false };
  if (/route=catalog/i.test(url)) тело.products = [];
  else {
    тело.items = [];
    тело.reservations = [];
    тело.orders = [];
    тело.status = 'idle';
    тело.data = null;
  }
  return тело;
}

/**
 * Вешает перехват на страницу.
 * @param {import('playwright').Page} page
 * @param {string} базовый корень локального сервера — только он ходит по-настоящему
 */
export async function изолировать(page, базовый) {
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(базовый) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    if (u.includes('functions.yandexcloud.net')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify(ответApertura(u)),
      });
    }
    return route.abort();
  });
}

/** Сообщения, на которые ругаться не нужно: это следствие самой изоляции. */
export const ШУМ = /SmartCaptcha.*allowed hosts|net::ERR_FAILED|net::ERR_ABORTED/i;

/**
 * Приводит страницу в вид, пригодный для съёмки: снимает загрузочную шторку
 * и аварийную табличку Apertura.
 *
 * Табличка «сигнал нестабилен» вылезает потому, что часть обращений к
 * бэкенду в изоляции всё равно не проходит. Она честная для боевого сайта,
 * но здесь закрывает половину карточки товара и мешает смотреть вёрстку.
 * Снимаем её штатной функцией сайта, а не удалением узла, — чтобы не
 * оставить интерфейс в полусостоянии.
 */
export async function подготовить(page) {
  await page.evaluate(() => {
    document.documentElement.classList.remove('ew-first-boot-pending');
    document.getElementById('ewFirstBoot')?.remove();
    try { window.closeAperturaStatus && window.closeAperturaStatus(); } catch (_) {}
  }).catch(() => {});
  await page.waitForTimeout(600);
  // вторая попытка: табличка может подняться уже после первой волны запросов
  await page.evaluate(() => {
    try { window.closeAperturaStatus && window.closeAperturaStatus(); } catch (_) {}
  }).catch(() => {});
}
