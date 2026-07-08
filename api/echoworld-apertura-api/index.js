const { Driver, MetadataAuthService } = require("ydb-sdk");
const https = require("https");
const querystring = require("querystring");
const crypto = require("crypto");

const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

const ENDPOINT = process.env.ENDPOINT;
const DATABASE = process.env.DATABASE;
const SMARTCAPTCHA_SERVER_KEY = process.env.SMARTCAPTCHA_SERVER_KEY || "";
const ORDER_STATUS_TOKEN_SECRET =
  process.env.ORDER_STATUS_TOKEN_SECRET ||
  process.env.STATUS_TOKEN_SECRET ||
  SMARTCAPTCHA_SERVER_KEY ||
  DATABASE ||
  "echoworld-local-dev";

let driverPromise = null;

function json(statusCode, body) {
  return {
    statusCode,
    headers: HEADERS,
    body: JSON.stringify(body)
  };
}

function getMethod(event) {
  return (
    event?.httpMethod ||
    event?.requestContext?.http?.method ||
    "GET"
  ).toUpperCase();
}

function getQuery(event) {
  return event?.queryStringParameters || {};
}

function parseBody(event) {
  if (!event || !event.body) return {};

  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("utf8")
      : event.body;

    if (!raw) return {};

    try {
      return JSON.parse(raw);
    } catch (_) {
      return querystring.parse(raw);
    }
  } catch (_) {
    return {};
  }
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeRoute(event) {
  const query = getQuery(event);
  const route = query.route || query.r || "";

  if (route) return String(route).replace(/^\/+/, "");

  const path =
    event?.path ||
    event?.rawPath ||
    event?.requestContext?.http?.path ||
    "";

  return String(path).replace(/^\/+/, "");
}

async function getDriver() {
  if (!ENDPOINT || !DATABASE) {
    throw new Error("Missing ENDPOINT or DATABASE env");
  }

  if (!driverPromise) {
    driverPromise = (async () => {
      const driver = new Driver({
        endpoint: ENDPOINT,
        database: DATABASE,
        authService: new MetadataAuthService()
      });

      const ready = await driver.ready(10000);

      if (!ready) {
        throw new Error("YDB driver is not ready");
      }

      return driver;
    })();
  }

  return driverPromise;
}

function unwrapYdbValue(value) {
  if (value === null || value === undefined) return null;

  if (typeof value !== "object") return value;

  if ("textValue" in value) return value.textValue;
  if ("utf8Value" in value) return value.utf8Value;
  if ("stringValue" in value) return value.stringValue;
  if ("bytesValue" in value) return value.bytesValue;

  if ("uint64Value" in value) return Number(value.uint64Value);
  if ("int64Value" in value) return Number(value.int64Value);
  if ("uint32Value" in value) return Number(value.uint32Value);
  if ("int32Value" in value) return Number(value.int32Value);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("floatValue" in value) return Number(value.floatValue);

  if ("boolValue" in value) return Boolean(value.boolValue);

  if ("optionalValue" in value) return unwrapYdbValue(value.optionalValue);
  if ("nestedValue" in value) return unwrapYdbValue(value.nestedValue);
  if ("value" in value) return unwrapYdbValue(value.value);

  return value;
}

function resultSetToObjects(resultSet) {
  if (!resultSet) return [];

  const columns = (resultSet.columns || []).map((column) => column.name);
  const rows = resultSet.rows || [];

  return rows.map((row) => {
    const items = row.items || [];
    const itemMap = {};

    columns.forEach((name, index) => {
      itemMap[name] = unwrapYdbValue(items[index]);
    });

    return itemMap;
  });
}

