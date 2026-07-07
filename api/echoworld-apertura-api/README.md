# EchoWorld Apertura API

Phase 1B/1C backend source for the Yandex Cloud Function `echoworld-apertura-api`.

This package provides read-only catalog routes for YDB:

- `GET ?route=catalog/list`
- `GET ?route=catalog/product-status&product_id=01-0001`
- `GET ?route=products` as a manual compatibility alias

Existing safety routes are preserved:

- `POST ?route=antiabuse/check`
- `POST ?route=smartcaptcha/verify`

Do not use this phase for YooKassa payments, real orders, reservations, Echo writes,
audio uploads, or donation/support writes. Those are later phases.

## Required environment variables

- `ENDPOINT`
- `DATABASE`
- `SMARTCAPTCHA_SERVER_KEY`

## Apply order

1. Check whether `products` already exists in YDB.
2. If it does not exist, run `api/echoworld-apertura-api/schema/products.yql`.
3. If it already exists in an older compact shape, add only missing columns from
   `api/echoworld-apertura-api/schema/products.add-missing-columns.yql`.
4. Run `data/products.upsert.yql` in YDB.
5. Deploy this folder to the Cloud Function.
6. Keep business/write feature flags disabled. The frontend may use read-only
   catalog data, but must not create orders, reservations, payments or uploads.
7. Test:
   - `https://functions.yandexcloud.net/d4e5vcvae4csacbacs2i?route=catalog/list`
   - `https://functions.yandexcloud.net/d4e5vcvae4csacbacs2i?route=catalog/product-status&product_id=01-0006`

Expected `01-0006` status:

```json
{
  "status": "first_form",
  "orderable": false
}
```
