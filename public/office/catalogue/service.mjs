// Phase 5C staff interface for site inspections and installations (local; off unless OFFICE_HARDWARE_SERVICE_ENABLED).
// The database and API remain the authority: every booking is re-verified there (working hours, unavailability, existing
// bookings and Office meetings), every write sends the expected version and refusals are shown as-is. Times are Africa/Lagos.
// No public booking, customer notification, price or payment control exists here, and no open slots are offered.
export const SERVICE_API = "/api/lead-agents/admin/hardware-service";
const SCHEDULE = "commerce.orders.service.schedule", PERFORM = "commerce.orders.service.perform", CONFIGURE = "commerce.orders.service.configure";
export const VISIT_LABEL = { requested: "Requested", scheduled: "Scheduled", in_progress: "In progress", on_hold: "On hold", completed: "Completed", cancelled: "Cancelled" };
const KIND_LABEL = { inspection: "Site inspection", installation: "Installation" };
const HOLD_REASONS = ["customer_unavailable", "site_not_ready", "access_issue", "safety_issue", "parts_unavailable", "refund_review", "other"];
const CANCEL_REASONS = ["customer_request", "duplicate", "not_feasible", "outside_coverage", "other"];
const RECOMMENDATIONS = ["proceed", "proceed_with_changes", "requires_quote", "not_feasible"];
const RELATIONSHIPS = ["customer", "household_member", "colleague", "security_or_reception", "other"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const SERVICE_ERRORS = {
  service_disabled: "Inspections and installations are not enabled in this environment.",
  visit_state_changed: "Someone else updated this visit. The latest state has been reloaded.",
  invalid_service_transition: "That step is not allowed from the current state.",
  invalid_service_input: "Check the details and try again.",
  coverage_not_configured: "Coverage areas are not configured yet (Fees & coverage).",
  outside_coverage: "This address is outside the configured coverage for this service.",
  installation_requires_order: "Installations must be linked to an order.",
  installation_not_requested: "This order did not request installation.",
  installation_already_open: "This order already has an installation record.",
  order_not_paid_and_allocated: "The order is not a verified, allocated payment (or a refund was requested), so work is frozen.",
  technician_not_eligible: "Choose an active staff member with the field-technician capability.",
  no_working_hours: "This technician has no working hours recorded yet.",
  outside_working_hours: "That time is outside the technician's working hours (Lagos time, same day).",
  technician_unavailable: "The technician is unavailable at that time.",
  technician_double_booked: "The technician already has a visit at that time.",
  technician_has_meeting: "The technician has an Office meeting at that time.",
  invalid_slot: "Choose a start and end between 30 minutes and 8 hours apart, from now up to 90 days ahead.",
  not_assigned_technician: "Only the assigned technician can record this work.",
  too_early_to_start: "Work can be started from the day before the appointment.",
  goods_not_delivered: "The goods must be delivered (delivery record) before installation starts.",
  checklist_not_configured: "No installation checklist is configured yet (Fees & coverage).",
  invalid_checklist: "The checklist contains unknown items.",
  checklist_incomplete: "Complete every required checklist item first.",
  invalid_inspection_report: "Enter findings (at least 10 characters) and choose a recommendation.",
  inspection_report_required: "Record the inspection report first.",
  evidence_required: "Upload at least one photograph of the work first.",
  customer_acceptance_required: "Enter the name of the person accepting the work and their relationship.",
  duplicate_evidence: "This photo was already uploaded for this visit.",
  evidence_limit_reached: "This visit already has the maximum of 20 photographs.",
  invalid_service_exception: "Choose a reason and add a note of at least 8 characters.",
  invalid_schedule: "Check the working hours: each day needs a start before its end (HH:MM).",
  schedule_changed: "The working hours were changed by someone else. The latest version has been reloaded.",
  conflicts_with_booked_appointment: "That period overlaps a booked visit. Reschedule the visit first.",
  invalid_unavailability: "Check the period and give a reason.",
  unsupported_photo_type: "Photos must be JPEG, PNG or WebP.",
  photo_too_large: "The photo is too large (maximum 8 MB).",
  unreadable_photo: "The photo could not be read.",
  forbidden: "You do not have permission for this action.",
};
const message = (e) => SERVICE_ERRORS[e?.data?.error] || SERVICE_ERRORS[e?.message] || e?.message || "The action could not be completed.";
const human = (s) => String(s || "").replaceAll("_", " ");
const when = (t) => (t ? new Date(t).toLocaleString("en-NG", { timeZone: "Africa/Lagos", dateStyle: "medium", timeStyle: "short" }) : "—");
const hhmm = (t) => new Date(t).toLocaleTimeString("en-NG", { timeZone: "Africa/Lagos", hour: "2-digit", minute: "2-digit", hour12: false });
// A Lagos wall-clock date + time (UTC+1, no daylight saving) as an ISO instant; null when malformed.
export function lagosInstant(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || "")) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(time || ""))) return null;
  const d = new Date(`${date}T${time}:00+01:00`);
  return Number.isNaN(d.getTime()) ? null : `${date}T${time}:00+01:00`;
}
const pill = (ui, state) => `<span class="cat-pill ${ui.escapeHtml(state)}">${ui.escapeHtml(VISIT_LABEL[state] || state)}</span>`;
const addressLine = (a) => [a?.address, a?.city, a?.state].filter(Boolean).join(", ");

