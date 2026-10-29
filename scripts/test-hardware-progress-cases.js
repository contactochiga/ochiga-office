"use strict";
// Phase 5D customer order progress (TEST_PROGRESS=true, after the 5C service cases): ownership through the checkout receipt,
// every 5A/5B/5C stage, request-versus-paid distinction, privacy (no staff, technician, appointment, tracking, photo, address
// or contact data), function posture, scope isolation and the HTTP route against the real Office server.
const fs = require("fs"), path = require("path"), crypto = require("crypto"), http = require("http");
module.exports = async (h) => {
  const { run, one, psql, check, paid, ROOT, startApp, gatewayUrl, reloadSchema, restUrl, F, DL, make, O, O2, IV, T1, T2 } = h;
  const migration = fs.readFileSync(path.join(ROOT, "db/phase5d/20261102090000_hardware_order_progress.sql"), "utf8");
  const rb = psql("begin;" + migration + "rollback;");
  check("OP-M0", "progress migration transaction rolls back cleanly", rb.status === 0 && one("select to_regproc('hardware_order_public_progress') is null") === "t", rb.err);
  const ap = psql("begin;" + migration + "commit;");
  check("OP-M1", "progress function exists after apply; no table created", ap.status === 0 && one("select count(*) from pg_proc where proname='hardware_order_public_progress'") === "1", ap.err);
  if (ap.status !== 0) return;
  const owner = (o) => one(`select client||'|'||guest_hash from hardware_checkout_receipts where order_id='${o}'`).split("|");
  const prog = (o, client, guest) => { const [c, g] = owner(o); return psql(`select hardware_order_public_progress('${client || c}','${guest || g}','${o}')`); };
  const ok = (r) => (r.status === 0 ? JSON.parse(r.out.trim().split("\n").pop()) : null);
  const err = (r, code) => r.status !== 0 && r.err.includes(code);
  const stage = (p, k) => p && p.stages.find((s) => s.key === k);
  const fver = (o) => Number(one(`select coalesce((select row_version from hardware_fulfilments where order_id='${o}'),0)`));

  // Ownership and input.
  const U = make();
  const [c0, g0] = owner(U);
  check("OP-OWNER-UNKNOWN", "unknown order, wrong guest and wrong client all answer the same not-found", err(psql(`select hardware_order_public_progress('${c0}','${g0}','${crypto.randomUUID()}')`), "order_not_found")
    && err(prog(U, null, "f".repeat(64)), "order_not_found") && err(prog(U, "other-client"), "order_not_found"));
  check("OP-INPUT", "malformed client or guest refused", err(psql(`select hardware_order_public_progress('BAD CLIENT','${g0}','${U}')`), "invalid_progress_request") && err(psql(`select hardware_order_public_progress('${c0}','xyz','${U}')`), "invalid_progress_request"));
  // Order request (not paid) vs paid order.
  const pu = ok(prog(U));
  check("OP-REQUEST", "an unpaid order is shown as an order request, payment not taken", pu?.kind === "order_request" && stage(pu, "payment").status === "not_paid" && pu.current_stage === "payment" && stage(pu, "received").status === "done");
  const P = await paid(false);
  const pp = ok(prog(P));
  check("OP-PAID", "a verified paid order is a paid order; next stage packed", pp?.kind === "paid_order" && stage(pp, "payment").status === "done" && !!stage(pp, "payment").at && pp.current_stage === "packed" && !stage(pp, "installation"));
  check("OP-REFERENCE", "customer reference and totals from Office; lines without internal ids", /^HW-[0-9A-F]{8}$/.test(pp.reference) && pp.lines.length >= 1 && pp.lines.every((l) => l.name && Number.isInteger(l.quantity) && !("sku" in l) && !("variant_id" in l)) && Number.isInteger(pp.goods_total_kobo));
  // 5A/5B stages.
  run(`select hardware_fulfilment_transition('${F}','${P}',${fver(P)},'packed','')`);
  run(`select hardware_delivery_schedule('${DL}','${P}',0,'{"method":"courier","courier_name":"Synthetic Secret Courier","tracking_reference":"SECRET-TRACK-77"}'::jsonb)`);
  check("OP-PACKED", "packed shown with a date; delivery being arranged", stage(ok(prog(P)), "packed").status === "done" && stage(ok(prog(P)), "dispatched").note === "being_arranged");
  run(`select hardware_delivery_dispatch('${DL}','${P}',1)`);
  check("OP-ON-ITS-WAY", "dispatched; delivery shown as on its way", stage(ok(prog(P)), "dispatched").status === "done" && stage(ok(prog(P)), "delivered").note === "on_its_way");
  run(`select hardware_delivery_fail('${DL}','${P}',2,'recipient_unavailable','')`);
  const pf = ok(prog(P));
  check("OP-REARRANGED", "a failed attempt is shown only as being rearranged (no reason)", stage(pf, "delivered").note === "being_rearranged" && !JSON.stringify(pf).includes("recipient_unavailable"));
  check("OP-NO-TRACKING", "courier name and tracking reference never appear", !JSON.stringify(pf).includes("SECRET-TRACK-77") && !JSON.stringify(pf).includes("Synthetic Secret Courier"));
  // 5C installation stages (orders from the service cases).
  const po = ok(prog(O));
  check("OP-INSTALLED", "installed and closed order: every stage done, current completed", po?.kind === "paid_order" && stage(po, "installation").status === "done" && stage(po, "completed").status === "done" && po.current_stage === "completed");
  const po2 = ok(prog(O2));
  check("OP-UNDER-REVIEW", "a refund request shows the order as under review (no reason)", po2?.kind === "under_review" && !JSON.stringify(po2).includes("LOCAL synthetic refund"));
  check("OP-INSTALL-ARRANGED", "installation in progress shown without a date, time or technician", stage(po2, "installation").note === "in_progress" && stage(po2, "installation").at === null);
  const Q = await paid(true);
  check("OP-INSTALL-REQUESTED", "installation requested with no visit yet", stage(ok(prog(Q)), "installation").note === "requested");
  // Privacy: nothing private in any view.
  const all = [pu, pp, pf, po, po2, ok(prog(Q))].map((x) => JSON.stringify(x)).join("\n");
  const visitTimes = one(`select string_agg(to_char(starts_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI'),',') from hardware_service_visits where order_id in ('${O}','${O2}')`).split(",").filter(Boolean);
  const leaks = ["@", T1, T2, F, DL, "Synthetic Receiver", "Ada Customer", "LOCAL 1 Synthetic", "LOCAL TEST ADDRESS", "TEST-PRI", "private@fixture.test", "delivery_proof_", "service_visit_photo_", "office_files", "technician", "meeting", "slot", "phone", "email", "guest_hash", "contact_id", "reason", "storage_key", ...visitTimes];
  check("OP-PRIVACY", "no staff identity, technician, appointment time, recipient/acceptance name, street address, contact, attachment or reason in any view", leaks.every((s) => !all.includes(s)), leaks.filter((s) => all.includes(s)));
  check("OP-AREA-ONLY", "delivery shown as state and city only", po.delivery_area && Object.keys(po.delivery_area).sort().join(",") === "city,state");
  check("OP-READONLY", "progress is read-only, invoker, path-pinned and service-only", one("select (not prosecdef) and provolatile='s' and proconfig=array['search_path=public, pg_temp'] and not has_function_privilege('anon',oid,'EXECUTE') and not has_function_privilege('authenticated',oid,'EXECUTE') and prosrc !~* '(insert into|update |delete from)' from pg_proc where proname='hardware_order_public_progress'") === "t");
  const before = one("select (select count(*) from audit_events)||'/'||(select count(*) from hardware_fulfilment_events)||'/'||(select count(*) from hardware_payment_history)");
  ok(prog(P)); ok(prog(O));
  check("OP-NO-WRITES", "reading progress writes nothing", one("select (select count(*) from audit_events)||'/'||(select count(*) from hardware_fulfilment_events)||'/'||(select count(*) from hardware_payment_history)") === before);

  // HTTP route and scope isolation against the real server.
  await reloadSchema(restUrl);
  const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
  const KEY = { status: "progress-" + crypto.randomUUID(), checkout: "checkout-" + crypto.randomUUID(), catalogue: "catalogue-" + crypto.randomUUID() };
  const keys = JSON.stringify([{ client: c0, key_sha256: sha(KEY.status), scopes: ["orders.public.status"] }, { client: c0, key_sha256: sha(KEY.checkout), scopes: ["commerce.checkout.submit"] }, { client: "getoyi-catalogue", key_sha256: sha(KEY.catalogue), scopes: ["catalogue.public.read"] }]);
  const raw = (base, p, key, body, method = "POST") => new Promise((resolve, reject) => {
    const u = new URL(base + p); const data = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname, method, agent: false, headers: { "content-type": "application/json", "x-api-key": key, ...(data ? { "content-length": Buffer.byteLength(data) } : {}) } }, (res) => {
      const c = []; res.on("data", (x) => c.push(x)); res.on("end", () => { let j = null; try { j = JSON.parse(Buffer.concat(c).toString()); } catch {} resolve({ status: res.statusCode, json: j }); });
    });
    r.on("error", reject); if (data) r.write(data); r.end();
  });
  const off = await startApp(gatewayUrl, true, true, { LEAD_AGENTS_SCOPED_API_KEYS: keys });
  check("OP-HTTP-DISABLED", "progress route disabled unless its own flag is on (default)", (await raw(off.url, "/api/public/orders/progress", KEY.status, { guest_hash: g0, id: U })).json?.error === "order_status_disabled");
  await off.stop();
  const app = await startApp(gatewayUrl, true, true, { LEAD_AGENTS_SCOPED_API_KEYS: keys, OFFICE_HARDWARE_ORDER_STATUS_ENABLED: "true" });
  const [cP, gP] = owner(P);
  const r1 = await raw(app.url, "/api/public/orders/progress", KEY.status, { guest_hash: gP, id: P });
  check("OP-HTTP", "status key reads its guest's order progress", r1.status === 200 && r1.json.progress.kind === "paid_order" && cP === c0, r1.json);
  check("OP-HTTP-OTHER-GUEST", "another guest gets not found", (await raw(app.url, "/api/public/orders/progress", KEY.status, { guest_hash: "e".repeat(64), id: P })).status === 404);
  check("OP-HTTP-FIELDS", "unknown fields and malformed ids refused", (await raw(app.url, "/api/public/orders/progress", KEY.status, { guest_hash: gP, id: P, include: "all" })).status === 400 && (await raw(app.url, "/api/public/orders/progress", KEY.status, { guest_hash: gP, id: "x" })).status === 400);
  check("OP-SCOPE-ISOLATION", "status key cannot use checkout or the catalogue; checkout and catalogue keys cannot read progress",
    (await raw(app.url, "/api/commerce/checkout/status", KEY.status, { guest_hash: gP, id: P })).status === 403
    && (await raw(app.url, "/api/public/catalogue/products", KEY.status, undefined, "GET")).status === 403
    && (await raw(app.url, "/api/public/orders/progress", KEY.checkout, { guest_hash: gP, id: P })).status === 403
    && (await raw(app.url, "/api/public/orders/progress", KEY.catalogue, { guest_hash: gP, id: P })).status === 403);
  check("OP-HTTP-GET-REFUSED", "only POST is routed for the status key", (await raw(app.url, "/api/public/orders/progress", KEY.status, undefined, "GET")).status === 403);
  await app.stop();
  h.release(U); // free the unpaid order's stock hold so later Phase 4 stock checks start from the expected state
};
