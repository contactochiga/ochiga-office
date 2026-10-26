"use strict";
const { json, readJsonBody } = require("./http");
const { hasPermission } = require("./permissions");
const BACKEND_CODES = new Set([
  "payments_disabled",
  "payment_processing_disabled",
  "invalid_payment_authorization",
  "payment_not_eligible",
  "unknown_payment_reference",
]);
function backendFailure(statusCode, code) {
  const e = new Error(code);
  e.statusCode = statusCode;
  e.code = code;
  return e;
}
async function handleHardwarePaymentsRequest({
  req,
  res,
  pathname,
  authContext,
  store,
  config,
}) {
  const confirm = pathname === "/api/commerce/payments/confirm";
  const delivery =
    /^\/api\/lead-agents\/admin\/hardware-orders\/([0-9a-f-]{36})\/delivery$/.exec(
      pathname,
    );
  if (!confirm && !delivery) return false;
  res.setHeader("cache-control", "private, no-store");
  res.setHeader("x-content-type-options", "nosniff");
  const send = (s, b) => {
    json(res, s, b);
    return true;
  };
  try {
    if (req.method !== "POST")
      return send(405, { error: "method_not_allowed" });
    if (!store.client) return send(503, { error: "payment_unavailable" });
    const b = await readJsonBody(req, 8192);
    if (confirm) {
      if (
        authContext?.type !== "scoped_api_key" ||
        !authContext.scopes?.includes("commerce.payment.confirm")
      )
        return send(403, { error: "forbidden" });
      // Keep confirmation available during initialization rollback so paid orders are not stranded.
      if (process.env.OFFICE_HARDWARE_PAYMENT_PROCESSING_ENABLED !== "true")
        return send(503, { error: "payment_processing_disabled" });
      if (
        !b ||
        Object.keys(b).some(
          (k) =>
            ![
              "reference",
              "provider_id",
              "order_id",
              "reservation_id",
              "amount_kobo",
              "currency",
              "environment",
              "purpose",
              "authorization_hash",
            ].includes(k),
        )
      )
        return send(400, { error: "invalid_payment_evidence" });
      return send(
        200,
        (await store.client.post("/rpc/hardware_payment_confirm", { p: b }))
          .data,
      );
    }
    if (
      process.env.OFFICE_HARDWARE_PAYMENTS_ENABLED !== "true" ||
      process.env.OFFICE_HARDWARE_ORDERS_ENABLED !== "true"
    )
      return send(503, { error: "payments_disabled" });
    if (
      authContext?.type !== "session" ||
      !hasPermission(authContext, "commerce.orders.delivery.confirm") ||
      !hasPermission(authContext, "commerce.orders.read") ||
      !authContext?.email
    )
      return send(403, { error: "forbidden" });
    const origin =
      config.officeAppUrl ||
      (process.env.NODE_ENV !== "production"
        ? `http://${req.headers.host}`
        : "");
    if (!origin || req.headers.origin !== origin)
      return send(403, { error: "origin_not_allowed" });
    if (
      !b ||
      Object.keys(b).some(
        (k) => !["gross_kobo", "tax_kobo", "evidence"].includes(k),
      ) ||
      !Number.isSafeInteger(b.gross_kobo) ||
      !Number.isSafeInteger(b.tax_kobo) ||
      b.gross_kobo < 0 ||
      b.tax_kobo < 0 ||
      b.tax_kobo > b.gross_kobo ||
      typeof b.evidence !== "string"
    )
      return send(400, { error: "invalid_delivery_confirmation" });
    await store.client.post("/rpc/hardware_payment_confirm_delivery", {
      p_actor: authContext.email.toLowerCase(),
      p_order: delivery[1],
      p_gross: b.gross_kobo,
      p_tax: b.tax_kobo,
      p_evidence: b.evidence,
    });
    return send(200, { confirmed: true });
  } catch (e) {
    const d = e.response?.data || {};
    return send(
      /^PT(400|403|404|409)$/.test(d.code || "")
        ? Number(d.code.slice(2))
        : 503,
      {
        error: /^[a-z_]+$/.test(d.message || "")
          ? d.message
          : "payment_unavailable",
      },
    );
  }
}
async function initializeHardwarePayment(authorization) {
  const base = process.env.HARDWARE_PAYMENT_BACKEND_URL || "",
    key = process.env.HARDWARE_PAYMENT_BACKEND_KEY || "";
  let u;
  try { u = new URL(base); } catch { throw backendFailure(503, "payment_backend_unconfigured"); }
  if (u.protocol !== "https:" || key.length < 32)
    throw backendFailure(503, "payment_backend_unconfigured");
  let r;
  try {
    r = await fetch(
      u.href.replace(/\/$/, "") + "/hardware-payments/initialize",
      {
      method: "POST",
      headers: { "content-type": "application/json", "x-office-api-key": key },
      body: JSON.stringify(authorization),
      redirect: "error",
      signal: AbortSignal.timeout(20000),
      },
    );
  } catch (e) {
    const code = e?.name === "TimeoutError" || e?.name === "AbortError"
      ? "payment_backend_timeout_uncertain"
      : ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(e?.code || e?.cause?.code)
        ? "payment_backend_connection_failure"
        : "payment_backend_transport_uncertain";
    throw backendFailure(503, code);
  }
  let data;
  try { data = await r.json(); } catch { throw backendFailure(503, "payment_backend_malformed_response"); }
  if (!r.ok) {
    const code = BACKEND_CODES.has(data?.error) ? data.error
      : r.status === 429 ? "payment_backend_rate_limited"
        : "payment_backend_rejected";
    const status = BACKEND_CODES.has(data?.error) && [400, 403, 404, 409, 503].includes(r.status)
      ? r.status
      : 503;
    throw backendFailure(status, code);
  }
  if (!data || typeof data !== "object" || Array.isArray(data) || !["created", "initializing", "pending", "processing", "confirmed", "refund_required", "manual_reconciliation"].includes(data.state) || (data.state === "pending" && !data.checkout_url))
    throw backendFailure(503, "payment_backend_malformed_response");
  if (data.checkout_url) {
    let h;
    try { h = new URL(data.checkout_url); } catch { throw backendFailure(503, "payment_backend_malformed_response"); }
    if (
      h.protocol !== "https:" ||
      h.hostname !== "checkout.paystack.com" ||
      h.username ||
      h.password ||
      h.port
    )
      throw backendFailure(503, "payment_backend_malformed_response");
  }
  return {
    state: data.state,
    ...(data.checkout_url ? { checkout_url: data.checkout_url } : {}),
  };
}
module.exports = { handleHardwarePaymentsRequest, initializeHardwarePayment };