// ---- Inspections & installations tab ----
export async function renderVisits(body, token, ui, view = {}) {
  const { el, escapeHtml: esc } = ui;
  const filter = VISIT_LABEL[view.state] ? view.state : "";
  const data = await ui.api(`${SERVICE_API}/visits${filter ? `?state=${filter}` : ""}`);
  if (token !== ui.state.renderToken) return;
  body.innerHTML = "";
  const panel = el(`<section class="cat-panel" data-visits><h2>Inspections & installations</h2>
    <p>Staff-scheduled site inspections and installations. Bookings are checked against working hours, unavailability, other visits and Office meetings. Times are Lagos time. Customer booking and notifications are off.</p>
    <label>Status <select class="cat-select" data-visit-filter aria-label="Filter by status"><option value="">All</option>${Object.keys(VISIT_LABEL).map((s) => `<option value="${s}" ${s === filter ? "selected" : ""}>${esc(VISIT_LABEL[s])}</option>`).join("")}</select></label>
    <div data-visit-tools></div><div class="cat-table" role="table" data-visit-list></div><p role="status" data-visits-status></p></section>`);
  body.appendChild(panel);
  panel.querySelector("[data-visit-filter]").onchange = (ev) => renderVisits(body, token, ui, { state: ev.target.value });
  const status = panel.querySelector("[data-visits-status]");
  if (ui.hasPermission(SCHEDULE)) {
    const b = el(`<button type="button" class="cat-btn" data-new-inspection>New inspection request</button>`);
    b.onclick = () => ui.openDialog("New site inspection", addressFields(), async (f) => {
      try {
        const r = await ui.api(`${SERVICE_API}/visits`, { method: "POST", body: { kind: "inspection", contact_id: String(f.contact_id || "").trim() || null, order_id: String(f.order_id || "").trim() || null, service_address: addressFrom(f), note: String(f.note || "") } });
        await renderVisits(body, token, ui, { visit: r.visit.id });
      } catch (e) { status.textContent = message(e); }
    });
    panel.querySelector("[data-visit-tools]").appendChild(b);
  }
  const list = panel.querySelector("[data-visit-list]");
  if (!data.visits.length) list.appendChild(el(`<p data-empty>No visits in this status.</p>`));
  for (const v of data.visits) {
    const r = el(`<div class="cat-tr" role="row" tabindex="0" data-visit="${esc(v.id)}"><span class="cat-cell">${esc(KIND_LABEL[v.kind])}</span><span class="cat-cell">${pill(ui, v.state)}</span>
      <span class="cat-cell">${esc(v.starts_at ? when(v.starts_at) : "Not scheduled")}</span><span class="cat-cell">${esc(v.technician || "—")}</span><span class="cat-cell">${esc(addressLine(v.service_address))}</span></div>`);
    const open = () => renderVisitDetail(body, token, ui, v.id);
    r.onclick = open; r.onkeydown = (ev) => { if (ev.key === "Enter") open(); };
    list.appendChild(r);
  }
  await renderTechnicians(body, token, ui);
  if (view.visit) await renderVisitDetail(body, token, ui, view.visit);
}
const addressFields = (withContact = true) => [
  ...(withContact ? [{ name: "contact_id", label: "CRM contact ID (or leave empty and give an order ID)" }, { name: "order_id", label: "Related order ID (optional)" }] : []),
  { name: "state", label: "State" }, { name: "city", label: "City" }, { name: "address", label: "Street address" }, { name: "landmark", label: "Landmark (optional)" },
  { name: "note", label: "Note (optional, recorded)", type: "textarea" },
];
const addressFrom = (f) => Object.fromEntries([["country", "NG"], ...["state", "city", "address", "landmark"].map((k) => [k, String(f[k] || "").trim()])].filter(([, v]) => v));

