const { Driver, MetadataAuthService } = require("ydb-sdk");
const https = require("https");
const querystring = require("querystring");
const crypto = require("crypto");

const SERVICE_NAME = "EchoWorld Apertura API";
const CATALOG_SCHEMA = "echoworld.catalog.list.v1";
const PRODUCT_STATUS_SCHEMA = "echoworld.catalog.product-status.v1";

const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

const PRODUCT_STATUS_MODEL = {
  available: {
    label: "Доступна",
    orderable: true
  },
  first_form: {
    label: "В MARKETSPACE",
    orderable: false
  },
  transition_complete: {
    label: "В нашем мире",
    orderable: false
  }
};

const POWER_MODEL = {
  K: {
    name: "ИЗЛОМ",
    echoSlots: 1,
    priceRub: 9999
  },
  C: {
    name: "СКОПЛЕНИЕ",
    echoSlots: 2,
    priceRub: 25999
  },
  R: {
    name: "РЕЗОНАНС",
    echoSlots: 3,
    priceRub: 49999
  },
  S: {
    name: "СИНГУЛЯРНОСТЬ",
    echoSlots: 4,
    priceRub: 99999
  }
};

const ANTIABUSE = {
  actorWindowMs: 10 * 60 * 1000,
  sourceWindowMs: 10 * 60 * 1000,
  hourWindowMs: 60 * 60 * 1000,
  actorCaptchaAfter: 2,
  actorBlockAfter: 5,
  sourceCaptchaAfter: 10,
  sourceBlockAfter: 20,
  sourceHourBlockAfter: 60,
  cooldownSec: 15 * 60
};

let ydbDriverPromise = null;
let ydbDriver = null;

function response(statusCode, data, extraHeaders) {
  return {
    statusCode,
    headers: Object.assign({}, HEADERS, extraHeaders || {}),
    body: JSON.stringify(data)
  };
}

function ok(data) {
  return response(200, Object.assign({
    ok: true,
    service: SERVICE_NAME,
    timestamp: new Date().toISOString()
  }, data || {}));
}

function fail(statusCode, code, message, extra) {
  return response(statusCode, Object.assign({
    ok: false,
    service: SERVICE_NAME,
    error: {
      code,
      message
    },
    timestamp: new Date().toISOString()
  }, extra || {}));
}

function textValue(item) {
  if (!item) return "";
  if (item.textValue !== undefined) return String(item.textValue || "");
  if (item.utf8Value !== undefined) return String(item.utf8Value || "");
  if (item.stringValue !== undefined) return String(item.stringValue || "");
  return "";
}