async function ydbQuery(query, params = {}) {
  const driver = await getDriver();

  return await driver.tableClient.withSession(async (session) => {
    const preparedQuery = await session.prepareQuery(query);
    const result = await session.executeQuery(preparedQuery, params);
    return result.resultSets || [];
  });
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return 0;

  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function isOrderableByStatus(status) {
  return String(status || "").trim() === "available";
}

function productFromRow(row) {
  const status = row.status || "";

  return {
    product_id: row.product_id,
    relic_code: row.relic_code,
    title: row.title,
    subtitle: row.subtitle || "",
    description: row.description || "",
    price_rub: toNumber(row.price_rub_text),
    power_code: row.power_code,
    power_label: row.power_label,
    echo_slots: toNumber(row.echo_slots_text),
    status,
    orderable: isOrderableByStatus(status),
    visible: true,
    image_url: row.image_url || "",
    category_code: row.category_code || "",
    category_label: row.category_label || "",
    catalog_status_label: row.catalog_status_label || "",
    character_female_url: row.character_female_url || "",
    character_male_url: row.character_male_url || "",
    sort_order: toNumber(row.sort_order_text),
    updated_at: row.updated_at || ""
  };
}

async function catalogList() {
  const query = `
    SELECT
      product_id,
      relic_code,
      title,
      subtitle,
      description,
      CAST(price_rub AS Utf8) AS price_rub_text,
      power_code,
      power_label,
      CAST(echo_slots AS Utf8) AS echo_slots_text,
      status,
      image_url,
      category_code,
      category_label,
      catalog_status_label,
      character_female_url,
      character_male_url,
      CAST(sort_order AS Utf8) AS sort_order_text,
      updated_at
    FROM products
    WHERE visible = TRUE
    ORDER BY sort_order ASC;
  `;

  const resultSets = await ydbQuery(query);
  const rows = resultSetToObjects(resultSets[0]);
  const products = rows.map(productFromRow);

  return json(200, {
    ok: true,
    route: "GET /catalog/list",
    schema: "echoworld.catalog.list.v1",
    count: products.length,
    products,
    ts: nowIso()
  });
}

async function productStatus(productId) {
  if (!productId) {
    return json(400, {
      ok: false,
      route: "GET /catalog/product-status",
      error: "missing_product_id"
    });
  }

  const safeProductId = String(productId).replace(/[^0-9-]/g, "");

  await expireReservationLockForProduct(safeProductId);
  await expireStaleCheckoutLockForProduct(safeProductId);

  const query = `
    SELECT
      product_id,
      relic_code,
      title,
      status,
      CAST(echo_slots AS Utf8) AS echo_slots_text,
      CAST(price_rub AS Utf8) AS price_rub_text,
      power_code,
      power_label,
      catalog_status_label,
      updated_at
    FROM products
    WHERE product_id = "${safeProductId}"
    LIMIT 1;
  `;

  const resultSets = await ydbQuery(query);
  const rows = resultSetToObjects(resultSets[0]);

  if (!rows.length) {
    return json(404, {
      ok: false,
      route: "GET /catalog/product-status",
      schema: "echoworld.catalog.product-status.v1",
      product_id: safeProductId,
      error: "product_not_found",
      ts: nowIso()
    });
  }

  const row = rows[0];
  const status = row.status || "";

  return json(200, {
    ok: true,
    route: "GET /catalog/product-status",
    schema: "echoworld.catalog.product-status.v1",
    product_id: row.product_id,
    relic_code: row.relic_code,
    title: row.title,
    status,
    orderable: isOrderableByStatus(status),
    visible: true,
    echo_slots: toNumber(row.echo_slots_text),
    price_rub: toNumber(row.price_rub_text),
    power_code: row.power_code,
    power_label: row.power_label,
    catalog_status_label: row.catalog_status_label || "",
    updated_at: row.updated_at || "",
    ts: nowIso()
  });
}

function safeProductId(value) {
  return String(value || "").trim().replace(/[^0-9-]/g, "");
}

function cleanScalar(value, maxLength = 256) {
  const text = String(value === null || value === undefined ? "" : value)
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .trim();

  return text.slice(0, maxLength);
}

function yqlUtf8(value) {
  return JSON.stringify(cleanScalar(value, 2000));
}

function yqlTimestampFromMs(ms) {
  const safeMs = Math.max(0, Math.floor(Number(ms) || 0));
  return `DateTime::FromMilliseconds(CAST(${safeMs} AS Uint64))`;
}

function makeReservationId() {
  return `res_${Date.now().toString(36)}_${crypto.randomBytes(8).toString("hex")}`;
}

function makeReservationCode(productId) {
  const compact = String(productId || "").replace(/[^0-9]/g, "");
  return `EWR-${compact}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

function isDuplicatePrimaryKeyError(error) {
  const message = String(error && (error.message || error.stack || error) || "");
  return /PRECONDITION_FAILED|insert_pk|constraint violation|already exists|duplicate/i.test(message);
}

function isTrueFlag(value) {
  if (value === true) return true;
  if (value === 1) return true;

  return String(value || "").trim().toLowerCase() === "true";
}

function reservationPayload(event) {
  const body = parseBody(event);
  const query = getQuery(event);

  const rawProductId =
    body.product_id ||
    body.relic_id ||
    body.productId ||
    body.relicId ||
    query.product_id ||
    query.relic_id ||
    query.productId ||
    query.relicId ||
    "";

  const reserveMinutesRaw =
    body.reserve_minutes ||
    body.reserveMinutes ||
    query.reserve_minutes ||
    query.reserveMinutes ||
    15;

  const reserveMinutesNumber = Number(reserveMinutesRaw);
  const reserveMinutes = Number.isFinite(reserveMinutesNumber)
    ? Math.min(30, Math.max(5, Math.floor(reserveMinutesNumber)))
    : 15;

  return {
    productId: safeProductId(rawProductId),
    customerId: cleanScalar(body.customer_id || body.customerId || query.customer_id || query.customerId || "", 128),
    clientSessionId: cleanScalar(body.client_session_id || body.clientSessionId || query.client_session_id || query.clientSessionId || "", 160),
    checkoutDraftId: cleanScalar(body.checkout_draft_id || body.checkoutDraftId || query.checkout_draft_id || query.checkoutDraftId || "", 160),
    reserveMinutes
  };
}

async function readReservationProduct(productId) {
  const query = `
    SELECT
      product_id,
      relic_code,
      title,
      status,
      orderable,
      CAST(orderable AS Utf8) AS orderable_text,
      visible,
      CAST(visible AS Utf8) AS visible_text,
      CAST(price_rub AS Utf8) AS price_rub_text,
      power_code,
      power_label,
      catalog_status_label,
      CAST(echo_slots AS Utf8) AS echo_slots_text,
      updated_at
    FROM products
    WHERE product_id = ${yqlUtf8(productId)}
    LIMIT 1;
  `;

  const resultSets = await ydbQuery(query);
  const rows = resultSetToObjects(resultSets[0]);
  return rows[0] || null;
}

async function expireReservationLockForProduct(productId) {
  const safe = safeProductId(productId);

  const markJournalQuery = `
    UPDATE product_reservations
    SET
      status = "expired",
      expired_at = CurrentUtcTimestamp(),
      updated_at = CurrentUtcTimestamp()
    WHERE
      product_id = ${yqlUtf8(safe)}
      AND status = "active"
      AND reserved_until < CurrentUtcTimestamp();
  `;

  const removeLockQuery = `
    DELETE FROM product_reservation_locks
    WHERE
      product_id = ${yqlUtf8(safe)}
      AND status = "active"
      AND reserved_until < CurrentUtcTimestamp();
  `;

  await ydbQuery(markJournalQuery);
  await ydbQuery(removeLockQuery);
}

async function readReservationLock(productId) {
  const query = `
    SELECT
      product_id,
      reservation_id,
      reservation_code,
      status,
      CAST(reserved_until AS Utf8) AS reserved_until_text,
      customer_id,
      converted_order_id
    FROM product_reservation_locks
    WHERE product_id = ${yqlUtf8(productId)}
    LIMIT 1;
  `;

  const resultSets = await ydbQuery(query);
  const rows = resultSetToObjects(resultSets[0]);
  return rows[0] || null;
}

async function createReservationLock(payload, product) {
  const reservationId = makeReservationId();
  const reservationCode = makeReservationCode(payload.productId);
  const nowMs = Date.now();
  const reservedUntilMs = nowMs + payload.reserveMinutes * 60 * 1000;
  const reservedUntilIso = new Date(reservedUntilMs).toISOString();

  const insertLockQuery = `
    INSERT INTO product_reservation_locks (
      product_id,
      reservation_id,
      reservation_code,
      status,
      customer_id,
      reserved_until,
      created_at,
      updated_at
    )
    VALUES (
      ${yqlUtf8(payload.productId)},
      ${yqlUtf8(reservationId)},
      ${yqlUtf8(reservationCode)},
      "active",
      ${yqlUtf8(payload.customerId)},
      ${yqlTimestampFromMs(reservedUntilMs)},
      CurrentUtcTimestamp(),
      CurrentUtcTimestamp()
    );
  `;

  const insertJournalQuery = `
    INSERT INTO product_reservations (
      id,
      reservation_code,
      product_id,
      status,
      reserved_until,
      created_at,
      updated_at
    )
    VALUES (
      ${yqlUtf8(reservationId)},
      ${yqlUtf8(reservationCode)},
      ${yqlUtf8(payload.productId)},
      "active",
      ${yqlTimestampFromMs(reservedUntilMs)},
      CurrentUtcTimestamp(),
      CurrentUtcTimestamp()
    );
  `;

  await ydbQuery(insertLockQuery);

  try {
    await ydbQuery(insertJournalQuery);
  } catch (error) {
    const rollbackLockQuery = `
      DELETE FROM product_reservation_locks
      WHERE
        product_id = ${yqlUtf8(payload.productId)}
        AND reservation_id = ${yqlUtf8(reservationId)};
    `;

    try {
      await ydbQuery(rollbackLockQuery);
    } catch (rollbackError) {
      console.error("ECHOWORLD_RESERVATION_ROLLBACK_ERROR", {
        message: rollbackError.message,
        product_id: payload.productId,
        reservation_id: reservationId
      });
    }

    throw error;
  }

  return {
    reservation_id: reservationId,
    reservation_code: reservationCode,
    status: "active",
    reserved_until: reservedUntilIso,
    reserve_minutes: payload.reserveMinutes,
    product_id: product.product_id,
    relic_code: product.relic_code,
    title: product.title
  };
}

async function reservationCreate(event) {
  const payload = reservationPayload(event);

  if (!payload.productId) {
    return json(400, {
      ok: false,
      route: "POST /reservations/create",
      schema: "echoworld.reservation.create.v1",
      error: "missing_product_id",
      ts: nowIso()
    });
  }

  await expireReservationLockForProduct(payload.productId);
  await expireStaleCheckoutLockForProduct(payload.productId);

  const product = await readReservationProduct(payload.productId);

  if (!product) {
    return json(404, {
      ok: false,
      route: "POST /reservations/create",
      schema: "echoworld.reservation.create.v1",
      product_id: payload.productId,
      error: "product_not_found",
      ts: nowIso()
    });
  }

  const status = String(product.status || "").trim();
  const dbOrderable = isTrueFlag(product.orderable) || isTrueFlag(product.orderable_text);
  const dbVisible = isTrueFlag(product.visible) || isTrueFlag(product.visible_text);
  const productOrderable = dbOrderable && dbVisible && isOrderableByStatus(status);

  if (!productOrderable) {
    return json(409, {
      ok: false,
      route: "POST /reservations/create",
      schema: "echoworld.reservation.create.v1",
      product_id: product.product_id,
      relic_code: product.relic_code,
      title: product.title,
      status,
      orderable: false,
      catalog_status_label: product.catalog_status_label || "",
      error: "product_not_orderable",
      ts: nowIso()
    });
  }

  const existingLock = await readReservationLock(payload.productId);

  if (existingLock) {
    return json(409, {
      ok: false,
      route: "POST /reservations/create",
      schema: "echoworld.reservation.create.v1",
      product_id: product.product_id,
      relic_code: product.relic_code,
      title: product.title,
      error: "product_already_reserved",
      lock: {
        reservation_id: existingLock.reservation_id || "",
        reservation_code: existingLock.reservation_code || "",
        status: existingLock.status || "",
        reserved_until: existingLock.reserved_until_text || ""
      },
      ts: nowIso()
    });
  }

  try {
    const reservation = await createReservationLock(payload, product);

    return json(201, {
      ok: true,
      route: "POST /reservations/create",
      schema: "echoworld.reservation.create.v1",
      mode: "reservation_only_no_payment",
      reservation,
      product: {
        product_id: product.product_id,
        relic_code: product.relic_code,
        title: product.title,
        status,
        orderable: true,
        price_rub: toNumber(product.price_rub_text),
        power_code: product.power_code,
        power_label: product.power_label,
        echo_slots: toNumber(product.echo_slots_text),
        catalog_status_label: product.catalog_status_label || ""
      },
      order: {
        created: false,
        reason: "phase2a_reservation_only"
      },
      payment: {
        status: "not_started",
        provider: null,
        payment_id: null
      },
      ts: nowIso()
    });
  } catch (error) {
    if (isDuplicatePrimaryKeyError(error)) {
      const lock = await readReservationLock(payload.productId);

      return json(409, {
        ok: false,
        route: "POST /reservations/create",
        schema: "echoworld.reservation.create.v1",
        product_id: product.product_id,
        relic_code: product.relic_code,
        title: product.title,
        error: "product_already_reserved",
        lock: lock ? {
          reservation_id: lock.reservation_id || "",
          reservation_code: lock.reservation_code || "",
          status: lock.status || "",
          reserved_until: lock.reserved_until_text || ""
        } : null,
        ts: nowIso()
      });
    }

    throw error;
  }
}


function normalizeBackendProductId(value) {
  const text = String(value || "").trim();
  const match = text.match(/\d{2}-\d{4}/);
  if (match) return match[0];
  return safeProductId(text).replace(/^-+/, "");
}

function yqlInt32(value) {
  const n = Math.max(0, Math.min(2147483647, Math.floor(Number(value) || 0)));
  return `CAST(${n} AS Int32)`;
}

function yqlNullableUtf8(value, maxLength = 2000) {
  const text = cleanScalar(value, maxLength);
  return text ? yqlUtf8(text) : "NULL";
}

function makeHashId(prefix, parts, length = 24) {
  const hash = crypto
    .createHash("sha256")
    .update(parts.filter(Boolean).join("|"))
    .digest("hex")
    .slice(0, length);

  return `${prefix}_${hash}`;
}

function makeCustomerId(customer) {
  return makeHashId("cust", [
    String(customer.email || "").trim().toLowerCase(),
    String(customer.phone || "").replace(/\D+/g, ""),
    String(customer.name || "").trim().toLowerCase()
  ], 24);
}

function makeOrderId(reservationId) {
  return makeHashId("ord", [reservationId], 26);
}

function makeOrderItemId(orderId, productId) {
  return makeHashId("oi", [orderId, productId], 26);
}

function makeOrderNumber(reservationId) {
  const d = new Date();
  const date = [
    d.getUTCFullYear(),
    String(d.getUTCMonth() + 1).padStart(2, "0"),
    String(d.getUTCDate()).padStart(2, "0")
  ].join("");
  const tail = crypto.createHash("sha256").update(String(reservationId || "")).digest("hex").slice(0, 6).toUpperCase();
  return `EWO-${date}-${tail}`;
}

function makeOrderStatusToken(order) {
  const source = [
    order && order.id,
    order && order.order_number,
    order && order.customer_id,
    order && order.reservation_id
  ].map((value) => String(value || "")).join("|");

  return crypto
    .createHmac("sha256", String(ORDER_STATUS_TOKEN_SECRET || ""))
    .update(source)
    .digest("hex")
    .slice(0, 48);
}

function verifyOrderStatusToken(order, token) {
  const expected = makeOrderStatusToken(order);
  const received = cleanScalar(token, 120);

  if (!expected || !received) return false;

  try {
    const expectedBuffer = Buffer.from(expected);
    const receivedBuffer = Buffer.from(received);
    return expectedBuffer.length === receivedBuffer.length &&
      crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
  } catch (_) {
    return false;
  }
}

function isPaymentStatusProtectedFromShortExpiry(status) {
  const normalized = String(status || "").trim().toLowerCase();
  return normalized === "pending" ||
    normalized === "waiting_for_capture" ||
    normalized === "succeeded";
}

function isPaymentStatusSafeToExpire(status) {
  const normalized = String(status || "").trim().toLowerCase();
  return !normalized || normalized === "not_started" || normalized === "canceled" || normalized === "cancelled";
}

function isLockTimeExpired(lock) {
  const raw = lock && (lock.reserved_until_text || lock.reserved_until || lock.expires_at || "");
  const ts = Date.parse(String(raw || ""));
  return Number.isFinite(ts) && ts > 0 && ts < Date.now();
}

function checkoutCreatePayload(event) {
  const body = parseBody(event);
  const query = getQuery(event);
  const orderPayload = body.orderPayload || body.order_payload || body.order || body.payload || body;
  const reservation = body.reservation || orderPayload.reservation || body.checkoutReservation || orderPayload.checkoutReservation || {};
  const items = Array.isArray(orderPayload.items) ? orderPayload.items : (Array.isArray(body.items) ? body.items : []);
  const item = items[0] || body.item || {};
  const customerRaw = orderPayload.customer || body.customer || {};
  const deliveryRaw = orderPayload.delivery || body.delivery || {};
  const totalsRaw = orderPayload.totals || body.totals || {};

  const reservationId = cleanScalar(
    body.reservation_id ||
    body.reservationId ||
    reservation.reservation_id ||
    reservation.reservationId ||
    query.reservation_id ||
    "",
    160
  );

  const reservationCode = cleanScalar(
    body.reservation_code ||
    body.reservationCode ||
    reservation.reservation_code ||
    reservation.reservationCode ||
    "",
    80
  );

  const productId = normalizeBackendProductId(
    body.product_id ||
    body.productId ||
    reservation.product_id ||
    reservation.productId ||
    item.relicId ||
    item.product_id ||
    item.productId ||
    item.id ||
    query.product_id ||
    ""
  );

  const customer = {
    name: cleanScalar(customerRaw.name || body.customer_name || body.name || "", 120),
    email: cleanScalar(customerRaw.email || body.customer_email || body.email || "", 160),
    phone: cleanScalar(customerRaw.phone || body.customer_phone || body.phone || "", 80),
    telegram: cleanScalar(customerRaw.telegram || body.telegram || "", 80)
  };

  const delivery = {
    method: cleanScalar(deliveryRaw.method || body.delivery_method || "post_ru", 80),
    address: cleanScalar(deliveryRaw.address || body.delivery_address || body.address || "", 600),
    price: toNumber(deliveryRaw.price || body.delivery_price_rub || 0)
  };

  const echoSlots = Array.isArray(item.echoSlots) ? item.echoSlots : [];
  const clientSessionId = cleanScalar(orderPayload.clientSessionId || body.client_session_id || body.clientSessionId || "", 160);
  const checkoutDraftId = cleanScalar(orderPayload.checkoutDraftId || body.checkout_draft_id || body.checkoutDraftId || "", 160);
  const idempotencyKey = cleanScalar(orderPayload.idempotencyKey || body.idempotency_key || checkoutDraftId || reservationId, 180);

  const debugComment = JSON.stringify({
    phase: "phase2c_order_without_payment",
    clientSessionId,
    checkoutDraftId,
    idempotencyKey,
    reservationCode,
    echoSlots,
    frontendTotal: toNumber(totalsRaw.total || body.total_rub || 0)
  });

  return {
    reservationId,
    reservationCode,
    productId,
    customer,
    delivery,
    item,
    clientSessionId,
    checkoutDraftId,
    idempotencyKey,
    customerComment: cleanScalar(body.customer_comment || orderPayload.customerComment || debugComment, 1800)
  };
}

async function readCheckoutReservationLock(productId, reservationId) {
  let query;

  if (productId) {
    query = `
      SELECT
        product_id,
        reservation_id,
        reservation_code,
        status,
        customer_id,
        CAST(reserved_until AS Utf8) AS reserved_until_text,
        converted_order_id
      FROM product_reservation_locks
      WHERE product_id = ${yqlUtf8(productId)}
      LIMIT 1;
    `;
  } else {
    query = `
      SELECT
        product_id,
        reservation_id,
        reservation_code,
        status,
        customer_id,
        CAST(reserved_until AS Utf8) AS reserved_until_text,
        converted_order_id
      FROM product_reservation_locks
      WHERE reservation_id = ${yqlUtf8(reservationId)}
      LIMIT 1;
    `;
  }

  const resultSets = await ydbQuery(query);
  const rows = resultSetToObjects(resultSets[0]);
  const lock = rows[0] || null;

  if (!lock) return null;
  if (reservationId && lock.reservation_id !== reservationId) return null;

  return lock;
}

async function readCheckoutOrderByReservation(reservationId) {
  if (!reservationId) return null;

  const query = `
    SELECT
      id,
      order_number,
      customer_id,
      reservation_id,
      status,
      delivery_method,
      delivery_address,
      customer_comment,
      CAST(subtotal_rub AS Utf8) AS subtotal_rub_text,
      CAST(delivery_price_rub AS Utf8) AS delivery_price_rub_text,
      CAST(total_rub AS Utf8) AS total_rub_text,
      payment_status,
      payment_provider,
      payment_id,
      CAST(created_at AS Utf8) AS created_at_text,
      CAST(updated_at AS Utf8) AS updated_at_text
    FROM product_orders
    WHERE reservation_id = ${yqlUtf8(reservationId)}
    ORDER BY created_at DESC
    LIMIT 1;
  `;

  const resultSets = await ydbQuery(query);
  const rows = resultSetToObjects(resultSets[0]);
  return rows[0] || null;
}

async function readCheckoutOrderById(orderId) {
  if (!orderId) return null;

  const query = `
    SELECT
      id,
      order_number,
      customer_id,
      reservation_id,
      status,
      delivery_method,
      delivery_address,
      customer_comment,
      CAST(subtotal_rub AS Utf8) AS subtotal_rub_text,
      CAST(delivery_price_rub AS Utf8) AS delivery_price_rub_text,
      CAST(total_rub AS Utf8) AS total_rub_text,
      payment_status,
      payment_provider,
      payment_id,
      CAST(created_at AS Utf8) AS created_at_text,
      CAST(updated_at AS Utf8) AS updated_at_text
    FROM product_orders
    WHERE id = ${yqlUtf8(orderId)}
    LIMIT 1;
  `;

  const resultSets = await ydbQuery(query);
  const rows = resultSetToObjects(resultSets[0]);
  return rows[0] || null;
}

async function readCheckoutOrderItem(orderId) {
  if (!orderId) return null;

  const query = `
    SELECT
      id,
      order_id,
      product_id,
      title_snapshot,
      CAST(price_rub_snapshot AS Utf8) AS price_rub_snapshot_text,
      power_code_snapshot,
      power_name_snapshot,
      gender_signature,
      attr_clothing,
      attr_hair,
      attr_accessory,
      CAST(item_total_rub AS Utf8) AS item_total_rub_text,
      CAST(created_at AS Utf8) AS created_at_text
    FROM product_order_items
    WHERE order_id = ${yqlUtf8(orderId)}
    LIMIT 1;
  `;

  const resultSets = await ydbQuery(query);
  const rows = resultSetToObjects(resultSets[0]);
  return rows[0] || null;
}

async function expireCheckoutOrderIfSafe(order, lock) {
  if (!order || !lock) return { expired: false, reason: "missing_order_or_lock" };

  const orderId = cleanScalar(order.id, 100);
  const reservationId = cleanScalar(order.reservation_id || lock.reservation_id, 160);
  const productId = safeProductId(lock.product_id);
  const lockOrderId = cleanScalar(lock.converted_order_id, 100);
  const lockStatus = String(lock.status || "").trim().toLowerCase();
  const orderStatus = String(order.status || "").trim().toLowerCase();
  const paymentStatus = String(order.payment_status || "").trim().toLowerCase();
  const paymentId = cleanScalar(order.payment_id, 160);

  if (!orderId || !reservationId || !productId) return { expired: false, reason: "missing_identity" };
  if (lockStatus !== "converted") return { expired: false, reason: "lock_not_converted" };
  if (lockOrderId && lockOrderId !== orderId) return { expired: false, reason: "lock_order_mismatch" };
  if (orderStatus === "paid") {
    return { expired: false, reason: "order_paid" };
  }
  if (paymentId || isPaymentStatusProtectedFromShortExpiry(paymentStatus)) {
    return { expired: false, reason: "payment_in_progress_or_confirmed" };
  }
  if (!isPaymentStatusSafeToExpire(paymentStatus)) {
    return { expired: false, reason: "payment_status_not_safe_to_expire" };
  }
  if (!isLockTimeExpired(lock)) {
    return { expired: false, reason: "lock_window_active" };
  }

  const orderQuery = `
    UPDATE product_orders
    SET
      status = "expired",
      updated_at = CurrentUtcTimestamp()
    WHERE
      id = ${yqlUtf8(orderId)}
      AND payment_id = ""
      AND (
        payment_status = "not_started"
        OR payment_status = "canceled"
        OR payment_status = "cancelled"
      );
  `;

  const journalQuery = `
    UPDATE product_reservations
    SET
      status = "expired",
      expired_at = CurrentUtcTimestamp(),
      updated_at = CurrentUtcTimestamp()
    WHERE
      id = ${yqlUtf8(reservationId)}
      AND status = "converted"
      AND converted_order_id = ${yqlUtf8(orderId)};
  `;

  const lockQuery = `
    DELETE FROM product_reservation_locks
    WHERE
      product_id = ${yqlUtf8(productId)}
      AND reservation_id = ${yqlUtf8(reservationId)}
      AND status = "converted"
      AND converted_order_id = ${yqlUtf8(orderId)};
  `;

  await ydbQuery(orderQuery);
  await ydbQuery(journalQuery);
  await ydbQuery(lockQuery);

  return {
    expired: true,
    reason: "not_started_window_expired",
    order_id: orderId,
    reservation_id: reservationId,
    product_id: productId
  };
}

async function expireStaleCheckoutLockForProduct(productId) {
  const safe = safeProductId(productId);
  if (!safe) return { expired: false, reason: "missing_product_id" };

  const lock = await readReservationLock(safe);
  if (!lock || String(lock.status || "").toLowerCase() !== "converted" || !lock.converted_order_id) {
    return { expired: false, reason: "no_converted_lock" };
  }

  const order = await readCheckoutOrderById(lock.converted_order_id);
  return await expireCheckoutOrderIfSafe(order, lock);
}

function checkoutOrderResponse(order, item, product, lock, options = {}) {
  const statusToken = makeOrderStatusToken(order);
  const paymentStatus = order.payment_status || "not_started";

  return {
    ok: true,
    route: "POST /checkout/create",
    schema: "echoworld.checkout.create.v1",
    mode: "order_created_no_payment",
    reused: Boolean(options.reused),
    order: {
      id: order.id,
      order_number: order.order_number,
      status: order.status || "new",
      reservation_id: order.reservation_id,
      customer_id: order.customer_id,
      subtotal_rub: toNumber(order.subtotal_rub_text),
      delivery_price_rub: toNumber(order.delivery_price_rub_text),
      total_rub: toNumber(order.total_rub_text),
      payment_status: paymentStatus,
      payment_provider: order.payment_provider || "",
      payment_id: order.payment_id || "",
      status_token: statusToken,
      public_status_token: statusToken,
      expires_at: lock && lock.reserved_until_text || "",
      created_at: order.created_at_text || "",
      updated_at: order.updated_at_text || ""
    },
    item: item ? {
      id: item.id,
      order_id: item.order_id,
      product_id: item.product_id,
      title: item.title_snapshot,
      price_rub: toNumber(item.price_rub_snapshot_text),
      power_code: item.power_code_snapshot || "",
      power_label: item.power_name_snapshot || "",
      item_total_rub: toNumber(item.item_total_rub_text)
    } : null,
    product: product ? {
      product_id: product.product_id,
      relic_code: product.relic_code,
      title: product.title,
      status: product.status,
      price_rub: toNumber(product.price_rub_text),
      power_code: product.power_code,
      power_label: product.power_label,
      echo_slots: toNumber(product.echo_slots_text),
      catalog_status_label: product.catalog_status_label || ""
    } : null,
    reservation: lock ? {
      product_id: lock.product_id,
      reservation_id: lock.reservation_id,
      reservation_code: lock.reservation_code || "",
      status: lock.status || "",
      reserved_until: lock.reserved_until_text || "",
      converted_order_id: lock.converted_order_id || ""
    } : null,
    payment: {
      status: paymentStatus,
      provider: order.payment_provider || null,
      payment_id: order.payment_id || null
    },
    ts: nowIso()
  };
}

function checkoutStatusPayload(event) {
  const body = parseBody(event);
  const query = getQuery(event);

  return {
    orderId: cleanScalar(body.order_id || body.orderId || body.id || query.order_id || query.orderId || query.id || "", 120),
    reservationId: cleanScalar(body.reservation_id || body.reservationId || query.reservation_id || query.reservationId || "", 160),
    statusToken: cleanScalar(body.status_token || body.statusToken || body.token || query.status_token || query.statusToken || query.token || "", 160)
  };
}

function checkoutStatusKey(order, lock) {
  const orderStatus = String(order && order.status || "").trim().toLowerCase();
  const paymentStatus = String(order && order.payment_status || "").trim().toLowerCase();

  if (orderStatus === "expired") return "order-cycle-expired";
  if (paymentStatus === "succeeded") return "order-paid";
  if (paymentStatus === "waiting_for_capture") return "order-payment-authorized";
  if (paymentStatus === "pending") return "order-payment-waiting";
  if (paymentStatus === "canceled" || paymentStatus === "cancelled") return "order-payment-canceled";
  if (lock && isLockTimeExpired(lock) && isPaymentStatusSafeToExpire(paymentStatus) && !cleanScalar(order && order.payment_id, 160)) {
    return "order-cycle-expired";
  }
  return "order-fixed";
}

function checkoutStatusResponse(order, item, product, lock, lifecycle) {
  const statusToken = makeOrderStatusToken(order);
  const paymentStatus = order.payment_status || "not_started";
  const orderStatus = order.status || "new";
  const hasPayment = Boolean(order.payment_id);
  const lockStillHeld = Boolean(lock && lock.reservation_id);
  const stateKey = checkoutStatusKey(order, lock);

  return {
    ok: true,
    route: "GET /checkout/status",
    schema: "echoworld.checkout.status.v1",
    order: {
      id: order.id,
      order_number: order.order_number,
      status: orderStatus,
      reservation_id: order.reservation_id,
      subtotal_rub: toNumber(order.subtotal_rub_text),
      delivery_price_rub: toNumber(order.delivery_price_rub_text),
      total_rub: toNumber(order.total_rub_text),
      payment_status: paymentStatus,
      payment_provider: order.payment_provider || "",
      payment_id: order.payment_id || "",
      status_token: statusToken,
      public_status_token: statusToken,
      expires_at: lock && lock.reserved_until_text || "",
      created_at: order.created_at_text || "",
      updated_at: order.updated_at_text || ""
    },
    item: item ? {
      id: item.id,
      order_id: item.order_id,
      product_id: item.product_id,
      title: item.title_snapshot,
      price_rub: toNumber(item.price_rub_snapshot_text),
      power_code: item.power_code_snapshot || "",
      power_label: item.power_name_snapshot || "",
      item_total_rub: toNumber(item.item_total_rub_text)
    } : null,
    product: product ? {
      product_id: product.product_id,
      relic_code: product.relic_code,
      title: product.title,
      status: product.status,
      price_rub: toNumber(product.price_rub_text),
      power_code: product.power_code,
      power_label: product.power_label,
      echo_slots: toNumber(product.echo_slots_text),
      catalog_status_label: product.catalog_status_label || ""
    } : null,
    reservation: lock ? {
      product_id: lock.product_id,
      reservation_id: lock.reservation_id,
      reservation_code: lock.reservation_code || "",
      status: lock.status || "",
      reserved_until: lock.reserved_until_text || "",
      converted_order_id: lock.converted_order_id || ""
    } : null,
    payment: {
      status: paymentStatus,
      provider: order.payment_provider || null,
      payment_id: order.payment_id || null,
      has_payment: hasPayment
    },
    state: {
      key: stateKey,
      lock_held: lockStillHeld,
      can_pay: orderStatus !== "expired" && paymentStatus === "not_started" && !hasPayment && lockStillHeld,
      can_retry_payment: orderStatus !== "expired" && (paymentStatus === "canceled" || paymentStatus === "cancelled") && lockStillHeld,
      can_check: true
    },
    lifecycle: lifecycle || { expired: false },
    ts: nowIso()
  };
}

async function checkoutStatus(event) {
  const payload = checkoutStatusPayload(event);

  if (!payload.orderId && !payload.reservationId) {
    return json(400, {
      ok: false,
      route: "GET /checkout/status",
      schema: "echoworld.checkout.status.v1",
      error: "missing_order_id",
      ts: nowIso()
    });
  }

  let order = payload.orderId
    ? await readCheckoutOrderById(payload.orderId)
    : await readCheckoutOrderByReservation(payload.reservationId);

  if (!order) {
    return json(404, {
      ok: false,
      route: "GET /checkout/status",
      schema: "echoworld.checkout.status.v1",
      error: "order_not_found",
      ts: nowIso()
    });
  }

  if (!verifyOrderStatusToken(order, payload.statusToken)) {
    return json(403, {
      ok: false,
      route: "GET /checkout/status",
      schema: "echoworld.checkout.status.v1",
      error: "invalid_status_token",
      ts: nowIso()
    });
  }

  let item = await readCheckoutOrderItem(order.id);
  let productId = item && item.product_id || "";
  let lock = await readCheckoutReservationLock(productId, order.reservation_id);
  let lifecycle = await expireCheckoutOrderIfSafe(order, lock);

  if (lifecycle.expired) {
    order = await readCheckoutOrderById(order.id) || order;
    item = await readCheckoutOrderItem(order.id);
    productId = item && item.product_id || productId;
    lock = await readCheckoutReservationLock(productId, order.reservation_id);
  }

  const product = productId ? await readReservationProduct(productId) : null;

  return json(200, checkoutStatusResponse(order, item, product, lock, lifecycle));
}

async function checkoutCreate(event) {
  const payload = checkoutCreatePayload(event);

  if (!payload.reservationId) {
    return json(400, {
      ok: false,
      route: "POST /checkout/create",
      schema: "echoworld.checkout.create.v1",
      error: "missing_reservation_id",
      ts: nowIso()
    });
  }

  if (!payload.productId) {
    return json(400, {
      ok: false,
      route: "POST /checkout/create",
      schema: "echoworld.checkout.create.v1",
      error: "missing_product_id",
      ts: nowIso()
    });
  }

  if (!payload.customer.name || !payload.customer.email || !payload.customer.phone) {
    return json(400, {
      ok: false,
      route: "POST /checkout/create",
      schema: "echoworld.checkout.create.v1",
      error: "missing_customer_fields",
      required: ["customer.name", "customer.email", "customer.phone"],
      ts: nowIso()
    });
  }

  if (!payload.delivery.address) {
    return json(400, {
      ok: false,
      route: "POST /checkout/create",
      schema: "echoworld.checkout.create.v1",
      error: "missing_delivery_address",
      ts: nowIso()
    });
  }

  const existingOrder = await readCheckoutOrderByReservation(payload.reservationId);
  if (existingOrder) {
    const existingItem = await readCheckoutOrderItem(existingOrder.id);
    const product = payload.productId ? await readReservationProduct(payload.productId) : null;
    const lock = await readCheckoutReservationLock(payload.productId, payload.reservationId);
    return json(200, checkoutOrderResponse(existingOrder, existingItem, product, lock, { reused: true }));
  }

  await expireReservationLockForProduct(payload.productId);

  const lock = await readCheckoutReservationLock(payload.productId, payload.reservationId);

  if (!lock) {
    return json(409, {
      ok: false,
      route: "POST /checkout/create",
      schema: "echoworld.checkout.create.v1",
      product_id: payload.productId,
      reservation_id: payload.reservationId,
      error: "reservation_not_found_or_expired",
      ts: nowIso()
    });
  }

  if (String(lock.status || "") !== "active") {
    return json(409, {
      ok: false,
      route: "POST /checkout/create",
      schema: "echoworld.checkout.create.v1",
      product_id: payload.productId,
      reservation_id: payload.reservationId,
      reservation_status: lock.status || "",
      converted_order_id: lock.converted_order_id || "",
      error: "reservation_not_active",
      ts: nowIso()
    });
  }

  const product = await readReservationProduct(payload.productId);

  if (!product) {
    return json(404, {
      ok: false,
      route: "POST /checkout/create",
      schema: "echoworld.checkout.create.v1",
      product_id: payload.productId,
      error: "product_not_found",
      ts: nowIso()
    });
  }

  const status = String(product.status || "").trim();
  const dbOrderable = isTrueFlag(product.orderable) || isTrueFlag(product.orderable_text);
  const dbVisible = isTrueFlag(product.visible) || isTrueFlag(product.visible_text);

  if (!(dbOrderable && dbVisible && isOrderableByStatus(status))) {
    return json(409, {
      ok: false,
      route: "POST /checkout/create",
      schema: "echoworld.checkout.create.v1",
      product_id: payload.productId,
      status,
      error: "product_not_orderable",
      ts: nowIso()
    });
  }

  const customerId = makeCustomerId(payload.customer);
  const orderId = makeOrderId(payload.reservationId);
  const itemId = makeOrderItemId(orderId, payload.productId);
  const orderNumber = makeOrderNumber(payload.reservationId);
  const priceRub = toNumber(product.price_rub_text);
  const deliveryPriceRub = 0;
  const totalRub = priceRub + deliveryPriceRub;
  const titleSnapshot = cleanScalar(payload.item.title || product.title || "Реликвия", 160);
  const powerCodeSnapshot = cleanScalar(payload.item.powerClass || product.power_code || "", 20);
  const powerNameSnapshot = cleanScalar(payload.item.powerName || product.power_label || "", 80);

  const customerQuery = `
    UPSERT INTO customers (
      id,
      customer_name,
      customer_email,
      customer_phone,
      telegram,
      created_at,
      updated_at
    )
    VALUES (
      ${yqlUtf8(customerId)},
      ${yqlUtf8(payload.customer.name)},
      ${yqlUtf8(payload.customer.email)},
      ${yqlUtf8(payload.customer.phone)},
      ${yqlNullableUtf8(payload.customer.telegram, 80)},
      CurrentUtcTimestamp(),
      CurrentUtcTimestamp()
    );
  `;

  const orderQuery = `
    INSERT INTO product_orders (
      id,
      order_number,
      customer_id,
      reservation_id,
      status,
      delivery_method,
      delivery_address,
      customer_comment,
      subtotal_rub,
      delivery_price_rub,
      total_rub,
      payment_status,
      payment_provider,
      payment_id,
      created_at,
      updated_at
    )
    VALUES (
      ${yqlUtf8(orderId)},
      ${yqlUtf8(orderNumber)},
      ${yqlUtf8(customerId)},
      ${yqlUtf8(payload.reservationId)},
      "new",
      ${yqlUtf8(payload.delivery.method)},
      ${yqlUtf8(payload.delivery.address)},
      ${yqlUtf8(payload.customerComment)},
      ${yqlInt32(priceRub)},
      ${yqlInt32(deliveryPriceRub)},
      ${yqlInt32(totalRub)},
      "not_started",
      "",
      "",
      CurrentUtcTimestamp(),
      CurrentUtcTimestamp()
    );
  `;

  const itemQuery = `
    INSERT INTO product_order_items (
      id,
      order_id,
      product_id,
      title_snapshot,
      price_rub_snapshot,
      power_code_snapshot,
      power_name_snapshot,
      gender_signature,
      attr_clothing,
      attr_hair,
      attr_accessory,
      item_total_rub,
      created_at
    )
    VALUES (
      ${yqlUtf8(itemId)},
      ${yqlUtf8(orderId)},
      ${yqlUtf8(payload.productId)},
      ${yqlUtf8(titleSnapshot)},
      ${yqlInt32(priceRub)},
      ${yqlUtf8(powerCodeSnapshot)},
      ${yqlUtf8(powerNameSnapshot)},
      ${yqlUtf8(cleanScalar(payload.item.genderSignature || payload.item.gender_signature || "", 80))},
      ${yqlUtf8(cleanScalar(payload.item.attrClothing || payload.item.attr_clothing || "", 160))},
      ${yqlUtf8(cleanScalar(payload.item.attrHair || payload.item.attr_hair || "", 160))},
      ${yqlUtf8(cleanScalar(payload.item.attrAccessory || payload.item.attr_accessory || "", 160))},
      ${yqlInt32(priceRub)},
      CurrentUtcTimestamp()
    );
  `;

  const markLockQuery = `
    UPDATE product_reservation_locks
    SET
      status = "converted",
      converted_order_id = ${yqlUtf8(orderId)},
      updated_at = CurrentUtcTimestamp()
    WHERE
      product_id = ${yqlUtf8(payload.productId)}
      AND reservation_id = ${yqlUtf8(payload.reservationId)};
  `;

  const markJournalQuery = `
    UPDATE product_reservations
    SET
      status = "converted",
      converted_order_id = ${yqlUtf8(orderId)},
      updated_at = CurrentUtcTimestamp()
    WHERE id = ${yqlUtf8(payload.reservationId)};
  `;

  let orderCreated = false;
  let itemCreated = false;

  try {
    await ydbQuery(customerQuery);
    await ydbQuery(orderQuery);
    orderCreated = true;
    await ydbQuery(itemQuery);
    itemCreated = true;
    await ydbQuery(markLockQuery);
    await ydbQuery(markJournalQuery);
  } catch (error) {
    if (isDuplicatePrimaryKeyError(error)) {
      const duplicateOrder = await readCheckoutOrderByReservation(payload.reservationId);
      if (duplicateOrder) {
        const duplicateItem = await readCheckoutOrderItem(duplicateOrder.id);
        const duplicateLock = await readCheckoutReservationLock(payload.productId, payload.reservationId);
        return json(200, checkoutOrderResponse(duplicateOrder, duplicateItem, product, duplicateLock, { reused: true }));
      }
    }

    if (itemCreated) {
      try { await ydbQuery(`DELETE FROM product_order_items WHERE id = ${yqlUtf8(itemId)};`); } catch (_) {}
    }

    if (orderCreated) {
      try { await ydbQuery(`DELETE FROM product_orders WHERE id = ${yqlUtf8(orderId)};`); } catch (_) {}
    }

    throw error;
  }

  const order = await readCheckoutOrderByReservation(payload.reservationId);
  const item = order ? await readCheckoutOrderItem(order.id) : null;
  const updatedLock = await readCheckoutReservationLock(payload.productId, payload.reservationId);

  return json(201, checkoutOrderResponse(order, item, product, updatedLock));
}

function hashClientKey(parts) {
  return crypto
    .createHash("sha256")
    .update(parts.filter(Boolean).join("|"))
    .digest("hex")
    .slice(0, 32);
}

async function antiabuseCheck(event) {
  const body = parseBody(event);

  const ip =
    event?.headers?.["x-forwarded-for"] ||
    event?.headers?.["X-Forwarded-For"] ||
    "";

  const ua =
    event?.headers?.["user-agent"] ||
    event?.headers?.["User-Agent"] ||
    "";

  const contact = body.contact || body.email || body.phone || "";
  const form = body.form || body.form_id || body.source || "unknown";
  const clientKey = hashClientKey([ip, ua, contact, form]);

  return json(200, {
    ok: true,
    route: "POST /antiabuse/check",
    allow: true,
    action: "allow",
    client_key: clientKey,
    ts: nowIso()
  });
}

function postForm(url, data) {
  return new Promise((resolve, reject) => {
    const payload = querystring.stringify(data);
    const parsedUrl = new URL(url);

    const req = https.request(
      {
        method: "POST",
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(payload)
        }
      },
      (res) => {
        let raw = "";

        res.on("data", (chunk) => {
          raw += chunk;
        });

        res.on("end", () => {
          try {
            resolve(JSON.parse(raw));
          } catch (_) {
            resolve({
              ok: false,
              raw
            });
          }
        });
      }
    );

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function smartcaptchaVerify(event) {
  const body = parseBody(event);
  const token = body.token || body.smart_token || body["smart-token"] || "";

  if (!SMARTCAPTCHA_SERVER_KEY) {
    return json(500, {
      ok: false,
      route: "POST /smartcaptcha/verify",
      error: "captcha_key_not_configured"
    });
  }

  if (!token) {
    return json(400, {
      ok: false,
      route: "POST /smartcaptcha/verify",
      error: "missing_token"
    });
  }

  try {
    const result = await postForm(
      "https://smartcaptcha.yandexcloud.net/validate",
      {
        secret: SMARTCAPTCHA_SERVER_KEY,
        token
      }
    );

    return json(200, {
      ok: Boolean(result.status === "ok" || result.ok === true),
      route: "POST /smartcaptcha/verify",
      provider: "yandex_smartcaptcha",
      result
    });
  } catch (error) {
    return json(502, {
      ok: false,
      route: "POST /smartcaptcha/verify",
      error: "captcha_request_failed"
    });
  }
}

exports.handler = async function handler(event) {
  const method = getMethod(event);

  if (method === "OPTIONS") {
    return {
      statusCode: 204,
      headers: HEADERS,
      body: ""
    };
  }

  const route = normalizeRoute(event);
  const query = getQuery(event);

  try {
    if (method === "GET" && (route === "catalog/list" || route === "products")) {
      return await catalogList();
    }

    if (method === "GET" && route === "catalog/product-status") {
      return await productStatus(query.product_id || query.id || query.sku);
    }

    if (method === "POST" && route === "antiabuse/check") {
      return await antiabuseCheck(event);
    }

    if (method === "POST" && route === "smartcaptcha/verify") {
      return await smartcaptchaVerify(event);
    }

    if (method === "POST" && (route === "reservations/create" || route === "reservation/create")) {
      return await reservationCreate(event);
    }

    if ((method === "GET" || method === "POST") && (route === "checkout/status" || route === "order/status")) {
      return await checkoutStatus(event);
    }

    if (method === "POST" && (route === "checkout/create" || route === "order/create")) {
      return await checkoutCreate(event);
    }

    return json(404, {
      ok: false,
      error: "route_not_found",
      route,
      method,
      available_routes: [
        "GET ?route=catalog/list",
        "GET ?route=products",
        "GET ?route=catalog/product-status&product_id=01-0006",
        "POST ?route=antiabuse/check",
        "POST ?route=smartcaptcha/verify",
        "POST ?route=reservations/create",
        "POST ?route=reservation/create",
        "POST ?route=checkout/create",
        "GET ?route=checkout/status&order_id=ord_...&status_token=..."
      ],
      ts: nowIso()
    });
  } catch (error) {
    console.error("ECHOWORLD_API_ERROR", {
      message: error.message,
      stack: error.stack,
      route,
      method
    });

    return json(500, {
      ok: false,
      error: "internal_error",
      route,
      method,
      ts: nowIso()
    });
  }
};