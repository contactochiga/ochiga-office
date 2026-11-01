const API = "/api/lead-agents/admin/hardware-financial";
export async function renderHardwareFinancial(host, token, ui) {
  const summary = await ui.api("/api/lead-agents/admin/hardware-orders");
  let financial;
  try { financial = await ui.api(API); }
  catch (e) {
    if (e.message !== "financial_operations_disabled") throw e;
  }
  // Ordinary order/delivery work must not require the financial-operations switch.
  const orders = summary.orders.map(o => ({...o, ...(financial?.orders || []).find(f => f.id === o.id)}));
  orders.push(...(financial?.orders || []).filter(f => !orders.some(o => o.id === f.id)));
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
      `<section class="cat-panel" style="padding:16px;margin-top:12px"><h3>Order ${esc(o.id)}</h3><p>${o.payable_total_kobo == null ? "Delivery charge not confirmed" : `₦${(o.payable_total_kobo / 100).toLocaleString("en-NG")}`} · ${esc(o.payment_state)} · ${esc(o.refund_status?.state === "processed" ? "Refund complete — provider verified" : o.financial_state || "No recovery observations")}</p><div data-actions></div><p role="status"></p><details><summary>Immutable payment history</summary><ol>${(o.history || []).map((h) => `<li>${esc(h.created_at)} — ${esc(h.event_type)} ${esc(h.detail?.note || "")}</li>`).join("")}</ol></details></section>`,
    );
    host.appendChild(card);
    const actions = card.querySelector("[data-actions]");
    if (o.order_state === "awaiting_confirmation" && o.payment_state === "not_started" && o.delivery_state === "unconfirmed" && ui.hasPermission("commerce.orders.delivery.confirm")) {
      const review = el('<button type="button" class="cat-btn">Review delivery and charge</button>');
      actions.appendChild(review);
      review.onclick = async () => {
        review.disabled = true;
        try {
          // Existing endpoint requires customer-data AND CRM permission; viewing is audited.
          const detail = await ui.api(`/api/lead-agents/admin/hardware-orders/${o.id}?customer=true`);
          if (token !== ui.state.renderToken) return;
          const d = detail.private?.delivery;
          if (!d) throw Error("Delivery details are unavailable. Contact an authorized order reviewer.");
          const form = el(`<form class="cat-panel"><p>${esc([d.address,d.city,d.state,d.country].filter(Boolean).join(", "))}</p><p>Confirm serviceability and the agreed delivery charge. Installation is a separate consultation.</p><label>Total delivery charge (NGN)<input name="gross" class="cat-input" type="text" inputmode="decimal" required pattern="[0-9]+(\\.[0-9]{1,2})?" maxlength="11"></label><label>Included delivery VAT (NGN)<input name="tax" class="cat-input" type="text" inputmode="decimal" required pattern="[0-9]+(\\.[0-9]{1,2})?" maxlength="11"></label><label>Serviceability and charge evidence<input name="evidence" class="cat-input" minlength="8" maxlength="500" required></label><button type="submit" class="cat-btn">Confirm delivery only</button><p role="status"></p></form>`);
          review.replaceWith(form);
          let saving = false;
          form.onsubmit = async event => {
            event.preventDefault();
            if (saving || !form.reportValidity()) return;
            const kobo = name => {
              const value = form.elements.namedItem(name).value;
              if (!/^\d+(\.\d{1,2})?$/.test(value)) throw Error("Enter an NGN amount with at most two decimal places.");
              const [whole,fraction=""] = value.split(".");
              const amount = Number(whole)*100+Number(fraction.padEnd(2,"0"));
              if (!Number.isSafeInteger(amount) || amount>999999999) throw Error("Delivery amount exceeds the permitted limit.");
              return amount;
            };
            const button = form.querySelector('button');
            try {
              const gross_kobo=kobo("gross"), tax_kobo=kobo("tax");
              if(tax_kobo>gross_kobo)throw Error("Included VAT cannot exceed the delivery charge.");
              saving=true;button.disabled=true;
              await ui.api(`/api/lead-agents/admin/hardware-orders/${o.id}/delivery`,{method:"POST",body:{gross_kobo,tax_kobo,evidence:form.elements.namedItem("evidence").value}});
              await renderHardwareFinancial(host, token, ui);
            } catch(e) { form.querySelector('[role=status]').textContent=e.message; saving=false;button.disabled=false; }
          };
        } catch(e) {card.querySelector('[role=status]').textContent=e.message;review.disabled=false;}
      };
    }
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
      financial && !o.refund &&
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
    if (financial && ui.hasPermission("commerce.orders.reconcile")) {
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
