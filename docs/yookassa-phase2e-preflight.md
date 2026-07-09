# EchoWorld · YooKassa Phase 2E preflight

## Назначение

Этот файл фиксирует, что сайт подготовлен к подаче заявки в ЮKassa и к последующему подключению ключей без переписывания frontend-логики.

## Что уже подготовлено

- Публичная оферта обновлена под оплату через ЮKassa, НПД и чек самозанятого.
- Политика конфиденциальности обновлена под передачу данных платёжному провайдеру и регистрацию дохода в сервисе «Мой налог».
- Checkout показывает пользователю, что оплата откроется через ЮKassa, а банковские данные не хранятся EchoWorld.
- Добавлен backend route `POST ?route=payment/create`.
- Frontend-кнопка «Перейти к оплате» вызывает `payment/create`.
- Если ключей ЮKassa ещё нет, backend безопасно возвращает `payment_provider_not_configured`, а frontend показывает APERTURA STATUS «Платёжный канал готовится.»
- После добавления ключей `payment/create` создаёт redirect-платёж ЮKassa и возвращает `confirmation_url`.
- `checkout/status` умеет обновлять статус уже созданного платежа по `payment_id`, если ключи ЮKassa настроены.
- Успешная оплата фиксирует заказ как `paid`, но не переводит реликвию в `transition_complete`.

## Env-переменные Cloud Function

Добавить в `echoworld-apertura-api` после получения данных от ЮKassa:

```text
YOOKASSA_SHOP_ID=<shop_id из ЮKassa>
YOOKASSA_SECRET_KEY=<secret_key из ЮKassa>
YOOKASSA_RETURN_URL=https://www.echoworld.space/?payment=return
```

Секретный ключ нельзя коммитить в GitHub и нельзя вставлять в `index.html`.

## Проверка до получения ключей

В браузере:

```js
inspectYooKassaFrontendReadiness()
```

Ожидаемо:

```text
ok: true
functions.createPayment: "function"
functions.goPayment: "function"
paymentCreateRoute содержит route=payment/create
```

Backend без ключей:

```js
fetch('https://functions.yandexcloud.net/d4e5vcvae4csacbacs2i?route=payment/create', {
  method: 'POST',
  headers: {'Content-Type':'application/json'},
  body: JSON.stringify({order_id:'ord_fake', reservation_id:'res_fake', status_token:'fake'})
}).then(async r => ({status:r.status, body: await r.json()})).then(console.log)
```

Для fake order допустимо получить `order_not_found`. Для настоящего active order без ключей ожидаемо: `payment_provider_not_configured`.

## Проверка после получения ключей

1. Добавить env-переменные в Yandex Cloud Function.
2. Создать новый заказ через checkout.
3. Нажать «Перейти к оплате».
4. Ожидаемо: backend создаёт платёж и возвращает `confirmation_url`, frontend уводит пользователя на страницу ЮKassa.
5. После возврата на `?payment=return` сайт проверяет `checkout/status`.
6. Если ЮKassa уже отдаёт `succeeded`, заказ должен стать `payment_status: succeeded`, `status: paid`.

## Что ещё не сделано

- Webhook `payment.succeeded` / `payment.canceled` / `payment.waiting_for_capture` — следующий этап Phase 2F.
- Автоматическое создание НПД-чека через ЮKassa не реализовано. Для самозанятого чек нужно регистрировать через «Мой налог» и передавать покупателю.
- Refund flow через API — отдельный этап после боевого подключения.
