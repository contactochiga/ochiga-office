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
  concurrentSql,
  startApp,
  gatewayUrl,
  PG,
  sh,
  sleep,
}) => {
  const sql = fs.readFileSync(
    path.join(ROOT, "db/phase4c/20261026090615_hardware_reservations.sql"),
    "utf8",
  );
  const run = (q) => {
    const r = psql(q);
    if (r.status) throw Error(r.err);
    return r.out;
  };
  if(process.env.TEST_PAYMENTS_FAST==='true') {
    run('begin;'+sql+'commit;');
    const order=()=>{const c=one("insert into crm_contacts(name,email) values('LOCAL PAYMENT','payment@example.invalid') returning id");return JSON.parse(run(`select hardware_order_create('creator@fixture.test','${crypto.randomUUID()}','${JSON.stringify({contact_id:c,delivery:{country:'NG',state:'Plateau',city:'Jos',address:'LOCAL TEST'},lines:[{variant_id:vid,quantity:1}]})}')`)).id;};
    const hold=id=>`select hardware_reservation_hold('${id}','reservation-key-${id}','fixture',900)`;
    const release=id=>run(`select hardware_reservation_finish('${id}','released','fixture','Local cleanup')`);
    run(`update catalogue_variants set stock_on_hand=100 where id='${vid}'`);
    await require('./test-hardware-payments-cases')({run,one,psql,check,order,hold,release,vid,PG,sh,concurrentSql,ROOT,startApp,gatewayUrl,RUN,reloadSchema,restUrl});return;
  }
  const shapeSql = fs.readFileSync(
    path.join(ROOT, "release/phase4c-gate/reservation-shape.sql"),
    "utf8",
  );
  const baseShape = JSON.parse(one(shapeSql));
  const preSql = fs
    .readFileSync(
      path.join(ROOT, "release/phase4c-gate/production-rollout-gates.sql"),
      "utf8",
    )
    .trim()
    .replace(/;$/, "");
  const preRows = JSON.parse(one(`select jsonb_agg(g) from (${preSql}) g`));
  check(
    "C-GATE-ABSENT",
    "prior candidate passes with reservations absent",
    preRows.find((x) => x.gate.startsWith("VERDICT")).status === "GO",
  );
  const rolled = psql("begin;" + sql + "rollback;");
  check(
    "C-M0",
    "reservation migration rolls back",
    rolled.status === 0 &&
      one("select to_regclass('hardware_reservations') is null") === "t",
    rolled.err,
  );
  if (rolled.status) throw Error(rolled.err);
  run("begin;" + sql + "commit;");
  await reloadSchema(restUrl);
  const gateSql = fs
    .readFileSync(
      path.join(ROOT, "release/phase4c-gate/production-rollout-gates.sql"),
      "utf8",
    )
    .trim()
    .replace(/;$/, "");
  const gate = (mutation) => {
    const out = run(
      `begin;${mutation};select jsonb_agg(g) from (${gateSql}) g;rollback;`,
    );
    return JSON.parse(out.split("\n").filter(Boolean).pop());
  };
  for (const mutation of [
    "",
    "alter table hardware_reservations disable row level security",
    "grant select on hardware_reservation_events to anon",
    "alter table hardware_reservations disable trigger reservation_state_guard",
    "alter table catalogue_variants disable trigger reservation_consistency",
    "alter function hardware_reservation_hold(uuid,text,text,integer) security definer",
    "grant execute on function hardware_reservation_hold(uuid,text,text,integer) to authenticated",
    "alter function hardware_reservation_expire(integer) set search_path=public",
    "alter table hardware_order_lines disable trigger order_immutable",
    "create or replace function hardware_reservation_payment_verified(p_order uuid,p_reservation uuid) returns boolean language sql stable set search_path=public,pg_temp as $$select true$$",
  ]) {
    const rows = gate(mutation);
    check(
      "C-GATE",
      mutation || "reviewed reservation schema and prior gates pass",
      rows.find((x) => x.gate.startsWith("VERDICT")).status ===
        (mutation ? "NO-GO" : "GO"),
      rows.filter((x) => x.status === "FAIL"),
    );
  }
  const order = (orderLines = [{ variant_id: vid, quantity: 1 }]) => {
    const c = one(
      "insert into crm_contacts(name,email) values('LOCAL RESERVATION TEST','reservation@example.invalid') returning id",
    );
    return JSON.parse(
      one(
        `select hardware_order_create('creator@fixture.test','${crypto.randomUUID()}', '${JSON.stringify({ contact_id: c, delivery: { country: "NG", state: "Plateau", city: "Jos", address: "LOCAL TEST" }, lines: orderLines })}')`,
      ),
    ).id;
  };
  const hold = (id, key = "reservation-key-" + id, ttl = 900) =>
    `select hardware_reservation_hold('${id}','${key}','fixture',${ttl})`;
  const release = (id) =>
    run(
      `select hardware_reservation_finish('${id}','released','fixture','Local test cleanup')`,
    );
  const a = order(),
    b = order();
  run(`update catalogue_variants set stock_on_hand=1 where id='${vid}'`);
  const race = await concurrentSql([hold(a), hold(b)]);
  check(
    "C-LAST",
    "two customers race for last unit: exactly one winner",
    race.filter((x) => x.code === 0).length === 1 &&
      race.some((x) => /stock_unavailable/.test(x.err)),
    race,
  );
  if (race.filter((x) => x.code === 0).length !== 1)
    throw Error(JSON.stringify(race));
  const winner = one(
    "select order_id from hardware_reservations where state='held' limit 1",
  );
  check(
    "C-COUNT",
    "authoritative stock counter and immutable reservation evidence agree",
    one(`select stock_reserved from catalogue_variants where id='${vid}'`) ===
      "1" && one("select count(*) from hardware_reservation_events") === "1",
  );
  const dup = await concurrentSql(Array(5).fill(hold(winner)));
  check(
    "C-IDEM",
    "duplicate reservation requests replay one hold",
    dup.every((x) => x.code === 0 && JSON.parse(x.out).replayed) &&
      one("select count(*) from hardware_reservations") === "1",
    dup,
  );
  check(
    "C-KEY",
    "changed idempotency key conflicts",
    /idempotency_conflict/.test(
      psql(hold(winner, "different-reservation-key")).err,
    ),
  );
  check(
    "C-ADJUST",
    "on-hand reduction cannot steal reserved stock",
    psql(
      `select catalogue_update_inventory('${vid}',(select row_version from catalogue_variants where id='${vid}'),'{"stock_on_hand":0}','fixture','test')`,
    ).status !== 0,
  );
  check(
    "C-MANUAL",
    "manual reserved reduction cannot steal managed stock",
    /reserved_stock_protected/.test(
      psql(
        `select catalogue_update_inventory('${vid}',(select row_version from catalogue_variants where id='${vid}'),'{"stock_reserved":0}','fixture','test')`,
      ).err,
    ),
  );
  check(
    "C-DIRECT",
    "direct stock-counter corruption denied",
    psql(`update catalogue_variants set stock_reserved=0 where id='${vid}'`)
      .status !== 0,
  );
  check(
    "C-PAY",
    "allocation fails closed without verified payment",
    /verified_order_payment_required/.test(
      psql(`select hardware_reservation_allocate('${winner}')`).err,
    ),
  );
  run(`select hardware_order_cancel('canceller@fixture.test','${winner}',1)`);
  check(
    "C-CANCEL",
    "order cancellation atomically releases stock",
    one(`select stock_reserved from catalogue_variants where id='${vid}'`) ===
      "0" &&
      one(
        `select state from hardware_reservations where order_id='${winner}'`,
      ) === "released",
  );
  // Allocation engine exercised with a transaction-local synthetic verified-evidence adapter.
  // Roll back the adapter and all allocation writes; final schema MUST retain select false.
  const allocation = order();
  run(hold(allocation));
  const mockProof =
    "create or replace function hardware_reservation_payment_verified(p_order uuid,p_reservation uuid) returns boolean language sql stable set search_path=public,pg_temp as $$ select true $$;";
  const allocated = run(
    `begin;${mockProof}select hardware_reservation_allocate('${allocation}');select hardware_reservation_allocate('${allocation}');set constraints all immediate;select stock_on_hand||':'||stock_reserved from catalogue_variants where id='${vid}';rollback;`,
  );
  check(
    "C-ALLOCATE-CONTRACT",
    "verified-evidence fixture allocates once and consumes physical stock",
    allocated.includes('"state": "allocated"') &&
      allocated.includes('"replayed": true') &&
      allocated.split("\n").includes("0:0"),
    allocated,
  );
  check(
    "C-ALLOCATE-ROLLBACK",
    "proof fixture rolled back; runtime still rejects unverified allocation",
    one(
      `select hardware_reservation_payment_verified('${allocation}',(select id from hardware_reservations where order_id='${allocation}'))`,
    ) === "f" &&
      /verified_order_payment_required/.test(
        psql(`select hardware_reservation_allocate('${allocation}')`).err,
      ),
  );
  const cancellationAfterAllocation = psql(
    `begin;${mockProof}select hardware_reservation_allocate('${allocation}');select hardware_order_cancel('canceller@fixture.test','${allocation}',1);commit;`,
  );
  check(
    "C-ALLOCATED-CANCEL",
    "allocated stock cannot be cancelled through prepayment workflow",
    /allocated_order_requires_refund_workflow/.test(
      cancellationAfterAllocation.err,
    ),
  );
  release(allocation);
  const before = one("select count(*) from hardware_reservation_events");
  release(winner);
  check(
    "C-RELEASE",
    "repeat release has no duplicate history",
    one("select count(*) from hardware_reservation_events") === before,
  );
  const cancelled = order();
  run(
    `select hardware_order_cancel('canceller@fixture.test','${cancelled}',1)`,
  );
  check(
    "C-CANCELLED",
    "cancelled order cannot reserve",
    /order_not_eligible/.test(psql(hold(cancelled)).err),
  );
  const crash = order();
  run("begin;" + hold(crash) + ";rollback;");
  check(
    "C-ROLLBACK",
    "interrupted transaction leaves no hold, stock or audit",
    one(
      `select count(*) from hardware_reservations where order_id='${crash}'`,
    ) === "0" &&
      one(`select stock_reserved from catalogue_variants where id='${vid}'`) ===
        "0",
  );
  run(hold(crash));
  release(crash);
  for (const t of [
    "hardware_reservations",
    "hardware_reservation_lines",
    "hardware_reservation_events",
    "hardware_reservation_stock",
  ])
    check(
      "C-AUTH",
      "RLS and denied browser grants " + t,
      one(
        `select relrowsecurity and not has_table_privilege('anon','${t}','SELECT') and not has_table_privilege('authenticated','${t}','SELECT') from pg_class where oid='${t}'::regclass`,
      ) === "t",
    );
  check(
    "C-FUNCTIONS",
    "service-only invoker functions with pinned paths",
    one(
      "select count(*) from pg_proc where pronamespace='public'::regnamespace and proname like 'hardware_reservation_%' and (prosecdef or has_function_privilege('anon',oid,'EXECUTE') or has_function_privilege('authenticated',oid,'EXECUTE') or proconfig is distinct from array['search_path=public, pg_temp'])",
    ) === "0",
  );
  for (const q of [
    "delete from hardware_reservation_events",
    "update hardware_reservation_lines set quantity=99",
    "truncate hardware_reservations",
  ])
    check(
      "C-IMM",
      "immutable reservation history rejects " + q,
      psql("set role service_role;" + q).status !== 0,
    );
  // Actual PostgreSQL cron capability, without the Office process.
  console.log("CRON CAPABILITY " + one("show shared_preload_libraries"));
  const scheduler = psql(
    fs.readFileSync(path.join(ROOT, "db/phase4c/expiry-scheduler.sql"), "utf8"),
  );
  check(
    "C-CRON",
    "database expiry job installed",
    scheduler.status === 0,
    scheduler.err,
  );

  // Independent multi-variant stock, using existing approval and price workflows.
  const category = one(
    `select category_id from catalogue_products where id='${pid}'`,
  );
  const second = one(
    `select catalogue_create_product('reservation-second','${category}',null,'{"name":"LOCAL RESERVATION SECOND","variants":[{"sku":"RES-SECOND","name":"Second"}]}','author@fixture.test')->>'id'`,
  );
  const v2 = one(
    `select id from catalogue_variants where product_id='${second}'`,
  );
  for (const [action, revision, actor] of [
    ["submit", 1, "author"],
    ["approve", 2, "reviewer"],
    ["publish", 3, "author"],
  ])
    run(
      `select catalogue_transition('${second}',${revision},'${action}','${actor}@fixture.test','','')`,
    );
  const price = one(
    `select catalogue_request_price_change('${v2}',50000,'standard',750,'author@fixture.test','')->>'id'`,
  );
  run(
    `select catalogue_decide_price_change('${price}','approved','reviewer@fixture.test','');select catalogue_publish_price_change('${price}','author@fixture.test');update catalogue_variants set sourcing='in_stock',stock_on_hand=1 where id='${v2}';insert into catalogue_public_listings(product_id,status,public_version,slug,released_at,released_by) select id,'public',published_version,slug,now(),'fixture' from catalogue_products where id='${second}';`,
  );
  const multiLines = [
    { variant_id: vid, quantity: 1 },
    { variant_id: v2, quantity: 1 },
  ];
  const m1 = order(multiLines),
    m2 = order([...multiLines].reverse());
  const multi = await concurrentSql([hold(m1), hold(m2)]);
  check(
    "C-MULTI",
    "simultaneous opposite-order carts reserve all variants or none",
    multi.filter((x) => x.code === 0).length === 1 &&
      one(
        `select sum(stock_reserved) from catalogue_variants where id in ('${vid}','${v2}')`,
      ) === "2",
    multi,
  );
  release(
    one(
      `select order_id from hardware_reservations where state='held' and order_id in ('${m1}','${m2}')`,
    ),
  );
  const partial = order(multiLines);
  run(`update catalogue_variants set stock_on_hand=0 where id='${v2}'`);
  check(
    "C-ALLNONE",
    "second unavailable line leaves no partial first-line reservation",
    psql(hold(partial)).status !== 0 &&
      one(`select stock_reserved from catalogue_variants where id='${vid}'`) ===
        "0" &&
      one(
        `select count(*) from hardware_reservations where order_id='${partial}'`,
      ) === "0",
  );
  // A true backend interruption after writes, before COMMIT.
  const interrupted = order();
  const { spawn } = require("node:child_process");
  const tx = spawn(
    "docker",
    [
      "exec",
      "-i",
      PG,
      "psql",
      "-X",
      "-q",
      "-At",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    { stdio: ["pipe", "ignore", "ignore"] },
  );
  const closed = new Promise((resolve) => tx.once("close", resolve));
  tx.stdin.end(
    `set application_name='reservation-interrupt-${RUN}';begin;${hold(interrupted)};select pg_sleep(30);commit;`,
  );
  let backend = "";
  for (let n = 0; n < 100; n++) {
    backend = one(
      `select pid from pg_stat_activity where application_name='reservation-interrupt-${RUN}' and wait_event='PgSleep'`,
    );
    if (backend) break;
    await sleep(100);
  }
  if (!backend)
    throw Error("interrupted transaction did not reach post-write pause");
  run(`select pg_terminate_backend(${Number(backend)})`);
  await closed;
  check(
    "C-KILL",
    "terminated DB session rolls back counter, ledger and audit",
    one(
      `select count(*) from hardware_reservations where order_id='${interrupted}'`,
    ) === "0" &&
      one(`select stock_reserved from catalogue_variants where id='${vid}'`) ===
        "0",
  );
  run(hold(interrupted));
  release(interrupted);
  const adjustOrder = order();
  const adjustment = await concurrentSql([
    hold(adjustOrder),
    `select catalogue_update_inventory('${vid}',(select row_version from catalogue_variants where id='${vid}'),'{"stock_on_hand":0}','fixture','race')`,
  ]);
  check(
    "C-INV-RACE",
    "inventory adjustment and last-unit checkout cannot both win",
    adjustment.filter((x) => x.code === 0).length === 1 &&
      one(
        `select stock_reserved<=stock_on_hand from catalogue_variants where id='${vid}'`,
      ) === "t",
    adjustment,
  );
  release(adjustOrder);
  run(
    `update catalogue_variants set stock_on_hand=100 where id='${vid}';select catalogue_update_inventory('${vid}',(select row_version from catalogue_variants where id='${vid}'),'{"stock_reserved":7}','fixture','legacy test')`,
  );
  const legacy = order();
  run(hold(legacy));
  check(
    "C-LEGACY",
    "existing manual reservations coexist with order holds",
    one(`select stock_reserved from catalogue_variants where id='${vid}'`) ===
      "8",
  );
  release(legacy);
  check(
    "C-LEGACY-RELEASE",
    "release restores manual reserved quantity",
    one(`select stock_reserved from catalogue_variants where id='${vid}'`) ===
      "7",
  );
  run(
    `select catalogue_update_inventory('${vid}',(select row_version from catalogue_variants where id='${vid}'),'{"stock_reserved":0}','fixture','cleanup')`,
  );
  for (const actor of ["plain@fixture.test", "missing@fixture.test"])
    check(
      "C-STAFF-DENY",
      "unauthorized staff cannot reserve",
      /forbidden/.test(
        psql(
          `select hardware_reservation_staff('${actor}','${legacy}','untrusted-staff-key','hold')`,
        ).err,
      ),
    );
  const eligibilityOrder=order();
  const withdrawn=psql(`begin;select catalogue_public_withdraw('${pid}',(select row_version from catalogue_public_listings where product_id='${pid}'),'fixture','eligibility test');${hold(eligibilityOrder)};rollback;`);
  check('C-WITHDRAWN','withdrawn product cannot acquire a reservation',/product_unavailable/.test(withdrawn.err));
  const supplier=psql(`begin;select catalogue_update_inventory('${vid}',(select row_version from catalogue_variants where id='${vid}'),'{"sourcing":"supplier_sourced"}','fixture','eligibility test');${hold(eligibilityOrder)};rollback;`);
  check('C-SUPPLIER','supplier-sourced order cannot reserve physical stock',/stock_unavailable/.test(supplier.err));
  const priceChanged=psql(`begin;do $$declare c uuid;begin select catalogue_request_price_change('${vid}',150000,'standard',750,'author@fixture.test','')->>'id' into c;perform catalogue_decide_price_change(c,'approved','reviewer@fixture.test','');perform catalogue_publish_price_change(c,'author@fixture.test');end$$;${hold(eligibilityOrder)};rollback;`);
  check('C-PRICE','approved price change invalidates stale order reservation',/order_price_changed/.test(priceChanged.err));
  const reservationApp = await startApp(gatewayUrl, true);
  const staffLogin = await fetch(
    reservationApp.url + "/api/lead-agents/admin/session/login",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "creator@fixture.test",
        password: "Isolated-Only-" + RUN,
      }),
    },
  );
  const staffCookie = staffLogin.headers
    .getSetCookie()
    .find((x) => x.startsWith("lead_agents_admin="))
    .split(";")[0];
  const staffOrder=order();
  const staffHold=await fetch(reservationApp.url+'/api/lead-agents/admin/hardware-orders/'+staffOrder+'/reservation',{method:'POST',headers:{'content-type':'application/json',cookie:staffCookie,origin:reservationApp.url},body:JSON.stringify({action:'hold',idempotency_key:'authorized-staff-hold'})});
  check('C-STAFF-HTTP','authorized staff can request a hold',staffHold.status===200&&(await staffHold.json()).reservation.state==='held');release(staffOrder);
  const off=await fetch(app.url+'/api/lead-agents/admin/hardware-orders/'+staffOrder+'/reservation',{method:'POST',headers:{'content-type':'application/json',cookie:staffCookie,origin:app.url},body:JSON.stringify({action:'hold',idempotency_key:'disabled-staff-hold'})});
  check('C-FLAG','new reservation route stays disabled without its flag',off.status===503);
  const forbiddenAction = await fetch(
    reservationApp.url +
      "/api/lead-agents/admin/hardware-orders/" +
      legacy +
      "/reservation",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: staffCookie,
        origin: reservationApp.url,
      },
      body: JSON.stringify({
        action: "allocate",
        idempotency_key: "unverified-callback-key",
      }),
    },
  );
  check(
    "C-HTTP-PAY",
    "staff cannot claim payment allocation via browser action",
    forbiddenAction.status === 400,
  );
  check(
    "C-PROOF-OWNER",
    "service role cannot replace fail-closed payment verifier",
    psql("set role service_role;" + mockProof).status !== 0,
  );

  const post = async (action, b) => {
    const r = await fetch(
      reservationApp.url + "/api/commerce/checkout/" + action,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "isolated-checkout-" + RUN,
        },
        body: JSON.stringify(b),
      },
    );
    return { status: r.status, data: await r.json() };
  };
  const lines = [{ product: "test-order", sku: "TEST-ORDER-1", quantity: 2 }],
    quote = await post("quote", { lines });
  check(
    "C-HTTP-QUOTE",
    "checkout advertises authoritative hold duration",
    quote.status === 200 && quote.data.quote.reservation_ttl_seconds === 900,
    quote,
  );
  const body = {
    guest_hash: crypto.randomBytes(32).toString("hex"),
    idempotency_key: crypto.randomUUID(),
    quote_hash: quote.data.quote.quote_hash,
    order: {
      lines,
      customer: {
        name: "LOCAL RESERVATION GUEST",
        email: "held@example.invalid",
        phone: "+2348000000000",
      },
      delivery: {
        country: "NG",
        state: "FCT",
        city: "Abuja",
        address: "LOCAL TEST ONLY",
      },
      installation_requested: false,
    },
  };
  const responses = await Promise.all([
    post("submit", body),
    post("submit", body),
  ]);
  check(
    "C-HTTP-IDEM",
    "duplicate checkout commits one order with one hold",
    responses
      .map((x) => x.status)
      .sort()
      .join(",") === "200,201" &&
      responses[0].data.order.id === responses[1].data.order.id &&
      responses.every((x) => x.data.order.reservation.state === "held"),
    responses,
  );
  const guestOrder = responses[0].data.order.id;
  const own = await post("status", {
    id: guestOrder,
    guest_hash: body.guest_hash,
  });
  check(
    "C-HTTP-OWN",
    "owner receipt exposes hold expiry without PII",
    own.status === 200 &&
      own.data.order.reservation.state === "held" &&
      !JSON.stringify(own).includes("held@example.invalid"),
  );
  check(
    "C-HTTP-OTHER",
    "different guest cannot inspect hold",
    (await post("status", { id: guestOrder, guest_hash: "0".repeat(64) }))
      .status === 404,
  );
  await reservationApp.stop();
  const restarted = await startApp(gatewayUrl, true);
  const recovered = await fetch(
    restarted.url + "/api/commerce/checkout/status",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "isolated-checkout-" + RUN,
      },
      body: JSON.stringify({ id: guestOrder, guest_hash: body.guest_hash }),
    },
  );
  check(
    "C-RESTART",
    "committed hold survives Office process restart",
    recovered.status === 200 &&
      (await recovered.json()).order.reservation.state === "held",
  );
  if (process.env.TEST_CHECKOUT_WEB === "true")
    await require("./test-hardware-checkout-web")({ app: restarted, RUN });
  // Release browser-test holds, then stop all Office processes before testing actual database cron expiry.
  for (const id of one(
    "select order_id from hardware_reservations where state='held'",
  )
    .split("\n")
    .filter(Boolean))
    release(id);
  await restarted.stop();
  await app.stop();
  const expiry = order();
  run(hold(expiry, "expiry-reservation-key", 60));
  run(
    "select cron.schedule('getoyi-hardware-reservation-expiry','1 second','select public.hardware_reservation_expire(500);')",
  );
  console.log("C-EXPIRY waiting for real TTL with Office stopped");
  for (let n = 0; n < 85; n++) {
    if (
      one(
        `select state from hardware_reservations where order_id='${expiry}'`,
      ) === "expired"
    )
      break;
    await sleep(1000);
  }
  check(
    "C-EXPIRY",
    "pg_cron expires hold with no running Office process",
    one(
      `select state from hardware_reservations where order_id='${expiry}'`,
    ) === "expired" &&
      one(`select stock_reserved from catalogue_variants where id='${vid}'`) ===
        "0",
  );
  check(
    "C-LATE-PAY",
    "late verified-evidence fixture cannot allocate expired stock",
    /reservation_not_held/.test(
      psql(
        `begin;${mockProof}select hardware_reservation_allocate('${expiry}');rollback;`,
      ).err,
    ),
  );
  const expiredRetry = JSON.parse(
    run(hold(expiry, "expiry-reservation-key", 60)),
  );
  check(
    "C-EXPIRED-RETRY",
    "retry never renews expired order hold",
    expiredRetry.state === "expired" && expiredRetry.replayed,
  );
  run(
    "select cron.schedule('getoyi-hardware-reservation-expiry','* * * * *','select public.hardware_reservation_expire(500);')",
  );
  check(
    "C-CRON-EVIDENCE",
    "scheduler records successful database execution",
    Number(
      one(
        "select count(*) from cron.job_run_details d join cron.job j using(jobid) where j.jobname='getoyi-hardware-reservation-expiry' and d.status='succeeded'",
      ),
    ) > 0,
  );
  const runtimeGate = fs
    .readFileSync(
      path.join(ROOT, "release/phase4c-gate/scheduler-check.sql"),
      "utf8",
    )
    .trim()
    .replace(/;$/, "");
  const runtimeRows = JSON.parse(
    one(`select jsonb_agg(g) from (${runtimeGate}) g`),
  );
  check(
    "C-SCHEDULER-GATE",
    "all database scheduler checks pass",
    runtimeRows.every((x) => x.status === "PASS"),
    runtimeRows,
  );
  Object.assign(app, await startApp(gatewayUrl));
  run(`update catalogue_variants set stock_on_hand=100 where id='${vid}'`);  if(process.env.TEST_PAYMENTS==='true')await require('./test-hardware-payments-cases')({run,one,psql,check,order,hold,release,vid,PG,sh,concurrentSql,ROOT,startApp,gatewayUrl,RUN,reloadSchema,restUrl});
};
