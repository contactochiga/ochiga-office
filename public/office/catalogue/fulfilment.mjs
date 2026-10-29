// Phase 5A.2 staff interface for the post-payment fulfilment lifecycle (local; off unless OFFICE_HARDWARE_FULFILMENT_ENABLED).
// The database and API remain the authority: buttons only offer what the API reports as the next step, every write sends
// the expected version, and refusals from the server are shown as-is. No guest, booking or payment control exists here.
const API = "/api/lead-agents/admin/hardware-fulfilment";
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
};
const message = (e) => ERRORS[e?.data?.error] || ERRORS[e?.message] || "The action could not be completed.";
const naira = (kobo) => (Number.isFinite(kobo) ? `₦${(kobo / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}` : "—");
const when = (t) => (t ? new Date(t).toLocaleString("en-NG", { dateStyle: "medium", timeStyle: "short" }) : "—");
const pill = (ui, state) => `<span class="cat-pill ${ui.escapeHtml(state)}">${ui.escapeHtml(STATE_LABEL[state] || state)}</span>`;

export async function renderFulfilment(host, token, ui, view = {}) {
  const { el, escapeHtml: esc } = ui;
  const current = view.tab === "settings" ? "settings" : "queue";
  host.innerHTML = "";
  const tabs = el(`<div class="crm-tabs" role="tablist" aria-label="Fulfilment"></div>`);
  for (const [key, label] of [["queue", "Queue"], ["settings", "Fees & coverage"]]) {
    const b = el(`<button type="button" role="tab" data-tab="${key}" aria-selected="${key === current}" class="crm-tab ${key === current ? "active" : ""}">${esc(label)}</button>`);
    b.onclick = () => renderFulfilment(host, token, ui, { tab: key });
    tabs.appendChild(b);
  }
  host.appendChild(tabs);
  const body = el(`<div data-fulfilment-body></div>`);
  host.appendChild(body);
  try {
    if (current === "settings") await renderSettings(body, token, ui);
    else await renderQueue(body, token, ui, view);
  } catch (e) {
    if (token !== ui.state.renderToken) return;
    body.innerHTML = "";
    body.appendChild(el(`<section class="cat-panel" role="status" data-fulfilment-error>${esc(message(e))}</section>`));
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
  if (lc && canManage) {
    for (const to of lc.next) {
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
  } else if (lc && !canManage) actions.appendChild(el(`<p data-readonly>You can view this order. Updating fulfilment needs the fulfilment permission.</p>`));

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
  for (const key of Object.keys(SETTING_META)) {
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
      if (key === "coverage_areas") html = cell("state", item.state) + cell("cities", (item.cities || []).join(", "), 'placeholder="empty = whole state"') + check("delivery", item.delivery) + check("installation", item.installation) + check("inspection", item.inspection);
      else html = cell("code", item.code) + cell("label", item.label) + cell("fee", item.fee_kobo != null ? (item.fee_kobo / 100).toFixed(2) : "", 'inputmode="decimal" placeholder="₦"') + cell("vat", item.vat_rate_bp != null ? (item.vat_rate_bp / 100).toString() : "", 'inputmode="decimal" placeholder="%"')
        + (key === "delivery_fees" ? cell("states", (item.states || []).join(", ")) : `<td><select class="cat-select" data-k="per" ${dis}><option value="order" ${item.per !== "unit" ? "selected" : ""}>per order</option><option value="unit" ${item.per === "unit" ? "selected" : ""}>per unit</option></select></td>`);
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
    if (key === "delivery_fees") item.states = splitList(v("states").value); else item.per = v("per").value;
    list.push(item);
  }
  return key === "coverage_areas" ? { areas: list } : { currency: "NGN", [meta.list]: list };
}
