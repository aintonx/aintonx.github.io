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
export const ZONES = [
  { id: 'header',        имя: 'Шапка',                   sel: 'header, .hdr' },
  { id: 'hero',          имя: 'Герой и терминал',        sel: '.hero' },
  { id: 'power',         имя: 'Мощь Реликвии',           sel: '.relic, #relic' },
  { id: 'catalog',       имя: 'Каталог',                 sel: '.catwrap, .catalog-main-section' },
  { id: 'echo',          имя: 'Эхо · передатчик',        sel: '.echo-right' },
  { id: 'system',        имя: 'Система и Конденсация',   sel: '.cond-screen, #system' },
  { id: 'worlds',        имя: 'Миры',                    sel: '#worlds, .worlds' },
  { id: 'architect',     имя: 'Архитектор',              sel: '.architect-terminal, .arch-term' },
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
    async open(page) {
      await page.evaluate(() => { window.openModal(1); window.addToCart(); });
      await page.waitForTimeout(600);
      await page.evaluate(() => window.toggleCart());
      await page.waitForTimeout(600);
    },
    async close(page) { await page.evaluate(() => window.toggleCart()); await page.waitForTimeout(500); },
  },
  {
    id: 'checkout-1', имя: 'Чекаут · шаг 1 Сигнатура', sel: '.chk-modal',
    async open(page) {
      await page.evaluate(() => { window.openModal(1); window.addToCart(); window.openCheckout(); });
      await page.waitForTimeout(800);
    },
  },
  {
    id: 'checkout-2', имя: 'Чекаут · шаг 2 Контакт', sel: '.chk-modal',
    async open(page) {
      await page.evaluate(() => { window.openModal(1); window.addToCart(); window.openCheckout(); });
      await page.waitForTimeout(700);
      await page.evaluate(() => document.querySelectorAll('.chk-nav-next')[0].click());
      await page.waitForTimeout(700);
    },
  },
  {
    id: 'checkout-3', имя: 'Чекаут · шаг 3 Подтверждение', sel: '.chk-modal',
    async open(page) {
      await page.evaluate(() => { window.openModal(1); window.addToCart(); window.openCheckout(); });
      await page.waitForTimeout(700);
      await page.evaluate(() => document.querySelectorAll('.chk-nav-next')[0].click());
      await page.waitForTimeout(600);
      await page.evaluate(() => {
        const v = { chkName: 'Иван', chkPhone: '+7 999 123-45-67', chkEmail: 'i@e.com', chkAddr: 'Москва, 1' };
        for (const [id, val] of Object.entries(v)) {
          const el = document.getElementById(id);
          if (el) { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); }
        }
        document.querySelectorAll('.chk-nav-next')[1].click();
      });
      await page.waitForTimeout(700);
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
      await page.evaluate(() => window.launchAttrDrum());
      await page.waitForTimeout(1400);   // ловим ленту в движении
    },
  },
  {
    id: 'checkout-result', имя: 'Чекаут · панель результата', sel: '.chk-modal',
    async open(page) {
      await ZONES.find((z) => z.id === 'checkout-3').open(page);
      await page.evaluate(() => window.launchAttrDrum());
      /* Ждём именно появления панели, а не «примерно пять секунд»: на узком
         экране барабан отрабатывает с другим таймингом, и фиксированная
         пауза ловила кадр то до, то после — регрессия ругалась на это. */
      await page.waitForSelector('#attrResultPanel.show', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(900);
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
