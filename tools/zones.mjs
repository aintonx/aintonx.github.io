/**
 * ЗОНЫ САЙТА — что снимаем и как до этого добраться.
 * ---------------------------------------------------------------------------
 * Порядок — путь покупателя, а не порядок в разметке: шапка → герой → каталог
 * → карточка → корзина → чекаут → Эхо → остальные разделы → служебные окна.
 * Блок считается закрытым, когда его кадр совпадает с эталоном.
 *
 * Поле `open` — то, что нужно сделать в странице, чтобы зона появилась
 * (открыть модалку, пройти шаги). Возвращает селектор снимаемого узла либо
 * null, если зона в этом размере не показывается.
 */
/* ── Общие шаги, где важно дождаться состояния, а не отсчитать паузу ────── */

/** Открыть чекаут и дождаться, что окно действительно раскрылось. */
async function открытьЧекаут(page) {
  /* Цепочка строго по состояниям. Раньше всё шло одним вызовом, и на узком
     экране addToCart успевал сработать до того, как карточка подставит
     товар: корзина оставалась пустой, openCheckout молча выходил, а зона
     считалась непроверенной. */
  await page.evaluate(() => window.openModal(1));
  await page.waitForSelector('.moverlay.open', { timeout: 10000 });
  await page.waitForTimeout(400);

  /* Клик по кнопке карточки, а ожидание — по счётчику в шапке: переменная
     корзины живёт внутри скрипта страницы, window.cart всегда ноль. */
  await page.locator('.moverlay .mbtn').filter({ hasText: 'корзину' }).first().click();
  await page.waitForFunction(
    () => Number(document.getElementById('cartCount')?.textContent || 0) > 0,
    null, { timeout: 10000 },
  );
  await page.waitForTimeout(600);

  await page.evaluate(() => window.openCheckout());
  await page.waitForFunction(
    () => document.querySelector('.chk-overlay.open') &&
          window.inspectCheckoutSteps && window.inspectCheckoutSteps().ok,
    null, { timeout: 12000 },
  );
  await page.waitForTimeout(500);
}

/**
 * Пересеять генератор случайных чисел ПЕРЕД запуском барабана.
 *
 * Стенд уже подменяет Math.random на входе в страницу, но этого мало:
 * барабан берёт значения из той же последовательности, а сколько чисел
 * израсходуют другие скрипты до него — от прогона к прогону разное. Выпадали
 * то короткие значения, то длинные, строка итога переносилась по-разному, и
 * высота панели гуляла на 22px — регрессия считала это правкой.
 * Пересев прямо перед запуском делает выбор барабана воспроизводимым.
 */
async function пересеять(page) {
  await page.evaluate(() => {
    let s = 7;
    Math.random = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  });
}

/** Нажать «Далее» и дождаться, что рейка переключилась на нужный шаг. */
async function шагДалее(page, откуда, куда) {
  await page.evaluate((i) => document.querySelectorAll('.chk-nav-next')[i].click(), откуда);
  await page.waitForFunction(
    (n) => window.inspectCheckoutSteps().текущий === n,
    куда, { timeout: 10000 },
  );
  await page.waitForTimeout(450);
}

