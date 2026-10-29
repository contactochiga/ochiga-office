"use strict";
// Phase 5A fulfilment lifecycle cases on the disposable Postgres stack, using orders paid through the real Phase 4 path
// (HardwarePayments.initialize + reconcile with a mocked provider, then hardware_payment_confirm). Run with TEST_FULFILMENT=true.
const fs = require("fs"), path = require("path"), crypto = require("crypto");
module.exports = async ({ run, one, psql, check, make, auth, service, ROOT, vid, guest, concurrentSql, release, startApp, gatewayUrl, reloadSchema, restUrl }) => {
  const { hashPassword } = require("../src/lead-agents/auth");
  const PASSWORD = "Fulfilment-Local-" + crypto.randomUUID();
  const migration = fs.readFileSync(path.join(ROOT, "db/phase5a/20261030090000_hardware_fulfilment_lifecycle.sql"), "utf8");
  const rb = psql("begin;" + migration + "rollback;");
  check("F-M0", "fulfilment migration transaction rolls back cleanly", rb.status === 0 && one("select to_regclass('hardware_fulfilments') is null") === "t", rb.err);
  run("begin;" + migration + "commit;");
  check("F-M1", "fulfilment tables exist after apply", one("select count(*) from pg_tables where tablename like 'hardware_fulfilment%'") === "4");

  const users = {
    fulfiller: ["commerce.orders.read", "commerce.orders.fulfilment.manage"],
    configurer: ["commerce.orders.read", "commerce.orders.fulfilment.configure"],
    viewer: ["commerce.orders.read"],
    technician: [],
    refunder: ["commerce.orders.read", "commerce.orders.refund.request"],
  };
  for (const [n, sc] of Object.entries(users)) run(`insert into admin_users(email,password_hash,role,status,permission_scopes) values('${n}@fulfilment.test','${hashPassword(PASSWORD)}','ochiga_staff','active',array[${sc.map((x) => `'${x}'`).join(",") || "''"}]::text[])`);
  run(`insert into admin_users(email,password_hash,role,status,permission_scopes) values('former@fulfilment.test','fixture-not-a-hash','ochiga_staff','disabled','{}')`);
  const F = "fulfiller@fulfilment.test";
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const tr = (actor, order, expected, to, reason = "") => psql(`select hardware_fulfilment_transition(${q(actor)},'${order}',${expected},${q(to)},${q(reason)})`);
  const ok = (r) => r.status === 0 ? JSON.parse(r.out.trim().split("\n").pop()) : null;
  const err = (r, code) => r.status !== 0 && r.err.includes(code);
  async function paid(installation = false) {
    let id;
    if (installation) {
      const c = one("insert into crm_contacts(name,email) values('LOCAL FULFILMENT','fulfilment@example.invalid') returning id");
      id = JSON.parse(run(`select hardware_order_create('creator@fixture.test','${crypto.randomUUID()}','${JSON.stringify({ contact_id: c, delivery: { country: "NG", state: "Plateau", city: "Jos", address: "LOCAL TEST" }, installation_requested: true, lines: [{ variant_id: vid, quantity: 1 }] })}')`)).id;
      run(`select hardware_reservation_hold('${id}','reservation-key-${id}','fixture',900)`);
      run(`insert into hardware_checkout_receipts values('payment-test','${guest}','${crypto.randomUUID()}','${"b".repeat(64)}','${id}',now())`);
      run(`select hardware_payment_confirm_delivery('creator@fixture.test','${id}',250000,17442,'LOCAL VERIFIED SERVICEABILITY TEST')`);
    } else id = make();
    const a = auth(id);
    await service.initialize(a);
    await service.reconcile(a.reference);
    return id;
  }
  const snapshot = (id) => one(`select concat_ws('|',(select stock_on_hand||'/'||stock_reserved from catalogue_variants where id='${vid}'),(select count(*) from catalogue_inventory_changes),
    (select payment_state||':'||reservation_state||':'||fulfilment_state||':'||row_version from hardware_orders where id='${id}'),(select state||':'||row_version from hardware_reservations where order_id='${id}'),
    (select count(*) from hardware_payment_confirmations where order_id='${id}'),(select count(*) from hardware_payment_history where order_id='${id}'))`);

  // A. Order without installation, paid through the Phase 4 path.
  const A = await paid(false);
  check("F-PAID", "Phase 4 payment produced a verified, allocated order", one(`select payment_state||':'||reservation_state||':'||fulfilment_state from hardware_orders where id='${A}'`) === "paid:allocated:allocated");
  const before = snapshot(A);
  check("F-AUTH-VIEWER", "read-only staff cannot transition", err(tr("viewer@fulfilment.test", A, 0, "packed"), "forbidden"));
  check("F-AUTH-DISABLED", "disabled staff cannot transition", err(tr("former@fulfilment.test", A, 0, "packed"), "forbidden"));
  check("F-AUTH-UNKNOWN", "unknown actor cannot transition", err(tr("nobody@fulfilment.test", A, 0, "packed"), "forbidden"));
  check("F-SKIP", "paid cannot jump to dispatched", err(tr(F, A, 0, "dispatched"), "invalid_fulfilment_transition"));
  check("F-SKIP-CLOSE", "paid cannot jump to closed", err(tr(F, A, 0, "closed", "skip attempt"), "invalid_fulfilment_transition"));
  check("F-BAD-STATE", "unknown target state refused", err(tr(F, A, 0, "shipped"), "invalid_fulfilment_input"));
  const p1 = ok(tr(F, A, 0, "packed"));
  check("F-PACK", "paid -> packed records row_version 1", p1 && p1.state === "packed" && p1.row_version === 1 && p1.replayed === false && p1.installation_required === false, p1);
  const p1b = ok(tr(F, A, 0, "packed"));
  check("F-REPLAY", "identical retry is an idempotent replay with no new event", p1b && p1b.replayed === true && one(`select count(*) from hardware_fulfilment_events where order_id='${A}'`) === "1", p1b);
  check("F-STALE", "stale expected version refused", err(tr(F, A, 0, "dispatched"), "fulfilment_state_changed"));
  check("F-BACKWARD", "no backward transition", err(tr(F, A, 1, "packed"), "invalid_fulfilment_transition"));
  const race = await concurrentSql(Array.from({ length: 6 }, () => `select hardware_fulfilment_transition(${q(F)},'${A}',1,'dispatched','')`));
  const fresh = race.filter((r) => r.code === 0 && JSON.parse(r.out).replayed === false).length;
  check("F-RACE", "six concurrent dispatches produce exactly one transition", fresh === 1 && one(`select count(*) from hardware_fulfilment_events where order_id='${A}'`) === "2"
    && race.every((r) => r.code === 0 || r.err.includes("fulfilment_state_changed")), race.map((r) => r.code));
  check("F-DELIVER", "dispatched -> delivered", ok(tr(F, A, 2, "delivered"))?.state === "delivered");
  check("F-NO-INSTALL", "installation step refused when installation was not requested", err(tr(F, A, 3, "installed"), "invalid_fulfilment_transition"));
  check("F-CLOSE-REASON", "closing requires a reason", err(tr(F, A, 3, "closed", " "), "closing_reason_required"));
  const closed = ok(tr(F, A, 3, "closed", "Customer received goods; no installation"));
  check("F-CLOSE", "delivered -> closed without installation at row_version 4", closed && closed.state === "closed" && closed.row_version === 4, closed);
  check("F-AFTER-CLOSE", "closed is terminal", ["packed", "dispatched", "delivered", "installed", "closed"].every((s) => tr(F, A, 4, s, "after close").status !== 0));
  check("F-INVENTORY", "lifecycle never touches stock, payment, reservation or order facts", snapshot(A) === before, [before, snapshot(A)]);
  check("F-CHAIN", "event chain is contiguous with actor, authorization and from/to states",
    one(`select string_agg(row_version||':'||from_state||'>'||to_state||':'||actor||':'||authorization_scope,',' order by row_version) from hardware_fulfilment_events where order_id='${A}'`) ===
    ["1:paid>packed", "2:packed>dispatched", "3:dispatched>delivered", "4:delivered>closed"].map((x) => `${x}:${F}:commerce.orders.fulfilment.manage`).join(","));
  check("F-AUDIT", "one audit event and one CRM activity per transition",
    one(`select count(*) from audit_events where target_id='${A}' and action like 'hardware_fulfilment_%' and action<>'hardware_fulfilment_assigned'`) === "4"
    && one(`select count(*) from crm_activities where related_id='${A}' and activity_type like 'hardware_fulfilment_%'`) === "4");
  check("F-TIMESTAMPS", "transition timestamps are monotonic", one(`select bool_and(created_at>=coalesce(prev,created_at)) from (select created_at,lag(created_at) over(order by row_version) prev from hardware_fulfilment_events where order_id='${A}') x`) === "t");

  // Direct tampering is refused by guards and the deferred consistency trigger.
  check("F-T-UPDATE", "direct lifecycle update denied", psql(`update hardware_fulfilments set state='delivered',row_version=5 where order_id='${A}'`).status !== 0);
  check("F-T-DELETE", "lifecycle row cannot be deleted", psql(`delete from hardware_fulfilments where order_id='${A}'`).status !== 0);
  check("F-T-EVENT-EDIT", "events are immutable", psql(`update hardware_fulfilment_events set actor='x' where order_id='${A}'`).status !== 0 && psql(`delete from hardware_fulfilment_events where order_id='${A}'`).status !== 0);
  check("F-T-TRUNCATE", "lifecycle tables cannot be truncated", psql("truncate hardware_fulfilment_events").status !== 0 && psql("truncate hardware_fulfilments cascade").status !== 0);
  check("F-T-EVENT-INJECT", "out-of-chain event injection denied at commit",
    psql(`begin;insert into hardware_fulfilment_events(order_id,row_version,from_state,to_state,actor,authorization_scope) values('${A}',5,'closed','closed','x','commerce.orders.fulfilment.manage');commit;`).status !== 0);
  const U = make();
  check("F-T-PAYMENT", "unpaid order cannot be manually marked paid", psql(`update hardware_orders set payment_state='paid' where id='${U}'`).status !== 0);
  release(U);

  // C. Unpaid order: no lifecycle, no direct insert, no assignment.
  const C = make();
  check("F-UNPAID", "unpaid order cannot enter fulfilment", err(tr(F, C, 0, "packed"), "order_not_paid_and_allocated"));
  check("F-T-INSERT-UNPAID", "direct lifecycle insert for an unpaid order denied at commit",
    psql(`begin;insert into hardware_fulfilments(order_id,state,installation_required,row_version) values('${C}','packed',false,1);insert into hardware_fulfilment_events(order_id,row_version,from_state,to_state,actor,authorization_scope) values('${C}',1,'paid','packed','x','commerce.orders.fulfilment.manage');commit;`).status !== 0);
  check("F-T-INSERT-SKIP", "direct insert that skips steps denied", psql(`insert into hardware_fulfilments(order_id,state,installation_required,row_version) values('${C}','delivered',false,1)`).status !== 0);
  release(C);
  check("F-UNPAID-RELEASED", "released unpaid order still cannot enter fulfilment", err(tr(F, C, 0, "packed"), "order_not_paid_and_allocated"));
  check("F-UNPAID-ASSIGN", "unpaid order cannot be assigned", err(psql(`select hardware_fulfilment_assign(${q(F)},'${C}','fulfilment',0,'technician@fulfilment.test','')`), "order_not_paid_and_allocated"));

  // B. Order with installation: delivery and installation are separate events.
  const B = await paid(true);
  check("F-B-PAID", "installation order paid and allocated", one(`select payment_state||':'||installation_requested from hardware_orders where id='${B}'`) === "paid:true");
  ok(tr(F, B, 0, "packed")); ok(tr(F, B, 1, "dispatched")); ok(tr(F, B, 2, "delivered"));
  check("F-B-NO-EARLY-CLOSE", "installation order cannot close at delivery", err(tr(F, B, 3, "closed", "too early"), "invalid_fulfilment_transition"));
  const tech = ok(psql(`select hardware_fulfilment_assign(${q(F)},'${B}','technician',0,'Technician@Fulfilment.test','Installation crew')`));
  check("F-B-TECH", "technician assignment recorded (normalized)", tech && tech.sequence === 1 && tech.assignee === "technician@fulfilment.test", tech);
  const inst = ok(tr(F, B, 3, "installed"));
  check("F-B-INSTALLED", "delivered -> installed", inst && inst.state === "installed" && inst.row_version === 4, inst);
  const bClosed = ok(tr(F, B, 4, "closed", "Installed and signed off"));
  check("F-B-CLOSED", "installed -> closed at row_version 5", bClosed && bClosed.row_version === 5);
  check("F-B-DISTINCT", "delivered and installed are distinct recorded events",
    one(`select count(distinct to_state) from hardware_fulfilment_events where order_id='${B}' and to_state in ('delivered','installed')`) === "2");

  // Assignments.
  const D = await paid(false);
  const a1 = ok(psql(`select hardware_fulfilment_assign(${q(F)},'${D}','fulfilment',0,'technician@fulfilment.test','Warehouse')`));
  check("F-ASSIGN", "fulfilment assignment recorded", a1 && a1.sequence === 1);
  check("F-ASSIGN-STALE", "stale assignment sequence refused", err(psql(`select hardware_fulfilment_assign(${q(F)},'${D}','fulfilment',0,'technician@fulfilment.test','')`), "assignment_changed"));
  check("F-ASSIGN-NONSTAFF", "assignee must be active staff", err(psql(`select hardware_fulfilment_assign(${q(F)},'${D}','delivery',0,'former@fulfilment.test','')`), "assignee_not_active_staff")
    && err(psql(`select hardware_fulfilment_assign(${q(F)},'${D}','delivery',0,'outsider@example.invalid','')`), "assignee_not_active_staff"));
  check("F-ASSIGN-TECH-NA", "technician role refused when installation was not requested", err(psql(`select hardware_fulfilment_assign(${q(F)},'${D}','technician',0,'technician@fulfilment.test','')`), "installation_not_requested"));
  check("F-UNASSIGN", "unassignment is an appended record", ok(psql(`select hardware_fulfilment_assign(${q(F)},'${D}','fulfilment',1,null,'Reassigning')`))?.assignee === null
    && one(`select count(*) from hardware_fulfilment_assignments where order_id='${D}'`) === "2");
  check("F-ASSIGN-AUTH", "read-only staff cannot assign", err(psql(`select hardware_fulfilment_assign('viewer@fulfilment.test','${D}','delivery',0,'technician@fulfilment.test','')`), "forbidden"));
  check("F-ASSIGN-CLOSED", "closed fulfilment cannot be reassigned", err(psql(`select hardware_fulfilment_assign(${q(F)},'${A}','delivery',0,'technician@fulfilment.test','')`), "fulfilment_closed"));

  // Refund requested: lifecycle stops.
  ok(tr(F, D, 0, "packed"));
  const rr = psql(`select hardware_refund_request('refunder@fulfilment.test','${D}','LOCAL synthetic refund hold check')`);
  check("F-REFUND-SETUP", "refund request recorded through the Phase 4 function", rr.status === 0, rr.err);
  check("F-REFUND-HOLD", "refund-requested order cannot advance", err(tr(F, D, 1, "dispatched"), "order_not_paid_and_allocated"));

  // Configuration (shape-validated, versioned; never applied to pricing in 5A).
  const set = (actor, key, ver, value, reason = "Local configuration test") => psql(`select hardware_fulfilment_setting_set(${q(actor)},${q(key)},${ver},'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb,${q(reason)})`);
  const C1 = "configurer@fulfilment.test";
  const zones = { currency: "NGN", zones: [{ code: "zone-a", label: "Synthetic zone A", fee_kobo: 0, vat_rate_bp: 750, states: ["Plateau"] }] };
  check("F-CFG-AUTH", "manage scope alone cannot configure", err(set(F, "delivery_fees", 0, zones), "forbidden"));
  check("F-CFG-SET", "valid delivery fee schedule stored as version 1", ok(set(C1, "delivery_fees", 0, zones))?.version === 1);
  check("F-CFG-STALE", "stale setting version refused", err(set(C1, "delivery_fees", 0, zones), "setting_changed"));
  for (const [name, key, value] of [
    ["negative fee", "delivery_fees", { currency: "NGN", zones: [{ code: "z1", label: "Z", fee_kobo: -1, vat_rate_bp: 0, states: ["Lagos"] }] }],
    ["fractional fee", "delivery_fees", { currency: "NGN", zones: [{ code: "z1", label: "Z", fee_kobo: 10.5, vat_rate_bp: 0, states: ["Lagos"] }] }],
    ["duplicate code", "installation_fees", { currency: "NGN", services: [{ code: "s1", label: "S", fee_kobo: 1, vat_rate_bp: 0, per: "order" }, { code: "s1", label: "S", fee_kobo: 1, vat_rate_bp: 0, per: "unit" }] }],
    ["extra key", "coverage_areas", { areas: [], price: 1 }],
    ["wrong currency", "installation_fees", { currency: "USD", services: [] }],
    ["vat over 100%", "delivery_fees", { currency: "NGN", zones: [{ code: "z1", label: "Z", fee_kobo: 1, vat_rate_bp: 10001, states: ["Lagos"] }] }],
  ]) check("F-CFG-INVALID", "invalid setting refused: " + name, err(set(C1, key, key === "delivery_fees" ? 1 : 0, value), "invalid_fulfilment_setting"));
  check("F-CFG-SHORT-REASON", "setting change needs a reason", err(set(C1, "coverage_areas", 0, { areas: [] }, "short"), "invalid_fulfilment_setting"));
  check("F-CFG-COVERAGE", "coverage areas stored", ok(set(C1, "coverage_areas", 0, { areas: [{ state: "Lagos", cities: [], delivery: true, installation: false, inspection: false }] }))?.version === 1);
  check("F-CFG-IMMUTABLE", "settings history is append-only", psql("update hardware_fulfilment_settings set reason='x'").status !== 0 && psql("delete from hardware_fulfilment_settings").status !== 0);
  check("F-CFG-NO-SEED", "no production values are seeded", one("select count(*) from hardware_fulfilment_settings where actor not like '%@fulfilment.test'") === "0");

  // Database security posture.
  for (const t of ["hardware_fulfilments", "hardware_fulfilment_events", "hardware_fulfilment_assignments", "hardware_fulfilment_settings"])
    check("F-DB", "RLS, no anonymous/authenticated access, no truncate: " + t, one(`select relrowsecurity and not has_table_privilege('anon','${t}','SELECT') and not has_table_privilege('authenticated','${t}','SELECT') and not has_table_privilege('service_role','${t}','TRUNCATE') and not has_table_privilege('service_role','${t}','DELETE') from pg_class where oid='${t}'::regclass`) === "t");
  check("F-DBFN", "fulfilment functions are invoker, path-pinned and service-only", one("select count(*) from pg_proc p where pronamespace='public'::regnamespace and proname like 'hardware_fulfilment_%' and (prosecdef or proconfig is distinct from array['search_path=public, pg_temp'] or has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE'))") === "0");
  check("F-NO-PAYMENT-WRITE", "no fulfilment function writes payment, reservation or inventory tables",
    one("select count(*) from pg_proc where pronamespace='public'::regnamespace and proname like 'hardware_fulfilment_%' and prosrc ~* '(update|insert into|delete from)\\s+(hardware_orders|hardware_payment_|hardware_reservation|catalogue_variants|catalogue_inventory_changes)'") === "0");

  // ---- UI <-> API integration: the real Office screen (jsdom) against the real server and this database ----
  const { createRequire } = require("module");
  const { JSDOM } = createRequire(path.join(ROOT, "../oyi-phase4e/package.json"))("jsdom");
  const dom = new JSDOM("<main></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document; globalThis.window = dom.window;
  const mod = await import(path.join(ROOT, "public/office/catalogue/fulfilment.mjs"));
  await reloadSchema(restUrl);
  const app = await startApp(gatewayUrl, true, true, { OFFICE_HARDWARE_FULFILMENT_ENABLED: "true" });
  const cookies = {};
  for (const n of ["fulfiller", "viewer", "configurer"]) {
    const r = await fetch(app.url + "/api/lead-agents/admin/session/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: n + "@fulfilment.test", password: PASSWORD }) });
    if (r.status !== 200) throw Error("login " + n + " " + r.status);
    cookies[n] = r.headers.getSetCookie().find((h) => h.startsWith("lead_agents_admin=")).split(";")[0];
  }
  const scopesOf = { fulfiller: users.fulfiller, viewer: users.viewer, configurer: users.configurer };
  const makeUi = (who, baseUrl = app.url) => {
    const dialogs = [];
    const ui = {
      state: { renderToken: 1 }, dialogs,
      hasPermission: (p) => scopesOf[who].includes(p),
      el: (html) => { const tpl = document.createElement("template"); tpl.innerHTML = html.trim(); return tpl.content.firstElementChild; },
      escapeHtml: (s) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"),
      openDialog: (title, fields, onSubmit) => dialogs.push({ title, fields, onSubmit }),
      api: async (p, opts = {}) => {
        const send = () => fetch(baseUrl + p, { method: opts.method || "GET", headers: { "content-type": "application/json", cookie: cookies[who], origin: baseUrl }, body: opts.body ? JSON.stringify(opts.body) : undefined });
        // A reused keep-alive socket can be closed by the server at the same moment (ECONNRESET). Retry reads once;
        // writes are never retried, so a reset write surfaces as a failure.
        let r;
        try { r = await send(); } catch (e) { if ((opts.method || "GET") !== "GET" || e?.cause?.code !== "ECONNRESET") throw e; r = await send(); }
        const data = await r.json().catch(() => null);
        if (!r.ok) { const e = new Error((data && data.error) || "failed"); e.status = r.status; e.data = data; throw e; }
        return data;
      },
    };
    return ui;
  };
  const host = () => { const m = document.createElement("main"); document.body.appendChild(m); return m; };
  const E = await paid(false), G = await paid(true);
  {
    const ui = makeUi("fulfiller"), h = host();
    await mod.renderFulfilment(h, 1, ui);
    check("UI-QUEUE", "queue lists the paid order with status Paid", !!h.querySelector(`[data-order="${E}"]`) && h.querySelector(`[data-order="${E}"]`).textContent.includes("Paid"));
    h.querySelector(`[data-order="${E}"]`).click(); await new Promise((r) => setTimeout(r, 300));
    for (let i = 0; i < 20 && !h.querySelector(`[data-detail="${E}"]`); i++) await new Promise((r) => setTimeout(r, 100));
    const buttons = [...h.querySelectorAll(`[data-detail="${E}"] [data-transition]`)].map((b) => b.dataset.transition);
    check("UI-NEXT-ONLY", "only the next allowed step is offered", buttons.join() === "packed", buttons);
    check("UI-NO-TECH", "no technician assignment for a delivery-only order", !h.querySelector(`[data-detail="${E}"] [data-assignment="technician"]`));
    h.querySelector('[data-transition="packed"]').click();
    check("UI-CONFIRM", "a confirmation prompt is required before the step", ui.dialogs.length === 1 && ui.dialogs[0].title === "Confirm: Mark packed" && one(`select count(*) from hardware_fulfilment_events where order_id='${E}'`) === "0");
    await ui.dialogs[0].onSubmit({ reason: "Boxed <b>safely</b>" });
    check("UI-PACKED", "confirmed step is recorded in the database by the signed-in actor",
      one(`select state||':'||row_version from hardware_fulfilments where order_id='${E}'`) === "packed:1" && one(`select actor from hardware_fulfilment_events where order_id='${E}'`) === "fulfiller@fulfilment.test");
    const item = h.querySelector(`[data-detail="${E}"] [data-event="1"]`);
    check("UI-HISTORY", "history shows time, transition, responsible staff and scope; text is escaped",
      !!item && item.textContent.includes("Paid → Packed") && item.textContent.includes("fulfiller@fulfilment.test") && item.textContent.includes("commerce.orders.fulfilment.manage") && !item.querySelector("b") && item.textContent.includes("<b>safely</b>"));
    // Concurrent update: a second staff screen still shows the old version.
    const stale = makeUi("fulfiller"), h2 = host();
    await mod.renderDetail(h2, 1, stale, E);
    const ui3 = makeUi("fulfiller"), h3 = host();
    await mod.renderDetail(h3, 1, ui3, E);
    const replayScreen = makeUi("fulfiller"), h4 = host();
    await mod.renderDetail(h4, 1, replayScreen, E);
    h3.querySelector('[data-transition="dispatched"]').click(); await ui3.dialogs[0].onSubmit({ reason: "" });
    h4.querySelector('[data-transition="dispatched"]').click(); await replayScreen.dialogs[0].onSubmit({ reason: "" });
    check("UI-REPLAY", "a second screen submitting the same step is an idempotent replay (no duplicate event)",
      one(`select count(*) from hardware_fulfilment_events where order_id='${E}'`) === "2");
    ui3.dialogs.length = 0; h3.querySelector('[data-transition="delivered"]').click(); await ui3.dialogs[0].onSubmit({ reason: "" });
    h2.querySelector('[data-transition="dispatched"]').click(); await stale.dialogs[0].onSubmit({ reason: "" });
    check("UI-CONCURRENT", "an outdated screen cannot apply its step; it reloads with an explanation and the current next step",
      one(`select count(*) from hardware_fulfilment_events where order_id='${E}'`) === "3" && h2.textContent.includes("Someone else updated this order") && [...h2.querySelectorAll("[data-transition]")].map((b) => b.dataset.transition).join() === "closed");
    // Close requires a reason.
    ui3.dialogs.length = 0; h3.querySelector('[data-transition="closed"]').click();
    let refused = false; try { await ui3.dialogs[0].onSubmit({ reason: " " }); } catch (e) { refused = /closing reason/i.test(e.message); }
    check("UI-CLOSE-REASON", "closing without a reason is refused before any request", refused && one(`select state from hardware_fulfilments where order_id='${E}'`) === "delivered");
    await ui3.dialogs[0].onSubmit({ reason: "Delivered and accepted" });
    check("UI-CLOSED", "order closed via the UI; terminal message shown", one(`select state from hardware_fulfilments where order_id='${E}'`) === "closed" && !!h3.querySelector("[data-terminal]"));
  }
  {
    const ui = makeUi("fulfiller"), h = host();
    await mod.renderDetail(h, 1, ui, G);
    check("UI-TECH", "technician assignment offered when installation was requested", !!h.querySelector('[data-assign="technician"]'));
    h.querySelector('[data-assign="technician"]').click();
    await ui.dialogs[0].onSubmit({ assignee: "  Technician@Fulfilment.test ", reason: "Crew A" });
    check("UI-ASSIGN", "assignment recorded with normalized staff email, shown with actor", one(`select assignee||':'||actor from hardware_fulfilment_assignments where order_id='${G}' and assignment_role='technician'`) === "technician@fulfilment.test:fulfiller@fulfilment.test"
      && h.querySelector('[data-assignment="technician"]').textContent.includes("technician@fulfilment.test"));
    ui.dialogs.length = 0; h.querySelector('[data-assign="delivery"]').click();
    await ui.dialogs[0].onSubmit({ assignee: "outsider@example.invalid", reason: "" });
    check("UI-ASSIGN-REFUSED", "non-staff assignee refused with a clear message", h.textContent.includes("must be an active staff account") && one(`select count(*) from hardware_fulfilment_assignments where order_id='${G}' and assignment_role='delivery'`) === "0");
    for (const [v, to] of [[0, "packed"], [1, "dispatched"], [2, "delivered"]]) run(`select hardware_fulfilment_transition('${F}','${G}',${v},'${to}','')`);
    await mod.renderDetail(h, 1, ui, G);
    check("UI-INSTALL-STEP", "delivered installation order offers Installed, not Close", [...h.querySelectorAll("[data-transition]")].map((b) => b.dataset.transition).join() === "installed");
  }
  {
    const ui = makeUi("viewer"), h = host();
    await mod.renderFulfilment(h, 1, ui);
    await mod.renderDetail(h.querySelector("[data-fulfilment-body]"), 1, ui, G);
    check("UI-VIEWER", "read-only staff see status and history but no controls", h.querySelectorAll("[data-transition],[data-assign]").length === 0 && !!h.querySelector("[data-readonly]"));
    let forged = null; try { await ui.api(`/api/lead-agents/admin/hardware-fulfilment/${G}/transition`, { method: "POST", body: { expected_row_version: 3, to: "installed" } }); } catch (e) { forged = e.data && e.data.error; }
    check("UI-VIEWER-API", "a forged request from a read-only session is refused by the API", forged === "forbidden" && one(`select state from hardware_fulfilments where order_id='${G}'`) === "delivered");
    const hs = host(); await mod.renderFulfilment(hs, 1, ui, { tab: "settings" });
    check("UI-SETTINGS-READONLY", "settings are read-only without the configuration permission", hs.querySelectorAll("[data-save],[data-add]").length === 0 && [...hs.querySelectorAll("input")].every((i) => i.disabled));
  }
  {
    const ui = makeUi("configurer"), h = host();
    await mod.renderFulfilment(h, 1, ui, { tab: "settings" });
    const card = h.querySelector('[data-setting="installation_fees"]');
    card.querySelector("[data-add]").click();
    const row = card.querySelector("[data-row]");
    const set = (k, v) => { row.querySelector(`[data-k="${k}"]`).value = v; };
    set("code", "standard-install"); set("label", "Synthetic installation"); set("fee", "12.5"); set("vat", "7.5");
    card.querySelector("[data-save]").click();
    let short = false; try { await ui.dialogs[0].onSubmit({ reason: "short" }); } catch (e) { short = /at least 8/.test(e.message); }
    await ui.dialogs[0].onSubmit({ reason: "Local UI configuration test" });
    const stored = JSON.parse(one("select value from hardware_fulfilment_settings where setting_key='installation_fees' order by version desc limit 1"));
    check("UI-SETTINGS-SAVE", "configuration saved as a new version with naira converted to integer kobo", short && stored.services[0].fee_kobo === 1250 && stored.services[0].vat_rate_bp === 750 && stored.services[0].per === "order");
    const h2 = host(); await mod.renderFulfilment(h2, 1, ui, { tab: "settings" });
    const c2 = h2.querySelector('[data-setting="installation_fees"]');
    c2.querySelector('[data-row] [data-k="fee"]').value = "12.555";
    c2.querySelector("[data-save]").click();
    check("UI-SETTINGS-INVALID", "invalid amount refused in the browser without a request", c2.querySelector("[data-status]").textContent.includes("two decimals") && one("select max(version) from hardware_fulfilment_settings where setting_key='installation_fees'") === "1");
    const hA = host(), hB = host(), uA = makeUi("configurer"), uB = makeUi("configurer");
    await mod.renderFulfilment(hA, 1, uA, { tab: "settings" }); await mod.renderFulfilment(hB, 1, uB, { tab: "settings" });
    const lastState = (hh) => [...hh.querySelectorAll('[data-setting="coverage_areas"] [data-k="state"]')].at(-1);
    const covBefore = Number(one("select max(version) from hardware_fulfilment_settings where setting_key='coverage_areas'"));
    hA.querySelector('[data-setting="coverage_areas"] [data-add]').click(); lastState(hA).value = "Kano";
    hB.querySelector('[data-setting="coverage_areas"] [data-add]').click(); lastState(hB).value = "Abuja";
    hA.querySelector('[data-setting="coverage_areas"] [data-save]').click(); await uA.dialogs[0].onSubmit({ reason: "First editor change" });
    hB.querySelector('[data-setting="coverage_areas"] [data-save]').click(); await uB.dialogs[0].onSubmit({ reason: "Second editor change" });
    check("UI-SETTINGS-CONCURRENT", "a second editor cannot overwrite a newer settings version",
      Number(one("select max(version) from hardware_fulfilment_settings where setting_key='coverage_areas'")) === covBefore + 1
      && one("select value::text from hardware_fulfilment_settings where setting_key='coverage_areas' order by version desc limit 1").includes("Kano")
      && !one("select string_agg(value::text,'') from hardware_fulfilment_settings where setting_key='coverage_areas'").includes("Abuja"));
  }
  await app.stop();
  const off = await startApp(gatewayUrl, true, true, {});
  {
    const offCookie = await fetch(off.url + "/api/lead-agents/admin/session/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "fulfiller@fulfilment.test", password: PASSWORD }) });
    cookies.fulfiller = offCookie.headers.getSetCookie().find((h) => h.startsWith("lead_agents_admin=")).split(";")[0];
    const ui = makeUi("fulfiller", off.url), h = host();
    await mod.renderFulfilment(h, 1, ui);
    check("UI-DISABLED", "with the feature flag off (default) the screen shows a disabled notice and no controls",
      h.textContent.includes("not enabled in this environment") && h.querySelectorAll("[data-transition],[data-assign],[data-save]").length === 0);
  }
  await off.stop();
};
