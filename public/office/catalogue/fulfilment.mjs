// Phase 5A.2 staff interface for the post-payment fulfilment lifecycle (local; off unless OFFICE_HARDWARE_FULFILMENT_ENABLED).
// The database and API remain the authority: buttons only offer what the API reports as the next step, every write sends
// the expected version, and refusals from the server are shown as-is. No guest, booking or payment control exists here.
const API = "/api/lead-agents/admin/hardware-fulfilment";
const DELIVERY_API = "/api/lead-agents/admin/hardware-delivery";
const DELIVERY = "commerce.orders.delivery.manage";
export const DELIVERY_LABEL = { scheduled: "Scheduled", out_for_delivery: "Out for delivery", failed: "Delivery failed", on_hold: "On hold", delivered: "Delivered" };
const FAIL_REASONS = ["recipient_unavailable", "address_issue", "refused", "access_denied", "damaged_in_transit", "other"];
const HOLD_REASONS = ["cancellation_requested", "address_verification", "customer_request", "stock_issue", "refund_review", "other"];
const RELATIONSHIPS = ["customer", "household_member", "colleague", "security_or_reception", "other"];
export const STATES = ["paid", "packed", "dispatched", "delivered", "installed", "closed"];
export const STATE_LABEL = { paid: "Paid", packed: "Packed", dispatched: "Dispatched", delivered: "Delivered", installed: "Installed", closed: "Closed" };
const ACTION_LABEL = { packed: "Mark packed", dispatched: "Mark dispatched", delivered: "Mark delivered", installed: "Mark installed", closed: "Close order" };
const ROLE_LABEL = { fulfilment: "Fulfilment staff", delivery: "Delivery", technician: "Technician" };
const MANAGE = "commerce.orders.fulfilment.manage", CONFIGURE = "commerce.orders.fulfilment.configure";
export const ERRORS = {
  fulfilment_disabled: "Fulfilment is not enabled in this environment.",
  fulfilment_state_changed: "Someone else updated this order. The latest state has been reloaded.",
  assignment_changed: "The assignment changed in the meantime. The latest assignments have been reloaded.",
  setting_changed: "These settings were changed by someone else. The latest version has been reloaded.",
  invalid_fulfilment_transition: "That step is not allowed from the current state.",
  order_not_paid_and_allocated: "This order is not a verified, allocated payment (or a refund was requested), so it cannot be fulfilled.",
  closing_reason_required: "A closing reason is required.",
  installation_not_requested: "This order did not request installation.",
  assignee_not_active_staff: "The assignee must be an active staff account.",
  fulfilment_closed: "This order is closed.",
  invalid_fulfilment_setting: "The settings are not valid. Check codes, amounts, VAT and the reason (at least 8 characters).",
  forbidden: "You do not have permission for this action.",
  use_delivery_record: "Dispatch and delivery are recorded from the delivery record below.",
  use_installation_record: "Installed is recorded by completing the installation visit.",
  delivery_disabled: "Delivery records are not enabled in this environment.",
  delivery_state_changed: "Someone else updated this delivery. The latest state has been reloaded.",
  invalid_delivery_transition: "That delivery step is not allowed from the current state.",
  invalid_delivery_details: "Check the delivery details: a method is required, couriers need a name, tracking links must use https.",
  invalid_delivery_date: "Choose a delivery date from today up to 90 days ahead.",
  delivery_assignee_required: "Assign a delivery staff member before dispatching (or use a courier with a tracking reference).",
  tracking_reference_required: "Courier deliveries need a tracking reference before dispatch.",
  order_not_packed: "Mark the order packed before dispatching it.",
  delivery_attempts_exhausted: "Three delivery attempts have failed. A manager decision is required before another attempt.",
  invalid_failure_reason: "Choose a reason. Refused, damaged and other need a note of at least 8 characters.",
  invalid_delivery_exception: "Choose an exception and add a note of at least 8 characters.",
  proof_of_delivery_required: "Upload at least one proof-of-delivery photo first.",
  invalid_acknowledgement: "Enter the recipient's name (at least 2 characters) and their relationship.",
  duplicate_proof: "This photo was already uploaded for this delivery.",
  proof_limit_reached: "This delivery already has the maximum of 10 proofs.",
  unsupported_proof_type: "Proof must be a JPEG, PNG or WebP photo.",
  proof_too_large: "The photo is too large (maximum 8 MB).",
  unreadable_proof_image: "The photo could not be read.",
};
const message = (e) => ERRORS[e?.data?.error] || ERRORS[e?.message] || "The action could not be completed.";
const naira = (kobo) => (Number.isFinite(kobo) ? `₦${(kobo / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}` : "—");
const when = (t) => (t ? new Date(t).toLocaleString("en-NG", { dateStyle: "medium", timeStyle: "short" }) : "—");
const pill = (ui, state) => `<span class="cat-pill ${ui.escapeHtml(state)}">${ui.escapeHtml(STATE_LABEL[state] || state)}</span>`;

