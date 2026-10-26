"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
module.exports = async ({
  psql,
  one,
  check,
  app,
  restUrl,
  reloadSchema,
  ROOT,
  pid,
  vid,
  RUN,
  FULL_KEY,
  SITE_KEY,
  CATALOGUE_KEY,
  concurrentSql,startApp,gatewayUrl,PG,sh,sleep,
}) => {
  const sql = fs.readFileSync(
    path.join(ROOT, "db/20261108_hardware_checkout.sql"),
    "utf8",
  );
  const rollback = psql("begin;" + sql + "rollback;");
  check(
    "B-M0",
    "checkout migration rolls back cleanly",
    rollback.status === 0 &&
      one("select to_regclass('hardware_checkout_receipts') is null") === "t",
    rollback.err,
  );
  const preSql = fs
    .readFileSync(
      path.join(ROOT, "release/phase4b-gate/production-rollout-gates.sql"),
      "utf8",
    )
    .trim()
    .replace(/;$/, "");
  const pre = JSON.parse(one(`select jsonb_agg(g) from (${preSql}) g`));
  check(
    "B-ABSENT",
    "gate allows wholly absent checkout",
    pre.find((x) => x.gate.startsWith("VERDICT")).status === "GO" &&
      pre.find((x) => x.gate.startsWith("STAGE P4B")).status === "ABSENT",
  );
  const applied = psql("begin;" + sql + "commit;");
  if (applied.status) throw Error(applied.err);
  const shape = fs.readFileSync(
    path.join(ROOT, "release/phase4b-gate/checkout-shape.sql"),
    "utf8",
  );
  const gateSql = fs
    .readFileSync(
      path.join(ROOT, "release/phase4b-gate/production-rollout-gates.sql"),
      "utf8",
    )
    .trim()
    .replace(/;$/, "");
  for (const mutation of [
    "",
    "alter table hardware_checkout_receipts disable row level security",
    "grant select on hardware_checkout_receipts to anon",
    "grant execute on function hardware_checkout_submit(text,text,text,jsonb,text) to authenticated",
    "alter function hardware_checkout_quote(jsonb) security definer",
    "alter table hardware_checkout_receipts disable trigger checkout_receipts_immutable",
  ]) {
    const result = psql(
      `begin;${mutation};select jsonb_agg(g) from (${gateSql}) g;rollback;`,
    );
    if (result.status) throw Error(result.err);
    const rows = JSON.parse(result.out.split("\n").filter(Boolean).pop());
    check(
      "B-GATE",
      mutation || "all prior checks and checkout schema intact",
      rows.find((x) => x.gate.startsWith("VERDICT")).status ===
        (mutation ? "NO-GO" : "GO"),
      rows.filter((x) => x.status === "FAIL"),
    );
  }
  await reloadSchema(restUrl);
  const post = async (action, b, key = "isolated-checkout-" + RUN) => {
    const r = await fetch(app.url + "/api/commerce/checkout/" + action, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify(b),
    });
    return { status: r.status, data: await r.json() };
  };
  const lines = [{ product: "test-order", sku: "TEST-ORDER-1", quantity: 2 }];
  for (const key of ["", FULL_KEY, SITE_KEY, CATALOGUE_KEY])
    check(
      "B-AUTH",
      "unrelated credentials denied",
      (await post("quote", { lines }, key)).status === 403 ||
        (await post("quote", { lines }, key)).status === 401,
    );
  // Synthetic fixture only: public-listing state is seeded, never a production release.
  psql(
    `update catalogue_products set publication_status='published' where id='${pid}'; update catalogue_variants set sourcing='in_stock',stock_on_hand=100 where id='${vid}'; insert into catalogue_public_listings(product_id,status,public_version,slug,released_at,released_by) select id,'public',published_version,slug,now(),'fixture' from catalogue_products where id='${pid}';`,
  );
  const q = await post("quote", { lines });
  check("B-Q", "authoritative quote", q.status === 200, q);
  if (q.status !== 200) throw Error("quote failed");
  for (const quantity of [0, -1, 1.1, 1001, "2"])
    check(
      "B-QTY",
      "invalid quantity rejected",
      (await post("quote", { lines: [{ ...lines[0], quantity }] })).status ===
        400,
    );
  check(
    "B-PRICE",
    "browser price injection rejected",
    (await post("quote", { lines: [{ ...lines[0], price: 1 }] })).status ===
      400,
  );
  for (const vat of ["exempt", "zero_rated"]) {
    const result = psql(
      `begin;do $$declare c uuid;begin select catalogue_request_price_change('${vid}',127500,'${vat}',0,'author@fixture.test','')->>'id' into c; perform catalogue_decide_price_change(c,'approved','reviewer@fixture.test','');perform catalogue_publish_price_change(c,'author@fixture.test');end$$;select hardware_checkout_quote('[{"variant_id":"${vid}","quantity":2}]')->>'goods_tax_kobo';rollback;`,
    );
    check(
      "B-TAX",
      "approved " + vat + " tax is zero",
      result.status === 0 && result.out === "0",
      result.err || result.out,
    );
  }
  const guest = crypto.randomBytes(32).toString("hex");
  const body = {
    guest_hash: guest,
    idempotency_key: "checkout-test-unique-001",
    quote_hash: q.data.quote.quote_hash,
    order: {
      customer: {
        name: "LOCAL TEST guest",
        email: "checkout@example.invalid",
        phone: "+2348000000000",
      },
      delivery: {
        country: "NG",
        state: "Plateau",
        city: "Jos",
        address: "LOCAL TEST address",
      },
      installation_requested: true,
      lines,
    },
  };
  check(
    "B-CHANGED",
    "changed quote refused",
    (await post("submit", { ...body, quote_hash: "0".repeat(64) })).data
      .error === "price_changed",
  );
  check(
    "B-DELIVERY",
    "outside NG refused",
    (
      await post("submit", {
        ...body,
        order: {
          ...body.order,
          delivery: { ...body.order.delivery, country: "GH" },
        },
      })
    ).data.error === "delivery_restricted",
  );
  const changed = one(
    `select catalogue_request_price_change('${vid}',127500,'standard',750,'author@fixture.test','')->>'id'`,
  );
  psql(
    `select catalogue_decide_price_change('${changed}','approved','reviewer@fixture.test',''); select catalogue_publish_price_change('${changed}','author@fixture.test');`,
  );
  check(
    "B-REALPRICE",
    "actual approved price change rejects stale quote",
    (await post("submit", body)).data.error === "price_changed",
  );
  body.quote_hash = (await post("quote", { lines })).data.quote.quote_hash;
  const pair = await Promise.all([post("submit", body), post("submit", body)]);
  check(
    "B-IDEM",
    "concurrent submissions create exactly one order",
    pair
      .map((x) => x.status)
      .sort()
      .join(",") === "200,201" &&
      pair[0].data.order.id === pair[1].data.order.id,
    pair,
  );
  const id = pair[0].data.order.id;
  check(
    "B-CONFLICT",
    "changed payload with same key refused",
    (
      await post("submit", {
        ...body,
        order: { ...body.order, installation_requested: false },
      })
    ).data.error === "idempotency_conflict",
  );
  check(
    "B-RECOVERY",
    "same guest recovers receipt by idempotency key",
    (
      await post("status", {
        guest_hash: guest,
        idempotency_key: body.idempotency_key,
      })
    ).data.order?.id === id,
  );
  check(
    "B-IMM",
    "receipt cannot be updated or deleted",
    psql(
      `set role service_role;delete from hardware_checkout_receipts where order_id='${id}'`,
    ).status !== 0 &&
      psql(
        `set role service_role;update hardware_checkout_receipts set request_hash='tampered' where order_id='${id}'`,
      ).status !== 0,
  );
  const own = await post("status", { guest_hash: guest, id });
  check(
    "B-PRIVATE",
    "receipt has no customer data and remains nonpayable",
    own.status === 200 &&
      !JSON.stringify(own.data).includes("example.invalid") &&
      own.data.order.payable_total_kobo === null,
  );
  check(
    "B-OTHER",
    "other guest cannot read order",
    (await post("status", { guest_hash: "a".repeat(64), id })).status === 404,
  );
  check(
    "B-CRM",
    "contact opportunity activity link atomically",
    one(
      `select count(*) from hardware_orders o join crm_contacts c on c.id=o.contact_id join crm_opportunities p on p.id=o.opportunity_id and p.contact_id=c.id join crm_activities a on a.related_id=o.id::text and a.contact_id=c.id where o.id='${id}'`,
    ) === "1",
  );
  check(
    "B-SNAPSHOT",
    "tax totals and options preserved",
    one(
      `select (sum(l.gross_kobo)=max(o.goods_total_kobo) and sum(l.tax_kobo)=max(o.goods_tax_kobo) and bool_and(jsonb_typeof(l.variant_options)='object')) from hardware_order_lines l join hardware_orders o on o.id=l.order_id where o.id='${id}'`,
    ) === "t",
  );
  for (const source of ["supplier_sourced", "made_to_order", "discontinued"]) {
    const r = psql(
      `begin; update catalogue_variants set sourcing='${source}' where id='${vid}';select hardware_checkout_quote('[{"variant_id":"${vid}","quantity":2}]');rollback;`,
    );
    check(
      "B-STOCK",
      "non-stock source refused " + source,
      r.status !== 0 && /stock_unavailable|variant_unavailable/.test(r.err),
      r.err,
    );
  }
  if (process.env.TEST_RESERVATIONS === "true") await require('./test-hardware-reservations-cases')({psql,one,check,app,restUrl,reloadSchema,ROOT,pid,vid,RUN,concurrentSql,startApp,gatewayUrl,PG,sh,sleep});
  if (process.env.TEST_CHECKOUT_WEB === "true")
    await require("./test-hardware-checkout-web")({ app, RUN });
  psql(`update catalogue_variants set stock_on_hand=0 where id='${vid}'`);
  check(
    "B-STOCK",
    "empty stock refused",
    (await post("quote", { lines })).data.error === "stock_unavailable",
  );
  psql(
    `update catalogue_variants set stock_on_hand=100 where id='${vid}'; select catalogue_public_withdraw('${pid}',1,'fixture','LOCAL TEST')`,
  );
  check(
    "B-WITHDRAW",
    "withdrawn product refused",
    (await post("quote", { lines })).data.error === "product_unavailable",
  );
  check(
    "B-RETRY",
    "committed retry survives withdrawal",
    (await post("submit", body)).data.order?.id === id,
  );
  check(
    "B-RLS",
    "guest receipt table inaccessible",
    one(
      "select not has_table_privilege('anon','hardware_checkout_receipts','SELECT') and not has_table_privilege('authenticated','hardware_checkout_receipts','SELECT') and relrowsecurity from pg_class where oid='hardware_checkout_receipts'::regclass",
    ) === "t",
  );
  check(
    "B-FUNC",
    "functions service-only and invoker",
    one(
      "select count(*) from pg_proc where pronamespace='public'::regnamespace and proname like 'hardware_checkout_%' and (prosecdef or has_function_privilege('anon',oid,'EXECUTE') or has_function_privilege('authenticated',oid,'EXECUTE') or proconfig is distinct from array['search_path=public, pg_temp'])",
    ) === "0",
  );
};