export const ZONES = [
  { id: 'header',        имя: 'Шапка',                   sel: 'header, .hdr' },
  { id: 'hero',          имя: 'Герой и терминал',        sel: '.hero' },
  { id: 'power',         имя: 'Мощь Реликвии',           sel: '.relic, #relic' },
  { id: 'catalog',       имя: 'Каталог',                 sel: '.catwrap, .catalog-main-section' },
  { id: 'echo',          имя: 'Эхо · передатчик',        sel: '.echo-right' },
  /* .cond-screen убран при переносе интерфейса конденсации с эталона —
     зона молча пропускалась и не проверялась вовсе. Новый узел — #condScreen. */
  { id: 'system',        имя: 'Система и Конденсация',   sel: '#condScreen, #system' },
  { id: 'worlds',        имя: 'Миры',                    sel: '#worlds, .worlds' },
  /* Терминал Архитектора снят по решению владельца — зона указывала на него
     и молча пропускалась. Теперь снимается сама запись. */
  { id: 'architect',     имя: 'Архитектор',              sel: '.arch-rec, #architect' },
  { id: 'partners',      имя: 'Партнёрства',             sel: '.collab, .clink' },
  { id: 'donate',        имя: 'Поддержка',               sel: '.donate-right, .donate' },
  { id: 'faq',           имя: 'FAQ',                     sel: '#faq, .faq' },
  { id: 'footer',        имя: 'Футер',                   sel: 'footer, .footer' },

  {
    id: 'card', имя: 'Карточка реликвии', sel: '.moverlay .modal',
    async open(page) { await page.evaluate(() => window.openModal(1)); await page.waitForTimeout(700); },
    async close(page) { await page.evaluate(() => window.closeModal && window.closeModal()); await page.waitForTimeout(500); },
  },
  {
    id: 'cart', имя: 'Корзина', sel: '#cartPanel',
    /* У toggleCart замок на 420 мс и классы cart-opening/cart-closing: вызов
       не вовремя молча ничего не делает, и кадр ловил закрытую панель — это
       и давало ложное расхождение в 7%. Поэтому ждём именно состояние. */
    async open(page) {
      await page.evaluate(() => window.openModal(1));
      await page.waitForSelector('.moverlay.open', { timeout: 10000 });
      await page.waitForTimeout(400);
      /* Кладём в корзину настоящим кликом по кнопке карточки.
         Ждём по РАЗМЕТКЕ, а не по window.cart: переменная корзины живёт в
         области видимости скрипта и наружу не выставлена — window.cart
         остаётся нулём даже когда товар уже добавлен. На этом я потерял
         полтора часа: ждал условия, которое не могло стать истинным. */
      await page.locator('.moverlay .mbtn').filter({ hasText: 'корзину' }).first().click();
      await page.waitForFunction(
        () => Number(document.getElementById('cartCount')?.textContent || 0) > 0,
        null, { timeout: 10000 },
      );
      await page.waitForTimeout(900);          // переживаем замок toggleCart
      await page.evaluate(() => window.toggleCart());
      await page.waitForFunction(() => {
        const p = document.getElementById('cartPanel');
        return p && p.classList.contains('open') && !p.classList.contains('cart-opening');
      }, null, { timeout: 10000 });
      await page.waitForTimeout(400);
    },
  },
  {
    id: 'checkout-1', имя: 'Чекаут · шаг 1 Сигнатура', sel: '.chk-modal',
    async open(page) { await открытьЧекаут(page); },
  },
  {
    id: 'checkout-2', имя: 'Чекаут · шаг 2 Контакт', sel: '.chk-modal',
    async open(page) {
      await открытьЧекаут(page);
      await шагДалее(page, 0, 1);
    },
  },
  {
    id: 'checkout-3', имя: 'Чекаут · шаг 3 Подтверждение', sel: '.chk-modal',
    async open(page) {
      await открытьЧекаут(page);
      await шагДалее(page, 0, 1);
      await page.evaluate(() => {
        const v = { chkName: 'Иван', chkPhone: '+7 999 123-45-67', chkEmail: 'i@e.com', chkAddr: 'Москва, 1' };
        for (const [id, val] of Object.entries(v)) {
          const el = document.getElementById(id);
          if (el) { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); }
        }
      });
      await шагДалее(page, 1, 2);
      /* Слоты Эхо рисуются отдельным проходом уже после показа шага. Без
         ожидания кадр иногда снимался до них, и высота окна прыгала на 84px
         от прогона к прогону — регрессия принимала это за правку. */
      await page.waitForFunction(
        () => document.querySelectorAll('.chk-echo-slot').length > 0,
        null, { timeout: 8000 },
      ).catch(() => {});
      await page.waitForTimeout(350);
    },
  },
  {
    id: 'checkout-echo-editor', имя: 'Чекаут · редактор слота Эхо', sel: '.chk-modal',
    async open(page) {
      await ZONES.find((z) => z.id === 'checkout-3').open(page);
      await page.evaluate(() => document.querySelector('.chk-echo-slot')?.click());
      await page.waitForTimeout(900);
    },
  },
  {
    id: 'checkout-drum', имя: 'Чекаут · барабан атрибутов', sel: '.chk-modal',
    async open(page) {
      await ZONES.find((z) => z.id === 'checkout-3').open(page);
      await пересеять(page);
      await page.evaluate(() => window.launchAttrDrum());
      await page.waitForTimeout(1400);   // ловим ленту в движении
    },
  },
  {
    id: 'checkout-result', имя: 'Чекаут · панель результата', sel: '.chk-modal',
    async open(page) {
      await ZONES.find((z) => z.id === 'checkout-3').open(page);
      await пересеять(page);
      await page.evaluate(() => window.launchAttrDrum());
      /* Ждём фактическую готовность, а не «примерно столько-то секунд».
         Колонки садятся по очереди и с разной длительностью, поэтому
         фиксированная пауза ловила кадр то до, то после — регрессия
         принимала это за правку. Условие: все три колонки выбрали значение
         и панель результата показана. */
      await page.waitForFunction(
        () => document.querySelectorAll('.attr-drum-item.selected').length >= 3 &&
              document.querySelector('#attrResultPanel.show'),
        null, { timeout: 20000 },
      ).catch(() => {});
      await page.waitForTimeout(1200);
    },
  },
  {
    id: 'echo-order', имя: 'Заказ Эхо', sel: '#echoOrderModal',
    async open(page) {
      await page.evaluate(() => {
        const ta = document.getElementById('echoTextInput');
        if (ta) { ta.value = 'Я был здесь и это правда'; ta.dispatchEvent(new Event('input', { bubbles: true })); }
        window.openEchoOrder();
      });
      await page.waitForTimeout(800);
    },
  },
  {
    id: 'echo-aura', имя: 'Заказ Эхо · барабан Ауры', sel: '#echoOrderModal',
    async open(page) {
      await ZONES.find((z) => z.id === 'echo-order').open(page);
      await page.evaluate(() => {
        const set = (id, v) => { const el = document.getElementById(id); if (el) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); } };
        set('echoOrderName', 'Иван'); set('echoOrderEmail', 'i@e.com');
        const c = document.getElementById('echoOrderConsent');
        if (c && !c.checked) c.click();
        window._updateEchoOrderSubmit && window._updateEchoOrderSubmit();
        document.getElementById('echoOrderSubmit').click();
      });
      await page.waitForTimeout(3600);
    },
  },
  {
    id: 'legal', имя: 'Документы', sel: '#privacyModal',
    async open(page) { await page.evaluate(() => window.openPrivacyModal()); await page.waitForTimeout(700); },
  },
  {
    id: 'mobnav', имя: 'Мобильное меню', sel: '#menu',
    только: 'mobile',
    /* Живое меню — #menu. Блок <nav class="mob-nav" id="mobNav"> в разметке
       есть, но никогда не отображается: после клика по бургеру он остаётся
       display:none, а всплывает #menu. Именно поэтому тумблера темы,
       лежащего внутри mobNav, на сайте не видно. Открывать только настоящим
       кликом: openMobNav() ничего не раскрывает. */
    async open(page) {
      await page.locator('#mobBurger').click();
      await page.waitForTimeout(900);
    },
  },
];

export const РАЗМЕРЫ = [
  { id: 'desktop', width: 1440, height: 900 },
  { id: 'mobile', width: 390, height: 844 },
];