function intValue(item) {
  const n = numberValue(item);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function boolValue(item) {
  if (!item) return false;
  if (item.boolValue !== undefined) return item.boolValue === true;
  if (item.textValue !== undefined) return String(item.textValue).toLowerCase() === "true";
  return false;
}

function numberValue(item) {
  if (!item) return 0;
  if (item.uint64Value !== undefined) return Number(item.uint64Value);
  if (item.uint32Value !== undefined) return Number(item.uint32Value);
  if (item.int64Value !== undefined) return Number(item.int64Value);
  if (item.int32Value !== undefined) return Number(item.int32Value);
  if (item.textValue !== undefined) return Number(item.textValue) || 0;
  if (item.utf8Value !== undefined) return Number(item.utf8Value) || 0;
  return 0;
}

function parseJsonBody(event) {
  if (!event || !event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch (error) {
    return {};
  }
}

function normalizeFormType(value) {
  return String(value || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .slice(0, 64) || "unknown";
}

function normalizeContact(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .slice(0, 160);
}

function safeSqlString(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function getClientIp(event) {
  const headers = event && event.headers || {};
  return (
    headers["x-forwarded-for"] ||
    headers["X-Forwarded-For"] ||
    headers["x-real-ip"] ||
    headers["X-Real-IP"] ||
    event && event.requestContext && event.requestContext.identity && event.requestContext.identity.sourceIp ||
    ""
  )
    .split(",")[0]
    .trim();
}

function getUserAgent(event) {
  const headers = event && event.headers || {};
  return String(
    headers["user-agent"] ||
    headers["User-Agent"] ||
    ""
  ).slice(0, 240);
}

function getRequestRoute(event, body) {
  const qs = event && (event.queryStringParameters || event.query || event.params) || {};
  const route = qs.route || qs.action || body && (body.route || body.action) || "";
  const path = event && (event.path || event.url) || "";
  const cleanRoute = String(route || "").replace(/^\/+/, "").toLowerCase();
  if (cleanRoute) return cleanRoute;
  return String(path || "/").replace(/^\/+/, "").toLowerCase();
}

function normalizeProductId(value) {
  const raw = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/^RELIC-?/, "");
  return /^\d{2}-\d{4}$/.test(raw) ? raw : "";
}

function relicCodeFromId(id) {
  const normalized = normalizeProductId(id);
  return normalized ? "RELIC-" + normalized : "";
}

function normalizeRelicCode(value) {
  const id = normalizeProductId(value);
  return id ? relicCodeFromId(id) : "";
}

function normalizeProductStatus(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "available";
  const compact = raw.replace(/[\s_-]+/g, "");
  if (raw === "available" || raw === "доступен" || compact === "active") return "available";
  if (
    raw === "first_form" ||
    raw === "first-form" ||
    raw === "первая форма" ||
    raw === "ожидает перехода" ||
    raw === "ожидает переход" ||
    compact === "reserved" ||
    compact === "paid" ||
    compact === "paymentconfirmed" ||
    compact === "firstform" ||
    compact === "awaitingtransition" ||
    compact === "transitionpending"
  ) return "first_form";
  if (
    raw === "transition_complete" ||
    raw === "transition-complete" ||
    raw === "прошёл переход" ||
    raw === "прошел переход" ||
    raw === "цикл завершён" ||
    raw === "цикл завершен" ||
    compact === "sold" ||
    compact === "transitioncomplete"
  ) return "transition_complete";
  return "available";
}

function normalizePowerCode(value) {
  const raw = String(value || "").trim().toUpperCase();
  return POWER_MODEL[raw] ? raw : "K";
}

function buildAntiabuseIdentity(event, formType, contact) {
  const ip = getClientIp(event);
  const userAgent = getUserAgent(event);
  const normalizedFormType = normalizeFormType(formType);
  const normalizedContact = normalizeContact(contact);

  const ipHash = sha256(ip || "unknown-ip");
  const userAgentHash = sha256(userAgent || "unknown-ua");
  const contactHash = normalizedContact ? sha256(normalizedContact) : "no-contact";

  const actorBucketHash = "actor:" + sha256([
    ipHash,
    userAgentHash,
    contactHash,
    normalizedFormType
  ].join("|"));

  const sourceBucketHash = "source:" + sha256([
    ipHash,
    userAgentHash,
    normalizedFormType
  ].join("|"));

  return {
    formType: normalizedFormType,
    contactHash,
    ipHash,
    userAgentHash,
    actorBucketHash,
    sourceBucketHash
  };
}

async function getYdbDriver() {
  if (ydbDriver) return ydbDriver;
  if (ydbDriverPromise) return ydbDriverPromise;

  ydbDriverPromise = (async () => {
    const endpoint = process.env.ENDPOINT;
    const database = process.env.DATABASE;

    if (!endpoint || !database) {
      throw new Error("Missing ENDPOINT or DATABASE environment variables");
    }

    const driver = new Driver({
      endpoint,
      database,
      authService: new MetadataAuthService()
    });

    const ready = await driver.ready(10000);
    if (!ready) {
      throw new Error("YDB driver is not ready");
    }

    ydbDriver = driver;
    return driver;
  })().catch((error) => {
    ydbDriverPromise = null;
    ydbDriver = null;
    throw error;
  });

  return ydbDriverPromise;
}

async function withYdbSession(operation) {
  const driver = await getYdbDriver();
  return await driver.tableClient.withSession(operation);
}

async function countAntiabuseAttempts(session, bucketHash, sinceMs) {
  const result = await session.executeQuery(`
    SELECT COUNT(*) AS attempts_count
    FROM antiabuse_attempts
    WHERE actor_hash = "${safeSqlString(bucketHash)}"
      AND created_at_ms >= ${Number(sinceMs)};
  `);

  const row = result.resultSets && result.resultSets[0] && result.resultSets[0].rows && result.resultSets[0].rows[0];
  const item = row && row.items && row.items[0];
  return numberValue(item);
}

async function writeAntiabuseAttempt(session, identity, bucketType, bucketHash, outcome, createdAtMs) {
  const id = crypto.randomUUID
    ? crypto.randomUUID()
    : `${createdAtMs}-${crypto.randomBytes(12).toString("hex")}`;

  await session.executeQuery(`
    UPSERT INTO antiabuse_attempts (
      id,
      actor_hash,
      form_type,
      contact_hash,
      ip_hash,
      user_agent_hash,
      outcome,
      created_at_ms
    ) VALUES (
      "${safeSqlString(id)}",
      "${safeSqlString(bucketHash)}",
      "${safeSqlString(identity.formType)}",
      "${safeSqlString(identity.contactHash)}",
      "${safeSqlString(identity.ipHash)}",
      "${safeSqlString(identity.userAgentHash)}",
      "${safeSqlString(bucketType + ":" + outcome)}",
      ${Number(createdAtMs)}
    );
  `);
}

async function checkAntiabuse(event, formType, contact) {
  const now = Date.now();
  const identity = buildAntiabuseIdentity(event, formType, contact);

  return await withYdbSession(async (session) => {
    const actorAttempts = await countAntiabuseAttempts(
      session,
      identity.actorBucketHash,
      now - ANTIABUSE.actorWindowMs
    );

    const sourceAttempts = await countAntiabuseAttempts(
      session,
      identity.sourceBucketHash,
      now - ANTIABUSE.sourceWindowMs
    );

    const sourceHourAttempts = await countAntiabuseAttempts(
      session,
      identity.sourceBucketHash,
      now - ANTIABUSE.hourWindowMs
    );

    let outcome = "allowed";
    let captchaRequired = false;
    let blocked = false;
    let reason = "allowed";

    if (
      actorAttempts >= ANTIABUSE.actorBlockAfter ||
      sourceAttempts >= ANTIABUSE.sourceBlockAfter ||
      sourceHourAttempts >= ANTIABUSE.sourceHourBlockAfter
    ) {
      outcome = "blocked";
      blocked = true;
      reason = "rate_limit";
    } else if (
      actorAttempts >= ANTIABUSE.actorCaptchaAfter ||
      sourceAttempts >= ANTIABUSE.sourceCaptchaAfter
    ) {
      outcome = "captcha_required";
      captchaRequired = true;
      reason = "captcha_escalation";
    }

    await writeAntiabuseAttempt(session, identity, "actor", identity.actorBucketHash, outcome, now);
    await writeAntiabuseAttempt(session, identity, "source", identity.sourceBucketHash, outcome, now);

    return {
      ok: !blocked,
      blocked,
      captcha_required: captchaRequired,
      retry_after_sec: blocked ? ANTIABUSE.cooldownSec : 0,
      reason,
      counters: {
        actor_attempts_10m_before_current: actorAttempts,
        source_attempts_10m_before_current: sourceAttempts,
        source_attempts_1h_before_current: sourceHourAttempts
      }
    };
  });
}

function validateSmartCaptchaToken(token, ip) {
  const secret = process.env.SMARTCAPTCHA_SERVER_KEY;

  if (!secret) {
    throw new Error("Missing SMARTCAPTCHA_SERVER_KEY environment variable");
  }

  if (!token || typeof token !== "string") {
    return Promise.resolve({
      ok: false,
      status: "missing_token",
      message: "SmartCaptcha token is missing"
    });
  }

  const postData = querystring.stringify({
    secret,
    token,
    ip: ip || ""
  });

  const options = {
    hostname: "smartcaptcha.cloud.yandex.ru",
    path: "/validate",
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(postData)
    },
    timeout: 3500
  };

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        raw += chunk;
      });
      res.on("end", () => {
        if (res.statusCode && res.statusCode !== 200) {
          resolve({
            ok: true,
            technical: true,
            status: "smartcaptcha_non_200_failopen",
            message: `SmartCaptcha returned HTTP ${res.statusCode}`,
            rawStatusCode: res.statusCode
          });
          return;
        }

        try {
          const data = JSON.parse(raw || "{}");
          resolve({
            ok: data.status === "ok",
            status: data.status || "unknown",
            message: data.message || "",
            host: data.host || "",
            rawStatusCode: res.statusCode
          });
        } catch (error) {
          resolve({
            ok: true,
            technical: true,
            status: "smartcaptcha_invalid_json_failopen",
            message: "SmartCaptcha returned invalid JSON",
            rawStatusCode: res.statusCode
          });
        }
      });
    });

    req.on("timeout", () => {
      req.destroy();
      resolve({
        ok: true,
        technical: true,
        status: "smartcaptcha_timeout_failopen",
        message: "SmartCaptcha validation timeout"
      });
    });

    req.on("error", (error) => {
      resolve({
        ok: true,
        technical: true,
        status: "smartcaptcha_request_error_failopen",
        message: error.message
      });
    });

    req.write(postData);
    req.end();
  });
}

