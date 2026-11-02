"use strict";
// Phase 5C HTTP API, photo evidence (real Office storage service; metadata stripping, permissions, audit, generic-route
// isolation) and the Office screen, against the real Office server. Runs after test-hardware-service-cases.js.
const path = require("path"), http = require("http"), { pathToFileURL } = require("url");
module.exports = async (h) => {
  const { one, check, paid, ROOT, startApp, gatewayUrl, reloadSchema, restUrl, PASSWORD, F, mod, S, T1, T2, CFG, lagos, deliver, ver, st, fs5a, checklist } = h;
  await reloadSchema(restUrl);
  const app = await startApp(gatewayUrl, true, true, { OFFICE_HARDWARE_FULFILMENT_ENABLED: "true", OFFICE_HARDWARE_DELIVERY_ENABLED: "true", OFFICE_HARDWARE_SERVICE_ENABLED: "true" });
  const raw = (url, { method = "GET", headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: { ...headers, ...(body ? { "content-length": Buffer.byteLength(body) } : {}) }, agent: false }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }));
    });
    r.on("error", reject); if (body) r.write(body); r.end();
  });
  const login = async (base, e) => {
    const r = await raw(base + "/api/lead-agents/admin/session/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: e, password: PASSWORD }) });
    if (r.status !== 200) throw Error("login " + e + " " + r.status);
    return [].concat(r.headers["set-cookie"] || []).find((x) => x.startsWith("lead_agents_admin=")).split(";")[0];
  };
  const V = "sviewer@service.test", ROOTU = "root@delivery.test";
  // The fulfilment test user also schedules installations from the order screen.
  h.run(`update admin_users set permission_scopes=array_append(permission_scopes,'commerce.orders.service.schedule') where email='${F}'`);
  const cookies = {};
  for (const e of [S, T1, T2, CFG, V, ROOTU, F]) cookies[e] = await login(app.url, e);
  const api = async (who, method, p, body) => {
    let r;
    try { r = await raw(app.url + p, { method, headers: { "content-type": "application/json", cookie: cookies[who], origin: app.url }, body: body ? JSON.stringify(body) : undefined }); }
    catch (e) { if (e.code === "ECONNRESET" || e.code === "EPIPE") return { status: 413, data: null, buf: Buffer.alloc(0), reset: true }; throw e; }
    let data = null; try { data = JSON.parse(r.buf.toString()); } catch {}
    return { status: r.status, data, buf: r.buf, type: r.headers["content-type"] };
  };
  const A = "/api/lead-agents/admin/hardware-service";
  const day = (n) => one(`select ((now() at time zone 'Africa/Lagos')::date+${n})::text`);
  const at = (n, hm) => `${day(n)}T${hm}:00+01:00`;
  const sharp = require("sharp");
  const jpeg = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#a62" } }).jpeg().withExif({ IFD0: { Copyright: "SERVICE-SECRET-MARKER" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "6/1 35/1 0/1" } }).toBuffer();
  const dataUrl = (buf, mime = "image/jpeg") => `data:${mime};base64,${buf.toString("base64")}`;

  check("API-S-AUTH", "read-only staff and technicians cannot create requests", (await api(V, "POST", A + "/visits", { kind: "inspection", contact_id: h.contact, service_address: lagos })).status === 403
    && (await api(T1, "POST", A + "/visits", { kind: "inspection", contact_id: h.contact, service_address: lagos })).status === 403);
  check("API-S-FIELDS", "unknown fields refused", (await api(S, "POST", A + "/visits", { kind: "inspection", contact_id: h.contact, service_address: lagos, price_kobo: 1 })).status === 400);
  check("API-S-ORIGIN", "cross-origin writes refused", (await raw(app.url + A + "/visits", { method: "POST", headers: { "content-type": "application/json", cookie: cookies[S], origin: "https://evil.example" }, body: JSON.stringify({ kind: "inspection" }) })).status === 403);
  const created = await api(S, "POST", A + "/visits", { kind: "inspection", contact_id: h.contact, service_address: { ...lagos, landmark: "Opposite LOCAL park" }, note: "API request" });
  check("API-S-REQUEST", "inspection request created through the API", created.status === 201 && created.data?.visit?.state === "requested", created.data);
  const VID = created.data?.visit?.id;
  check("API-S-OUTSIDE", "outside coverage mapped to a safe conflict", (await api(S, "POST", A + "/visits", { kind: "inspection", contact_id: h.contact, service_address: { ...lagos, city: "Badagry" } })).data?.error === "outside_coverage");
  const techs = await api(S, "GET", A + "/technicians");
  check("API-S-TECHS", "technician list shows field technicians with working hours only", techs.status === 200 && techs.data.technicians.map((t) => t.email).sort().join(",") === [T1, T2].sort().join(",") && techs.data.technicians.every((t) => t.windows.length === 7) && JSON.stringify(techs.data).indexOf("password") < 0);
  check("API-S-BAD-TIME", "malformed times refused", (await api(S, "POST", A + `/visits/${VID}/schedule`, { expected_row_version: 1, technician: T1, starts_at: "tomorrow 10am", ends_at: at(7, "12:00") })).data?.error === "invalid_slot");
  check("API-S-SCHED-AUTH", "technicians cannot schedule", (await api(T1, "POST", A + `/visits/${VID}/schedule`, { expected_row_version: 1, technician: T1, starts_at: at(1, "15:00"), ends_at: at(1, "16:00") })).status === 403);
  const sch = await api(S, "POST", A + `/visits/${VID}/schedule`, { expected_row_version: 1, technician: T1, starts_at: at(1, "16:00"), ends_at: at(1, "17:30") });
  check("API-S-SCHEDULE", "scheduled through the API", sch.data?.visit?.state === "scheduled" && sch.data.visit.technician === T1, sch.data);
  const busy = await api(S, "GET", A + `/technicians/${encodeURIComponent(T1)}/busy?date=${day(1)}`);
  check("API-S-BUSY", "busy times for the day include the booking; no open slots are published", busy.status === 200 && busy.data.busy.some((b) => b.type === "inspection" && Date.parse(b.starts_at) === Date.parse(at(1, "16:00"))) && !("slots" in busy.data) && !("available" in busy.data));
  const busy2 = await api(S, "GET", A + `/technicians/${encodeURIComponent(T2)}/busy?date=${day(5)}`);
  check("API-S-BUSY-AWAY", "recorded unavailability appears as busy", busy2.data?.busy?.some((b) => b.type === "unavailable"));
  const other = (await api(S, "POST", A + "/visits", { kind: "inspection", contact_id: h.contact, service_address: lagos })).data.visit;
  check("API-S-DOUBLE", "double booking refused through the API", (await api(S, "POST", A + `/visits/${other.id}/schedule`, { expected_row_version: 1, technician: T1, starts_at: at(1, "17:00"), ends_at: at(1, "18:00") })).data?.error === "technician_double_booked");
  check("API-S-NOT-MINE", "another technician cannot start", (await api(T2, "POST", A + `/visits/${VID}/start`, { expected_row_version: 2 })).data?.error === "not_assigned_technician");
  check("API-S-START", "assigned technician starts", (await api(T1, "POST", A + `/visits/${VID}/start`, { expected_row_version: 2 })).data?.visit?.state === "in_progress");
  const filesBefore = one("select count(*) from office_files where purpose='service_visit_photo'");
  check("API-S-PHOTO-VIEWER", "read-only staff cannot upload", (await api(V, "POST", A + `/visits/${VID}/evidence`, { expected_row_version: 3, kind: "inspection_photo", data_url: dataUrl(jpeg) })).status === 403 && one("select count(*) from office_files where purpose='service_visit_photo'") === filesBefore);
  check("API-S-PHOTO-TYPE", "non-image content refused", (await api(T1, "POST", A + `/visits/${VID}/evidence`, { expected_row_version: 3, kind: "inspection_photo", data_url: "data:image/png;base64," + Buffer.from("%PDF-1.4 definitely not a picture.....").toString("base64") })).data?.error === "unsupported_photo_type");
  { const big = await api(T1, "POST", A + `/visits/${VID}/evidence`, { expected_row_version: 3, kind: "inspection_photo", data_url: dataUrl(Buffer.concat([jpeg, Buffer.alloc(9 * 1024 * 1024)])) });
    check("API-S-PHOTO-BIG", "oversized photo refused, nothing stored", big.status === 413 && one("select count(*) from office_files where purpose='service_visit_photo'") === filesBefore); }
  const up = await api(T1, "POST", A + `/visits/${VID}/evidence`, { expected_row_version: 3, kind: "inspection_photo", data_url: dataUrl(jpeg) });
  check("API-S-PHOTO", "photograph stored through the Office storage service and linked to the visit", up.status === 201
    && one(`select count(*) from office_files f join hardware_service_visit_evidence e on e.file_id=f.id where e.visit_id='${VID}' and f.purpose='service_visit_photo' and f.resource_type='hardware_service_visit' and f.resource_id='${VID}' and f.storage_key like 'service_visit_photo_%.webp'`) === "1", up.data);
  const eid = up.data?.evidence?.evidence_id;
  const dup = await api(T1, "POST", A + `/visits/${VID}/evidence`, { expected_row_version: 4, kind: "inspection_photo", data_url: dataUrl(jpeg) });
  check("API-S-PHOTO-DUP-CLEANUP", "duplicate refused and its stored file record removed", dup.data?.error === "duplicate_evidence" && one("select count(*) from office_files where purpose='service_visit_photo'") === String(Number(filesBefore) + 1));
  const view = await api(S, "GET", A + `/visits/${VID}/evidence/${eid}`);
  const meta = view.status === 200 ? await sharp(view.buf).metadata() : {};
  check("API-S-PHOTO-STRIPPED", "stored photograph is WebP with all EXIF/GPS metadata removed", view.status === 200 && view.type === "image/webp" && meta.format === "webp" && !meta.exif && !view.buf.includes(Buffer.from("SERVICE-SECRET-MARKER")) && !view.buf.includes(Buffer.from("GPS")));
  check("API-S-PHOTO-AUDIT", "photograph viewing is audited", one(`select count(*) from audit_events where action='hardware_service_evidence_viewed' and target_id='${VID}'`) === "1");
  check("API-S-PHOTO-PERM", "read-only staff cannot view photographs; wrong visit is not found", (await api(V, "GET", A + `/visits/${VID}/evidence/${eid}`)).status === 403 && (await api(S, "GET", A + `/visits/${other.id}/evidence/${eid}`)).status === 404);
  const key = one(`select storage_key from office_files f join hardware_service_visit_evidence e on e.file_id=f.id where e.id='${eid}'`);
  check("API-S-GENERIC-ROUTES", "generic storage routes cannot read or create visit photographs (even for super admin)", (await api(ROOTU, "GET", "/api/lead-agents/admin/storage/" + key)).status === 404
    && (await api(ROOTU, "POST", "/api/lead-agents/admin/storage", { purpose: "service_visit_photo", data_url: dataUrl(jpeg) })).status === 403);
  const asViewer = await api(V, "GET", A + `/visits/${VID}`);
  check("API-S-RESTRICTED", "read-only staff see status and area but not the street address or photo links", asViewer.data?.visit?.service_address?.address === "(restricted)" && asViewer.data.visit.service_address.city === "Ikeja" && asViewer.data.can_view_evidence === false && asViewer.data.public_booking === false && asViewer.data.notifications === false);
  check("API-S-REPORT", "report recorded through the API", (await api(T1, "POST", A + `/visits/${VID}/report`, { expected_row_version: 4, findings: "Ceiling void accessible; one socket faulty.", recommendation: "requires_quote" })).data?.visit?.report?.recommendation === "requires_quote");
  check("API-S-COMPLETE", "inspection completed through the API", (await api(T1, "POST", A + `/visits/${VID}/complete`, { expected_row_version: 5, note: "Done" })).data?.visit?.state === "completed");
  check("API-S-STALE", "stale version mapped to a safe conflict", (await api(T1, "POST", A + `/visits/${VID}/complete`, { expected_row_version: 5 })).status === 409);
  check("API-S-HOURS-AUTH", "schedulers cannot change working hours", (await api(S, "POST", A + `/technicians/${encodeURIComponent(T1)}/hours`, { expected_version: 1, windows: [], reason: "LOCAL synthetic change" })).status === 403);
  check("API-S-HOURS", "configurers change working hours (versioned)", (await api(CFG, "POST", A + `/technicians/${encodeURIComponent(T1)}/hours`, { expected_version: 1, windows: Array.from({ length: 7 }, (_, d) => ({ weekday: d, start: "07:00", end: "19:00" })), reason: "LOCAL synthetic longer day" })).data?.schedule?.version === 2);
  check("API-S-UNAVAIL", "configurers record unavailability through the API", (await api(CFG, "POST", A + `/technicians/${encodeURIComponent(T1)}/unavailability`, { starts_at: at(20, "00:00"), ends_at: at(21, "00:00"), reason: "LOCAL leave" })).status === 201);
  const settings = await api(CFG, "GET", "/api/lead-agents/admin/hardware-fulfilment/settings");
  check("API-S-SETTINGS", "Fees & coverage offers inspection fees and the installation checklist when service visits are on", "inspection_fees" in (settings.data?.settings || {}) && settings.data.settings.installation_checklist.version === 2 && settings.data.applied_to_pricing === false);

  // ---- Office screen ----
  const smod = await import(pathToFileURL(path.join(ROOT, "public/office/catalogue/service.mjs")).href);
  const scopes = { [S]: ["commerce.orders.read", "commerce.orders.service.schedule"], [T1]: ["commerce.orders.read", "commerce.orders.service.perform"], [T2]: ["commerce.orders.read", "commerce.orders.service.perform"], [V]: ["commerce.orders.read"],
    [F]: ["commerce.orders.read", "commerce.orders.fulfilment.manage", "commerce.orders.service.schedule"] };
  const makeUi = (who) => { const dialogs = []; return { dialogs, state: { renderToken: 1, admin: { email: who } }, hasPermission: (p) => scopes[who].includes(p),
    el: (x) => { const t = document.createElement("template"); t.innerHTML = x.trim(); return t.content.firstElementChild; },
    escapeHtml: (s) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"),
    openDialog: (title, fields, onSubmit) => dialogs.push({ title, fields, onSubmit }),
    api: async (p, o = {}) => { const r = await api(who, o.method || "GET", p, o.body); if (r.status >= 400) { const e = new Error(r.data?.error || "failed"); e.data = r.data; throw e; } return r.data; } }; };
  const hostEl = () => { const m = document.createElement("main"); document.body.appendChild(m); return m; };
  const O = await paid(true); deliver(O);
  {
    const fui = makeUi(F), hf = hostEl();
    await mod.renderDetail(hf, 1, fui, O);
    check("UI-S-NO-MARK-INSTALLED", "with installation records on, the fulfilment buttons no longer offer Mark installed", ![...hf.querySelectorAll("[data-transition]")].some((b) => b.dataset.transition === "installed") && !!hf.querySelector("[data-order-service]") && !!hf.querySelector("[data-installed-by-record]"));
    hf.querySelector("[data-request-installation]").click();
    check("UI-S-REQUEST-DIALOG", "requesting installation opens a dialog with the service address", fui.dialogs[0]?.title === "Request installation" && fui.dialogs[0].fields.some((f) => f.name === "address"));
    await fui.dialogs[0].onSubmit({ state: "Lagos", city: "Lekki", address: "LOCAL 9 Synthetic Way", landmark: "", note: "<i>gate</i>" });
    const IV = one(`select id from hardware_service_visits where order_id='${O}' and kind='installation'`);
    check("UI-S-REQUESTED", "installation requested from the order screen and the visit opened", st(IV) === "requested" && !!hf.querySelector(`[data-visit-detail="${IV}"]`));
    const sui = makeUi(S), hs = hostEl();
    await smod.renderVisits(hs, 1, sui, { visit: IV });
    check("UI-S-LIST", "visits tab lists the installation and the technicians", !!hs.querySelector(`[data-visit="${IV}"]`) && hs.querySelectorAll("[data-tech]").length === 2 && hs.textContent.includes("notifications are off"));
    hs.querySelector('[data-visit-action="schedule"]').click();
    const dlg = sui.dialogs.find((d) => d.title.startsWith("Confirm: Schedule"));
    await dlg.onSubmit({ technician: T2, date: day(1), start: "20:00", end: "21:00", note: "" });
    check("UI-S-OUTSIDE-HOURS", "a booking outside working hours shows the server's reason and changes nothing", hs.textContent.includes("outside the technician's working hours") && st(IV) === "requested");
    await dlg.onSubmit({ technician: T2, date: day(1), start: "14:00", end: "16:00", note: "" });
    check("UI-S-SCHEDULED", "scheduled from the screen (Lagos time)", st(IV) === "scheduled" && one(`select to_char(starts_at at time zone 'Africa/Lagos','HH24:MI') from hardware_service_visits where id='${IV}'`) === "14:00");
    const tui = makeUi(T2), ht = hostEl();
    await smod.renderVisitDetail(ht, 1, tui, IV);
    ht.querySelector('[data-visit-action="start"]').click(); await tui.dialogs[0].onSubmit({ note: "" });
    check("UI-S-STARTED", "assigned technician starts work from the screen; checklist shown", st(IV) === "in_progress" && ht.querySelectorAll("[data-check-input]").length === checklist.items.length + 1);
    for (const i of ht.querySelectorAll("[data-check-input]")) i.checked = true;
    ht.querySelector("[data-save-checklist]").click(); await new Promise((r) => setTimeout(r, 400));
    check("UI-S-CHECKLIST", "checklist saved from the screen", one(`select checklist->>'mount' from hardware_service_visits where id='${IV}'`) === "true");
    tui.dialogs.length = 0; ht.querySelector('[data-visit-action="complete"]').click();
    await tui.dialogs[0].onSubmit({ acceptance_name: "Ngozi Customer", acceptance_relationship: "customer", note: "" });
    check("UI-S-NEEDS-PHOTO", "completion without a photograph shows a clear message and changes nothing", ht.textContent.includes("Upload at least one photograph") && st(IV) === "in_progress");
    await smod.uploadEvidence(tui, IV, ver(IV), "installation_photo", dataUrl(await sharp({ create: { width: 320, height: 240, channels: 3, background: "#39c" } }).png().toBuffer(), "image/png"));
    await smod.renderVisitDetail(ht, 1, tui, IV);
    check("UI-S-PHOTO-LISTED", "uploaded photograph listed with a protected view link", !!ht.querySelector("[data-evidence-item] a[href*='/evidence/']"));
    tui.dialogs.length = 0; ht.querySelector('[data-visit-action="complete"]').click();
    await tui.dialogs[0].onSubmit({ acceptance_name: "Ngozi <b>Customer</b>", acceptance_relationship: "customer", note: "" });
    check("UI-S-COMPLETED", "installation completed from the screen; order Installed; escaped acceptance shown", st(IV) === "completed" && fs5a(O) === "installed" && ht.querySelector("[data-acceptance]")?.textContent.includes("Ngozi <b>Customer</b>") && !ht.querySelector("[data-acceptance] b"));
    const vui = makeUi(V), hv = hostEl();
    await smod.renderVisitDetail(hv, 1, vui, IV);
    check("UI-S-VIEWER", "read-only staff see the visit without controls, street address or photo links", hv.querySelectorAll("[data-visit-action],[data-evidence-upload],[data-save-checklist]").length === 0 && !hv.querySelector("[data-evidence-item] a") && hv.textContent.includes("(restricted)"));
    const oth = makeUi(T1), ho = hostEl();
    const vid2 = (await api(S, "POST", A + "/visits", { kind: "inspection", contact_id: h.contact, service_address: lagos })).data.visit.id;
    await api(S, "POST", A + `/visits/${vid2}/schedule`, { expected_row_version: 1, technician: T2, starts_at: at(8, "09:00"), ends_at: at(8, "10:00") });
    await smod.renderVisitDetail(ho, 1, oth, vid2);
    check("UI-S-NOT-MINE", "a technician sees no work controls on another technician's visit", ho.querySelectorAll('[data-visit-action="start"]').length === 0);
  }
  await app.stop();
  const off = await startApp(gatewayUrl, true, true, { OFFICE_HARDWARE_FULFILMENT_ENABLED: "true", OFFICE_HARDWARE_DELIVERY_ENABLED: "true" });
  {
    const ck = await login(off.url, S);
    const g = await raw(off.url + A + "/visits", { headers: { cookie: ck } });
    const s = await raw(off.url + "/api/lead-agents/admin/hardware-fulfilment/settings", { headers: { cookie: ck } });
    check("API-S-DISABLED", "service API disabled unless its own flag is on (default); settings unchanged", g.status === 503 && JSON.parse(g.buf.toString()).error === "service_disabled" && !("inspection_fees" in JSON.parse(s.buf.toString()).settings));
  }
  await off.stop();
};
