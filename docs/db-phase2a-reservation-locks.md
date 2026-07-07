# EchoWorld DB Phase 2A — Reservation lock layer

Phase 2A prepares the database for safe reservation of unique catalog relics before payment integration.

## Goal

Prevent two clients from reserving the same unique relic at the same time.

## Existing tables

- `products` — public catalog state.
- `product_reservations` — reservation journal/history.
- `product_orders` — product order header.
- `product_order_items` — order item snapshots.
- `customers` — customer records.

## New lock table

`product_reservation_locks` stores the current lock slot for a specific relic.

The important design decision is:

```sql
PRIMARY KEY (`product_id`)
```

This means one `product_id` can have only one row in this lock table.
The table is separate from `products` so the read-only catalog overlay remains clean and stable.

## Status dictionary

Internal reservation statuses:

- `active` — reservation is active.
- `expired` — reservation expired.
- `converted` — reservation became an order.
- `cancelled` — reservation was cancelled.

These are internal API/DB statuses, not public catalog labels.

## Created in YDB

Table schema:

```sql
CREATE TABLE `product_reservation_locks` (
    `product_id` Utf8 NOT NULL,
    `reservation_id` Utf8,
    `reservation_code` Utf8,
    `status` Utf8,
    `customer_id` Utf8,
    `reserved_until` Timestamp,
    `created_at` Timestamp,
    `updated_at` Timestamp,
    `expired_at` Timestamp,
    `converted_order_id` Utf8,
    PRIMARY KEY (`product_id`)
)
WITH (
    AUTO_PARTITIONING_BY_SIZE = ENABLED,
    AUTO_PARTITIONING_PARTITION_SIZE_MB = 2048
);
```

## Current state after creation

Expected check:

```sql
SELECT COUNT(*) AS locks_count
FROM product_reservation_locks;
```

Expected result:

```text
locks_count = 0
```

## Next backend phase

Next route to design: `POST /reservation/create` or `POST /checkout/reserve`.

It should initially be backend-only and not connected to the public checkout until tested.

Expected behavior:

1. Validate product exists in `products`.
2. Check `status = available` and `orderable = true`.
3. Create a lock row in `product_reservation_locks` using `product_id` as key.
4. Create a journal row in `product_reservations`.
5. Return reservation details and expiration time.
6. If a lock already exists, return a clean conflict response instead of creating a second reservation.

