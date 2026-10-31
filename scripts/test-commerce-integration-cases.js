"use strict";
// Invoked in the existing disposable PostgreSQL/Office harness; no shared data.
const fs = require("node:fs");
const path = require("node:path");
module.exports = async ({ psql, one, check, app, ROOT, vid, request }) => {
  const migration = fs.readFileSync(path.join(ROOT, "db/commerce/20261031132537_hardware_commerce_kind_boundary.sql"), "utf8");
  const definitions = () => one("select md5(string_agg(pg_get_functiondef(oid),'|' order by proname)) from pg_proc where oid in ('hardware_order_create(text,text,jsonb)'::regprocedure,'hardware_checkout_quote(jsonb)'::regprocedure)");
  const before = definitions();
  const rolled = psql(migration.replace(/commit;\s*$/, "rollback;"));
  check("CI-ROLLBACK", "transaction rollback preserves original function definitions", rolled.status === 0 && definitions() === before, rolled.err);
  const applied = psql(migration);
  check("CI-APPLY", "additive kind guard applies", applied.status === 0, applied.err);
  if (applied.status) throw Error("commerce migration failed");
  const after = definitions();
  const second = psql(migration);
  check("CI-REAPPLY", "guard reapplication is definition-idempotent", second.status === 0 && definitions() === after);
  const counts = () => one("select jsonb_build_array((select count(*) from hardware_orders),(select count(*) from hardware_order_lines),(select count(*) from hardware_order_events),(select sum(stock_reserved) from catalogue_variants))");
  const baseline = counts();
  for (const kind of ["package", "service"]) {
    const content = JSON.stringify({ name: "SYNTHETIC consultation " + kind, variants: [{ sku: "CI-" + kind.toUpperCase(), name: "Consultation" }] });
    const fixture = psql(`select catalogue_create_item('${kind}','ci-${kind}',(select id from catalogue_categories limit 1),null,'${content}','author@fixture.test')->>'id'`);
    if (fixture.status) throw Error(fixture.err);
    const id = fixture.out;
    const variant = one(`select id from catalogue_variants where product_id='${id}'`);
    check("CI-FIXTURE", kind + " created through existing catalogue function", /^[a-f0-9-]{36}$/.test(variant));
    const quote = psql(`select hardware_checkout_quote('[{"variant_id":"${variant}","quantity":1}]')`);
    check("CI-QUOTE", kind + " refused by authoritative checkout quote", quote.status !== 0 && quote.err.includes("product_not_orderable"), quote.err);
    const order = { ...request, lines: [{ variant_id: variant, quantity: 1 }] };
    const created = psql(`select hardware_order_create('creator@fixture.test','ci-${kind}-order-key','${JSON.stringify(order)}')`);
    check("CI-STAFF", kind + " refused by staff order creation", created.status !== 0 && created.err.includes("product_not_orderable"), created.err);
  }
  check("CI-NO-WRITES", "rejections create no financial/order/reservation changes", counts() === baseline);
  const ordinary = psql(`select hardware_checkout_quote('[{"variant_id":"${vid}","quantity":1}]')`);
  check("CI-HARDWARE", "ordinary hardware retains existing eligibility rules", !ordinary.err.includes("product_not_orderable"));
  check("CI-ACL", "both functions remain invoker, path-pinned and service-only", one("select bool_and(not prosecdef and proconfig=array['search_path=public, pg_temp'] and not has_function_privilege('anon',oid,'execute') and not has_function_privilege('authenticated',oid,'execute') and has_function_privilege('service_role',oid,'execute')) from pg_proc where oid in ('hardware_order_create(text,text,jsonb)'::regprocedure,'hardware_checkout_quote(jsonb)'::regprocedure)") === "t");
  const asset = await fetch(app.url + "/office/catalogue/hardware-financial.mjs");
  check("CI-ASSET", "real Office route serves Orders & payments module", asset.status === 200 && (asset.headers.get("content-type") || "").includes("javascript") && (await asset.text()).includes("renderHardwareFinancial"));
  check("CI-METHOD", "financial screen asset rejects POST", (await fetch(app.url + "/office/catalogue/hardware-financial.mjs", {method: "POST"})).status === 405);
};