async function renderTechnicians(body, token, ui) {
  const { el, escapeHtml: esc } = ui;
  const data = await ui.api(`${SERVICE_API}/technicians`);
  if (token !== ui.state.renderToken) return;
  const box = el(`<section class="cat-panel" data-technicians style="margin-top:12px"><h3>Field technicians</h3><p class="cat-muted">Staff with the field-technician capability. Working hours are Lagos time.</p><ul data-tech-list></ul><p role="status" data-tech-status></p></section>`);
  body.appendChild(box);
  const list = box.querySelector("[data-tech-list]"), status = box.querySelector("[data-tech-status]");
  if (!data.technicians.length) list.appendChild(el(`<li data-no-tech>No staff have the field-technician capability.</li>`));
  for (const t of data.technicians) {
    const hours = t.windows.length ? t.windows.map((w) => `${WEEKDAYS[w.weekday]} ${w.start}–${w.end}`).join(", ") : "No working hours";
    const li = el(`<li data-tech="${esc(t.email)}">${esc(t.display_name || t.email)} · <span data-hours>${esc(hours)}</span> </li>`);
    if (ui.hasPermission(CONFIGURE)) {
      const b = el(`<button type="button" class="cat-btn" data-edit-hours>Working hours</button>`);
      b.onclick = () => ui.openDialog(`Working hours: ${t.email}`, [
        ...WEEKDAYS.map((d, i) => ({ name: `d${i}`, label: `${d} (HH:MM-HH:MM, empty = off)`, value: t.windows.filter((w) => w.weekday === i).map((w) => `${w.start}-${w.end}`).join(" ") })),
        { name: "reason", label: "Reason (at least 8 characters, recorded)", type: "textarea" },
      ], async (f) => {
        const windows = [];
        for (let i = 0; i < 7; i++) for (const part of String(f[`d${i}`] || "").split(/\s+/).filter(Boolean)) {
          const m = part.match(/^(\d{2}:\d{2})-(\d{2}:\d{2})$/); if (!m) { status.textContent = SERVICE_ERRORS.invalid_schedule; return; }
          windows.push({ weekday: i, start: m[1], end: m[2] });
        }
        try { await ui.api(`${SERVICE_API}/technicians/${encodeURIComponent(t.email)}/hours`, { method: "POST", body: { expected_version: t.hours_version, windows, reason: String(f.reason || "") } }); await renderVisits(body, token, ui); }
        catch (e) { status.textContent = message(e); }
      });
      const u = el(`<button type="button" class="cat-btn" data-add-unavailability>Unavailable…</button>`);
      u.onclick = () => ui.openDialog(`Unavailability: ${t.email}`, [
        { name: "from_date", label: "From date", type: "date" }, { name: "from_time", label: "From time (HH:MM)", value: "00:00" },
        { name: "to_date", label: "To date", type: "date" }, { name: "to_time", label: "To time (HH:MM)", value: "23:59" }, { name: "reason", label: "Reason (recorded)" },
      ], async (f) => {
        const a = lagosInstant(f.from_date, f.from_time), z = lagosInstant(f.to_date, f.to_time);
        if (!a || !z) { status.textContent = SERVICE_ERRORS.invalid_unavailability; return; }
        try { await ui.api(`${SERVICE_API}/technicians/${encodeURIComponent(t.email)}/unavailability`, { method: "POST", body: { starts_at: a, ends_at: z, reason: String(f.reason || "") } }); status.textContent = "Unavailability recorded."; }
        catch (e) { status.textContent = message(e); }
      });
      li.append(b, u);
    }
    list.appendChild(li);
  }
}