export async function renderFulfilment(host, token, ui, view = {}) {
  const { el, escapeHtml: esc } = ui;
  const current = ["settings", "visits"].includes(view.tab) ? view.tab : "queue";
  host.innerHTML = "";
  const tabs = el(`<div class="crm-tabs" role="tablist" aria-label="Fulfilment"></div>`);
  // Phase 5C tab: only offered when the service API answers (it is off by default).
  let service = null;
  try { service = await import("./service.mjs"); if (!Array.isArray((await ui.api(`${service.SERVICE_API}/technicians`))?.technicians)) service = null; } catch { service = null; }
  if (token !== ui.state.renderToken) return;
  const tabList = [["queue", "Queue"], ...(service ? [["visits", "Inspections & installations"]] : []), ["settings", "Fees & coverage"]];
  for (const [key, label] of tabList) {
    const b = el(`<button type="button" role="tab" data-tab="${key}" aria-selected="${key === current}" class="crm-tab ${key === current ? "active" : ""}">${esc(label)}</button>`);
    b.onclick = () => renderFulfilment(host, token, ui, { tab: key });
    tabs.appendChild(b);
  }
  host.appendChild(tabs);
  const body = el(`<div data-fulfilment-body></div>`);
  host.appendChild(body);
  try {
    if (current === "settings") await renderSettings(body, token, ui);
    else if (current === "visits" && service) await service.renderVisits(body, token, ui, view);
    else await renderQueue(body, token, ui, view);
  } catch (e) {
    if (token !== ui.state.renderToken) return;
    body.innerHTML = "";
    body.appendChild(el(`<section class="cat-panel" role="status" data-fulfilment-error>${esc(service && current === "visits" ? (service.SERVICE_ERRORS[e?.data?.error] || message(e)) : message(e))}</section>`));
  }
}

async function renderQueue(body, token, ui, view) {
  const { el, escapeHtml: esc } = ui;
  const filter = STATES.includes(view.state) ? view.state : "";
  const data = await ui.api(API + (filter ? `?state=${filter}` : ""));
  if (token !== ui.state.renderToken) return;
  body.innerHTML = "";
  const panel = el(`<section class="cat-panel"><h2>Fulfilment queue</h2>
    <p>Paid orders with allocated stock. Steps follow Paid → Packed → Dispatched → Delivered → Installed (only when requested) → Closed.</p>
    <label>Status <select class="cat-select" data-filter aria-label="Filter by status"><option value="">All</option>${STATES.map((s) => `<option value="${s}" ${s === filter ? "selected" : ""}>${esc(STATE_LABEL[s])}</option>`).join("")}</select></label>
    <div class="cat-table" role="table" data-queue></div></section>`);
  body.appendChild(panel);
  panel.querySelector("[data-filter]").onchange = (ev) => renderFulfilment(body.parentElement, token, ui, { tab: "queue", state: ev.target.value });
  const table = panel.querySelector("[data-queue]");
  if (!data.orders.length) table.appendChild(el(`<p data-empty>No orders in this status.</p>`));
  for (const row of data.orders) {
    const r = el(`<div class="cat-tr" role="row" tabindex="0" data-order="${esc(row.order.id)}">
      <span class="cat-cell">${esc(row.order.id.slice(0, 8))}</span><span class="cat-cell">${pill(ui, row.lifecycle.state)}</span>
      <span class="cat-cell">${row.lifecycle.installation_required ? "Installation requested" : "Delivery only"}</span>
      <span class="cat-cell">${esc(naira(row.order.payable_total_kobo))}</span><span class="cat-cell">${esc(when(row.order.created_at))}</span></div>`);
    const open = () => renderDetail(body, token, ui, row.order.id);
    r.onclick = open; r.onkeydown = (ev) => { if (ev.key === "Enter") open(); };
    table.appendChild(r);
  }
  if (view.order) await renderDetail(body, token, ui, view.order);
}