function mapProductRow(row) {
  const items = row.items || [];
  const id = textValue(items[0]);
  const relicCode = textValue(items[1]) || relicCodeFromId(id);
  const title = textValue(items[5]);
  const status = normalizeProductStatus(textValue(items[12]));
  const statusDefaults = PRODUCT_STATUS_MODEL[status] || PRODUCT_STATUS_MODEL.available;
  const powerCode = normalizePowerCode(textValue(items[9]));
  const powerDefaults = POWER_MODEL[powerCode] || POWER_MODEL.K;
  const priceRub = intValue(items[7]);
  const currency = textValue(items[8]) || "RUB";
  const powerLabel = textValue(items[10]) || powerDefaults.name;
  const echoSlots = intValue(items[11]) || powerDefaults.echoSlots;
  const catalogStatusLabel = textValue(items[13]) || statusDefaults.label;
  const orderableFromDb = boolValue(items[14]);
  const isVisible = boolValue(items[16]);
  const imageUrl = textValue(items[15]);
  const updatedAtMs = numberValue(items[17]);

  return {
    product_id: id,
    relic_code: relicCode,
    title,
    subtitle: "",
    description: textValue(items[6]),
    price_rub: priceRub,
    currency,
    power_code: powerCode,
    power_label: powerLabel,
    echo_slots: echoSlots,
    status,
    orderable: statusDefaults.orderable && orderableFromDb,
    visible: isVisible,
    image_url: imageUrl,
    category_code: "relic",
    category_label: "Реликвии",
    catalog_status_label: catalogStatusLabel,
    sort_order: intValue(items[4]),
    updated_at: updatedAtMs ? new Date(updatedAtMs).toISOString() : "",

    id,
    relicCode,
    collection: textValue(items[2]),
    position: intValue(items[3]),
    sortOrder: intValue(items[4]),
    title,
    name: title,
    description: textValue(items[6]),
    price: {
      amount: priceRub,
      currency
    },
    status,
    statusLabel: catalogStatusLabel,
    orderable: statusDefaults.orderable && orderableFromDb,
    available: status === "available" && orderableFromDb,
    power: {
      code: powerCode,
      name: powerLabel,
      echoSlots
    },
    power_name: powerLabel,
    image: {
      path: imageUrl
    },
    img: imageUrl,
    is_visible: isVisible,
    updated_at_ms: updatedAtMs
  };
}

