const API = "/api/lead-agents/admin/hardware-financial";
export async function renderHardwareFinancial(host, token, ui) {
  const { orders } = await ui.api(API);
  if (token !== ui.state.renderToken) return;
  const { el, escapeHtml: esc } = ui;
  host.innerHTML = "";
  host.appendChild(
    el(
      '<section class="cat-panel"><h2>Orders & payments</h2><p>Provider processing does not confirm arrival at the customer’s bank. Refunds do not automatically restock items.</p></section>',
    ),
  );
  for (const o of orders) {
    const card = el(
      `<section class="cat-panel" style="padding:16px;margin-top:12px"><h3>Order ${esc(o.id)}</h3><p>₦${(o.payable_total_kobo / 100).toLocaleString("en-NG")} · ${esc(o.payment_state)} · ${esc(o.financial_state || "No recovery observations")}</p><div data-actions></div><p role="status"></p><details><summary>Immutable payment history</summary><ol>${(o.history || []).map((h) => `<li>${esc(h.created_at)} — ${esc(h.event_type)} ${esc(h.detail?.note || "")}</li>`).join("")}</ol></details></section>`,
    );
    host.appendChild(card);
    const actions = card.querySelector("[data-actions]");
    const submit = async (body, b) => {
      b.disabled = true;
      try {
        await ui.api(API, { method: "POST", body });
        await renderHardwareFinancial(host, token, ui);
      } catch (e) {
        card.querySelector("[role=status]").textContent = e.message;
        b.disabled = false;
      }
    };
    if (
      !o.refund &&
      ["paid", "refund_required"].includes(o.payment_state) &&
      ui.hasPermission("commerce.orders.refund.request")
    ) {
      const label = el(
        '<label>Refund reason <input class="cat-input" minlength="8" maxlength="500" required></label>',
      );
      actions.appendChild(label);
      const b = el(
        '<button type="button" class="cat-btn">Request full refund review</button>',
      );
      actions.appendChild(b);
      b.onclick = () => {
        const input = label.querySelector("input");
        if (input.reportValidity())
          submit({ action: "request", id: o.id, reason: input.value }, b);
      };
    }
    if (ui.hasPermission("commerce.orders.reconcile")) {
      const label = el(
        '<label>Reconciliation note <input class="cat-input" minlength="8" maxlength="500" required></label>',
      );
      actions.appendChild(label);
      const b = el(
        '<button type="button" class="cat-btn">Record note (does not change payment state)</button>',
      );
      actions.appendChild(b);
      b.onclick = () => {
        const input = label.querySelector("input");
        if (input.reportValidity())
          submit({ action: "note", id: o.id, note: input.value }, b);
      };
    }
    if (o.refund) {
      actions.appendChild(
        el(
          `<p>Refund requested by ${esc(o.refund.requested_by)}. ${esc(o.refund.reason)} ${o.refund.approved_by ? "Approved for provider processing." : "Independent approval required."}</p>`,
        ),
      );
      if (
        !o.refund.approved_by &&
        ui.hasPermission("commerce.orders.refund.approve")
      ) {
        const b = el(
          '<button type="button" class="cat-btn">Approve refund for processing</button>',
        );
        actions.appendChild(b);
        b.onclick = () => submit({ action: "approve", id: o.refund.id }, b);
      }
    }
  }
}