export async function renderDetail(body, token, ui, id) {
  const { el, escapeHtml: esc } = ui;
  const d = await ui.api(`${API}/${encodeURIComponent(id)}`);
  if (token !== ui.state.renderToken) return;
  body.querySelector("[data-detail]")?.remove();
  const lc = d.lifecycle;
  const card = el(`<section class="cat-panel" data-detail="${esc(d.order.id)}" style="margin-top:12px">
    <h3>Order ${esc(d.order.id)}</h3>
    <p>${lc ? pill(ui, lc.state) : "Not eligible for fulfilment"} · ${esc(naira(d.order.payable_total_kobo))} · ${lc && lc.installation_required ? "Installation requested" : "Delivery only (no installation)"}</p>
    <p class="cat-muted" role="status" data-status></p>
    <div data-actions></div><h4>Assignments</h4><div data-assignments></div><h4>History</h4><ol data-history></ol></section>`);
  body.appendChild(card);
  const status = card.querySelector("[data-status]");
  const reload = async (note) => { await renderDetail(body, token, ui, id); if (note) body.querySelector("[data-detail] [data-status]").textContent = note; };
  const fail = async (e, b) => {
    const code = e?.data?.error || e?.message;
    if (["fulfilment_state_changed", "assignment_changed"].includes(code)) return reload(message(e));
    status.textContent = message(e); if (b) b.disabled = false;
  };
  const canManage = ui.hasPermission(MANAGE);
  const actions = card.querySelector("[data-actions]");
  let delivery = null;
  if (lc) { try { const r = await ui.api(`${DELIVERY_API}/${encodeURIComponent(id)}`); delivery = r && Array.isArray(r.proofs) && Array.isArray(r.events) ? r : null; } catch { delivery = null; } }
  if (token !== ui.state.renderToken) return;
  let service = null;
  if (lc) { try { const m = await import("./service.mjs"); if (Array.isArray((await ui.api(`${m.SERVICE_API}/technicians`))?.technicians)) service = m; } catch { service = null; } }
  if (token !== ui.state.renderToken) return;
  const nextSteps = lc ? lc.next.filter((to) => !(delivery && ["dispatched", "delivered"].includes(to)) && !(service && to === "installed")) : [];
  if (lc && canManage) {
    for (const to of nextSteps) {
      const b = el(`<button type="button" class="cat-btn" data-transition="${to}">${esc(ACTION_LABEL[to])}</button>`);
      b.onclick = () => ui.openDialog(`Confirm: ${ACTION_LABEL[to]}`, [
        { name: "reason", label: to === "closed" ? "Closing reason (required, recorded)" : `Note (optional, recorded). Moves ${STATE_LABEL[lc.state]} → ${STATE_LABEL[to]}.`, type: "textarea" },
      ], async (form) => {
        const reason = String(form.reason || "").trim();
        if (to === "closed" && reason.length < 3) throw new Error(ERRORS.closing_reason_required);
        b.disabled = true;
        try {
          await ui.api(`${API}/${encodeURIComponent(id)}/transition`, { method: "POST", body: { expected_row_version: lc.row_version, to, reason } });
          await reload(`${STATE_LABEL[to]} recorded.`);
        } catch (e) { await fail(e, b); }
      });
      actions.appendChild(b);
    }
    if (!lc.next.length) actions.appendChild(el(`<p data-terminal>This order is closed. No further steps.</p>`));
    else if (!nextSteps.length) actions.appendChild(el(`<p data-delivery-next>${lc.next.includes("installed") && service ? "The next step is recorded by the installation visit below." : "The next step is recorded from the delivery record below."}</p>`));
  } else if (lc && !canManage) actions.appendChild(el(`<p data-readonly>You can view this order. Updating fulfilment needs the fulfilment permission.</p>`));

  if (delivery) renderDeliveryPanel(card, body, token, ui, id, lc, delivery, reload);
  if (service) {
    await service.renderOrderServicePanel(card, ui, id, lc, (visitId) => service.renderVisitDetail(body, token, ui, visitId));
    if (token !== ui.state.renderToken) return;
  }
  const box = card.querySelector("[data-assignments]");
  const roles = ["fulfilment", "delivery", ...(lc && lc.installation_required ? ["technician"] : [])];
  for (const role of roles) {
    const a = d.assignments[role];
    const line = el(`<p data-assignment="${role}"><b>${esc(ROLE_LABEL[role])}:</b> ${a && a.assignee ? esc(a.assignee) : "Unassigned"}${a ? ` <span class="cat-muted">(by ${esc(a.actor)}, ${esc(when(a.created_at))})</span>` : ""} </p>`);
    if (lc && canManage && lc.state !== "closed") {
      const b = el(`<button type="button" class="cat-btn" data-assign="${role}">Change</button>`);
      b.onclick = () => ui.openDialog(`Assign ${ROLE_LABEL[role]}`, [
        { name: "assignee", label: "Staff email (leave empty to unassign)", value: a && a.assignee ? a.assignee : "" },
        { name: "reason", label: "Reason (optional, recorded)", type: "textarea" },
      ], async (form) => {
        b.disabled = true;
        try {
          await ui.api(`${API}/${encodeURIComponent(id)}/assign`, { method: "POST", body: { role, expected_sequence: a ? a.sequence : 0, assignee: String(form.assignee || "").trim() || null, reason: String(form.reason || "") } });
          await reload(`${ROLE_LABEL[role]} assignment recorded.`);
        } catch (e) { await fail(e, b); }
      });
      line.appendChild(b);
    }
    box.appendChild(line);
  }
  const hist = card.querySelector("[data-history]");
  if (!d.events.length) hist.appendChild(el(`<li data-history-empty>Paid and allocated; no fulfilment steps recorded yet.</li>`));
  for (const ev of d.events) hist.appendChild(el(`<li data-event="${ev.row_version}">${esc(when(ev.created_at))} — ${esc(STATE_LABEL[ev.from_state])} → ${esc(STATE_LABEL[ev.to_state])} by ${esc(ev.actor)} <span class="cat-muted">(${esc(ev.authorization_scope)})</span>${ev.reason ? ` — “${esc(ev.reason)}”` : ""}</li>`));
}

