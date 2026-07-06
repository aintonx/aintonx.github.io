# EchoWorld / MARKETSPACE — DB Phase 1B Handoff

Этот документ нужен для продолжения работы в другом чате без потери контекста.

## Важно

Пользователь ещё не применял изменения в Yandex Cloud.

В репозитории уже подготовлены файлы для YDB и Cloud Function, но:

- YDB schema ещё не применена;
- товары в YDB ещё не загружены;
- Cloud Function ещё не обновлена новым кодом;
- frontend сайта ещё не переключён на API;
- YooKassa, реальные оплаты, реальные заказы, резервы, Object Storage и Эхо-аудио ещё не подключались.

Нельзя включать оплату, заказы и frontend API до ручной проверки read-only каталога.

## Текущие Yandex Cloud данные

- Cloud: `echoworld-cloud`
- Folder: `default`
- YDB: `echoworld-db`
- Database path: `/ru-central1/b1g2gnnfvrjj9u0ommhk/etntcuip4hdge6cro5nl`
- Endpoint: `grpcs://ydb.serverless.yandexcloud.net:2135`
- Cloud Function: `echoworld-apertura-api`
- Function URL: `https://functions.yandexcloud.net/d4e5vcvae4csacbacs2i`
- Service account: `echoworld-apertura-sa`
- Runtime on screenshot: `nodejs22`
- Entry point: `index.handler`
- Memory: `256 MB`
- Timeout: `15 секунд`

## Уже созданные файлы

Обязательные файлы для следующего этапа:

- `/Users/naboy/Documents/Codex/2026-07-02/files-mentioned-by-the-user-index-2/work/aintonx.github.io-cleanpush/index.html`
- `/Users/naboy/Documents/Codex/2026-07-02/files-mentioned-by-the-user-index-2/work/aintonx.github.io-cleanpush/data/products.seed.json`
- `/Users/naboy/Documents/Codex/2026-07-02/files-mentioned-by-the-user-index-2/work/aintonx.github.io-cleanpush/data/products.upsert.yql`
- `/Users/naboy/Documents/Codex/2026-07-02/files-mentioned-by-the-user-index-2/work/aintonx.github.io-cleanpush/scripts/extract-products-from-index.js`
- `/Users/naboy/Documents/Codex/2026-07-02/files-mentioned-by-the-user-index-2/work/aintonx.github.io-cleanpush/scripts/build-products-upsert-yql.js`
- `/Users/naboy/Documents/Codex/2026-07-02/files-mentioned-by-the-user-index-2/work/aintonx.github.io-cleanpush/api/echoworld-apertura-api/index.js`
- `/Users/naboy/Documents/Codex/2026-07-02/files-mentioned-by-the-user-index-2/work/aintonx.github.io-cleanpush/api/echoworld-apertura-api/package.json`
- `/Users/naboy/Documents/Codex/2026-07-02/files-mentioned-by-the-user-index-2/work/aintonx.github.io-cleanpush/api/echoworld-apertura-api/README.md`
- `/Users/naboy/Documents/Codex/2026-07-02/files-mentioned-by-the-user-index-2/work/aintonx.github.io-cleanpush/api/echoworld-apertura-api/schema/products.yql`
- `/Users/naboy/Documents/Codex/2026-07-02/files-mentioned-by-the-user-index-2/work/aintonx.github.io-cleanpush/api/echoworld-apertura-api/schema/products.add-missing-columns.yql`

Локально также подготовлен ZIP для Yandex Cloud Function:

- `/Users/naboy/Documents/Codex/2026-07-02/files-mentioned-by-the-user-index-2/work/aintonx.github.io-cleanpush/dist/echoworld-apertura-api-phase1b.zip`

Если ZIP потеряется, пересобрать:

