"use strict";
// Phase 5B delivery-record cases (TEST_DELIVERY=true, after the 5A fulfilment cases): database rules, 5A integration,
// failed/rescheduled/held/refund-frozen deliveries, proof-of-delivery attachments through the real Office storage
// service (metadata stripping, permissions, audit, generic-route isolation), HTTP API and the Office screen.
const fs = require("fs"), path = require("path"), crypto = require("crypto");
module.exports = async (h) => {
  const { run, one, psql, check, paid, ROOT, vid, concurrentSql, startApp, gatewayUrl, reloadSchema, restUrl, hashPassword, PASSWORD, F, mod } = h;
  const migration = fs.readFileSync(path.join(ROOT, "db/phase5b/20261031090000_hardware_delivery.sql"), "utf8");
  const rb = psql("begin;" + migration + "rollback;");
  check("D-M0", "delivery migration transaction rolls back cleanly", rb.status === 0 && one("select to_regclass('hardware_deliveries') is null") === "t", rb.err);
  run("begin;" + migration + "commit;");
  check("D-M1", "delivery tables exist after apply", one("select count(*) from pg_tables where tablename like 'hardware_deliver%'") === "3");
  const users = { courier: ["commerce.orders.read", "commerce.orders.delivery.manage"], dviewer: ["commerce.orders.read"], custreader: ["commerce.orders.read", "commerce.orders.customer.read"] };
  for (const [n, sc] of Object.entries(users)) run(`insert into admin_users(email,password_hash,role,status,permission_scopes) values('${n}@delivery.test','${hashPassword(PASSWORD)}','ochiga_staff','active',array[${sc.map((x) => `'${x}'`).join(",")}]::text[])`);
  run(`insert into admin_users(email,password_hash,role,status,permission_scopes) values('root@delivery.test','${hashPassword(PASSWORD)}','super_admin','active','{}')`);
  const C = "courier@delivery.test";
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const J = (o) => `'${JSON.stringify(o).replace(/'/g, "''")}'::jsonb`;
  const ok = (r) => (r.status === 0 ? JSON.parse(r.out.trim().split("\n").pop()) : null);
  const err = (r, code) => r.status !== 0 && r.err.includes(code);
  const ver = (o) => Number(one(`select coalesce((select row_version from hardware_deliveries where order_id='${o}'),0)`));
  const st = (o) => one(`select state from hardware_deliveries where order_id='${o}'`);
  const fs5a = (o) => one(`select coalesce((select state from hardware_fulfilments where order_id='${o}'),'paid')`);
  const fver = (o) => Number(one(`select coalesce((select row_version from hardware_fulfilments where order_id='${o}'),0)`));
  const tomorrow = one("select (current_date+1)::text");
  const sched = (actor, o, v, d) => psql(`select hardware_delivery_schedule(${q(actor)},'${o}',${v},${J(d)})`);
  const call = (fn, actor, o, ...args) => psql(`select ${fn}(${q(actor)},'${o}',${args.map((a) => (typeof a === "number" ? a : a === null ? "null" : q(a))).join(",")})`);
  const pack = (o) => run(`select hardware_fulfilment_transition('${F}','${o}',${fver(o)},'packed','')`);
  const assign = (o) => run(`select hardware_fulfilment_assign('${F}','${o}','delivery',(select coalesce(max(sequence),0) from hardware_fulfilment_assignments where order_id='${o}' and assignment_role='delivery'),'technician@fulfilment.test','Driver')`);
  const fakeProof = (o, tag) => {
    const id = "delivery_proof_test_" + crypto.randomBytes(6).toString("hex");
    run(`insert into office_files(id,storage_driver,storage_key,filename,mime_type,size,purpose,resource_type,resource_id) values('${id}','supabase','${id}.webp','${id}.webp','image/webp',1234,'delivery_proof','hardware_order','${o}')`);
    return { id, sha: crypto.createHash("sha256").update(tag).digest("hex") };
  };
  const snap = (o) => one(`select concat_ws('|',(select stock_on_hand||'/'||stock_reserved from catalogue_variants where id='${vid}'),(select count(*) from catalogue_inventory_changes),(select payment_state||':'||reservation_state||':'||fulfilment_state||':'||row_version from hardware_orders where id='${o}'),(select count(*) from hardware_payment_history where order_id='${o}'))`);

  // X: delivery without installation, happy path with a failed attempt and a reschedule.
  const X = await paid(false);
  const OTHER = await paid(false); // created before the snapshot so the snapshot measures delivery actions only
  const before = snap(X);
  check("D-USE-RECORD-PAID", "5A wrapper cannot dispatch directly", err(psql(`select hardware_fulfilment_transition('${F}','${X}',0,'dispatched','')`), "use_delivery_record"));
  check("D-AUTH", "fulfilment-only staff cannot manage deliveries", err(sched(F, X, 0, { method: "own_fleet" }), "forbidden"));
  check("D-AUTH-VIEW", "read-only staff cannot manage deliveries", err(sched("dviewer@delivery.test", X, 0, { method: "own_fleet" }), "forbidden"));
  for (const [name, d, code] of [["courier without name", { method: "courier" }, "invalid_delivery_details"], ["http tracking link", { method: "own_fleet", tracking_url: "http://x.example/t" }, "invalid_delivery_details"],
    ["unknown field", { method: "own_fleet", price: 1 }, "invalid_delivery_details"], ["past date", { method: "own_fleet", scheduled_for: "2020-01-01" }, "invalid_delivery_date"],
    ["impossible date", { method: "own_fleet", scheduled_for: "2026-13-45" }, "invalid_delivery_date"], ["bad tracking ref", { method: "courier", courier_name: "GIG", tracking_reference: "x y" }, "invalid_delivery_details"]])
    check("D-SCHED-INVALID", "schedule refused: " + name, err(sched(C, X, 0, d), code));
  const s1 = ok(sched(C, X, 0, { method: "own_fleet", scheduled_for: tomorrow, instructions: "Call on arrival" }));
  check("D-SCHEDULE", "delivery scheduled at version 1 (before packing is allowed)", s1 && s1.state === "scheduled" && s1.row_version === 1);
  check("D-SCHED-STALE", "a second create with a stale version is refused", err(sched(C, X, 0, { method: "own_fleet" }), "delivery_state_changed"));
  check("D-EDIT", "details can be updated while scheduled", ok(sched(C, X, 1, { method: "own_fleet", scheduled_for: tomorrow, instructions: "Gate code 1234" }))?.row_version === 2);
  check("D-NOT-PACKED", "dispatch refused before packing", err(call("hardware_delivery_dispatch", C, X, 2), "order_not_packed") || err(call("hardware_delivery_dispatch", C, X, 2), "delivery_assignee_required"));
  pack(X);
  check("D-NO-ASSIGNEE", "own-fleet dispatch requires a responsible delivery staff member", err(call("hardware_delivery_dispatch", C, X, 2), "delivery_assignee_required"));
  assign(X);
  const race = await concurrentSql(Array.from({ length: 6 }, () => `select hardware_delivery_dispatch(${q(C)},'${X}',2)`));
  check("D-RACE", "six concurrent dispatches: exactly one succeeds", race.filter((r) => r.code === 0).length === 1 && race.every((r) => r.code === 0 || r.err.includes("delivery_state_changed")) && st(X) === "out_for_delivery");
  check("D-DISPATCH-5A", "dispatch performed fulfilment packed -> dispatched with the delivery scope, once",
    fs5a(X) === "dispatched" && one(`select count(*)||':'||max(authorization_scope) from hardware_fulfilment_events where order_id='${X}' and to_state='dispatched'`) === "1:commerce.orders.delivery.manage");
  check("D-USE-RECORD-DELIVERED", "5A wrapper cannot mark delivered directly", err(psql(`select hardware_fulfilment_transition('${F}','${X}',${fver(X)},'delivered','')`), "use_delivery_record"));
  check("D-NOPROOF", "delivered refused without proof of delivery", err(call("hardware_delivery_complete", C, X, ver(X), "Ada Customer", "customer", ""), "proof_of_delivery_required"));
  check("D-FAIL-NOTE", "refused attempt needs a note", err(call("hardware_delivery_fail", C, X, ver(X), "refused", ""), "invalid_failure_reason"));
  check("D-FAIL-CODE", "unknown failure reason refused", err(call("hardware_delivery_fail", C, X, ver(X), "lost", "whatever note"), "invalid_failure_reason"));
  check("D-FAIL", "failed attempt recorded and counted", ok(call("hardware_delivery_fail", C, X, ver(X), "recipient_unavailable", ""))?.attempt_count === 1 && st(X) === "failed");
  check("D-RESCHED-DATE", "reschedule needs a valid future date", err(psql(`select hardware_delivery_reschedule(${q(C)},'${X}',${ver(X)},'2020-01-01','')`), "invalid_delivery_date"));
  check("D-RESCHED", "failed -> scheduled", ok(psql(`select hardware_delivery_reschedule(${q(C)},'${X}',${ver(X)},'${tomorrow}','Customer asked for tomorrow')`))?.state === "scheduled");
  check("D-REDISPATCH", "second attempt dispatches without a second fulfilment step", ok(call("hardware_delivery_dispatch", C, X, ver(X)))?.state === "out_for_delivery" && one(`select count(*) from hardware_fulfilment_events where order_id='${X}' and to_state='dispatched'`) === "1");
  // Proof registration rules (files are normally created by the API; here the office_files row is created directly).
  const p1 = fakeProof(X, "photo-1");
  const otherOrderFile = fakeProof(OTHER, "other");
  check("D-PROOF-OTHER-ORDER", "a file linked to another order is refused", err(psql(`select hardware_delivery_add_proof(${q(C)},'${X}',${ver(X)},'${otherOrderFile.id}','photo','${otherOrderFile.sha}',1234)`), "invalid_proof_file"));
  run(`insert into office_files(id,storage_driver,storage_key,filename,mime_type,size,purpose,resource_type,resource_id) values('document_test_x','supabase','document_test_x.pdf','x.pdf','application/pdf',10,'document','hardware_order','${X}')`);
  check("D-PROOF-WRONG-PURPOSE", "a non-proof file is refused", err(psql(`select hardware_delivery_add_proof(${q(C)},'${X}',${ver(X)},'document_test_x','photo','${p1.sha}',10)`), "invalid_proof_file"));
  check("D-PROOF-SIZE", "declared size must match the stored file", err(psql(`select hardware_delivery_add_proof(${q(C)},'${X}',${ver(X)},'${p1.id}','photo','${p1.sha}',99)`), "invalid_proof_file"));
  check("D-PROOF", "proof registered and versioned", ok(psql(`select hardware_delivery_add_proof(${q(C)},'${X}',${ver(X)},'${p1.id}','photo','${p1.sha}',1234)`))?.row_version === ver(X));
  const p1dup = fakeProof(X, "photo-1");
  check("D-PROOF-DUP", "the same image cannot be registered twice", err(psql(`select hardware_delivery_add_proof(${q(C)},'${X}',${ver(X)},'${p1dup.id}','photo','${p1dup.sha}',1234)`), "duplicate_proof"));
  check("D-ACK-INVALID", "recipient name and relationship are required", err(call("hardware_delivery_complete", C, X, ver(X), "A", "customer", ""), "invalid_acknowledgement") && err(call("hardware_delivery_complete", C, X, ver(X), "Ada Customer", "friend", ""), "invalid_acknowledgement"));
  const done = ok(call("hardware_delivery_complete", C, X, ver(X), "Ada Customer", "customer", "Left with customer"));
  check("D-COMPLETE", "delivered with recipient acknowledgement; fulfilment delivered by the delivery scope",
    done && done.state === "delivered" && done.recipient_name === "Ada Customer" && fs5a(X) === "delivered" && one(`select authorization_scope from hardware_fulfilment_events where order_id='${X}' and to_state='delivered'`) === "commerce.orders.delivery.manage");
  check("D-DELIVERED-TERMINAL", "a delivered record cannot fail, reschedule, hold or dispatch again",
    ["hardware_delivery_dispatch"].every((fn) => call(fn, C, X, ver(X)).status !== 0) && call("hardware_delivery_fail", C, X, ver(X), "other", "after delivery").status !== 0 && call("hardware_delivery_hold", C, X, ver(X), "other", "after delivery note").status !== 0);
  const late = fakeProof(X, "late-signature");
  check("D-LATE-PROOF", "a proof can still be added after delivery (append-only)", ok(psql(`select hardware_delivery_add_proof(${q(C)},'${X}',${ver(X)},'${late.id}','signature','${late.sha}',1234)`)) !== null);
  check("D-5A-CLOSE", "5A close still works after delivery", ok(psql(`select hardware_fulfilment_transition('${F}','${X}',${fver(X)},'closed','Delivered and accepted')`))?.state === "closed");
  check("D-INVENTORY", "delivery never touches stock, payment, reservation or order facts", snap(X) === before, [before, snap(X)]);
  check("D-AUDIT", "one audit event and one CRM activity per delivery event",
    one(`select count(*) from hardware_delivery_events where order_id='${X}'`) === one(`select count(*) from audit_events where target_id='${X}' and action like 'hardware_delivery_%' and action<>'hardware_delivery_proof_viewed'`)
    && one(`select count(*) from hardware_delivery_events where order_id='${X}'`) === one(`select count(*) from crm_activities where related_id='${X}' and activity_type like 'hardware_delivery_%'`));
  check("D-CHAIN", "event chain records from/to, actor and scope for every step",
    one(`select string_agg(event_type,',' order by row_version) from hardware_delivery_events where order_id='${X}'`) === "scheduled,details_updated,dispatched,attempt_failed,rescheduled,dispatched,proof_added,delivered,proof_added"
    && one(`select count(*) from hardware_delivery_events where order_id='${X}' and (actor<>'${C}' or authorization_scope<>'commerce.orders.delivery.manage')`) === "0");

  // Y: attempt limit (safe default 3).
  const Y = await paid(false); pack(Y); assign(Y);
  sched(C, Y, 0, { method: "courier", courier_name: "Synthetic Courier", tracking_reference: "SYN-001" });
  for (let i = 0; i < 3; i++) {
    ok(call("hardware_delivery_dispatch", C, Y, ver(Y)));
    ok(call("hardware_delivery_fail", C, Y, ver(Y), "address_issue", ""));
    if (i < 2) ok(psql(`select hardware_delivery_reschedule(${q(C)},'${Y}',${ver(Y)},'${tomorrow}','')`));
  }
  check("D-ATTEMPTS", "after three failed attempts a reschedule needs a manager decision", err(psql(`select hardware_delivery_reschedule(${q(C)},'${Y}',${ver(Y)},'${tomorrow}','')`), "delivery_attempts_exhausted"));
  check("D-COURIER-TRACKING", "courier dispatch used the tracking reference (no staff assignee needed)", one(`select count(*) from hardware_delivery_events where order_id='${Y}' and event_type='dispatched'`) === "3");

  // Z: hold and release; W: refund request freezes delivery.
  const Z = await paid(false);
  sched(C, Z, 0, { method: "customer_pickup" });
  check("D-HOLD-NOTE", "hold needs a reason note", err(call("hardware_delivery_hold", C, Z, 1, "customer_request", "short"), "invalid_delivery_exception"));
  check("D-HOLD", "scheduled -> on hold with an exception", ok(call("hardware_delivery_hold", C, Z, 1, "cancellation_requested", "Customer asked to cancel; awaiting refund decision"))?.state === "on_hold");
  check("D-HOLD-BLOCKS", "a held delivery cannot be dispatched", err(call("hardware_delivery_dispatch", C, Z, 2), "invalid_delivery_transition"));
  check("D-RELEASE", "release returns to the previous state", ok(call("hardware_delivery_release", C, Z, 2, "Customer confirmed delivery is still wanted"))?.state === "scheduled");
  const W = await paid(false);
  sched(C, W, 0, { method: "own_fleet" });
  run(`select hardware_refund_request('refunder@fulfilment.test','${W}','LOCAL synthetic refund freezes delivery')`);
  check("D-REFUND-FREEZE", "a refund request freezes every delivery action", err(sched(C, W, 1, { method: "own_fleet" }), "order_not_paid_and_allocated") && err(call("hardware_delivery_hold", C, W, 1, "refund_review", "Refund under review here"), "order_not_paid_and_allocated"));
  const U = h.make(); // unpaid
  check("D-UNPAID", "an unpaid order cannot get a delivery record", err(sched(C, U, 0, { method: "own_fleet" }), "order_not_paid_and_allocated"));
  h.release(U);

  // Tampering.
  check("D-T-UPDATE", "direct delivery state change denied", psql(`update hardware_deliveries set state='delivered' where order_id='${Z}'`).status !== 0);
  check("D-T-DELETE", "delivery record cannot be deleted", psql(`delete from hardware_deliveries where order_id='${Z}'`).status !== 0);
  check("D-T-EVENTS", "events and proofs are immutable", psql(`update hardware_delivery_events set actor='x' where order_id='${X}'`).status !== 0 && psql(`delete from hardware_delivery_proofs where order_id='${X}'`).status !== 0);
  check("D-T-INJECT", "out-of-chain event denied at commit", psql(`begin;insert into hardware_delivery_events(order_id,row_version,event_type,from_state,to_state,actor,authorization_scope) values('${Z}',99,'delivered','scheduled','delivered','x','commerce.orders.delivery.manage');commit;`).status !== 0);
  const V = await paid(false);
  check("D-T-BARE-INSERT", "a delivery row without its event and audit evidence is denied at commit", psql(`begin;insert into hardware_deliveries(order_id,state,method,row_version) values('${V}','scheduled','own_fleet',1);commit;`).status !== 0);
  check("D-T-DELIVERED-NO-PROOF", "direct jump to delivered refused by the row guard", psql(`update hardware_deliveries set state='delivered',delivered_at=now(),recipient_name='x y',recipient_relationship='customer',row_version=row_version+1 where order_id='${Z}'`).status !== 0);
  for (const t of ["hardware_deliveries", "hardware_delivery_events", "hardware_delivery_proofs"])
    check("D-DB", "RLS, no anonymous access, no truncate/delete: " + t, one(`select relrowsecurity and not has_table_privilege('anon','${t}','SELECT') and not has_table_privilege('authenticated','${t}','SELECT') and not has_table_privilege('service_role','${t}','TRUNCATE') and not has_table_privilege('service_role','${t}','DELETE') from pg_class where oid='${t}'::regclass`) === "t");
  check("D-DBFN", "delivery functions are invoker, path-pinned and service-only", one("select count(*) from pg_proc p where pronamespace='public'::regnamespace and (proname like 'hardware_delivery_%' or proname='hardware_fulfilment_step') and (prosecdef or proconfig is distinct from array['search_path=public, pg_temp'] or has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE'))") === "0");
  check("D-NO-PAYMENT-WRITE", "no delivery function writes payment, reservation or inventory tables",
    one("select count(*) from pg_proc where pronamespace='public'::regnamespace and (proname like 'hardware_delivery_%' or proname='hardware_fulfilment_step') and prosrc ~* '(update|insert into|delete from)\\s+(hardware_orders|hardware_payment_|hardware_reservation|catalogue_variants|catalogue_inventory_changes)'") === "0");

  // ---- HTTP API, attachments and the Office screen against the real server ----
  await reloadSchema(restUrl);
  const app = await startApp(gatewayUrl, true, true, { OFFICE_HARDWARE_FULFILMENT_ENABLED: "true", OFFICE_HARDWARE_DELIVERY_ENABLED: "true" });
  const cookies = {};
  for (const e of ["courier@delivery.test", "dviewer@delivery.test", "custreader@delivery.test", "root@delivery.test", "fulfiller@fulfilment.test"]) {
    const r = await fetch(app.url + "/api/lead-agents/admin/session/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: e, password: PASSWORD }) });
    if (r.status !== 200) throw Error("login " + e + " " + r.status);
    cookies[e] = r.headers.getSetCookie().find((x) => x.startsWith("lead_agents_admin=")).split(";")[0];
  }
  // One fresh connection per request (agent:false): a refused oversized upload closes its socket, which must never be reused.
  const http = require("http");
  const raw = (url, { method = "GET", headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: { ...headers, ...(body ? { "content-length": Buffer.byteLength(body) } : {}) }, agent: false }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }));
    });
    r.on("error", reject); if (body) r.write(body); r.end();
  });
  const api = async (who, method, p, body) => {
    let r;
    try { r = await raw(app.url + p, { method, headers: { "content-type": "application/json", cookie: cookies[who], origin: app.url }, body: body ? JSON.stringify(body) : undefined }); }
    catch (e) { if (e.code === "ECONNRESET" || e.code === "EPIPE") return { status: 413, data: null, buf: Buffer.alloc(0), type: null, reset: true }; throw e; }
    let data = null; try { data = JSON.parse(r.buf.toString()); } catch {}
    return { status: r.status, data, buf: r.buf, type: r.headers["content-type"] };
  };
  const D = "/api/lead-agents/admin/hardware-delivery/";
  const sharp = require("sharp");
  const jpeg = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#2a6" } }).jpeg().withExif({ IFD0: { Copyright: "SECRET-LOCATION-MARKER" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "6/1 27/1 0/1" } }).toBuffer();
  const dataUrl = (buf, mime = "image/jpeg") => `data:${mime};base64,${buf.toString("base64")}`;
  const A = await paid(false); pack(A); assign(A);
  check("API-AUTH", "read-only staff cannot schedule", (await api("dviewer@delivery.test", "POST", D + A + "/schedule", { expected_row_version: 0, method: "own_fleet" })).status === 403);
  check("API-FIELDS", "unknown fields refused", (await api("courier@delivery.test", "POST", D + A + "/schedule", { expected_row_version: 0, method: "own_fleet", amount_kobo: 1 })).status === 400);
  check("API-SCHEDULE", "courier staff schedule a delivery", (await api("courier@delivery.test", "POST", D + A + "/schedule", { expected_row_version: 0, method: "own_fleet", scheduled_for: tomorrow, instructions: "Private gate code 4471" })).data?.delivery?.row_version === 1);
  check("API-DISPATCH", "dispatch through the API", (await api("courier@delivery.test", "POST", D + A + "/dispatch", { expected_row_version: 1 })).data?.delivery?.state === "out_for_delivery");
  const filesBefore = one("select count(*) from office_files where purpose='delivery_proof'");
  check("API-PROOF-VIEWER", "read-only staff cannot upload proof", (await api("dviewer@delivery.test", "POST", D + A + "/proofs", { expected_row_version: 2, kind: "photo", data_url: dataUrl(jpeg) })).status === 403 && one("select count(*) from office_files where purpose='delivery_proof'") === filesBefore);
  check("API-PROOF-TYPE", "non-image content refused", (await api("courier@delivery.test", "POST", D + A + "/proofs", { expected_row_version: 2, kind: "photo", data_url: "data:image/png;base64," + Buffer.from("%PDF-1.4 not an image at all......").toString("base64") })).data?.error === "unsupported_proof_type");
  { const big = await api("courier@delivery.test", "POST", D + A + "/proofs", { expected_row_version: 2, kind: "photo", data_url: dataUrl(Buffer.concat([jpeg, Buffer.alloc(9 * 1024 * 1024)])) });
    check("API-PROOF-BIG", "oversized proof refused before processing (413 or connection closed while the body streams), nothing stored", big.status === 413 && one("select count(*) from office_files where purpose='delivery_proof'") === filesBefore); }
  const up = await api("courier@delivery.test", "POST", D + A + "/proofs", { expected_row_version: 2, kind: "photo", data_url: dataUrl(jpeg) });
  check("API-PROOF", "proof uploaded through the Office storage service", up.status === 201 && one(`select count(*) from office_files f join hardware_delivery_proofs p on p.file_id=f.id where p.order_id='${A}' and f.purpose='delivery_proof' and f.resource_id='${A}' and f.storage_key like 'delivery_proof_%.webp'`) === "1", up.data);
  const proofId = up.data?.proof?.proof_id;
  const dup = await api("courier@delivery.test", "POST", D + A + "/proofs", { expected_row_version: 3, kind: "photo", data_url: dataUrl(jpeg) });
  check("API-PROOF-DUP-CLEANUP", "duplicate refused and its stored file record removed (no orphan)", dup.data?.error === "duplicate_proof" && one("select count(*) from office_files where purpose='delivery_proof'") === String(Number(filesBefore) + 1));
  const view = await api("custreader@delivery.test", "GET", D + A + "/proofs/" + proofId);
  const meta = view.status === 200 ? await sharp(view.buf).metadata() : {};
  check("API-PROOF-STRIPPED", "stored proof is WebP with all EXIF/GPS metadata removed",
    view.status === 200 && view.type === "image/webp" && meta.format === "webp" && !meta.exif && !view.buf.includes(Buffer.from("SECRET-LOCATION-MARKER")) && !view.buf.includes(Buffer.from("GPS")));
  check("API-PROOF-AUDIT", "proof viewing is audited", one(`select count(*) from audit_events where action='hardware_delivery_proof_viewed' and target_id='${A}'`) === "1");
  check("API-PROOF-PERM", "read-only staff cannot view proof; wrong order is not found",
    (await api("dviewer@delivery.test", "GET", D + A + "/proofs/" + proofId)).status === 403 && (await api("courier@delivery.test", "GET", D + X + "/proofs/" + proofId)).status === 404);
  const fname = one(`select storage_key from office_files f join hardware_delivery_proofs p on p.file_id=f.id where p.id='${proofId}'`);
  check("API-GENERIC-ROUTES", "generic storage routes cannot read or create delivery proofs (even for super admin)",
    (await api("root@delivery.test", "GET", "/api/lead-agents/admin/storage/" + fname)).status === 404
    && (await api("root@delivery.test", "POST", "/api/lead-agents/admin/storage", { purpose: "delivery_proof", data_url: dataUrl(jpeg) })).status === 403);
  const asViewer = await api("dviewer@delivery.test", "GET", D + A);
  check("API-RESTRICTED", "read-only staff see status but not instructions or proof links", asViewer.data?.delivery?.instructions === "(restricted)" && asViewer.data?.can_view_proofs === false && asViewer.data?.notifications === false && asViewer.data?.public_tracking === false);
  check("API-COMPLETE", "mark delivered through the API", (await api("courier@delivery.test", "POST", D + A + "/complete", { expected_row_version: 3, recipient_name: "Bola Receiver", recipient_relationship: "security_or_reception" })).data?.delivery?.state === "delivered" && fs5a(A) === "delivered");
  check("API-STALE", "stale version mapped to a safe conflict", (await api("courier@delivery.test", "POST", D + A + "/dispatch", { expected_row_version: 1 })).data?.error === "delivery_state_changed");

  // Office screen with the delivery panel.
  const scopes = { "courier@delivery.test": users.courier, "dviewer@delivery.test": users.dviewer, "fulfiller@fulfilment.test": ["commerce.orders.read", "commerce.orders.fulfilment.manage"] };
  const makeUi = (who) => { const dialogs = []; return { dialogs, state: { renderToken: 1 }, hasPermission: (p) => scopes[who].includes(p),
    el: (x) => { const t = document.createElement("template"); t.innerHTML = x.trim(); return t.content.firstElementChild; },
    escapeHtml: (s) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"),
    openDialog: (title, fields, onSubmit) => dialogs.push({ title, fields, onSubmit }),
    api: async (p, o = {}) => { const r = await api(who, o.method || "GET", p, o.body); if (r.status >= 400) { const e = new Error(r.data?.error || "failed"); e.data = r.data; throw e; } return r.data; } }; };
  const hostEl = () => { const m = document.createElement("main"); document.body.appendChild(m); return m; };
  const B = await paid(false); pack(B); assign(B);
  {
    const fui = makeUi("fulfiller@fulfilment.test"), hf = hostEl();
    await mod.renderDetail(hf, 1, fui, B);
    check("UI-D-NO-DIRECT-DISPATCH", "with delivery records on, the fulfilment buttons no longer offer Dispatch", ![...hf.querySelectorAll("[data-transition]")].some((b) => b.dataset.transition === "dispatched") && !!hf.querySelector("[data-delivery-next]"));
    check("UI-D-FULFILMENT-ONLY", "fulfilment-only staff see the delivery panel without delivery controls", !!hf.querySelector("[data-delivery]") && hf.querySelectorAll("[data-delivery-action]").length === 0);
    const ui = makeUi("courier@delivery.test"), hh = hostEl();
    await mod.renderDetail(hh, 1, ui, B);
    hh.querySelector('[data-delivery-action="schedule"]').click();
    check("UI-D-CONFIRM", "scheduling needs a confirmation dialog", ui.dialogs[0]?.title === "Confirm: Schedule delivery" && !one(`select count(*) from hardware_deliveries where order_id='${B}'`).startsWith("1"));
    await ui.dialogs[0].onSubmit({ method: "own_fleet", scheduled_for: tomorrow, courier_name: "", tracking_reference: "", tracking_url: "", instructions: "" });
    check("UI-D-SCHEDULED", "delivery scheduled from the screen", st(B) === "scheduled" && hh.querySelector("[data-delivery-state]").textContent.includes("Scheduled"));
    ui.dialogs.length = 0; hh.querySelector('[data-delivery-action="dispatch"]').click(); await ui.dialogs[0].onSubmit({ note: "" });
    check("UI-D-DISPATCHED", "dispatch from the screen also marks the order Dispatched", st(B) === "out_for_delivery" && fs5a(B) === "dispatched");
    ui.dialogs.length = 0; hh.querySelector('[data-delivery-action="complete"]').click();
    await ui.dialogs[0].onSubmit({ recipient_name: "Chi Receiver", recipient_relationship: "customer", note: "" });
    check("UI-D-NEEDS-PROOF", "delivery without proof shows a clear message and changes nothing", hh.textContent.includes("Upload at least one proof-of-delivery photo") && st(B) === "out_for_delivery");
    await mod.uploadProof(ui, B, ver(B), "photo", dataUrl(await sharp({ create: { width: 320, height: 240, channels: 3, background: "#36c" } }).png().toBuffer(), "image/png"));
    await mod.renderDetail(hh, 1, ui, B);
    check("UI-D-PROOF-LISTED", "uploaded proof is listed with a protected view link", !!hh.querySelector("[data-proof] a[href*='/proofs/']"));
    ui.dialogs.length = 0; hh.querySelector('[data-delivery-action="complete"]').click();
    await ui.dialogs[0].onSubmit({ recipient_name: "Chi Receiver", recipient_relationship: "customer", note: "<b>signed</b>" });
    check("UI-D-DELIVERED", "marked delivered from the screen; recipient and escaped history shown",
      st(B) === "delivered" && fs5a(B) === "delivered" && hh.querySelector("[data-recipient]")?.textContent.includes("Chi Receiver") && !hh.querySelector("[data-delivery-history] b"));
    const vui = makeUi("dviewer@delivery.test"), hv = hostEl();
    await mod.renderDetail(hv, 1, vui, B);
    check("UI-D-VIEWER", "read-only staff see delivery status but no controls or proof links", hv.querySelectorAll("[data-delivery-action],[data-proof-upload]").length === 0 && !hv.querySelector("[data-proof] a"));
  }
  await app.stop();
  const off = await startApp(gatewayUrl, true, true, { OFFICE_HARDWARE_FULFILMENT_ENABLED: "true" });
  {
    const r = await raw(off.url + "/api/lead-agents/admin/session/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "courier@delivery.test", password: PASSWORD }) });
    const ck = [].concat(r.headers["set-cookie"] || []).find((x) => x.startsWith("lead_agents_admin=")).split(";")[0];
    const g = await raw(off.url + D + A, { headers: { cookie: ck } });
    check("API-DISABLED", "delivery API is disabled unless its own flag is on (default)", g.status === 503 && JSON.parse(g.buf.toString()).error === "delivery_disabled");
  }
  await off.stop();
};
