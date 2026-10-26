"use strict";
const { json, readJsonBody } = require("./http");
const { hasPermission } = require("./permissions");
async function handleHardwareFinancialRequest({
  req,
  res,
  pathname,
  authContext,
  store,
  config,
}) {
  const service = pathname === "/api/commerce/payments/operations";
  const staff = pathname === "/api/lead-agents/admin/hardware-financial";
  if (!service && !staff) return false;
  res.setHeader("cache-control", "private, no-store");
  res.setHeader("x-content-type-options", "nosniff");
  const send = (s, b) => {
    json(res, s, b);
    return true;
  };
  if (process.env.OFFICE_HARDWARE_FINANCIAL_ENABLED !== "true" || !store.client)
    return send(503, { error: "financial_operations_disabled" });
  try {
    if (service) {
      if (req.method !== "POST")
        return send(405, { error: "method_not_allowed" });
      if (
        authContext?.type !== "scoped_api_key" ||
        !authContext.scopes?.includes("commerce.payment.operations")
      )
        return send(403, { error: "forbidden" });
      const b = await readJsonBody(req, 8192);
      if (b.action === "approved-refunds" && Object.keys(b).length === 1)
        return send(200, {
          approvals: (
            await store.client.post("/rpc/hardware_refund_approved", {})
          ).data,
        });
      if (
        b.action === "observe" &&
        Object.keys(b).every((k) => ["action", "event"].includes(k))
      ) {
        await store.client.post("/rpc/hardware_financial_observe", {
          p: b.event,
        });
        return send(200, { accepted: true });
      }
      return send(400, { error: "invalid_action" });
    }
    if (
      authContext?.type !== "session" ||
      !authContext.email ||
      !hasPermission(authContext, "commerce.orders.read")
    )
      return send(403, { error: "forbidden" });
    const actor = authContext.email.toLowerCase();
    if (req.method === "GET")
      return send(200, {
        orders: (
          await store.client.post("/rpc/hardware_financial_list", {
            p_actor: actor,
          })
        ).data,
      });
    if (req.method !== "POST")
      return send(405, { error: "method_not_allowed" });
    const origin =
      config.officeAppUrl ||
      (process.env.NODE_ENV !== "production"
        ? `http://${req.headers.host}`
        : "");
    if (!origin || req.headers.origin !== origin)
      return send(403, { error: "origin_not_allowed" });
    const b = await readJsonBody(req, 2048);
    if (b?.action === "note") {
      if (!hasPermission(authContext, "commerce.orders.reconcile"))
        return send(403, { error: "forbidden" });
      if (
        Object.keys(b).some((k) => !["action", "id", "note"].includes(k)) ||
        !/^[0-9a-f-]{36}$/.test(b.id) ||
        typeof b.note !== "string" ||
        b.note.length < 8 ||
        b.note.length > 500
      )
        return send(400, { error: "invalid_reconciliation_note" });
      await store.client.post("/rpc/hardware_financial_note", {
        p_actor: actor,
        p_order: b.id,
        p_note: b.note,
      });
      return send(200, { recorded: true });
    }
    if (
      !b ||
      !["request", "approve"].includes(b.action) ||
      !hasPermission(authContext, "commerce.orders.refund." + b.action)
    )
      return send(403, { error: "forbidden" });
    if (
      Object.keys(b).some((k) => !["action", "id", "reason"].includes(k)) ||
      !/^[0-9a-f-]{36}$/.test(b.id) ||
      (b.action === "request" &&
        (typeof b.reason !== "string" ||
          b.reason.length < 8 ||
          b.reason.length > 500))
    )
      return send(400, { error: "invalid_refund_request" });
    return send(
      200,
      (
        await store.client.post(
          "/rpc/hardware_refund_" + b.action,
          b.action === "request"
            ? { p_actor: actor, p_order: b.id, p_reason: b.reason }
            : { p_actor: actor, p_id: b.id },
        )
      ).data,
    );
  } catch (e) {
    const d = e.response?.data || {};
    return send(
      /^PT(400|403|404|409)$/.test(d.code || "")
        ? Number(d.code.slice(2))
        : 503,
      {
        error: /^[a-z_]+$/.test(d.message || "")
          ? d.message
          : "financial_operations_unavailable",
      },
    );
  }
}
module.exports = { handleHardwareFinancialRequest };