```bash
cd /Users/naboy/Documents/Codex/2026-07-02/files-mentioned-by-the-user-index-2/work/aintonx.github.io-cleanpush
mkdir -p dist
rm -f dist/echoworld-apertura-api-phase1b.zip
cd api/echoworld-apertura-api
zip -r ../../dist/echoworld-apertura-api-phase1b.zip index.js package.json
```

## Что уже сделано в коде

1. Из текущего `index.html` извлечён seed каталога:
   - 12 товаров;
   - 11 `available`;
   - 1 `first_form`: `RELIC-01-0006 / Тёмный оракул`;
   - мощность → слоты Эхо:
     - `K = 1`;
     - `C = 2`;
     - `R = 3`;
     - `S = 4`.

2. Добавлен generator:
   - `scripts/extract-products-from-index.js` — пересобирает `data/products.seed.json` из `index.html`;
   - `scripts/build-products-upsert-yql.js` — собирает `data/products.upsert.yql` из seed.

3. Подготовлен backend source для Cloud Function:
   - сохраняет текущие safety routes:
     - `POST ?route=antiabuse/check`;
     - `POST ?route=smartcaptcha/verify`;
   - добавляет read-only catalog routes:
     - `GET ?route=catalog/list`;
     - `GET ?route=catalog/product-status&product_id=01-0006`;
     - `GET ?route=products` как compatibility alias.

4. Новые DB/API сущности не используют старый термин `Импульс`.
   Актуальный термин: `Эхо`.

## Каноническая модель статусов

Использовать только:

- `available` — можно заказать;
- `first_form` — обнаружен сигнал/ожидает Перехода, заказать нельзя;
- `transition_complete` — Переход завершён, заказать нельзя.

Не возвращать frontend-у старую модель `reserved/sold/unavailable` как основную.
Если такие статусы уже есть в старых таблицах, их нужно маппить:

- `reserved`, `paid`, `payment_confirmed` → `first_form`;
- `sold` → `transition_complete`.

## Пошаговый план для пользователя

### Шаг 1. Проверить таблицу `products` в YDB

Открыть:

Yandex Cloud → Managed Service for YDB → `echoworld-db` → Query / SQL / YQL console.

Понять, существует ли таблица `products`.

Если таблицы нет:

1. Открыть файл:
   `/Users/naboy/Documents/Codex/2026-07-02/files-mentioned-by-the-user-index-2/work/aintonx.github.io-cleanpush/api/echoworld-apertura-api/schema/products.yql`
2. Вставить весь код в YDB Query.
3. Выполнить.

Если таблица уже есть:

1. Не удалять её вслепую.
2. Проверить колонки.
3. Если таблица старая/короткая, добавлять только отсутствующие колонки из:
   `/Users/naboy/Documents/Codex/2026-07-02/files-mentioned-by-the-user-index-2/work/aintonx.github.io-cleanpush/api/echoworld-apertura-api/schema/products.add-missing-columns.yql`

Важно: если `ALTER TABLE ... ADD COLUMN` ругается, что колонка уже существует, эту строку пропустить и выполнить следующую.

### Шаг 2. Загрузить товары в YDB

После готовности таблицы `products` открыть файл:

`/Users/naboy/Documents/Codex/2026-07-02/files-mentioned-by-the-user-index-2/work/aintonx.github.io-cleanpush/data/products.upsert.yql`

Вставить весь код в YDB Query и выполнить.

Ожидаемый результат:

- в таблице `products` 12 товаров;
- `01-0006` имеет:
  - `status = "first_form"`;
  - `orderable = FALSE`;
  - `echo_slots = 2`.

### Шаг 3. Проверить права service account

Service account:

`echoworld-apertura-sa`

должен иметь доступ к YDB.

Если API потом выдаёт ошибку доступа, временно добавить роль на YDB:

- `ydb.editor`

Позже права можно ужать.

Не хранить секреты в GitHub.

### Шаг 4. Обновить Cloud Function

Открыть:

Yandex Cloud → Cloud Functions → `echoworld-apertura-api` → `Редактировать` / `Создать версию`.

Настройки версии:

