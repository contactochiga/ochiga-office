"use strict";
const fs = require("fs"),
  path = require("path"),
  crypto = require("crypto"),
  { spawn } = require("child_process");
module.exports = async ({
  run,
  one,
  psql,
  check,
  order,
  hold,
  release,
  vid,
  PG,
  sh,
  concurrentSql,
  ROOT,
  startApp,
  gatewayUrl,
  RUN,
  reloadSchema,
  restUrl,
}) => {
  const migration = fs.readFileSync(
    path.join(
      ROOT,
      "db/phase4d/20261026094828_hardware_payment_confirmation.sql",
    ),
    "utf8",
  );
  const preGate=fs.readFileSync(path.join(ROOT,'release/phase4d-gate/production-rollout-gates.sql'),'utf8').trim().replace(/;$/,'');
  const preRows=JSON.parse(one('select jsonb_agg(g) from ('+preGate+') g'));
  check('D-PREFLIGHT','Stage4C baseline passes with payments absent',preRows.find(x=>x.gate.startsWith('VERDICT')).status==='GO',preRows.filter(x=>x.status==='FAIL'));
  if(process.env.TEST_PAYMENT_PREFLIGHT_ONLY==='true')return;
  const rb = psql("begin;" + migration + "rollback;");
  check(
    "D-M0",
    "Office migration transaction rolls back",
    rb.status === 0,
    rb.err,
  );
  if (rb.status) throw Error(rb.err);
  run("begin;" + migration + "commit;");
  const backend = path.resolve(ROOT, "../backend-phase4d");
  const br = sh("docker", [
    "exec",
    PG,
    "createdb",
    "-U",
    "postgres",
    "hardware_payments_test",
  ]);
  if (br.status) throw Error(br.stderr);
  const bsql = (sql) => {
    const r = sh(
      "docker",
      [
        "exec",
        "-i",
        PG,
        "psql",
        "-X",
        "-Atq",
        "-U",
        "postgres",
        "-d",
        "hardware_payments_test",
        "-v",
        "ON_ERROR_STOP=1",
      ],
      { input: sql },
    );
    if (r.status) throw Error(r.stderr);
    return r.stdout.trim();
  };
  const backendMigration=fs.readFileSync(path.join(backend,'supabase/migrations/20261026094951_hardware_payment_attempts.sql'),'utf8');
  bsql('begin;'+backendMigration+'rollback;');
  check('D-BACKEND-ROLLBACK','Backend migration rollback leaves no payment tables',bsql("select to_regclass('hardware_payment_attempts') is null")==='t');
  bsql(
    fs.readFileSync(
      path.join(
        backend,
        "supabase/migrations/20261026094951_hardware_payment_attempts.sql",
      ),
      "utf8",
    ),
  );
  const gate = fs
    .readFileSync(
      path.join(ROOT, "release/phase4d-gate/production-rollout-gates.sql"),
      "utf8",
    )
    .trim()
    .replace(/;$/, "");
  for (const mutation of [
    "",
    "alter table hardware_payment_confirmations disable row level security",
    "grant select on hardware_payment_authorizations to anon",
    "alter function hardware_payment_confirm(jsonb) security definer",
    "alter table hardware_orders disable trigger payment_consistency",
    "alter function hardware_reservation_payment_verified(uuid,uuid) set search_path=public",
  ]) {
    const r = psql(
      "begin;" +
        mutation +
        ";select jsonb_agg(g) from (" +
        gate +
        ") g;rollback;",
    );
    if (r.status) throw Error(r.err);
    const rows = JSON.parse(r.out);
    check(
      "D-GATE",
      mutation || "reviewed Office payment schema and previous gates pass",
      rows.find((x) => x.gate.startsWith("VERDICT")).status ===
        (mutation ? "NO-GO" : "GO"),
      rows.filter((x) => x.status === "FAIL"),
    );
  }
  const bg = fs.readFileSync(
    path.join(backend, "release/phase4d/security-gate.sql"),
    "utf8",
  );
  check(
    "D-BACKEND-GATE",
    "reviewed Backend payment schema passes",
    bsql(bg) === "PASS",
  );
  check(
    "D-BACKEND-TAMPER",
    "Backend role-grant tampering fails gate",
    bsql(
      "begin;grant select on hardware_payment_attempts to anon;" +
        bg +
        "rollback;",
    ) === "FAIL",
  );
  const quote = (v) => "'" + JSON.stringify(v).replace(/'/g, "''") + "'::jsonb";
  const asyncSql = (db, sql) =>
    new Promise((resolve, reject) => {
      const p = spawn("docker", [
        "exec",
        "-i",
        PG,
        "psql",
        "-X",
        "-Atq",
        "-U",
        "postgres",
        "-d",
        db,
        "-v",
        "ON_ERROR_STOP=1",
      ]);
      let out = "",
        err = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      p.on("close", (c) => (c ? reject(Error(err)) : resolve(out.trim())));
      p.stdin.end(sql);
    });
  const rpc = async (name, args) => {
    const values = Object.values(args)
      .map((v) =>
        v && typeof v === "object"
          ? quote(v)
          : "'" + String(v).replace(/'/g, "''") + "'",
      )
      .join(",");
    const out = await asyncSql(
      "hardware_payments_test",
      `select ${name}(${values})`,
    );
    return out ? JSON.parse(out) : null;
  };
  const { HardwarePayments, validSignature, paymentCallback } = require(
    path.join(backend, "dist/commerce/hardwarePayments.js"),
  );
  let initCalls = 0,
    verifyCalls = 0,
    officeFail = false,
    timeout = false;
  const providerResults = new Map();
  const provider = {
    post: async (_, p) => {
      initCalls++;
      providerResults.set(p.reference, {
        id: 1000 + initCalls,
        reference: p.reference,
        status: "success",
        amount: Number(p.amount),
        currency: "NGN",
        domain: "test",
        metadata: p.metadata,
      });
      if (timeout) throw Error("timeout after provider acceptance");
      return {
        data: {
          status: true,
          data: {
            reference: p.reference,
            authorization_url: "https://checkout.paystack.com/local-test",
          },
        },
      };
    },
    get: async (url) => {
      verifyCalls++;
      return {
        data: { status: true, data: providerResults.get(url.split("/").pop()) },
      };
    },
  };
  const deps = {
    rpc,
    get: async (r) =>
      JSON.parse(
        bsql(
          `select row_to_json(a) from hardware_payment_attempts a where reference='${r}'`,
        ),
      ),
    due: async () =>
      JSON.parse(
        bsql(
          "select coalesce(json_agg(a),'[]') from (select reference from hardware_payment_attempts where state in ('initializing','pending','uncertain','verified')) a",
        ),
      ),
    provider,
    secret: "sk_test_SYNTHETIC_NOT_A_CREDENTIAL",
    callback: "https://getoyi.com/hardware/checkout",
    office: async (p) => {
      if (officeFail) throw Error("Office offline");
      return JSON.parse(
        await asyncSql(
          "postgres",
          `select hardware_payment_confirm(${quote(p)})`,
        ),
      );
    },
  };
  const service = new HardwarePayments(deps);
  process.env.SUPABASE_URL = "http://127.0.0.1:1";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-test-key";
  process.env.HARDWARE_OFFICE_API_KEY =
    "synthetic-internal-key-with-32-characters";
  const express = require(path.join(backend, "node_modules/express"));
  const { hardwareWebhookHandler, hardwareRoutes } = require(
    path.join(backend, "dist/commerce/hardwarePaymentRoutes.js"),
  );
  const httpApp = express();
  httpApp.post(
    "/webhook",
    express.raw({ type: "application/json" }),
    hardwareWebhookHandler(() => service),
  );
  httpApp.use(express.json());
  httpApp.use(
    "/payments",
    hardwareRoutes(() => service),
  );
  const server = await new Promise((resolve) => {
    const srv = httpApp.listen(0, "127.0.0.1", () => resolve(srv));
  });
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    let r = await fetch(base + "/payments/initialize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    check(
      "D-HTTP-AUTH",
      "Backend unauthenticated initialization returns403",
      r.status === 403,
    );
    r = await fetch(base + "/payments/initialize", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-office-api-key": process.env.HARDWARE_OFFICE_API_KEY,
      },
      body: "{}",
    });
    check(
      "D-HTTP-OFF",
      "Backend initialization disabled by default returns503",
      r.status === 503,
    );
    process.env.HARDWARE_PAYMENT_PROCESSING_ENABLED = "true";
    r = await fetch(base + "/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-paystack-signature": "bad",
      },
      body: "{}",
    });
    check(
      "D-HTTP-BAD-SIG",
      "actual raw-body HTTP webhook rejects bad signature401",
      r.status === 401,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  run(
    "update admin_users set permission_scopes=array_append(permission_scopes,'commerce.orders.delivery.confirm') where email='creator@fixture.test'",
  );
  const guest = "a".repeat(64);
  function make(delivery = true, ttl = 900) {
    const id = order();
    run(
      `select hardware_reservation_hold('${id}','reservation-key-${id}','fixture',${ttl})`,
    );
    run(
      `insert into hardware_checkout_receipts values('payment-test','${guest}','${crypto.randomUUID()}','${"b".repeat(64)}','${id}',now())`,
    );
    if (delivery)
      run(
        `select hardware_payment_confirm_delivery('creator@fixture.test','${id}',250000,17442,'LOCAL VERIFIED SERVICEABILITY TEST')`,
      );
    return id;
  }
  function auth(id) {
    return JSON.parse(
      run(
        `select hardware_payment_authorize('payment-test','${guest}','${id}',(select payable_total_kobo from hardware_orders where id='${id}'))`,
      ),
    );
  }
  const first = make(false);
  check(
    "D-DELIVERY",
    "unconfirmed delivery cannot initialize",
    psql(
      `select hardware_payment_authorize('payment-test','${guest}','${first}',100)`,
    ).status !== 0,
  );
  check(
    "D-DELIVERY-AUTH",
    "unauthorized delivery confirmation refused",
    psql(
      `select hardware_payment_confirm_delivery('none@fixture.test','${first}',0,0,'LOCAL TEST')`,
    ).status !== 0,
  );
  run(
    `select hardware_payment_confirm_delivery('creator@fixture.test','${first}',250000,17442,'LOCAL VERIFIED SERVICEABILITY TEST')`,
  );
  check(
    "D-ACCEPT",
    "browser accepted-total mismatch refused",
    psql(
      `select hardware_payment_authorize('payment-test','${guest}','${first}',1)`,
    ).status !== 0,
  );
  check(
    "D-OWNER",
    "other guest cannot authorize payment",
    psql(
      `select hardware_payment_authorize('payment-test','${"c".repeat(64)}','${first}',1)`,
    ).status !== 0,
  );
  const a = auth(first);
  const initial = await Promise.all(
    Array.from({ length: 6 }, () => service.initialize(a)),
  );
  check(
    "D-INIT-RACE",
    "six concurrent initializations produce one provider request",
    initCalls === 1 && initial.some((x) => x.checkout_url),
    initial,
  );
  const before = Number(
    one(`select stock_on_hand from catalogue_variants where id='${vid}'`),
  );
  await Promise.all(
    Array.from({ length: 6 }, () => service.reconcile(a.reference)),
  );
  check(
    "D-CONFIRM-RACE",
    "concurrent verification allocates once",
    one(`select payment_state from hardware_orders where id='${first}'`) ===
      "paid" &&
      Number(
        one(`select stock_on_hand from catalogue_variants where id='${vid}'`),
      ) ===
        before - 1,
  );
  check(
    "D-HISTORY",
    "one immutable financial confirmation and allocation",
    one(
      `select count(*) from hardware_payment_confirmations where order_id='${first}'`,
    ) === "1" &&
      one(
        `select count(*) from hardware_payment_history where order_id='${first}' and event_type='paid'`,
      ) === "1",
  );
  await service.reconcile(a.reference);
  check(
    "D-REPLAY",
    "confirmed payment replay has no stock effect",
    Number(
      one(`select stock_on_hand from catalogue_variants where id='${vid}'`),
    ) ===
      before - 1,
  );
  const raw = Buffer.from(
    JSON.stringify({
      event: "charge.success",
      data: { reference: a.reference },
    }),
  );
  const sig = crypto
    .createHmac("sha512", deps.secret)
    .update(raw)
    .digest("hex");
  check(
    "D-SIG",
    "strict raw signature rejects missing/tampered signatures",
    validSignature(raw, sig, deps.secret) &&
      !validSignature(raw, "x", deps.secret) &&
      !validSignature(Buffer.concat([raw, Buffer.from(" ")]), sig, deps.secret),
  );
  await Promise.all(Array.from({ length: 5 }, () => service.webhook(raw, sig)));
  check(
    "D-INBOX",
    "five webhook replays create one durable inbox row",
    bsql("select count(*) from hardware_payment_inbox") === "1",
  );
  let denied = false;
  try {
    await service.webhook(raw, "bad");
  } catch {
    denied = true;
  }
  check(
    "D-HTTP-SIGNATURE",
    "service rejects invalid signature before persistence",
    denied && bsql("select count(*) from hardware_payment_inbox") === "1",
  );
  for (const c of [
    "http://getoyi.example/hardware/checkout",
    "https://evil.example/elsewhere",
    "https://getoyi.example/hardware/checkout?next=evil",
  ]) {
    let no = false;
    try {
      paymentCallback(c);
    } catch {
      no = true;
    }
    check("D-CALLBACK", "invalid configured callback denied", no);
  }
  const unknown = "hwo_" + "f".repeat(32);
  const u = Buffer.from(
    JSON.stringify({ event: "charge.success", data: { reference: unknown } }),
  );
  await service.webhook(
    u,
    crypto.createHmac("sha512", deps.secret).update(u).digest("hex"),
  );
  const n = verifyCalls;
  await service.reconcile(unknown);
  check(
    "D-UNKNOWN",
    "unknown reference quarantined without provider or order mutation",
    verifyCalls === n &&
      bsql(
        `select known_reference from hardware_payment_inbox where reference='${unknown}'`,
      ) === "f",
  );
  const outage = make(),
    oa = auth(outage);
  await service.initialize(oa);
  officeFail = true;
  try {
    await service.reconcile(oa.reference);
  } catch {}
  check(
    "D-OUTBOX",
    "Office outage retains verified durable outbox",
    bsql(
      `select state from hardware_payment_attempts where reference='${oa.reference}'`,
    ) === "verified" &&
      one(`select payment_state from hardware_orders where id='${outage}'`) ===
        "not_started",
  );
  officeFail = false;
  await new HardwarePayments(deps).reconcile(oa.reference);
  check(
    "D-RECOVERY",
    "new process service recovers persisted payment once",
    one(`select payment_state from hardware_orders where id='${outage}'`) ===
      "paid",
  );
  const timed = make(),
    ta = auth(timed);
  timeout = true;
  await service.initialize(ta);
  timeout = false;
  const nc = initCalls;
  await service.initialize(ta);
  check(
    "D-TIMEOUT",
    "ambiguous initialization verifies original reference without reinitializing",
    initCalls === nc &&
      one(`select payment_state from hardware_orders where id='${timed}'`) ===
        "paid",
  );
  for (const kind of [
    "amount",
    "currency",
    "domain",
    "reference",
    "metadata",
  ]) {
    const id = make(),
      x = auth(id);
    await service.initialize(x);
    const p = providerResults.get(x.reference);
    if (kind === "amount") p.amount--;
    else if (kind === "metadata") p.metadata.purpose = "wallet";
    else p[kind] = "invalid";
    await service.reconcile(x.reference);
    check(
      "D-MISMATCH-" + kind,
      "mismatched evidence requires reconciliation and never allocates",
      bsql(
        `select state from hardware_payment_attempts where reference='${x.reference}'`,
      ) === "manual_reconciliation" &&
        one(`select payment_state from hardware_orders where id='${id}'`) ===
          "not_started",
    );
    release(id);
  }
  const cancelled = make(),
    ca = auth(cancelled);
  await service.initialize(ca);
  run(
    `select hardware_order_cancel('canceller@fixture.test','${cancelled}',1)`,
  );
  await service.reconcile(ca.reference);
  check(
    "D-CANCEL",
    "payment after cancellation records refund-required without allocation",
    one(
      `select payment_state||':'||reservation_state from hardware_orders where id='${cancelled}'`,
    ) === "refund_required:released",
  );
  const late = make(),
    la = auth(late);
  await service.initialize(la);
  release(late);
  await service.reconcile(la.reference);
  check(
    "D-LATE",
    "released hold cannot allocate a late successful payment",
    one(
      `select payment_state||':'||reservation_state from hardware_orders where id='${late}'`,
    ) === "refund_required:released",
  );
  check(
    "D-HISTORY-DENY",
    "confirmation and reservation history cannot be edited",
    psql(
      `update hardware_payment_confirmations set amount_kobo=1 where order_id='${first}'`,
    ).status !== 0,
  );
  check(
    "D-RLS",
    "payment tables inaccessible to public roles",
    one(
      "select count(*) from information_schema.role_table_grants where grantee in ('anon','authenticated','PUBLIC') and table_name like 'hardware_payment_%'",
    ) === "0",
  );
  check(
    "D-BACKEND-RLS",
    "Backend payment tables inaccessible to public roles",
    bsql(
      "select count(*) from information_schema.role_table_grants where grantee in ('anon','authenticated','PUBLIC') and table_name like 'hardware_payment_%'",
    ) === "0",
  );
  check(
    "D-NO-WALLET",
    "isolated payment database has no wallet ledger dependency",
    bsql(
      "select count(*) from pg_tables where schemaname='public' and tablename like '%wallet%'",
    ) === "0",
  );
  const proof = JSON.parse(
    bsql(
      `select proof from hardware_payment_attempts where reference='${a.reference}'`,
    ),
  );
  proof.provider_id = "999999";
  check(
    "D-SECOND-CHARGE",
    "second provider charge cannot reconfirm an order",
    psql(`select hardware_payment_confirm(${quote(proof)})`).status !== 0,
  );
  const duplicateProof = JSON.parse(
    bsql(
      `select proof from hardware_payment_attempts where reference='${oa.reference}'`,
    ),
  );
  const races = await concurrentSql(
    Array(6).fill(`select hardware_payment_confirm(${quote(duplicateProof)})`),
  );
  check(
    "D-OFFICE-RACE",
    "six independent Office confirmations replay one result",
    races.every((r) => r.code === 0) &&
      one(
        `select count(*) from hardware_payment_confirmations where order_id='${outage}'`,
      ) === "1",
  );
  const interrupted = make(),
    ia = auth(interrupted);
  await service.initialize(ia);
  officeFail = true;
  try {
    await service.reconcile(ia.reference);
  } catch {}
  officeFail = false;
  const ip = JSON.parse(
    bsql(
      `select proof from hardware_payment_attempts where reference='${ia.reference}'`,
    ),
  );
  const failWrite = psql(
    `begin;select hardware_payment_confirm(${quote(ip)});select 1/0;commit;`,
  );
  check(
    "D-INTERRUPTED",
    "failed Office transaction rolls back paid state and allocation",
    failWrite.status !== 0 &&
      one(
        `select payment_state||':'||reservation_state from hardware_orders where id='${interrupted}'`,
      ) === "not_started:held",
  );
  await service.reconcile(ia.reference);
  check(
    "D-INTERRUPTED-RETRY",
    "durable Backend evidence recovers failed Office transaction",
    one(
      `select payment_state from hardware_orders where id='${interrupted}'`,
    ) === "paid",
  );
  const expiry = make(true, 60),
    ea = auth(expiry);
  await service.initialize(ea);
  const leaseOrder = make(),
    ls = auth(leaseOrder);
  await service.initialize(ls);
  await rpc("hardware_payment_claim", { p_reference: ls.reference });
  await new HardwarePayments(deps).reconcile(ls.reference);
  check(
    "D-LEASE",
    "committed worker lease excludes concurrent recovery",
    one(
      `select payment_state from hardware_orders where id='${leaseOrder}'`,
    ) === "not_started",
  );
  console.log(
    "D-RECOVERY waiting for real reservation and abandoned worker lease expiry",
  );
  await new Promise((resolve) => setTimeout(resolve, 62000));
  await service.reconcile(ea.reference);
  check(
    "D-REAL-EXPIRY",
    "payment after actual reservation expiry requires refund without stock allocation",
    one(
      `select payment_state||':'||reservation_state from hardware_orders where id='${expiry}'`,
    ) === "refund_required:expired",
  );
  await new HardwarePayments(deps).reconcile(ls.reference);
  check(
    "D-LEASE-RECOVERY",
    "replacement worker recovers an abandoned lease after its real deadline",
    one(
      `select payment_state from hardware_orders where id='${leaseOrder}'`,
    ) === "paid",
  );
  await reloadSchema(restUrl);
  const officeApp = await startApp(gatewayUrl, true, true);
  try {
    const post = async (route, key, body) =>
      fetch(officeApp.url + route, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key },
        body: JSON.stringify(body),
      });
    const cp = JSON.parse(
      bsql(
        `select proof from hardware_payment_attempts where reference='${a.reference}'`,
      ),
    );
    let response = await post(
      "/api/commerce/payments/confirm",
      "isolated-checkout-" + RUN,
      cp,
    );
    check(
      "D-OFFICE-HTTP-SCOPE",
      "checkout credential cannot confirm payment",
      response.status === 403,
    );
    response = await post(
      "/api/commerce/payments/confirm",
      "isolated-payments-" + RUN,
      cp,
    );
    check(
      "D-OFFICE-HTTP-CONFIRM",
      "narrow confirmation scope idempotently acknowledges verified evidence",
      response.status === 200,
      await response.json(),
    );
    response = await post(
      "/api/commerce/payments/confirm",
      "isolated-payments-" + RUN,
      { ...cp, amount_kobo: 1 },
    );
    check(
      "D-OFFICE-HTTP-MATCH",
      "Office HTTP confirmation rejects mismatched amount409",
      response.status === 409,
    );
    response = await post(
      "/api/commerce/checkout/status",
      "isolated-payments-" + RUN,
      { id: first, guest_hash: guest },
    );
    check(
      "D-OFFICE-HTTP-PRIVATE",
      "payment confirmation scope cannot read guest orders",
      response.status === 403,
    );
  } finally {
    await officeApp.stop();
  }
  const unverified = make();
  check(
    "D-NO-REDIRECT",
    "unverified allocation remains denied",
    psql(`select hardware_reservation_allocate('${unverified}')`).status !== 0,
  );
  release(unverified);
};