export async function renderVisitDetail(body, token, ui, id) {
  const { el, escapeHtml: esc } = ui;
  const d = await ui.api(`${SERVICE_API}/visits/${encodeURIComponent(id)}`);
  if (token !== ui.state.renderToken) return;
  body.querySelector("[data-visit-detail]")?.remove();
  const v = d.visit;
  const card = el(`<section class="cat-panel" data-visit-detail="${esc(v.id)}" style="margin-top:12px">
    <h3>${esc(KIND_LABEL[v.kind])} ${esc(v.id.slice(0, 8))}</h3>
    <p data-visit-state>${pill(ui, v.state)} · ${esc(v.starts_at ? `${when(v.starts_at)}–${hhmm(v.ends_at)}` : "Not scheduled")} · ${esc(v.technician || "No technician")}${v.reschedule_count ? ` · rescheduled ${v.reschedule_count}×` : ""}</p>
    <p data-visit-address>${esc(addressLine(v.service_address))}${v.order_id ? ` · order ${esc(v.order_id.slice(0, 8))}` : ""}</p>
    ${v.state === "completed" && v.acceptance_name ? `<p data-acceptance>Accepted by ${esc(v.acceptance_name)} (${esc(human(v.acceptance_relationship))}) on ${esc(when(v.completed_at))}</p>` : ""}
    ${v.report ? `<div data-report><b>Recommendation:</b> ${esc(human(v.report.recommendation))}<p>${esc(v.report.findings)}</p>${v.report.notes ? `<p class="cat-muted">${esc(v.report.notes)}</p>` : ""}</div>` : ""}
    <p class="cat-muted">Customer notifications and public booking are off.</p><p class="cat-muted" role="status" data-visit-status></p>
    <div data-visit-actions></div><div data-checklist></div><h4>Photographs</h4><ul data-evidence></ul><h4>History</h4><ol data-visit-history></ol></section>`);
  body.appendChild(card);
  const status = card.querySelector("[data-visit-status]"), actions = card.querySelector("[data-visit-actions]");
  const reload = async (note) => { await renderVisitDetail(body, token, ui, id); if (note) body.querySelector("[data-visit-detail] [data-visit-status]").textContent = note; };
  const post = (action, payload) => ui.api(`${SERVICE_API}/visits/${encodeURIComponent(id)}/${action}`, { method: "POST", body: { expected_row_version: v.row_version, ...payload } });
  const act = (label, attr, fields, run) => {
    const b = el(`<button type="button" class="cat-btn" data-visit-action="${attr}">${esc(label)}</button>`);
    b.onclick = () => ui.openDialog(`Confirm: ${label}`, fields, async (form) => {
      b.disabled = true;
      try { await run(form); await reload(`${label} recorded.`); }
      catch (e) { if ((e?.data?.error || e?.message) === "visit_state_changed") return reload(message(e)); status.textContent = message(e); b.disabled = false; }
    });
    actions.appendChild(b);
  };
  const mine = v.technician && v.technician === String((ui.state.admin && ui.state.admin.email) || "").toLowerCase();
  const canSchedule = ui.hasPermission(SCHEDULE), canPerform = ui.hasPermission(PERFORM);
  if (canSchedule && ["requested", "scheduled"].includes(v.state)) {
    const techs = (await ui.api(`${SERVICE_API}/technicians`)).technicians;
    if (token !== ui.state.renderToken) return;
    act(v.state === "requested" ? "Schedule" : "Reschedule or reassign", "schedule", [
      { name: "technician", label: "Technician", type: "select", value: v.technician || techs[0]?.email || "", options: techs.map((t) => ({ value: t.email, label: t.display_name || t.email })) },
      { name: "date", label: "Date", type: "date" }, { name: "start", label: "Start (HH:MM, Lagos)" }, { name: "end", label: "End (HH:MM, Lagos)" },
      { name: "note", label: "Note (optional, recorded)", type: "textarea" },
    ], (f) => {
      const a = lagosInstant(f.date, f.start), z = lagosInstant(f.date, f.end);
      if (!a || !z) throw Object.assign(new Error("invalid_slot"), { data: { error: "invalid_slot" } });
      return post("schedule", { technician: f.technician, starts_at: a, ends_at: z, note: String(f.note || "") });
    });
  }
  if (canSchedule && ["requested", "scheduled", "in_progress"].includes(v.state))
    act("Put on hold", "hold", [{ name: "exception", label: "Exception", type: "select", value: "customer_unavailable", options: HOLD_REASONS.map((r) => ({ value: r, label: human(r) })) }, { name: "note", label: "Note (at least 8 characters)", type: "textarea" }], (f) => post("hold", { exception: f.exception, note: String(f.note || "") }));
  if (canSchedule && v.state === "on_hold") act("Release hold", "release", [{ name: "note", label: "Why the hold is released (at least 8 characters)", type: "textarea" }], (f) => post("release", { note: String(f.note || "") }));
  if (canSchedule && ["requested", "scheduled", "on_hold"].includes(v.state))
    act("Cancel visit", "cancel", [{ name: "reason", label: "Reason", type: "select", value: "customer_request", options: CANCEL_REASONS.map((r) => ({ value: r, label: human(r) })) }, { name: "note", label: "Note (at least 8 characters)", type: "textarea" }], (f) => post("cancel", { reason: f.reason, note: String(f.note || "") }));
  if (canPerform && mine && v.state === "scheduled") act("Start work", "start", [{ name: "note", label: v.kind === "installation" ? "Requires the goods to be delivered." : "Starts the inspection.", type: "textarea" }], () => post("start", {}));
  if (canPerform && mine && v.state === "in_progress") {
    if (v.kind === "inspection") act("Record report", "report", [{ name: "findings", label: "Findings (at least 10 characters)", type: "textarea", value: v.report?.findings || "" },
      { name: "recommendation", label: "Recommendation", type: "select", value: v.report?.recommendation || "proceed", options: RECOMMENDATIONS.map((r) => ({ value: r, label: human(r) })) }, { name: "notes", label: "Notes (optional)", type: "textarea", value: v.report?.notes || "" }],
      (f) => post("report", { findings: String(f.findings || "").trim(), recommendation: f.recommendation, ...(String(f.notes || "").trim() ? { notes: String(f.notes).trim() } : {}) }));
    act("Complete", "complete", v.kind === "installation"
      ? [{ name: "acceptance_name", label: "Accepted by (name)" }, { name: "acceptance_relationship", label: "Relationship", type: "select", value: "customer", options: RELATIONSHIPS.map((r) => ({ value: r, label: human(r) })) }, { name: "note", label: "Note (optional)", type: "textarea" }]
      : [{ name: "note", label: "Note (optional)", type: "textarea" }],
      (f) => post("complete", { ...(v.kind === "installation" ? { acceptance_name: String(f.acceptance_name || "").trim(), acceptance_relationship: f.acceptance_relationship } : {}), note: String(f.note || "") }));
    const kind = v.kind === "inspection" ? "inspection_photo" : "installation_photo";
    const up = el(`<label data-evidence-upload>Add photograph <input type="file" accept="image/jpeg,image/png,image/webp" data-evidence-file></label>`);
    up.querySelector("[data-evidence-file]").onchange = (ev) => {
      const file = ev.target.files && ev.target.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = () => uploadEvidence(ui, id, v.row_version, kind, String(reader.result)).then(() => reload("Photograph added.")).catch((e) => { if ((e?.data?.error || e?.message) === "visit_state_changed") return reload(message(e)); status.textContent = message(e); });
      reader.readAsDataURL(file);
    };
    actions.appendChild(up);
  }
  if (!actions.children.length) actions.appendChild(el(`<p data-visit-readonly>${["completed", "cancelled"].includes(v.state) ? "This visit is closed." : "No actions available to you for this visit."}</p>`));
  if (d.checklist) {
    const box = card.querySelector("[data-checklist]");
    const editable = canPerform && mine && v.state === "in_progress";
    box.appendChild(el(`<h4>Installation checklist <span class="cat-muted">(version ${esc(d.checklist.version)})</span></h4>`));
    for (const item of d.checklist.items) {
      const checked = v.checklist && v.checklist[item.code] === true;
      box.appendChild(el(`<label data-check="${esc(item.code)}"><input type="checkbox" data-check-input="${esc(item.code)}" ${checked ? "checked" : ""} ${editable ? "" : "disabled"}> ${esc(item.label)}${item.required ? " <b>(required)</b>" : ""}</label>`));
    }
    if (editable) {
      const save = el(`<button type="button" class="cat-btn" data-save-checklist>Save checklist</button>`);
      save.onclick = async () => {
        const checklist = Object.fromEntries([...box.querySelectorAll("[data-check-input]")].map((i) => [i.dataset.checkInput, i.checked]));
        save.disabled = true;
        try { await post("checklist", { checklist }); await reload("Checklist saved."); }
        catch (e) { if ((e?.data?.error || e?.message) === "visit_state_changed") return reload(message(e)); status.textContent = message(e); save.disabled = false; }
      };
      box.appendChild(save);
    }
  }
  const ev = card.querySelector("[data-evidence]");
  if (!d.evidence.length) ev.appendChild(el(`<li data-no-evidence>No photographs yet.</li>`));
  for (const p of d.evidence) ev.appendChild(el(`<li data-evidence-item="${esc(p.id)}">${esc(human(p.kind))} · ${esc(when(p.created_at))} by ${esc(p.actor)}${d.can_view_evidence ? ` · <a href="${SERVICE_API}/visits/${encodeURIComponent(id)}/evidence/${esc(p.id)}" target="_blank" rel="noopener noreferrer">View</a>` : ""}</li>`));
  const hist = card.querySelector("[data-visit-history]");
  for (const e of d.events) hist.appendChild(el(`<li data-visit-event="${e.row_version}">${esc(when(e.created_at))} — ${esc(human(e.event_type))}${e.from_state && e.to_state !== e.from_state ? ` (${esc(VISIT_LABEL[e.from_state])} → ${esc(VISIT_LABEL[e.to_state])})` : ""} by ${esc(e.actor)}${e.detail?.technician ? ` — ${esc(e.detail.technician)} ${esc(when(e.detail.starts_at))}` : ""}${e.detail?.exception ? ` — ${esc(human(e.detail.exception))}` : ""}${e.detail?.reason ? ` — ${esc(human(e.detail.reason))}` : ""}${e.reason ? ` — “${esc(e.reason)}”` : ""}</li>`));
}
export function uploadEvidence(ui, id, rowVersion, kind, dataUrl) {
  return ui.api(`${SERVICE_API}/visits/${encodeURIComponent(id)}/evidence`, { method: "POST", body: { expected_row_version: rowVersion, kind, data_url: dataUrl } });
}