- Runtime: `nodejs22`
- Entry point: `index.handler`
- Timeout: `15 секунд`
- Memory: `256 MB`
- Service account: `echoworld-apertura-sa`
- Public function: включено
- Source: ZIP archive
- ZIP:
  `/Users/naboy/Documents/Codex/2026-07-02/files-mentioned-by-the-user-index-2/work/aintonx.github.io-cleanpush/dist/echoworld-apertura-api-phase1b.zip`

Если ZIP не использовать, то в редактор функции нужно положить:

- `index.js` из:
  `/Users/naboy/Documents/Codex/2026-07-02/files-mentioned-by-the-user-index-2/work/aintonx.github.io-cleanpush/api/echoworld-apertura-api/index.js`
- `package.json` из:
  `/Users/naboy/Documents/Codex/2026-07-02/files-mentioned-by-the-user-index-2/work/aintonx.github.io-cleanpush/api/echoworld-apertura-api/package.json`

Переменные окружения функции:

```text
ENDPOINT=grpcs://ydb.serverless.yandexcloud.net:2135
DATABASE=/ru-central1/b1g2gnnfvrjj9u0ommhk/etntcuip4hdge6cro5nl
SMARTCAPTCHA_SERVER_KEY=<не публиковать, взять из SmartCaptcha>
```

### Шаг 5. Проверить API вручную

Открыть в браузере:

```text
https://functions.yandexcloud.net/d4e5vcvae4csacbacs2i?route=catalog/list
```

Ожидаемо:

```json
{
  "ok": true,
  "route": "GET /catalog/list",
  "schema": "echoworld.catalog.list.v1",
  "count": 12,
  "products": []
}
```

`products` должен быть массивом из 12 товаров.

Потом открыть:

```text
https://functions.yandexcloud.net/d4e5vcvae4csacbacs2i?route=catalog/product-status&product_id=01-0006
```

Ожидаемо:

```json
{
  "ok": true,
  "route": "GET /catalog/product-status",
  "schema": "echoworld.catalog.product-status.v1",
  "product_id": "01-0006",
  "relic_code": "RELIC-01-0006",
  "status": "first_form",
  "orderable": false
}
```

Также проверить:

```text
https://functions.yandexcloud.net/d4e5vcvae4csacbacs2i?route=catalog/product-status&product_id=01-0001
```

Ожидаемо:

```json
{
  "status": "available",
  "orderable": true
}
```

### Шаг 6. Пока не включать frontend API

В `index.html` уже есть флаги:

- `catalogList`;
- `productStatus`;
- `businessApi`.

Но сейчас их нельзя просто включить все сразу.

Причина: `businessApi` является master switch для будущих оплат/заказов/загрузок, а нам пока нужен только read-only catalog. Следующий чат должен либо:

1. добавить отдельный безопасный read-only-флаг для catalog routes;
2. либо включать catalog API очень точечно, не включая оплату/заказы.

До ручной проверки API сайт должен продолжать работать на локальном каталоге из `index.html`.

## Object Storage — не забыть, но не делать сейчас

Object Storage понадобится позже для Эхо-аудио.

Новая сущность должна называться через `echo`, не через старый термин.

Рекомендованное будущее имя bucket:

- `echoworld-echo-audio`

Нельзя делать прямую публичную запись из frontend в bucket.
Правильная будущая схема:

1. frontend просит backend создать upload target;
2. backend создаёт object key;
3. backend выдаёт короткоживущую upload-ссылку;
4. frontend загружает файл;
5. backend подтверждает, что файл реально есть;
6. только после этого запись Эхо считается принятой.

## YooKassa — не делать сейчас

YooKassa подключается позже, после:

1. стабильной YDB catalog API;
2. схем заказов/резервов;
3. юридических документов;
4. корректных статусов товара;
5. ручной проверки возврата ошибок.

Frontend не должен сам создавать payment URL.
Платёжная ссылка должна приходить только от backend после создания заказа/резерва.