// ---- Fees & coverage (versioned; not applied to pricing; no public booking) ----
const SETTING_META = {
  delivery_fees: { title: "Delivery fees", list: "zones", columns: ["code", "label", "fee", "vat", "states"] },
  installation_fees: { title: "Installation fees", list: "services", columns: ["code", "label", "fee", "vat", "per"] },
  coverage_areas: { title: "Coverage areas", list: "areas", columns: ["state", "cities", "delivery", "installation", "inspection"] },
  // Phase 5C (present only when the server offers them)
  inspection_fees: { title: "Inspection fees", list: "services", columns: ["code", "label", "fee", "vat"] },
  installation_checklist: { title: "Installation checklist", list: "items", columns: ["code", "label", "required"] },
};
const splitList = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
export function toKobo(nairaText) {
  const t = String(nairaText ?? "").trim();
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}
export function toBasisPoints(percentText) {
  const t = String(percentText ?? "").trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t) || Number(t) > 100) return null;
  return Math.round(Number(t) * 100);
}

async function renderSettings(body, token, ui) {
  const { el, escapeHtml: esc } = ui;
  const data = await ui.api(`${API}/settings`);
  if (token !== ui.state.renderToken) return;
  body.innerHTML = "";
  body.appendChild(el(`<section class="cat-panel"><h2>Fees & coverage</h2><p>Office-managed configuration with version history. It is <b>not applied to order pricing yet</b> and there is <b>no public booking</b>. No values are provided by default.</p></section>`));
  const canConfigure = ui.hasPermission(CONFIGURE);
  for (const key of Object.keys(SETTING_META).filter((k) => k in data.settings)) {
    const meta = SETTING_META[key], s = data.settings[key] || { version: 0, value: null };
    const items = (s.value && s.value[meta.list]) || [];
    const card = el(`<section class="cat-panel" data-setting="${key}" style="margin-top:12px"><h3>${esc(meta.title)}</h3>
      <p class="cat-muted">${s.version ? `Version ${s.version} by ${esc(s.actor)}, ${esc(when(s.created_at))}` : "Not configured"}</p>
      <table class="cat-table"><thead><tr>${meta.columns.map((c) => `<th>${esc(c)}</th>`).join("")}${canConfigure ? "<th></th>" : ""}</tr></thead><tbody data-rows></tbody></table>
      <p role="status" data-status></p></section>`);
    body.appendChild(card);
    const rows = card.querySelector("[data-rows]");
    const addRow = (item = {}) => {
      const dis = canConfigure ? "" : "disabled";
      const cell = (name, value, attrs = "") => `<td><input class="cat-input" data-k="${name}" value="${esc(value ?? "")}" ${attrs} ${dis}></td>`;
      const check = (name, value) => `<td><input type="checkbox" data-k="${name}" ${value ? "checked" : ""} ${dis}></td>`;
      let html;
      if (key === "installation_checklist") html = cell("code", item.code) + cell("label", item.label) + check("required", item.required);
      else if (key === "coverage_areas") html = cell("state", item.state) + cell("cities", (item.cities || []).join(", "), 'placeholder="empty = whole state"') + check("delivery", item.delivery) + check("installation", item.installation) + check("inspection", item.inspection);
      else html = cell("code", item.code) + cell("label", item.label) + cell("fee", item.fee_kobo != null ? (item.fee_kobo / 100).toFixed(2) : "", 'inputmode="decimal" placeholder="₦"') + cell("vat", item.vat_rate_bp != null ? (item.vat_rate_bp / 100).toString() : "", 'inputmode="decimal" placeholder="%"')
        + (key === "inspection_fees" ? "" : key === "delivery_fees" ? cell("states", (item.states || []).join(", ")) : `<td><select class="cat-select" data-k="per" ${dis}><option value="order" ${item.per !== "unit" ? "selected" : ""}>per order</option><option value="unit" ${item.per === "unit" ? "selected" : ""}>per unit</option></select></td>`);
      const tr = el(`<tr data-row>${html}${canConfigure ? '<td><button type="button" class="cat-btn" data-remove>Remove</button></td>' : ""}</tr>`);
      tr.querySelector("[data-remove]")?.addEventListener("click", () => tr.remove());
      rows.appendChild(tr);
    };
    items.forEach(addRow);
    if (!canConfigure) { card.appendChild(el(`<p data-readonly>Changing these settings needs the fulfilment configuration permission.</p>`)); continue; }
    const add = el(`<button type="button" class="cat-btn" data-add>Add row</button>`); add.onclick = () => addRow();
    const save = el(`<button type="button" class="cat-btn" data-save>Save new version</button>`);
    card.append(add, save);
    save.onclick = () => {
      const status = card.querySelector("[data-status]");
      let value;
      try { value = collect(key, meta, rows); } catch (e) { status.textContent = e.message; return; }
      ui.openDialog(`Save ${meta.title} (version ${s.version + 1})`, [{ name: "reason", label: "Reason for this change (at least 8 characters, recorded)", type: "textarea" }], async (form) => {
        const reason = String(form.reason || "").trim();
        if (reason.length < 8) throw new Error("A reason of at least 8 characters is required.");
        save.disabled = true;
        try {
          await ui.api(`${API}/settings/${key}`, { method: "PUT", body: { expected_version: s.version, value, reason } });
          await renderFulfilment(body.parentElement, token, ui, { tab: "settings" });
        } catch (e) {
          if ((e?.data?.error || e?.message) === "setting_changed") { await renderFulfilment(body.parentElement, token, ui, { tab: "settings" }); return; }
          status.textContent = message(e); save.disabled = false;
        }
      });
    };
  }
}

