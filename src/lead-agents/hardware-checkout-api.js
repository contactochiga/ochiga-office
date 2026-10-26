"use strict";
const { json, readJsonBody } = require("./http");
const PREFIX = "/api/commerce/checkout/";
const fail = (status, code) => {
  const e = new Error(code);
  e.statusCode = status;
  e.code = code;
  throw e;
};
const only = (v, keys) => {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).some((k) => !keys.includes(k))
  )
    fail(400, "invalid_checkout");
};
async function handleHardwareCheckoutRequest({
  req,
  res,
  pathname,
  authContext,
  store,
}) {
  if (!pathname.startsWith(PREFIX)) return false;
  res.setHeader("cache-control", "private, no-store");
  res.setHeader("x-content-type-options", "nosniff");
  const send = (status, value) => {
    json(res, status, value);
    return true;
  };
  try {
    if (
      authContext?.type !== "scoped_api_key" ||
      !(authContext.scopes || []).includes("commerce.checkout.submit")
    )
      fail(403, "checkout_key_required");
    if (
      process.env.OFFICE_HARDWARE_CHECKOUT_ENABLED !== "true" ||
      process.env.OFFICE_HARDWARE_ORDERS_ENABLED !== "true" ||
      !store.client
    )
      fail(503, "checkout_disabled");
    if (req.method !== "POST") fail(405, "method_not_allowed");
    const action = pathname.slice(PREFIX.length),
      b = await readJsonBody(req, 32 * 1024);
    only(
      b,
      action === "quote"
        ? ["lines"]
        : action === "submit"
          ? ["guest_hash", "idempotency_key", "order", "quote_hash"]
          : ["guest_hash", "id", "idempotency_key"],
    );
    const rpc = async (name, body) =>
      (await store.client.post("/rpc/" + name, body)).data;
    if (action === "status") {
      if (!/^[0-9a-f]{64}$/.test(b.guest_hash || ""))
        fail(400, "invalid_checkout");
      if (b.idempotency_key) {
        if (!/^[A-Za-z0-9_-]{16,128}$/.test(b.idempotency_key))
          fail(400, "invalid_checkout");
        const r = await store.client.get(
          `/hardware_checkout_receipts?client=eq.${encodeURIComponent(authContext.client)}&guest_hash=eq.${b.guest_hash}&idempotency_key=eq.${b.idempotency_key}&select=order_id`,
        );
        if (!r.data[0]) fail(404, "order_not_found");
        b.id = r.data[0].order_id;
      }
      if (!/^[0-9a-f-]{36}$/.test(b.id || "")) fail(400, "invalid_checkout");
      const order = await rpc("hardware_checkout_get", {
        p_client: authContext.client,
        p_guest_hash: b.guest_hash,
        p_id: b.id,
      });
      if (!order) fail(404, "order_not_found");
      return send(200, { order });
    }
    if (!["quote", "submit"].includes(action)) fail(404, "not_found");
    if (action === "submit")
      only(b.order, [
        "customer",
        "delivery",
        "installation_requested",
        "lines",
      ]);
    const input = action === "quote" ? b.lines : b.order.lines;
    if (!Array.isArray(input) || input.length < 1 || input.length > 50)
      fail(400, "invalid_order_lines");
    const lines = [];
    for (const l of input) {
      only(l, ["product", "sku", "quantity"]);
      if (
        typeof l.product !== "string" ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(l.product) ||
        l.product.length > 80 ||
        typeof l.sku !== "string" ||
        !/^[A-Z0-9][A-Z0-9_-]{0,79}$/.test(l.sku) ||
        !Number.isInteger(l.quantity) ||
        l.quantity < 1 ||
        l.quantity > 1000
      )
        fail(400, "invalid_order_lines");
      const r = await store.client.get(
        `/catalogue_variants?sku=eq.${encodeURIComponent(l.sku)}&select=id,product_id,catalogue_products!inner(slug)&catalogue_products.slug=eq.${encodeURIComponent(l.product)}`,
      );
      if (r.data.length !== 1) fail(409, "product_unavailable");
      lines.push({ variant_id: r.data[0].id, quantity: l.quantity });
    }
    if (action === "quote") {
      const q = await rpc("hardware_checkout_quote", { p_lines: lines });
      return send(200, {
        quote: {
          ...q,
          lines: q.lines.map((l) => ({
            sku: l.sku,
            name: l.product_name,
            variant: l.variant_name,
            options: l.variant_options,
            quantity: l.quantity,
            unit_price_kobo: l.unit_price_kobo,
            gross_kobo: l.gross_kobo,
            tax_kobo: l.tax_kobo,
          })),
        },
      });
    }
    const order = await rpc("hardware_checkout_submit", {
      p_client: authContext.client,
      p_guest_hash: b.guest_hash,
      p_key: b.idempotency_key,
      p_request: { ...b.order, lines },
      p_quote_hash: b.quote_hash,
    });
    return send(order.replayed ? 200 : 201, { order });
  } catch (e) {
    if (e.statusCode && e.code) return send(e.statusCode, { error: e.code });
    if ([400, 413].includes(e.statusCode))
      return send(e.statusCode, { error: "invalid_checkout" });
    const d = e.response?.data || {};
    if (
      /^PT(400|403|404|409)$/.test(d.code || "") &&
      /^[a-z_]+$/.test(d.message || "")
    )
      return send(Number(d.code.slice(2)), { error: d.message });
    return send(503, { error: "checkout_unavailable" });
  }
}
module.exports = { handleHardwareCheckoutRequest };