## Промт для следующего чата

```text
Продолжаем EchoWorld / MARKETSPACE. Нужно довести до рабочего состояния DB Phase 1B.

Пользователь новичок, нужны пошаговые инструкции.

Важно: пользователь ещё ничего не применял в Yandex Cloud после подготовки файлов.

Уже создано в репозитории:
- /Users/naboy/Documents/Codex/2026-07-02/files-mentioned-by-the-user-index-2/work/aintonx.github.io-cleanpush/data/products.seed.json
- /Users/naboy/Documents/Codex/2026-07-02/files-mentioned-by-the-user-index-2/work/aintonx.github.io-cleanpush/data/products.upsert.yql
- /Users/naboy/Documents/Codex/2026-07-02/files-mentioned-by-the-user-index-2/work/aintonx.github.io-cleanpush/scripts/extract-products-from-index.js
- /Users/naboy/Documents/Codex/2026-07-02/files-mentioned-by-the-user-index-2/work/aintonx.github.io-cleanpush/scripts/build-products-upsert-yql.js
- /Users/naboy/Documents/Codex/2026-07-02/files-mentioned-by-the-user-index-2/work/aintonx.github.io-cleanpush/api/echoworld-apertura-api/index.js
- /Users/naboy/Documents/Codex/2026-07-02/files-mentioned-by-the-user-index-2/work/aintonx.github.io-cleanpush/api/echoworld-apertura-api/package.json
- /Users/naboy/Documents/Codex/2026-07-02/files-mentioned-by-the-user-index-2/work/aintonx.github.io-cleanpush/api/echoworld-apertura-api/schema/products.yql
- /Users/naboy/Documents/Codex/2026-07-02/files-mentioned-by-the-user-index-2/work/aintonx.github.io-cleanpush/api/echoworld-apertura-api/schema/products.add-missing-columns.yql
- /Users/naboy/Documents/Codex/2026-07-02/files-mentioned-by-the-user-index-2/work/aintonx.github.io-cleanpush/dist/echoworld-apertura-api-phase1b.zip

Yandex Cloud:
- Cloud: echoworld-cloud
- Folder: default
- YDB: echoworld-db
- Database path: /ru-central1/b1g2gnnfvrjj9u0ommhk/etntcuip4hdge6cro5nl
- Endpoint: grpcs://ydb.serverless.yandexcloud.net:2135
- Cloud Function: echoworld-apertura-api
- Function URL: https://functions.yandexcloud.net/d4e5vcvae4csacbacs2i
- Service account: echoworld-apertura-sa
- Runtime: nodejs22
- Entry point: index.handler

Что нужно сделать:
1. Проверить, есть ли YDB table products.
2. Если нет, выполнить products.yql.
3. Если есть, проверить колонки и добавить только недостающие из products.add-missing-columns.yql.
4. Выполнить data/products.upsert.yql.
5. Обновить Cloud Function кодом из api/echoworld-apertura-api или ZIP dist/echoworld-apertura-api-phase1b.zip.
6. Проверить env vars: ENDPOINT, DATABASE, SMARTCAPTCHA_SERVER_KEY.
7. Проверить права service account echoworld-apertura-sa к YDB.
8. Проверить:
   https://functions.yandexcloud.net/d4e5vcvae4csacbacs2i?route=catalog/list
   https://functions.yandexcloud.net/d4e5vcvae4csacbacs2i?route=catalog/product-status&product_id=01-0006

Ожидаемое:
- catalog/list отдаёт ok=true, count=12, products массив.
- product 01-0006 отдаёт status=first_form и orderable=false.

Нельзя сейчас:
- подключать YooKassa;
- создавать реальные заказы;
- включать оплату;
- подключать Object Storage;
- включать frontend API без ручной проверки;
- использовать старый термин Импульс для новых DB/API сущностей.

Актуальный термин: Эхо.
Статусы: available, first_form, transition_complete.
```