export function collect(key, meta, rows) {
  const list = [];
  for (const tr of rows.querySelectorAll("[data-row]")) {
    const v = (k) => tr.querySelector(`[data-k="${k}"]`);
    if (key === "installation_checklist") {
      const code = v("code").value.trim(), label = v("label").value.trim();
      if (!code || !label) throw new Error("Each checklist item needs a code and a label.");
      list.push({ code, label, required: v("required").checked });
      continue;
    }
    if (key === "coverage_areas") {
      const state = v("state").value.trim();
      if (!state) throw new Error("Each coverage area needs a state.");
      list.push({ state, cities: splitList(v("cities").value), delivery: v("delivery").checked, installation: v("installation").checked, inspection: v("inspection").checked });
      continue;
    }
    const fee = toKobo(v("fee").value), vat = toBasisPoints(v("vat").value);
    if (fee === null) throw new Error("Fees must be naira amounts with at most two decimals.");
    if (vat === null) throw new Error("VAT must be a percentage between 0 and 100.");
    const item = { code: v("code").value.trim(), label: v("label").value.trim(), fee_kobo: fee, vat_rate_bp: vat };
    if (key === "delivery_fees") item.states = splitList(v("states").value); else if (key === "installation_fees") item.per = v("per").value;
    list.push(item);
  }
  if (key === "installation_checklist") return { items: list };
  return key === "coverage_areas" ? { areas: list } : { currency: "NGN", [meta.list]: list };
}