// ---- Installation summary inside the fulfilment order detail ----
export async function renderOrderServicePanel(card, ui, orderId, lc, openVisit) {
  const { el, escapeHtml: esc } = ui;
  let data;
  try { data = await ui.api(`${SERVICE_API}/visits?order_id=${encodeURIComponent(orderId)}`); } catch { return null; }
  if (!data || !Array.isArray(data.visits)) return null;
  const panel = el(`<div data-order-service><h4>Inspections & installation</h4><ul data-order-visits></ul><p role="status" data-order-service-status></p></div>`);
  card.querySelector("[data-history]").before(panel);
  const list = panel.querySelector("[data-order-visits]");
  if (!data.visits.length) list.appendChild(el(`<li data-no-visits>No inspection or installation recorded.</li>`));
  for (const v of data.visits) {
    const li = el(`<li data-order-visit="${esc(v.id)}">${esc(KIND_LABEL[v.kind])} · ${pill(ui, v.state)} · ${esc(v.starts_at ? when(v.starts_at) : "Not scheduled")} · ${esc(v.technician || "—")} </li>`);
    const b = el(`<button type="button" class="cat-btn" data-open-visit>Open</button>`); b.onclick = () => openVisit(v.id); li.appendChild(b);
    list.appendChild(li);
  }
  const open = data.visits.some((v) => v.kind === "installation" && v.state !== "cancelled");
  if (lc && lc.installation_required && !open && ui.hasPermission(SCHEDULE) && lc.state !== "closed") {
    const b = el(`<button type="button" class="cat-btn" data-request-installation>Request installation</button>`);
    b.onclick = () => ui.openDialog("Request installation", addressFields(false), async (f) => {
      try { const r = await ui.api(`${SERVICE_API}/visits`, { method: "POST", body: { kind: "installation", order_id: orderId, service_address: addressFrom(f), note: String(f.note || "") } }); await openVisit(r.visit.id); }
      catch (e) { panel.querySelector("[data-order-service-status]").textContent = message(e); }
    });
    panel.appendChild(b);
  }
  if (lc && lc.installation_required && lc.state === "delivered") panel.appendChild(el(`<p data-installed-by-record class="cat-muted">Installed is recorded by completing the installation visit (checklist, photographs and customer acceptance).</p>`));
  return panel;
}