async function getProductsFromYDB() {
  return await withYdbSession(async (session) => {
    const result = await session.executeQuery(`
      SELECT
        id,
        relic_code,
        collection,
        position,
        sort_order,
        title,
        description,
        price_rub,
        currency,
        power_code,
        power_name,
        echo_slots,
        status,
        status_label,
        orderable,
        image_path,
        is_visible,
        updated_at_ms
      FROM products
      WHERE is_visible = TRUE
      ORDER BY sort_order;
    `);

    const rows = result.resultSets && result.resultSets[0] && result.resultSets[0].rows || [];
    return rows.map(mapProductRow);
  });
}

async function getProductStatusFromYDB(productLookup) {
  const productId = normalizeProductId(productLookup);
  const relicCode = normalizeRelicCode(productLookup);

  if (!productId && !relicCode) {
    return null;
  }

  return await withYdbSession(async (session) => {
    const result = await session.executeQuery(`
      SELECT
        id,
        relic_code,
        collection,
        position,
        sort_order,
        title,
        description,
        price_rub,
        currency,
        power_code,
        power_name,
        echo_slots,
        status,
        status_label,
        orderable,
        image_path,
        is_visible,
        updated_at_ms
      FROM products
      WHERE id = "${safeSqlString(productId)}"
         OR relic_code = "${safeSqlString(relicCode)}"
      LIMIT 1;
    `);

    const row = result.resultSets && result.resultSets[0] && result.resultSets[0].rows && result.resultSets[0].rows[0];
    return row ? mapProductRow(row) : null;
  });
}