// ---- Phase 5B delivery record (shown only when the delivery API is enabled) ----
const human = (s) => String(s || "").replaceAll("_", " ");
function renderDeliveryPanel(card, body, token, ui, id, lc, data, reload) {
  const { el, escapeHtml: esc } = ui;
  const d = data.delivery, can = ui.hasPermission(DELIVERY);
  const panel = el(`<div data-delivery><h4>Delivery</h4><p data-delivery-state>${d ? `${esc(DELIVERY_LABEL[d.state] || d.state)} · ${esc(human(d.method))}${d.courier_name ? " · " + esc(d.courier_name) : ""}${d.tracking_reference ? " · tracking " + esc(d.tracking_reference) : ""}${d.scheduled_for ? " · " + esc(d.scheduled_for) : ""} · attempts ${d.attempt_count}` : "No delivery record yet."}</p>
    ${d && d.state === "delivered" ? `<p data-recipient>Received by ${esc(d.recipient_name)} (${esc(human(d.recipient_relationship))}) on ${esc(when(d.delivered_at))}</p>` : ""}
    <p class="cat-muted">Customer notifications and public tracking are off.</p><div data-delivery-actions></div><h5>Proof of delivery</h5><ul data-proofs></ul><h5>Delivery history</h5><ol data-delivery-history></ol></div>`);
  card.querySelector("[data-history]").before(panel);
  const status = card.querySelector("[data-status]");
  const act = (label, attr, fields, run) => {
    const b = el(`<button type="button" class="cat-btn" data-delivery-action="${attr}">${esc(label)}</button>`);
    b.onclick = () => ui.openDialog(`Confirm: ${label}`, fields, async (form) => {
      b.disabled = true;
      try { await run(form); await reload(`${label} recorded.`); }
      catch (e) { const code = e?.data?.error || e?.message; if (code === "delivery_state_changed") return reload(message(e)); status.textContent = message(e); b.disabled = false; }
    });
    panel.querySelector("[data-delivery-actions]").appendChild(b);
  };
  const post = (action, payload) => ui.api(`${DELIVERY_API}/${encodeURIComponent(id)}/${action}`, { method: "POST", body: { expected_row_version: d ? d.row_version : 0, ...payload } });
  const detailFields = (cur = {}) => [
    { name: "method", label: "Method", type: "select", value: cur.method || "own_fleet", options: [{ value: "own_fleet", label: "Own delivery staff" }, { value: "courier", label: "Courier" }, { value: "customer_pickup", label: "Customer pickup" }] },
    { name: "courier_name", label: "Courier company (couriers only)", value: cur.courier_name || "" },
    { name: "tracking_reference", label: "Tracking reference (optional)", value: cur.tracking_reference || "" },
    { name: "tracking_url", label: "Tracking link (https, optional, staff use only)", value: cur.tracking_url || "" },
    { name: "scheduled_for", label: "Planned date", type: "date", value: cur.scheduled_for || "" },
    { name: "instructions", label: "Delivery instructions (optional)", type: "textarea", value: cur.instructions || "" },
  ];
  const clean = (f) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, String(v || "").trim()]).filter(([, v]) => v));
  if (can && lc && lc.state !== "closed") {
    if (!d && ["paid", "packed"].includes(lc.state)) act("Schedule delivery", "schedule", detailFields(), (f) => post("schedule", clean(f)));
    if (d && d.state === "scheduled") {
      act("Edit delivery details", "edit", detailFields(d), (f) => post("schedule", clean(f)));
      act("Dispatch", "dispatch", [{ name: "note", label: lc.state === "packed" ? "Hands the order to delivery and marks it Dispatched." : "Starts the next delivery attempt.", type: "textarea" }], () => post("dispatch", {}));
    }
    if (d && d.state === "out_for_delivery") {
      act("Delivery failed", "fail", [{ name: "reason_code", label: "Reason", type: "select", value: "recipient_unavailable", options: FAIL_REASONS.map((r) => ({ value: r, label: human(r) })) }, { name: "note", label: "Note (required for refused, damaged and other)", type: "textarea" }], (f) => post("fail", { reason_code: f.reason_code, note: String(f.note || "") }));
      act("Mark delivered", "complete", [{ name: "recipient_name", label: "Received by (name)" }, { name: "recipient_relationship", label: "Relationship", type: "select", value: "customer", options: RELATIONSHIPS.map((r) => ({ value: r, label: human(r) })) }, { name: "note", label: "Note (optional)", type: "textarea" }],
        (f) => post("complete", { recipient_name: String(f.recipient_name || "").trim(), recipient_relationship: f.recipient_relationship, note: String(f.note || "") }));
    }
    if (d && d.state === "failed") act("Reschedule", "reschedule", [{ name: "scheduled_for", label: "New date", type: "date" }, { name: "note", label: "Note (optional)", type: "textarea" }], (f) => post("reschedule", { scheduled_for: String(f.scheduled_for || ""), note: String(f.note || "") }));
    if (d && ["scheduled", "failed"].includes(d.state)) act("Put on hold", "hold", [{ name: "exception", label: "Exception", type: "select", value: "customer_request", options: HOLD_REASONS.map((r) => ({ value: r, label: human(r) })) }, { name: "note", label: "Note (at least 8 characters)", type: "textarea" }], (f) => post("hold", { exception: f.exception, note: String(f.note || "") }));
    if (d && d.state === "on_hold") act("Release hold", "release", [{ name: "note", label: "Why the hold is released (at least 8 characters)", type: "textarea" }], (f) => post("release", { note: String(f.note || "") }));
    if (d && ["out_for_delivery", "delivered"].includes(d.state)) {
      const up = el(`<label data-proof-upload>Add proof photo <select class="cat-select" data-proof-kind><option value="photo">Photo</option><option value="signature">Signature</option></select> <input type="file" accept="image/jpeg,image/png,image/webp" data-proof-file></label>`);
      up.querySelector("[data-proof-file]").onchange = (ev) => {
        const file = ev.target.files && ev.target.files[0]; if (!file) return;
        const reader = new FileReader();
        reader.onload = () => uploadProof(ui, id, d.row_version, up.querySelector("[data-proof-kind]").value, String(reader.result)).then(() => reload("Proof added.")).catch((e) => { if ((e?.data?.error || e?.message) === "delivery_state_changed") return reload(message(e)); status.textContent = message(e); });
        reader.readAsDataURL(file);
      };
      panel.querySelector("[data-delivery-actions]").appendChild(up);
    }
  }
  const list = panel.querySelector("[data-proofs]");
  if (!data.proofs.length) list.appendChild(el(`<li data-no-proofs>No proof uploaded yet.</li>`));
  for (const p of data.proofs) list.appendChild(el(`<li data-proof="${esc(p.id)}">${esc(human(p.kind))} · ${esc(when(p.created_at))} by ${esc(p.actor)}${data.can_view_proofs ? ` · <a href="${DELIVERY_API}/${encodeURIComponent(id)}/proofs/${esc(p.id)}" target="_blank" rel="noopener noreferrer">View</a>` : ""}</li>`));
  const hist = panel.querySelector("[data-delivery-history]");
  for (const ev of data.events) hist.appendChild(el(`<li data-delivery-event="${ev.row_version}">${esc(when(ev.created_at))} — ${esc(human(ev.event_type))}${ev.to_state !== ev.from_state ? ` (${esc(DELIVERY_LABEL[ev.from_state] || "—")} → ${esc(DELIVERY_LABEL[ev.to_state])})` : ""} by ${esc(ev.actor)}${ev.detail && ev.detail.reason_code ? ` — ${esc(human(ev.detail.reason_code))}` : ""}${ev.detail && ev.detail.exception ? ` — ${esc(human(ev.detail.exception))}` : ""}${ev.reason ? ` — “${esc(ev.reason)}”` : ""}</li>`));
}
export function uploadProof(ui, id, rowVersion, kind, dataUrl) {
  return ui.api(`${DELIVERY_API}/${encodeURIComponent(id)}/proofs`, { method: "POST", body: { expected_row_version: rowVersion, kind, data_url: dataUrl } });
}
