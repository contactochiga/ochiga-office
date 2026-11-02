"use strict";
// Phase 5C site inspection / installation cases (TEST_SERVICE=true, after the 5B delivery cases): coverage, verified
// technician availability, double-booking prevention (including concurrency and the existing Office calendar),
// reassignment, reports, checklists, photo evidence, customer acceptance, holds, cancellation, 5A/5B integration,
// tampering and database posture. The HTTP API, attachments and screen run in test-hardware-service-api-cases.js.
const fs = require("fs"), path = require("path"), crypto = require("crypto");
module.exports = async (h) => {
  const { run, one, psql, check, paid, ROOT, vid, concurrentSql, hashPassword, PASSWORD, F } = h;
  const migration = fs.readFileSync(path.join(ROOT, "db/phase5c/20261101090000_hardware_service_visits.sql"), "utf8");
  const rb = psql("begin;" + migration + "rollback;");
  check("S-M0", "service migration transaction rolls back cleanly", rb.status === 0 && one("select to_regclass('hardware_service_visits') is null") === "t", rb.err);
  const ap = psql("begin;" + migration + "commit;");
  check("S-M1", "service tables exist after apply", ap.status === 0 && one("select count(*) from pg_tables where tablename like 'hardware_service_%' or tablename like 'hardware_technician_%'") === "6", ap.err);
  if (ap.status !== 0) return;

  const users = {
    scheduler: ["commerce.orders.read", "commerce.orders.service.schedule"],
    tech1: ["commerce.orders.read", "commerce.orders.service.perform"],
    tech2: ["commerce.orders.read", "commerce.orders.service.perform"],
    notech: ["commerce.orders.read", "commerce.orders.service.perform"],
    svcconfig: ["commerce.orders.read", "commerce.orders.service.configure", "commerce.orders.fulfilment.configure"],
    sviewer: ["commerce.orders.read"],
    sdeliver: ["commerce.orders.read", "commerce.orders.delivery.manage"],
  };
  for (const [n, sc] of Object.entries(users)) run(`insert into admin_users(email,password_hash,role,status,permission_scopes) values('${n}@service.test','${hashPassword(PASSWORD)}','ochiga_staff','active',array[${sc.map((x) => `'${x}'`).join(",")}]::text[])`);
  for (const n of ["tech1", "tech2"]) run(`insert into office_staff_capabilities(staff_email,capability,specialty) values('${n}@service.test','hardware.field_technician','LOCAL synthetic')`);
  const S = "scheduler@service.test", T1 = "tech1@service.test", T2 = "tech2@service.test", CFG = "svcconfig@service.test", DL = "sdeliver@service.test";
  const q = (s) => (s === null ? "null" : "'" + String(s).replace(/'/g, "''") + "'");
  const J = (o) => `'${JSON.stringify(o).replace(/'/g, "''")}'::jsonb`;
  const ok = (r) => (r.status === 0 ? JSON.parse(r.out.trim().split("\n").pop()) : null);
  const err = (r, code) => r.status !== 0 && r.err.includes(code);
  // Appointment times on the Lagos calendar, days ahead of today.
  const T = (day, hh, mm = 0) => `(((now() at time zone 'Africa/Lagos')::date+${day})::timestamp+interval '${hh} hours ${mm} minutes') at time zone 'Africa/Lagos'`;
  const ver = (v) => Number(one(`select row_version from hardware_service_visits where id='${v}'`));
  const st = (v) => one(`select state from hardware_service_visits where id='${v}'`);
  const fs5a = (o) => one(`select coalesce((select state from hardware_fulfilments where order_id='${o}'),'paid')`);
  const fver = (o) => Number(one(`select coalesce((select row_version from hardware_fulfilments where order_id='${o}'),0)`));
  const lagos = { country: "NG", state: "Lagos", city: "Ikeja", address: "LOCAL 1 Synthetic Close" };
  const contact = one("insert into crm_contacts(name,email) values('LOCAL SERVICE','service@example.invalid') returning id");
  const request = (actor, kind, order, address, c = contact) => psql(`select hardware_service_request(${q(actor)},${q(kind)},${order ? `'${order}'` : "null"},${c ? `'${c}'` : "null"},${J(address)},'LOCAL synthetic request')`);
  const schedule = (actor, v, e, tech, a, b) => psql(`select hardware_service_schedule(${q(actor)},'${v}',${e},${q(tech)},${a},${b},'')`);
  const call = (fn, actor, v, ...args) => psql(`select ${fn}(${q(actor)},'${v}',${args.map((a) => (typeof a === "number" ? a : a && typeof a === "object" ? J(a) : q(a))).join(",")})`);
  const fakePhoto = (v, tag) => {
    const id = "service_visit_photo_test_" + crypto.randomBytes(6).toString("hex");
    run(`insert into office_files(id,storage_driver,storage_key,filename,mime_type,size,purpose,resource_type,resource_id) values('${id}','supabase','${id}.webp','${id}.webp','image/webp',2222,'service_visit_photo','hardware_service_visit','${v}')`);
    return { id, sha: crypto.createHash("sha256").update(tag).digest("hex") };
  };
  const addPhoto = (actor, v, kind, tag) => { const p = fakePhoto(v, tag); return psql(`select hardware_service_add_evidence(${q(actor)},'${v}',${ver(v)},'${p.id}','${kind}','${p.sha}',2222)`); };
  const snap = () => one(`select concat_ws('|',(select stock_on_hand||'/'||stock_reserved from catalogue_variants where id='${vid}'),(select count(*) from catalogue_inventory_changes),(select count(*) from hardware_payment_history),(select count(*) from hardware_payment_confirmations),(select count(*) from hardware_refund_requests))`);
  const deliver = (o) => { // through the 5B delivery record (the only path to delivered)
    run(`select hardware_fulfilment_transition('${F}','${o}',${fver(o)},'packed','')`);
    run(`select hardware_delivery_schedule('${DL}','${o}',0,'{"method":"courier","courier_name":"Synthetic Courier","tracking_reference":"SYN-5C"}'::jsonb)`);
    run(`select hardware_delivery_dispatch('${DL}','${o}',1)`);
    const id = "delivery_proof_test_" + crypto.randomBytes(6).toString("hex");
    run(`insert into office_files(id,storage_driver,storage_key,filename,mime_type,size,purpose,resource_type,resource_id) values('${id}','supabase','${id}.webp','${id}.webp','image/webp',10,'delivery_proof','hardware_order','${o}')`);
    run(`select hardware_delivery_add_proof('${DL}','${o}',2,'${id}','photo','${crypto.createHash("sha256").update(id).digest("hex")}',10)`);
    run(`select hardware_delivery_complete('${DL}','${o}',3,'Synthetic Receiver','customer','')`);
  };
  // Every order this module uses is created (and paid) before the snapshot, so the snapshot measures service work only.
  const NOINST = await paid(false), O = await paid(true), O2 = await paid(true);
  const before = snap();

  // Coverage, address and request rules.
  // 5A cases already configured coverage; prove the empty case inside a rolled-back transaction.
  { const r = psql(`begin;alter table hardware_fulfilment_settings disable trigger all;delete from hardware_fulfilment_settings where setting_key='coverage_areas';select hardware_service_request(${q(S)},'inspection',null,'${contact}',${J(lagos)},'');rollback;`);
    check("S-COVERAGE-NONE", "no coverage configured: requests refused", err(r, "coverage_not_configured"), r.err); }
  const cov = ok(psql(`select hardware_fulfilment_setting_set('${CFG}','coverage_areas',(select coalesce(max(version),0) from hardware_fulfilment_settings where setting_key='coverage_areas'),${J({ areas: [
    { state: "Lagos", cities: ["Ikeja", "Lekki"], delivery: true, installation: true, inspection: true },
    { state: "FCT", cities: [], delivery: true, installation: false, inspection: false }] })},'LOCAL synthetic coverage')`));
  check("S-COVERAGE-SET", "coverage configured through the 5A settings", cov && cov.version >= 1);
  check("S-COVERAGE-OUT", "outside covered city refused", err(request(S, "inspection", null, { ...lagos, city: "Epe" }), "outside_coverage"));
  check("S-COVERAGE-FLAG", "state covered for delivery but not inspection refused", err(request(S, "inspection", null, { ...lagos, state: "FCT", city: "Garki" }), "outside_coverage"));
  check("S-ADDRESS", "invalid or extra address fields refused", err(request(S, "inspection", null, { ...lagos, address: "x" }), "invalid_service_input") && err(request(S, "inspection", null, { ...lagos, lat: "6.4" }), "invalid_service_input") && err(request(S, "inspection", null, { ...lagos, country: "GH" }), "invalid_service_input"));
  check("S-AUTH-REQUEST", "read-only and technician staff cannot create requests", err(request("sviewer@service.test", "inspection", null, lagos), "forbidden") && err(request(T1, "inspection", null, lagos), "forbidden"));
  check("S-INSTALL-NEEDS-ORDER", "installation without an order refused", err(request(S, "installation", null, lagos), "installation_requires_order"));
  check("S-INSTALL-NOT-REQUESTED", "installation for an order that did not request it refused", err(request(S, "installation", NOINST, lagos, null), "installation_not_requested"));
  const I1 = ok(request(S, "inspection", null, lagos));
  check("S-REQUEST", "inspection request recorded at version 1", I1 && I1.state === "requested" && I1.row_version === 1 && I1.kind === "inspection");

  // Working hours and verified availability.
  const hoursAll = Array.from({ length: 7 }, (_, d) => ({ weekday: d, start: "08:00", end: "18:00" }));
  check("S-NO-HOURS", "a technician without working hours cannot be booked", err(schedule(S, I1.id, 1, T1, T(2, 10), T(2, 12)), "no_working_hours"));
  check("S-HOURS-AUTH", "only service configurers set working hours", err(psql(`select hardware_service_set_schedule('${S}','${T1}',0,${J(hoursAll)},'LOCAL synthetic hours')`), "forbidden"));
  check("S-HOURS-INVALID", "invalid windows refused", err(psql(`select hardware_service_set_schedule('${CFG}','${T1}',0,${J([{ weekday: 9, start: "08:00", end: "18:00" }])},'LOCAL synthetic hours')`), "invalid_schedule")
    && err(psql(`select hardware_service_set_schedule('${CFG}','${T1}',0,${J([{ weekday: 1, start: "18:00", end: "08:00" }])},'LOCAL synthetic hours')`), "invalid_schedule"));
  check("S-HOURS-NONTECH", "staff without the field-technician capability get no hours", err(psql(`select hardware_service_set_schedule('${CFG}','notech@service.test',0,${J(hoursAll)},'LOCAL synthetic hours')`), "technician_not_eligible"));
  check("S-HOURS", "working hours saved (versioned)", ok(psql(`select hardware_service_set_schedule('${CFG}','${T1}',0,${J(hoursAll)},'LOCAL synthetic hours')`))?.version === 1
    && ok(psql(`select hardware_service_set_schedule('${CFG}','${T2}',0,${J(hoursAll)},'LOCAL synthetic hours')`))?.version === 1
    && err(psql(`select hardware_service_set_schedule('${CFG}','${T1}',0,${J(hoursAll)},'LOCAL synthetic hours')`), "schedule_changed"));
  check("S-SCHED-AUTH", "technicians and read-only staff cannot schedule", err(schedule(T1, I1.id, 1, T1, T(2, 10), T(2, 12)), "forbidden") && err(schedule("sviewer@service.test", I1.id, 1, T1, T(2, 10), T(2, 12)), "forbidden"));
  check("S-SCHED-NONTECH", "booking a non-technician refused", err(schedule(S, I1.id, 1, "notech@service.test", T(2, 10), T(2, 12)), "technician_not_eligible"));
  check("S-SCHED-OUTSIDE", "outside working hours refused", err(schedule(S, I1.id, 1, T1, T(2, 17), T(2, 19)), "outside_working_hours") && err(schedule(S, I1.id, 1, T1, T(2, 6), T(2, 9)), "outside_working_hours"));
  check("S-SCHED-PAST", "past, reversed, too short, too long or too far slots refused",
    err(schedule(S, I1.id, 1, T1, T(-1, 10), T(-1, 12)), "invalid_slot") && err(schedule(S, I1.id, 1, T1, T(2, 12), T(2, 10)), "invalid_slot")
    && err(schedule(S, I1.id, 1, T1, T(2, 10), T(2, 10, 15)), "invalid_slot") && err(schedule(S, I1.id, 1, T1, T(2, 8), T(2, 17)), "invalid_slot") && err(schedule(S, I1.id, 1, T1, T(120, 10), T(120, 12)), "invalid_slot"));
  const s1 = ok(schedule(S, I1.id, 1, T1, T(2, 10), T(2, 12)));
  check("S-SCHEDULE", "inspection scheduled for the technician inside working hours", s1 && s1.state === "scheduled" && s1.technician === T1 && s1.row_version === 2);
  check("S-CALENDAR", "appointment mirrored into the Office calendar (office_meetings) for the technician",
    one(`select count(*)||':'||max(owner)||':'||max(status) from office_meetings where related_type='hardware_service_visit' and related_id='${I1.id}'`) === `1:${T1}:active`);
  check("S-SCHED-STALE", "stale version refused", err(schedule(S, I1.id, 1, T1, T(3, 10), T(3, 12)), "visit_state_changed"));
  const I2 = ok(request(S, "inspection", null, lagos));
  check("S-DOUBLE-BOOK", "overlapping booking for the same technician refused", err(schedule(S, I2.id, 1, T1, T(2, 11), T(2, 13)), "technician_double_booked"));
  check("S-ADJACENT", "back-to-back booking allowed", ok(schedule(S, I2.id, 1, T1, T(2, 12), T(2, 14)))?.state === "scheduled");
  // Concurrent bookings of one slot for one technician: exactly one wins.
  const race = Array.from({ length: 6 }, () => ok(request(S, "inspection", null, lagos)).id);
  const rr = await concurrentSql(race.map((v) => `select hardware_service_schedule('${S}','${v}',1,'${T1}',${T(4, 9)},${T(4, 11)},'')`));
  check("S-RACE", "six concurrent bookings of one slot: exactly one succeeds", rr.filter((r) => r.code === 0).length === 1 && rr.every((r) => r.code === 0 || r.err.includes("technician_double_booked"))
    && one(`select count(*) from hardware_service_appointments where technician='${T1}' and state='booked' and slot && tstzrange(${T(4, 9)},${T(4, 11)})`) === "1", rr.map((r) => r.err));
  for (const v of race) if (st(v) === "requested") run(`select hardware_service_cancel('${S}','${v}',1,'duplicate','LOCAL synthetic race cleanup')`);
  // Existing Office calendar entries and unavailability block booking.
  run(`insert into office_meetings(id,title,business_unit,status,owner,scheduled_at,participants) values('meeting_5c_local','LOCAL synthetic meeting','technology','active','${T2}',${T(3, 14)},'[]')`);
  const I3 = ok(request(S, "inspection", null, lagos));
  check("S-MEETING-CONFLICT", "a technician's existing Office meeting blocks an overlapping slot", err(schedule(S, I3.id, 1, T2, T(3, 13, 30), T(3, 15)), "technician_has_meeting") && err(schedule(S, I3.id, 1, T2, T(3, 14, 30), T(3, 16)), "technician_has_meeting"));
  check("S-UNAVAIL-AUTH", "only service configurers record unavailability", err(psql(`select hardware_service_add_unavailability('${S}','${T2}',${T(5, 0)},${T(6, 0)},'LOCAL leave')`), "forbidden"));
  check("S-UNAVAIL", "recorded unavailability blocks booking", ok(psql(`select hardware_service_add_unavailability('${CFG}','${T2}',${T(5, 0)},${T(6, 0)},'LOCAL leave')`)) !== null && err(schedule(S, I3.id, 1, T2, T(5, 10), T(5, 12)), "technician_unavailable"));
  check("S-UNAVAIL-BOOKED", "unavailability cannot overlap an existing booking", err(psql(`select hardware_service_add_unavailability('${CFG}','${T1}',${T(2, 0)},${T(3, 0)},'LOCAL leave')`), "conflicts_with_booked_appointment"));
  // Reschedule and reassignment.
  const r1 = ok(schedule(S, I1.id, 2, T1, T(2, 10, 30), T(2, 11, 30)));
  check("S-RESCHEDULE-SELF", "rescheduling into its own previous slot is allowed; previous appointment superseded",
    r1?.reschedule_count === 1 && one(`select string_agg(state,',' order by sequence) from hardware_service_appointments where visit_id='${I1.id}'`) === "superseded,booked"
    && one(`select string_agg(status,',' order by created_at) from office_meetings where related_id='${I1.id}'`) === "cancelled,active");
  const r2 = ok(schedule(S, I1.id, 3, T2, T(2, 10), T(2, 12)));
  check("S-REASSIGN", "reassigned to another technician; the first technician's slot is freed", r2?.technician === T2 && r2.reschedule_count === 2
    && one(`select count(*) from hardware_service_appointments where technician='${T1}' and state='booked' and slot && tstzrange(${T(2, 10)},${T(2, 12)})`) === "0"
    && one(`select count(*) from hardware_service_appointments where visit_id='${I1.id}' and technician='${T1}' and state='booked'`) === "0");

  // Performing an inspection.
  check("S-START-OTHER-TECH", "only the assigned technician can start the visit", err(call("hardware_service_start", T1, I1.id, ver(I1.id)), "not_assigned_technician"));
  check("S-START-SCHEDULER", "schedulers cannot perform visits", err(call("hardware_service_start", S, I1.id, ver(I1.id)), "forbidden"));
  check("S-START-EARLY", "work cannot start days before the appointment", (() => { const far = ok(request(S, "inspection", null, lagos)); ok(schedule(S, far.id, 1, T2, T(9, 10), T(9, 12)));
    const r = err(call("hardware_service_start", T2, far.id, 2), "too_early_to_start"); run(`select hardware_service_cancel('${S}','${far.id}',2,'customer_request','LOCAL synthetic cleanup')`); return r; })());
  // Bring the appointment to tomorrow so it may start today.
  ok(schedule(S, I1.id, ver(I1.id), T2, T(1, 10), T(1, 12)));
  check("S-START", "assigned technician starts the inspection", ok(call("hardware_service_start", T2, I1.id, ver(I1.id)))?.state === "in_progress");
  check("S-REPORT-INVALID", "report needs findings and a known recommendation", err(call("hardware_service_record_report", T2, I1.id, ver(I1.id), { findings: "short", recommendation: "proceed" }), "invalid_inspection_report")
    && err(call("hardware_service_record_report", T2, I1.id, ver(I1.id), { findings: "Roof access fine; wiring old.", recommendation: "buy_now" }), "invalid_inspection_report")
    && err(call("hardware_service_record_report", T2, I1.id, ver(I1.id), { findings: "Roof access fine; wiring old.", recommendation: "proceed", price_kobo: 1 }), "invalid_inspection_report"));
  check("S-NO-REPORT", "inspection cannot complete without a report", err(call("hardware_service_complete", T2, I1.id, ver(I1.id), null, null, ""), "inspection_report_required"));
  check("S-REPORT", "inspection report recorded", ok(call("hardware_service_record_report", T2, I1.id, ver(I1.id), { findings: "Distribution board needs replacement before install.", recommendation: "proceed_with_changes", notes: "Synthetic" }))?.report?.recommendation === "proceed_with_changes");
  check("S-NO-PHOTO", "inspection cannot complete without a photograph", err(call("hardware_service_complete", T2, I1.id, ver(I1.id), null, null, ""), "evidence_required"));
  check("S-PHOTO-KIND", "an installation photo cannot be attached to an inspection", err(addPhoto(T2, I1.id, "installation_photo", "x1"), "invalid_evidence"));
  const other = fakePhoto(I2.id, "other-visit");
  check("S-PHOTO-OTHER", "a file linked to another visit is refused", err(psql(`select hardware_service_add_evidence('${T2}','${I1.id}',${ver(I1.id)},'${other.id}','inspection_photo','${other.sha}',2222)`), "invalid_evidence_file"));
  check("S-PHOTO-OTHER-TECH", "another technician cannot attach evidence", err(addPhoto(T1, I1.id, "inspection_photo", "x2"), "not_assigned_technician"));
  check("S-PHOTO", "inspection photograph registered", ok(addPhoto(T2, I1.id, "inspection_photo", "site-1"))?.row_version === ver(I1.id));
  check("S-PHOTO-DUP", "the same image cannot be registered twice", err(addPhoto(T2, I1.id, "inspection_photo", "site-1"), "duplicate_evidence"));
  const done1 = ok(call("hardware_service_complete", T2, I1.id, ver(I1.id), null, null, "Report ready"));
  check("S-COMPLETE-INSPECTION", "inspection completed; appointment and calendar entry completed", done1?.state === "completed"
    && one(`select state from hardware_service_appointments where visit_id='${I1.id}' and state<>'superseded' order by sequence desc limit 1`) === "completed"
    && one(`select count(*) from office_meetings where related_id='${I1.id}' and status='completed'`) === "1");
  check("S-COMPLETE-TWICE", "completion cannot be repeated", err(call("hardware_service_complete", T2, I1.id, ver(I1.id), null, null, ""), "invalid_service_transition") && err(call("hardware_service_complete", T2, I1.id, ver(I1.id) - 1, null, null, ""), "visit_state_changed"));
  check("S-COMPLETED-TERMINAL", "a completed visit cannot be rescheduled, held or cancelled", err(schedule(S, I1.id, ver(I1.id), T2, T(6, 10), T(6, 12)), "invalid_service_transition")
    && err(call("hardware_service_hold", S, I1.id, ver(I1.id), "other", "LOCAL synthetic note"), "invalid_service_transition") && err(call("hardware_service_cancel", S, I1.id, ver(I1.id), "other", "LOCAL synthetic note"), "invalid_service_transition"));

  // Installation lifecycle linked to a paid order with installation requested.
  check("S-INSTALL-REQUEST", "installation request linked to the order (contact taken from the order)", ok(request(S, "installation", O, lagos, null))?.order_id === O);
  const IV = one(`select id from hardware_service_visits where order_id='${O}' and kind='installation'`);
  check("S-INSTALL-DUP", "a second open installation for the same order refused", err(request(S, "installation", O, lagos, null), "installation_already_open"));
  check("S-INSTALL-CONTACT", "contact must match the order", err(request(S, "inspection", O, lagos, contact), "invalid_service_input"));
  ok(schedule(S, IV, 1, T1, T(1, 13), T(1, 16)));
  check("S-INSTALL-NOT-DELIVERED", "installation cannot start before the goods are delivered", err(call("hardware_service_start", T1, IV, ver(IV)), "goods_not_delivered"));
  deliver(O);
  check("S-DELIVERED", "order delivered through the 5B delivery record", fs5a(O) === "delivered");
  check("S-PREMATURE-CLOSE", "the order cannot be closed before installation", err(psql(`select hardware_fulfilment_transition('${F}','${O}',${fver(O)},'closed','Premature close attempt')`), "invalid_fulfilment_transition"));
  check("S-USE-INSTALLATION-RECORD", "the 5A screen cannot mark installed directly", err(psql(`select hardware_fulfilment_transition('${F}','${O}',${fver(O)},'installed','')`), "use_installation_record"));
  check("S-NO-CHECKLIST", "installation cannot start until a checklist is configured", err(call("hardware_service_start", T1, IV, ver(IV)), "checklist_not_configured"));
  const checklist = { items: [{ code: "mount", label: "Devices mounted", required: true }, { code: "test", label: "Function test passed", required: true }, { code: "tidy", label: "Site tidied", required: false }] };
  check("S-CHECKLIST-INVALID", "invalid checklist settings refused", err(psql(`select hardware_fulfilment_setting_set('${CFG}','installation_checklist',0,${J({ items: [{ code: "x", label: "", required: true }] })},'LOCAL synthetic checklist')`), "invalid_fulfilment_setting")
    && err(psql(`select hardware_fulfilment_setting_set('${CFG}','installation_checklist',0,${J({ items: [] })},'LOCAL synthetic checklist')`), "invalid_fulfilment_setting"));
  check("S-CHECKLIST-AUTH", "only fulfilment configurers set the checklist", err(psql(`select hardware_fulfilment_setting_set('${S}','installation_checklist',0,${J(checklist)},'LOCAL synthetic checklist')`), "forbidden"));
  check("S-CHECKLIST-SET", "checklist configured (versioned)", ok(psql(`select hardware_fulfilment_setting_set('${CFG}','installation_checklist',0,${J(checklist)},'LOCAL synthetic checklist')`))?.version === 1);
  check("S-INSTALL-START", "assigned technician starts installation; checklist version pinned", ok(call("hardware_service_start", T1, IV, ver(IV)))?.checklist_version === 1);
  ok(psql(`select hardware_fulfilment_setting_set('${CFG}','installation_checklist',1,${J({ items: [...checklist.items, { code: "extra", label: "Later item", required: true }] })},'LOCAL synthetic checklist v2')`));
  check("S-CHECKLIST-UNKNOWN", "checklist items outside the pinned version refused", err(call("hardware_service_update_checklist", T1, IV, ver(IV), { mount: true, extra: true }), "invalid_checklist")
    && err(call("hardware_service_update_checklist", T1, IV, ver(IV), { mount: "yes" }), "invalid_checklist"));
  check("S-CHECKLIST-PARTIAL", "partial checklist saved", ok(call("hardware_service_update_checklist", T1, IV, ver(IV), { mount: true }))?.checklist?.mount === true);
  check("S-CHECKLIST-INCOMPLETE", "completion refused while required checklist items are open", err(call("hardware_service_complete", T1, IV, ver(IV), "Ada Customer", "customer", ""), "checklist_incomplete"));
  ok(call("hardware_service_update_checklist", T1, IV, ver(IV), { mount: true, test: true }));
  check("S-INSTALL-NO-PHOTO", "completion refused without an installation photograph", err(call("hardware_service_complete", T1, IV, ver(IV), "Ada Customer", "customer", ""), "evidence_required"));
  check("S-INSTALL-PHOTO-KIND", "an inspection photo cannot be attached to an installation", err(addPhoto(T1, IV, "inspection_photo", "y1"), "invalid_evidence"));
  ok(addPhoto(T1, IV, "installation_photo", "install-1"));
  check("S-ACCEPTANCE", "customer acceptance (name and relationship) is required", err(call("hardware_service_complete", T1, IV, ver(IV), "", "customer", ""), "customer_acceptance_required")
    && err(call("hardware_service_complete", T1, IV, ver(IV), "Ada Customer", "friend", ""), "customer_acceptance_required"));
  check("S-INSTALL-OTHER-TECH", "another technician cannot complete", err(call("hardware_service_complete", T2, IV, ver(IV), "Ada Customer", "customer", ""), "not_assigned_technician"));
  const cv = ver(IV);
  const cr = await concurrentSql(Array.from({ length: 4 }, () => `select hardware_service_complete('${T1}','${IV}',${cv},'Ada Customer','customer','')`));
  check("S-COMPLETE-RACE", "four concurrent completions: exactly one; one installed step", cr.filter((r) => r.code === 0).length === 1
    && st(IV) === "completed" && fs5a(O) === "installed" && one(`select count(*)||':'||max(authorization_scope) from hardware_fulfilment_events where order_id='${O}' and to_state='installed'`) === "1:commerce.orders.service.perform", cr.map((r) => r.err));
  check("S-ACCEPTED", "acceptance stored on the visit", one(`select acceptance_name||':'||acceptance_relationship from hardware_service_visits where id='${IV}'`) === "Ada Customer:customer");
  check("S-CLOSE-AFTER", "5A close works after the installation record completes", ok(psql(`select hardware_fulfilment_transition('${F}','${O}',${fver(O)},'closed','Installed and accepted')`))?.state === "closed");
  check("S-INSTALL-AFTER-CLOSE", "no new installation once one is completed", err(request(S, "installation", O, lagos, null), "installation_already_open"));

  // Holds, release, cancellation and the refund freeze.
  const H = ok(request(S, "installation", O2, lagos, null)).id;
  ok(schedule(S, H, 1, T2, T(3, 9), T(3, 11)));
  check("S-HOLD-NOTE", "hold needs a known exception and a note", err(call("hardware_service_hold", S, H, 2, "weather", "LOCAL synthetic note"), "invalid_service_exception") && err(call("hardware_service_hold", S, H, 2, "site_not_ready", "short"), "invalid_service_exception"));
  check("S-HOLD", "hold frees the technician's booking and calendar entry", ok(call("hardware_service_hold", S, H, 2, "site_not_ready", "Site wiring not ready yet"))?.state === "on_hold"
    && one(`select count(*) from hardware_service_appointments where visit_id='${H}' and state='booked'`) === "0" && one(`select status from office_meetings where related_id='${H}'`) === "cancelled");
  check("S-HOLD-SLOT-FREE", "the freed slot can be booked by another visit", (() => { const x = ok(request(S, "inspection", null, lagos)); const r = ok(schedule(S, x.id, 1, T2, T(3, 9), T(3, 11)))?.state === "scheduled";
    run(`select hardware_service_cancel('${S}','${x.id}',2,'customer_request','LOCAL synthetic cleanup')`); return r; })());
  check("S-HOLD-BLOCKS", "a held visit cannot be scheduled or started", err(schedule(S, H, 3, T2, T(3, 13), T(3, 15)), "invalid_service_transition") && err(call("hardware_service_start", T2, H, 3), "not_assigned_technician"));
  check("S-RELEASE", "release returns the visit to requested (re-scheduling needed)", ok(call("hardware_service_release", S, H, 3, "Customer confirmed site ready"))?.state === "requested");
  check("S-CANCEL-NOTE", "cancellation needs a known reason and a note", err(call("hardware_service_cancel", S, H, 4, "bored", "LOCAL synthetic note"), "invalid_service_exception"));
  check("S-CANCEL", "cancelled with reason", ok(call("hardware_service_cancel", S, H, 4, "customer_request", "Customer will install later"))?.state === "cancelled");
  check("S-CANCEL-REOPEN", "a new installation may be requested after cancellation", ok(request(S, "installation", O2, lagos, null))?.state === "requested");
  const H2 = one(`select id from hardware_service_visits where order_id='${O2}' and state='requested'`);
  ok(schedule(S, H2, 1, T2, T(1, 8), T(1, 10))); deliver(O2); ok(call("hardware_service_start", T2, H2, 2));
  check("S-CANCEL-IN-PROGRESS", "work in progress cannot be cancelled (hold instead)", err(call("hardware_service_cancel", S, H2, 3, "customer_request", "LOCAL synthetic note"), "invalid_service_transition"));
  // Measured before the test's own refund request (which legitimately writes refund and payment history).
  check("S-NO-MONEY", "service work never touches stock, inventory, payments, confirmations or refunds", snap() === before, [before, snap()]);
  run(`select hardware_refund_request('refunder@fulfilment.test','${O2}','LOCAL synthetic refund freezes installation')`);
  check("S-REFUND-FREEZE", "a refund request freezes installation work and scheduling", err(call("hardware_service_update_checklist", T2, H2, 3, { mount: true }), "order_not_paid_and_allocated")
    && err(call("hardware_service_hold", S, H2, 3, "refund_review", "Refund under review here"), "order_not_paid_and_allocated"));

  // Fees: configurable, shape-validated, never applied.
  check("S-FEES", "inspection fees are configurable settings only (no seeded prices, nothing charged)",
    ok(psql(`select hardware_fulfilment_setting_set('${CFG}','inspection_fees',0,${J({ currency: "NGN", services: [{ code: "standard", label: "Standard inspection", fee_kobo: 0, vat_rate_bp: 750 }] })},'LOCAL synthetic placeholder')`))?.version === 1
    && err(psql(`select hardware_fulfilment_setting_set('${CFG}','inspection_fees',1,${J({ currency: "USD", services: [] })},'LOCAL synthetic placeholder')`), "invalid_fulfilment_setting")
    && one("select count(*) from information_schema.columns where table_name like 'hardware_service_%' and (column_name like '%kobo%' or column_name like '%price%' or column_name like '%fee%')") === "0");

  // Evidence trail and isolation from money and stock.
  check("S-AUDIT", "one audit event and one CRM activity per visit event",
    one("select count(*) from hardware_service_visit_events") === one("select count(*) from audit_events where target_type='hardware_service_visit' and action like 'hardware_service_%'")
    && one("select count(*) from hardware_service_visit_events") === one("select count(*) from crm_activities where related_type='hardware_service_visit'"));
  check("S-CHAIN", "inspection event chain recorded in order", one(`select string_agg(event_type,',' order by row_version) from hardware_service_visit_events where visit_id='${I1.id}'`) === "requested,scheduled,rescheduled,rescheduled,rescheduled,started,report_recorded,evidence_added,completed");

  // Tampering and posture.
  const Z = ok(request(S, "inspection", null, lagos)).id; ok(schedule(S, Z, 1, T1, T(6, 10), T(6, 12)));
  check("S-T-UPDATE", "direct state change denied", psql(`update hardware_service_visits set state='completed',completed_at=now(),row_version=row_version+1 where id='${Z}'`).status !== 0);
  check("S-T-DELETE", "visits and appointments cannot be deleted", psql(`delete from hardware_service_visits where id='${Z}'`).status !== 0 && psql(`delete from hardware_service_appointments where visit_id='${Z}'`).status !== 0);
  check("S-T-OVERLAP", "a directly inserted overlapping booking is refused by the exclusion constraint",
    err(psql(`insert into hardware_service_appointments(visit_id,sequence,technician,slot,state,actor) values('${I2.id}',9,'${T1}',tstzrange(${T(6, 11)},${T(6, 13)}),'booked','x')`), "hardware_service_no_double_booking"));
  check("S-T-MOVE", "a booked appointment's time or technician cannot be edited in place", psql(`update hardware_service_appointments set slot=tstzrange(${T(7, 10)},${T(7, 12)}) where visit_id='${Z}' and state='booked'`).status !== 0
    && psql(`update hardware_service_appointments set state='booked' where visit_id='${I1.id}' and state='completed'`).status !== 0);
  check("S-T-EVENTS", "events, evidence, hours and unavailability are immutable", ["hardware_service_visit_events", "hardware_service_visit_evidence", "hardware_technician_schedules", "hardware_technician_unavailability"].every((t) => psql(`update ${t} set actor='x'`).status !== 0 && psql(`delete from ${t}`).status !== 0));
  check("S-T-BARE", "a visit without its event and audit evidence is denied at commit", psql(`begin;insert into hardware_service_visits(kind,contact_id,service_address,state,row_version,created_by) values('inspection','${contact}',${J(lagos)},'requested',1,'x');commit;`).status !== 0);
  check("S-T-INJECT", "out-of-chain event denied at commit", psql(`begin;insert into hardware_service_visit_events(visit_id,row_version,event_type,from_state,to_state,actor,authorization_scope) values('${Z}',99,'completed','in_progress','completed','x','commerce.orders.service.perform');commit;`).status !== 0);
  check("S-T-UNBOOK", "freeing a booking without a visit event is denied at commit", psql(`begin;update hardware_service_appointments set state='cancelled' where visit_id='${Z}' and state='booked';commit;`).status !== 0);
  for (const t of ["hardware_service_visits", "hardware_service_appointments", "hardware_service_visit_events", "hardware_service_visit_evidence", "hardware_technician_schedules", "hardware_technician_unavailability"])
    check("S-DB", "RLS, no anonymous access, no truncate/delete: " + t, one(`select relrowsecurity and not has_table_privilege('anon','${t}','SELECT') and not has_table_privilege('authenticated','${t}','SELECT') and not has_table_privilege('service_role','${t}','TRUNCATE') and not has_table_privilege('service_role','${t}','DELETE') from pg_class where oid='${t}'::regclass`) === "t");
  check("S-DBFN", "service functions are invoker, path-pinned and service-only", one("select count(*) from pg_proc p where pronamespace='public'::regnamespace and (proname like 'hardware_service_%' or proname in ('hardware_fulfilment_step','hardware_fulfilment_transition','hardware_fulfilment_setting_set')) and (prosecdef or proconfig is distinct from array['search_path=public, pg_temp'] or has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE'))") === "0");
  check("S-NO-PAYMENT-WRITE", "no service function writes payment, reservation, order or inventory tables",
    one("select count(*) from pg_proc where pronamespace='public'::regnamespace and proname like 'hardware_service_%' and prosrc ~* '(update|insert into|delete from)\\s+(hardware_orders|hardware_payment_|hardware_reservation|hardware_refund|catalogue_variants|catalogue_inventory_changes|hardware_fulfilments)'") === "0");

  if (process.env.TEST_SERVICE_API !== "false") await require("./test-hardware-service-api-cases")({ ...h, S, T1, T2, CFG, DL, lagos, contact, T, ver, st, fs5a, fver, deliver, request, schedule, call, ok, err, q, J, checklist });
  if (process.env.TEST_PROGRESS === "true") await require("./test-hardware-progress-cases")({ ...h, DL, O, O2, T1, T2 });
};