async function handleCatalogList() {
  const products = await getProductsFromYDB();

  return ok({
    route: "GET /catalog/list",
    schema: CATALOG_SCHEMA,
    message: "YDB catalog snapshot loaded.",
    count: products.length,
    stale: false,
    server_time: new Date().toISOString(),
    products
  });
}

async function handleProductStatus(event, body) {
  const qs = event && (event.queryStringParameters || event.query || event.params) || {};
  const productLookup =
    qs.product_id ||
    qs.productId ||
    qs.relic_code ||
    qs.relicCode ||
    body.product_id ||
    body.productId ||
    body.relic_code ||
    body.relicCode ||
    "";

  const product = await getProductStatusFromYDB(productLookup);

  if (!product) {
    return fail(404, "PRODUCT_NOT_FOUND", "Product was not found in EchoWorld catalog.", {
      route: "GET /catalog/product-status",
      product_id: normalizeProductId(productLookup) || undefined,
      relic_code: normalizeRelicCode(productLookup) || undefined
    });
  }

  return ok({
    route: "GET /catalog/product-status",
    schema: PRODUCT_STATUS_SCHEMA,
    product_id: product.id,
    relic_code: product.relicCode,
    title: product.title,
    status: product.status,
    status_label: product.statusLabel,
    catalog_status_label: product.catalog_status_label,
    orderable: product.orderable,
    available: product.available,
    visible: product.visible,
    price_rub: product.price_rub,
    power_code: product.power_code,
    power_label: product.power_label,
    echo_slots: product.echo_slots,
    power: product.power,
    image_url: product.image_url,
    category_code: product.category_code,
    category_label: product.category_label,
    sort_order: product.sort_order,
    updated_at: product.updated_at,
    updated_at_ms: product.updated_at_ms
  });
}

module.exports.handler = async function (event, context) {
  const method = event && event.httpMethod || "GET";
  const body = parseJsonBody(event);
  const route = getRequestRoute(event, body);

  if (method === "OPTIONS") {
    return response(204, {});
  }

  try {
    if (method === "POST" && route === "antiabuse/check") {
      const antiabuse = await checkAntiabuse(
        event,
        body.formType || body.form_type || "unknown",
        body.contact || body.email || body.phone || ""
      );

      if (antiabuse.blocked) {
        return response(429, {
          ok: false,
          service: SERVICE_NAME,
          route: "POST /antiabuse/check",
          antiabuse,
          message: "Apertura rate limit is active",
          timestamp: new Date().toISOString()
        });
      }

      return ok({
        route: "POST /antiabuse/check",
        antiabuse
      });
    }

    if (method === "POST" && route === "smartcaptcha/verify") {
      const token = body.smartToken || body.smart_token || body.token || "";
      const ip = getClientIp(event);
      const captcha = await validateSmartCaptchaToken(token, ip);

      if (!captcha.ok) {
        return response(403, {
          ok: false,
          service: SERVICE_NAME,
          route: "POST /smartcaptcha/verify",
          captcha: {
            ok: false,
            status: captcha.status,
            message: captcha.message
          },
          timestamp: new Date().toISOString()
        });
      }

      return ok({
        route: "POST /smartcaptcha/verify",
        captcha: {
          ok: true,
          status: captcha.status,
          technical: !!captcha.technical
        }
      });
    }

    if (method !== "GET") {
      return fail(405, "METHOD_NOT_ALLOWED", "Method not allowed.");
    }

    if (
      route === "" ||
      route === "/" ||
      route === "products" ||
      route === "catalog/list"
    ) {
      return await handleCatalogList();
    }

    if (route === "catalog/product-status" || route === "product-status") {
      return await handleProductStatus(event, body);
    }

    return fail(404, "ROUTE_NOT_FOUND", "Apertura route was not found.", {
      route
    });
  } catch (error) {
    console.error("Apertura API error:", error);

    return fail(500, "APERTURA_INTERNAL_ERROR", error.message || "Internal API error.");
  }
};
