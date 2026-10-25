// Products-local merchandising. Reuses existing Office media through released product galleries.
const API = "/api/lead-agents/admin/catalogue/merchandising";
export async function renderMerchandising(host, token, ui) {
  const { el, escapeHtml: esc } = ui;
  const [{ merchandising: state }, { products }] = await Promise.all([
    ui.api(API),
    ui.api(`${API}/options`),
  ]);
  if (token !== ui.state.renderToken) return;
  const content = structuredClone(
    state.versions.find((v) => v.version === state.current_version)
      ?.content || {
      slides: [],
      featured: [],
      new_arrivals: [],
      collections: [],
    },
  );
  host.innerHTML = "";
  const root = el(
    `<section class="cat-panel" style="padding:20px"><h2>Hardware campaigns</h2><p>Draft v${state.current_version} · ${esc(state.workflow)} · Live version: ${state.published_version ?? "none"}</p><p>Campaigns use released product images from the existing Products media library. Upload new photography there, then complete product review and release. Campaigns never publish products.</p><div data-status role="status"></div><div data-slides></div><div data-collections></div><div data-selections></div><div data-actions class="cat-head-actions"></div><h3>History</h3><ol data-history></ol></section>`,
  );
  host.appendChild(root);
  const editable = ui.hasPermission("catalogue.write");
  const field = (parent, label, value, apply, type = "text") => {
    const wrap = el(
      `<label style="display:grid;gap:5px;margin:10px 0">${esc(label)}<input class="cat-input" type="${type}" value="${esc(value ?? "")}"></label>`,
    );
    const input = wrap.querySelector("input");
    input.disabled = !editable;
    input.addEventListener("input", () => apply(input.value));
    parent.appendChild(wrap);
    return input;
  };
  const button = (parent, label, fn, disabled = false) => {
    const b = el(
      `<button type="button" class="cat-btn">${esc(label)}</button>`,
    );
    b.disabled = disabled;
    b.addEventListener("click", fn);
    parent.appendChild(b);
    return b;
  };
  const selection = (parent, label, chosen, apply) => {
    const box = el(
      `<fieldset style="padding:12px;margin:12px 0;border:1px solid var(--line)"><legend>${esc(label)}</legend></fieldset>`,
    );
    for (const p of products) {
      const row = el(
        `<label style="display:block;margin:8px"><input type="checkbox" ${chosen.includes(p.slug) ? "checked" : ""} ${editable ? "" : "disabled"}> ${esc(p.name)} (${esc(p.availability)})</label>`,
      );
      row
        .querySelector("input")
        .addEventListener("change", () =>
          apply(
            products
              .filter(
                (x) =>
                  [...box.querySelectorAll("input")][products.indexOf(x)]
                    .checked,
              )
              .map((x) => x.slug),
          ),
        );
      box.appendChild(row);
    }
    if (!products.length)
      box.appendChild(el("<p>No publicly released products yet.</p>"));
    parent.appendChild(box);
  };
  const slides = root.querySelector("[data-slides]");
  const renderSlides = () => {
    slides.innerHTML = "<h3>Hero stories</h3>";
    content.slides.forEach((s, index) => {
      const box = el(
        `<fieldset style="padding:16px;border:1px solid var(--line);margin:12px 0"><legend>Story ${index + 1}</legend></fieldset>`,
      );
      slides.appendChild(box);
      field(box, "Story identifier", s.key, (v) => (s.key = v));
      field(box, "Eyebrow", s.eyebrow, (v) => (s.eyebrow = v));
      field(box, "Heading", s.title, (v) => (s.title = v));
      field(box, "Description", s.description, (v) => (s.description = v));
      const prod = el(
        `<label>Product <select class="cat-input" ${editable ? "" : "disabled"}><option value="">Select released product</option>${products.map((p) => `<option value="${esc(p.slug)}" ${p.slug === s.product ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label>`,
      );
      box.appendChild(prod);
      const media = el(
        '<label style="display:block;margin:12px 0">Campaign image <select class="cat-input"></select></label>',
      );
      box.appendChild(media);
      const mediaSelect = media.querySelector("select");
      mediaSelect.disabled = !editable;
      const showMedia = () => {
        const p = products.find((p) => p.slug === s.product);
        mediaSelect.innerHTML = `<option value="">Select approved gallery image</option>${(p?.images || []).map((i) => `<option value="${esc(i.src)}" ${i.src === s.image ? "selected" : ""}>${esc(i.alt)}</option>`).join("")}`;
      };
      showMedia();
      mediaSelect.addEventListener(
        "change",
        () => (s.image = mediaSelect.value),
      );
      prod.querySelector("select").addEventListener("change", (e) => {
        s.product = e.target.value;
        s.image = "";
        showMedia();
      });
      field(box, "CTA label", s.ctaLabel, (v) => (s.ctaLabel = v));
      field(
        box,
        "CTA destination (#browse, #categories, /contact?type=tech_oem or /hardware/product-slug)",
        s.ctaHref,
        (v) => (s.ctaHref = v),
      );
      field(
        box,
        "Duration (seconds, 3–20)",
        s.durationMs / 1000,
        (v) => (s.durationMs = Number(v) * 1000),
        "number",
      );
      field(
        box,
        "Starts at (UTC ISO timestamp, blank = immediately)",
        s.startsAt || "",
        (v) => (s.startsAt = v || null),
      );
      field(
        box,
        "Ends at (UTC ISO timestamp, blank = no end)",
        s.endsAt || "",
        (v) => (s.endsAt = v || null),
      );
      button(
        box,
        "Move earlier",
        () => {
          [content.slides[index - 1], content.slides[index]] = [
            s,
            content.slides[index - 1],
          ];
          renderSlides();
        },
        !editable || index === 0,
      );
      button(
        box,
        "Move later",
        () => {
          [content.slides[index + 1], content.slides[index]] = [
            s,
            content.slides[index + 1],
          ];
          renderSlides();
        },
        !editable || index === content.slides.length - 1,
      );
      button(
        box,
        "Remove story",
        () => {
          content.slides.splice(index, 1);
          renderSlides();
        },
        !editable,
      );
    });
    button(
      slides,
      "Add story",
      () => {
        content.slides.push({
          key: `story-${Date.now()}`,
          product: "",
          image: "",
          eyebrow: "",
          title: "",
          description: "",
          ctaLabel: "Explore hardware",
          ctaHref: "#browse",
          durationMs: 8000,
          startsAt: null,
          endsAt: null,
        });
        renderSlides();
      },
      !editable || content.slides.length >= 8,
    );
  };
  renderSlides();
  const collections = root.querySelector("[data-collections]");
  const renderCollections = () => {
    collections.innerHTML = "<h3>Featured collections</h3>";
    content.collections.forEach((c, i) => {
      const box = el(
        '<fieldset style="padding:16px;margin:12px 0;border:1px solid var(--line)"></fieldset>',
      );
      collections.appendChild(box);
      field(box, "Identifier", c.key, (v) => (c.key = v));
      field(box, "Title", c.title, (v) => (c.title = v));
      field(box, "Description", c.description, (v) => (c.description = v));
      selection(box, "Products", c.products, (v) => (c.products = v));
      button(
        box,
        "Remove collection",
        () => {
          content.collections.splice(i, 1);
          renderCollections();
        },
        !editable,
      );
    });
    button(
      collections,
      "Add collection",
      () => {
        content.collections.push({
          key: `collection-${Date.now()}`,
          title: "",
          description: "",
          products: [],
        });
        renderCollections();
      },
      !editable || content.collections.length >= 8,
    );
  };
  renderCollections();
  const selections = root.querySelector("[data-selections]");
  selection(
    selections,
    "Featured products",
    content.featured,
    (v) => (content.featured = v),
  );
  selection(
    selections,
    "New arrivals (staff-curated; do not select re-releases as new)",
    content.new_arrivals,
    (v) => (content.new_arrivals = v),
  );
  const actions = root.querySelector("[data-actions]");
  let busy = false;
  const mutate = async (action) => {
    if (busy) return;
    busy = true;
    actions.querySelectorAll("button").forEach((b) => (b.disabled = true));
    try {
      await ui.api(API, {
        method: "POST",
        body: {
          action,
          expected_row_version: state.row_version,
          ...(action === "save" ? { content } : {}),
        },
      });
      await renderMerchandising(host, token, ui);
    } catch (e) {
      root.querySelector("[data-status]").textContent = e.message;
      busy = false;
      actions.querySelectorAll("button").forEach((b) => (b.disabled = false));
    }
  };
  if (editable) button(actions, "Save new draft version", () => mutate("save"));
  if (editable && state.workflow === "draft" && state.current_version)
    button(actions, "Submit saved version for review", () => mutate("submit"));
  if (ui.hasPermission("catalogue.review") && state.workflow === "in_review") {
    button(actions, "Approve saved version", () => mutate("approve"));
    button(actions, "Request changes", () => mutate("reject"));
  }
  if (
    ui.hasPermission("catalogue.public.publish") &&
    state.workflow === "approved"
  )
    button(actions, "Publish approved campaign", () => mutate("publish"));
  if (ui.hasPermission("catalogue.public.publish") && state.published_version)
    button(actions, "Withdraw campaign", () => mutate("withdraw"));
  for (const event of [...state.events].reverse())
    root
      .querySelector("[data-history]")
      .appendChild(
        el(
          `<li>${esc(event.created_at)} · v${event.version} · ${esc(event.action)}${event.action === "withdraw" ? ` (withdrawn live v${event.previous_published_version ?? event.version}; draft v${event.current_version ?? "unknown"})` : ""} · ${esc(event.actor)}</li>`,
        ),
      );
}
