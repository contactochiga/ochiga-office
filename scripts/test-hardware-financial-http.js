"use strict";
const assert = require("assert/strict"),
  http = require("http");
const {
  handleHardwareFinancialRequest: handler,
} = require("../src/lead-agents/hardware-financial-api");
const { hasPermission } = require("../src/lead-agents/permissions");
(async () => {
  let calls = 0;
  process.env.OFFICE_HARDWARE_FINANCIAL_ENABLED = "true";
  const server = http.createServer(async (req, res) => {
    const role = req.headers["x-test-role"];
    const authContext =
      role === "service"
        ? { type: "scoped_api_key", scopes: ["commerce.payment.operations"] }
        : role === "wrong"
          ? { type: "scoped_api_key", scopes: ["commerce.payment.confirm"] }
          : {
              type: "session",
              role: role || "ochiga_staff",
              email: "synthetic@fixture.test",
            };
    await handler({
      req,
      res,
      pathname: req.url,
      authContext,
      config: { officeAppUrl: "https://isolated.example.invalid" },
      store: {
        client: {
          post: async () => {
            calls++;
            return { data: [] };
          },
        },
      },
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
  let count = 0;
  const test = async (path, role, body, expected, origin) => {
    const r = await fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: {
        "x-test-role": role,
        "content-type": "application/json",
        ...(origin ? { origin } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.equal(r.status, expected);
    assert.equal(r.headers.get("cache-control"), "private, no-store");
    count++;
  };
  try {
    const staff = "/api/lead-agents/admin/hardware-financial",
      service = "/api/commerce/payments/operations";
    await test(staff, "ochiga_staff", null, 403);
    await test(staff, "service", null, 403);
    await test(service, "wrong", { action: "approved-refunds" }, 403);
    await test(service, "super_admin", { action: "approved-refunds" }, 403);
    await test(service, "service", { action: "approved-refunds" }, 200);
    await test(service, "service", { action: "unknown" }, 400);
    await test(
      staff,
      "super_admin",
      { action: "approve", id: "a".repeat(36) },
      403,
      "https://evil.invalid",
    );
    await test(staff, "super_admin", null, 200);
    for (const role of ["ochiga_admin", "ochiga_staff", "estate_admin"])
      for (const p of ["request", "approve"])
        assert.equal(
          hasPermission(
            { type: "session", role },
            "commerce.orders.refund." + p,
          ),
          false,
        );
    assert.equal(calls, 2);
    console.log(
      count +
        " real HTTP financial access checks and 7 scope/storage assertions PASS",
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
