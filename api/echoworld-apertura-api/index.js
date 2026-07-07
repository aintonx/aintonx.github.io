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
      visible,
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
  const productOrderable = product.orderable === true && product.visible === true && isOrderableByStatus(status);

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
        "POST ?route=reservation/create"
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