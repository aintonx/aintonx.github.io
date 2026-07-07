# EchoWorld / MARKETSPACE — DB Phase 1C Read-Only Catalog

Этот документ фиксирует текущий безопасный этап интеграции сайта с YDB-каталогом.

## Что включено

- Frontend читает `GET ?route=catalog/list` из Cloud Function в read-only режиме.
- Данные API накладываются поверх локального массива `products[]` без перестановки карточек.
- DOM-карточки не пересобираются и `openModal(index)` не меняется.
- API может обновлять только безопасные поля:
  - `status`;
  - `orderable`;
  - `price_rub`;
  - `power_code`;
  - `power_label`;
  - `echo_slots`;
  - `catalog_status_label`;
  - `visible`;
  - `updated_at`.
- Названия, описания, изображения, hero, карточки, формы, SEO и текущие иконки не меняются API-оверлеем.
- Корзина нормализуется от канонического `products[]`, поэтому старый cart item не может сохранить устаревшую цену/статус.
- Если каталог недоступен, оформление временно ограничивается и показывается безопасный статус:
  - `Связь с каталогом нестабильна.`
  - `Мы показываем сохранённые данные, но текущий статус реликвий может быть неточным. Оформление временно ограничено — попробуйте позже или обновите подключение.`

## Что намеренно выключено

Не включались:

- реальные заказы;
- резервирование товара;
- YooKassa;
- платежные ссылки;
- success по query string;
- Object Storage;
- загрузка голосового Эхо;
- fake-success и любые клиентские имитации оплаты.

`businessApi.enabled` остаётся `false`.

## Основные файлы для продолжения

- `/Users/naboy/Documents/Codex/2026-07-02/files-mentioned-by-the-user-index-2/work/aintonx.github.io-cleanpush/index.html`
- `/Users/naboy/Documents/Codex/2026-07-02/files-mentioned-by-the-user-index-2/work/aintonx.github.io-cleanpush/api/echoworld-apertura-api/index.js`
- `/Users/naboy/Documents/Codex/2026-07-02/files-mentioned-by-the-user-index-2/work/aintonx.github.io-cleanpush/api/echoworld-apertura-api/package.json`
- `/Users/naboy/Documents/Codex/2026-07-02/files-mentioned-by-the-user-index-2/work/aintonx.github.io-cleanpush/api/echoworld-apertura-api/schema/products.yql`
- `/Users/naboy/Documents/Codex/2026-07-02/files-mentioned-by-the-user-index-2/work/aintonx.github.io-cleanpush/data/products.seed.json`
- `/Users/naboy/Documents/Codex/2026-07-02/files-mentioned-by-the-user-index-2/work/aintonx.github.io-cleanpush/data/products.upsert.yql`
- `/Users/naboy/Documents/Codex/2026-07-02/files-mentioned-by-the-user-index-2/work/aintonx.github.io-cleanpush/scripts/extract-products-from-index.js`
- `/Users/naboy/Documents/Codex/2026-07-02/files-mentioned-by-the-user-index-2/work/aintonx.github.io-cleanpush/scripts/build-products-upsert-yql.js`
- `/Users/naboy/Documents/Codex/2026-07-02/files-mentioned-by-the-user-index-2/work/aintonx.github.io-cleanpush/share/relic/`


## Текущий словарь публичных плашек статуса

Короткие публичные подписи `catalog_status_label`:

```text
available → Доступна
first_form → В MARKETSPACE
transition_complete → В нашем мире
```

Важно: это только короткие плашки. Длинные описания статусов в карточке товара не меняются этим словарём.

## Проверки в браузере

В консоли сайта:

```js
inspectEchoWorldCatalogSync()
```

Ожидаемо после успешной загрузки:

```js
{
  ok: true,
  readOnlyEnabled: true,
  orderingLimited: false,
  attempted: true,
  lastApplied: 12
}
```

Ручной retry:

```js
await refreshEchoWorldCatalog({ manual: true })
```

Проверка будущего payload заказа:

```js
inspectCheckoutOrderPayload()
```

Для `01-0006 / Тёмный оракул` товар должен оставаться:

```json
{
  "status": "first_form",
  "orderable": false,
  "price_rub": 25999,
  "power_code": "C",
  "power_label": "Скопление",
  "echo_slots": 2,
  "catalog_status_label": "В MARKETSPACE"
}
```

## Проверки API

```text
https://functions.yandexcloud.net/d4e5vcvae4csacbacs2i?route=catalog/list
https://functions.yandexcloud.net/d4e5vcvae4csacbacs2i?route=products
https://functions.yandexcloud.net/d4e5vcvae4csacbacs2i?route=catalog/product-status&product_id=01-0006
```

## Что сделать в Yandex Cloud после этого патча

Если нужно привести YDB-данные к текущей модели:

1. Открыть YDB Query для `echoworld-db`.
2. Выполнить:
   `/Users/naboy/Documents/Codex/2026-07-02/files-mentioned-by-the-user-index-2/work/aintonx.github.io-cleanpush/data/products.upsert.yql`
3. Обновить Cloud Function кодом:
   `/Users/naboy/Documents/Codex/2026-07-02/files-mentioned-by-the-user-index-2/work/aintonx.github.io-cleanpush/api/echoworld-apertura-api/index.js`
4. Проверить три API-ссылки выше.
5. Только после успешной проверки деплоить сайт на GitHub Pages.

## Мини-промт для следующего чата

Продолжи Phase 1C EchoWorld / MARKETSPACE. Нужно проверить и довести read-only интеграцию YDB-каталога. Работать только с файлами:

- `index.html`;
- `api/echoworld-apertura-api/index.js`;
- `api/echoworld-apertura-api/package.json`;
- `api/echoworld-apertura-api/schema/products.yql`;
- `data/products.seed.json`;
- `data/products.upsert.yql`;
- `scripts/extract-products-from-index.js`;
- `scripts/build-products-upsert-yql.js`;
- `share/relic/`;
- `docs/db-phase1c-readonly-catalog.md`.

Уже сделано: frontend читает `catalog/list` read-only, накладывает безопасные поля поверх `products[]`, не переставляет карточки, нормализует корзину от канонического товара, блокирует оформление при нестабильном каталоге, оставляет `businessApi.enabled=false`. Нельзя включать заказы, резервы, YooKassa, Object Storage, voice upload, fake-success. Нужно тестировать `inspectEchoWorldCatalogSync()`, `refreshEchoWorldCatalog({manual:true})`, `inspectCheckoutOrderPayload()`, `catalog/list`, `products`, `catalog/product-status&product_id=01-0006`.
