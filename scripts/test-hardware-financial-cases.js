"use strict";
const fs = require("fs"),
  path = require("path"),
  crypto = require("crypto");
module.exports = async ({
  run,
  one,
  psql,
  check,
  bsql,
  rpc,
  asyncSql,
  backend,
  ROOT,
  make,
  auth,
  service,
  providerResults,
  deps,
  quote,
}) => {
  const om = fs.readFileSync(
    path.join(
      ROOT,
      "db/phase4e/20261026102637_hardware_financial_operations.sql",
    ),
    "utf8",
  );
  const bm = fs.readFileSync(
    path.join(
      backend,
      "supabase/migrations/20261026102658_hardware_refund_recovery.sql",
    ),
    "utf8",
  );
  run("begin;" + om + "rollback;");
  bsql("begin;" + bm + "rollback;");
  check(
    "E-ROLLBACK",
    "transaction rollback removes both new schemas",
    one("select to_regclass('hardware_refund_requests') is null") === "t" &&
      bsql("select to_regclass('hardware_refunds') is null") === "t",
  );
  run(om);
  bsql(bm);
  run(fs.readFileSync(path.join(ROOT, "release/phase4e/rollback.sql"), "utf8"));
  bsql(
    fs.readFileSync(path.join(backend, "release/phase4e/rollback.sql"), "utf8"),
  );
  check(
    "E-DOWN",
    "pre-use down migrations remove only Stage4E tables",
    one(
      "select to_regclass('hardware_refund_requests') is null and to_regprocedure('hardware_payment_quote(text,text,uuid)') is not null",
    ) === "t" &&
      bsql(
        "select to_regclass('hardware_refunds') is null and to_regclass('hardware_payment_attempts') is not null",
      ) === "t",
  );
  run(om);
  bsql(bm);
  for (const [root, sql, table] of [
    [ROOT, run, "hardware_refund_requests"],
    [backend, bsql, "hardware_refunds"],
  ]) {
    const dir = path.join(root, "release/phase4e"),
      shape = fs
        .readFileSync(path.join(dir, "shape.sql"), "utf8")
        .trim()
        .replace(/;$/, "");
    const actual = JSON.parse(sql(shape));
    const file = path.join(dir, "reviewed.json");
    if (process.env.RECORD_FINANCIAL_GATE === "true")
      fs.writeFileSync(file, JSON.stringify(actual, null, 2) + "\n");
    const expected = JSON.parse(fs.readFileSync(file, "utf8"));
    check(
      "E-GATE",
      "exact schema/ownership/grants/functions match reviewed shape",
      JSON.stringify(actual) === JSON.stringify(expected),
    );
    for (const mutation of [
      `grant select on ${table} to anon`,
      `alter table ${table} disable row level security`,
      `alter table ${table} disable trigger user`,
      `alter function ${root===ROOT?"hardware_financial_list(text)":"hardware_recovery_claim(text)"} security definer`,
      `grant execute on function ${root===ROOT?"hardware_financial_list(text)":"hardware_recovery_claim(text)"} to anon`,
    ]) {
      const altered = JSON.parse(
        sql("begin;" + mutation + ";" + shape + ";rollback;"),
      );
      check(
        "E-TAMPER",
        "gate detects " + mutation,
        JSON.stringify(altered) !== JSON.stringify(expected),
      );
    }
  }

  run(
    "update admin_users set permission_scopes=permission_scopes||array['commerce.orders.refund.request','commerce.orders.refund.approve'] where email in ('creator@fixture.test','reader@fixture.test')",
  );
  const { HardwareRecovery } = require(
    path.join(backend, "dist/commerce/hardwareRecovery"),
  );
  let posts = 0,
    timeout = false,
    providerRefunds = [],
    refundStatus = "processed",
    partial = false,
    disputed = false;
  const provider = {
    get: async (url) => {
      if (url.startsWith("/transaction/")) return deps.provider.get(url);
      if (url.startsWith("/dispute/"))
        return { data: { status: true, data: disputed ? [{ id: 1 }] : [] } };
      if (url.startsWith("/refund?"))
        return { data: { status: true, data: providerRefunds } };
      return {
        data: {
          status: true,
          data: providerRefunds.find(
            (r) => String(r.id) === url.split("/").pop(),
          ),
        },
      };
    },
    post: async (url, p) => {
      if (url !== "/refund") throw Error("unexpected endpoint");
      posts++;
      const a = await deps.get(p.transaction);
      const r = {
        id: 9000 + posts,
        transaction: Number(a.provider_id),
        amount: partial ? p.amount - 1 : p.amount,
        currency: "NGN",
        domain: "test",
        status: refundStatus,
        merchant_note: p.merchant_note,
      };
      providerRefunds.push(r);
      if (timeout) throw Error("timeout");
      return { data: { status: true, data: r } };
    },
  };
  const d = {
    ...deps,
    provider,
    refundsEnabled: true,
    approvals: async () => [],
    refundsDue: async () => [],
    outbox: async () => [],
    deliverObservation: async () => {},
  };
  const recovery = new HardwareRecovery(d);
  const paid = async () => {
    const a = auth(make());
    await service.initialize(a);
    await service.reconcile(a.reference);
    return a;
  };
  const approval = async (a) => {
    const request = JSON.parse(
      run(
        `select hardware_refund_request('creator@fixture.test','${a.order_id}','LOCAL synthetic refund verification')`,
      ),
    );
    check(
      "E-SELF",
      "self approval refused",
      psql(
        `select hardware_refund_approve('creator@fixture.test','${request.id}')`,
      ).status !== 0,
    );
    run(
      `select hardware_refund_approve('reader@fixture.test','${request.id}')`,
    );
    return {
      approval_id: request.id,
      order_id: a.order_id,
      reference: a.reference,
      amount_kobo: a.amount_kobo,
      requested_by: "creator@fixture.test",
      approved_by: "reader@fixture.test",
    };
  };
  const pending = auth(make());
  await service.initialize(pending);
  providerResults.get(pending.reference).status = "pending";
  // Test clock only: fixture owner changes created_at by disabling guard transactionally.
  bsql(
    `begin;alter table hardware_payment_attempts disable trigger user;update hardware_payment_attempts set created_at=now()-interval '31 minutes' where reference='${pending.reference}';alter table hardware_payment_attempts enable trigger user;commit;`,
  );
  await recovery.reconcile(pending.reference);
  check(
    "E-OVERDUE",
    "pending beyond expected completion recorded",
    bsql(
      `select count(*)>0 from hardware_payment_observations where reference='${pending.reference}' and state='pending_overdue'`,
    ) === "t",
  );
  providerResults.get(pending.reference).status = "failed";
  await recovery.reconcile(pending.reference);
  check(
    "E-PROVIDER-FAIL",
    "provider failure observed without false paid fact",
    bsql(
      `select count(*)>0 from hardware_payment_observations where reference='${pending.reference}' and state='provider_failed'`,
    ) === "t",
  );
  const a = await paid(),
    ap = await approval(a);
  check('E-SUPER-SELF','super-admin cannot self approve',psql(`begin;update admin_users set role='super_admin' where email='creator@fixture.test';select hardware_refund_approve('creator@fixture.test','${ap.approval_id}');rollback;`).status!==0);
  check(
    "E-DENY",
    "unprivileged refund denied",
    psql(
      `select hardware_refund_request('none@fixture.test','${a.order_id}','LOCAL unauthorized test')`,
    ).status !== 0,
  );
  const before = posts;
  await Promise.all([
    recovery.refund(ap),
    recovery.refund(ap),
    recovery.refund(ap),
  ]);
  check(
    "E-CONCURRENT",
    "simultaneous refunds issue one provider request",
    posts === before + 1,
  );
  check(
    "E-PROCESSED",
    "verified exact refund is processed",
    bsql(
      `select state from hardware_refunds where approval_id='${ap.approval_id}'`,
    ) === "processed",
  );
  await recovery.refund(ap);
  check(
    "E-REPLAY",
    "processed refund replay makes no provider request",
    posts === before + 1,
  );
  const b = await paid(),
    bp = await approval(b);
  timeout = true;
  await recovery.refund(bp);
  timeout = false;
  check(
    "E-TIMEOUT",
    "unknown provider outcome persisted",
    bsql(
      `select state from hardware_refunds where approval_id='${bp.approval_id}'`,
    ) === "uncertain",
  );
  const count = posts;
  await new HardwareRecovery(d).refund(bp);
  check(
    "E-RESTART",
    "restart recovers provider record without repeating POST",
    posts === count &&
      bsql(
        `select state from hardware_refunds where approval_id='${bp.approval_id}'`,
      ) === "processed",
  );
  const waiting = await paid(), wp = await approval(waiting);
  refundStatus='pending';await recovery.refund(wp);
  check('E-REFUND-PENDING','pending refund not falsely processed',bsql(`select state from hardware_refunds where approval_id='${wp.approval_id}'`)==='pending');
  providerRefunds.find(x=>x.merchant_note==='hardware-refund:'+wp.approval_id).status='processed';refundStatus='processed';
  const beforePoll=posts;await recovery.refund(wp);
  check('E-REFUND-POLL','provider lookup confirms refund without another initiation',posts===beforePoll&&bsql(`select state from hardware_refunds where approval_id='${wp.approval_id}'`)==='processed');
  const c = await paid(),
    cp = await approval(c);
  partial = true;
  await recovery.refund(cp);
  partial = false;
  check(
    "E-PARTIAL",
    "partial refund escalated, not processed",
    bsql(
      `select state from hardware_refunds where approval_id='${cp.approval_id}'`,
    ) === "escalated",
  );
  const f = await paid(),
    fp = await approval(f);
  refundStatus = "failed";
  await recovery.refund(fp);
  refundStatus = "processed";
  check(
    "E-FAILED",
    "failed provider refund escalated",
    bsql(
      `select state from hardware_refunds where approval_id='${fp.approval_id}'`,
    ) === "escalated",
  );
  const g = await paid(),
    gp = await approval(g);
  disputed = true;
  const n = posts;
  await recovery.refund(gp);
  disputed = false;
  check(
    "E-DISPUTE",
    "disputed payment cannot automatically refund",
    posts === n &&
      bsql(
        `select state from hardware_refunds where approval_id='${gp.approval_id}'`,
      ) === "escalated",
  );
  await recovery.reconcile(a.reference);
  check(
    "E-RECOVERY",
    "confirmed payment independently reverified",
    bsql(
      `select count(*)>0 from hardware_payment_observations where reference='${a.reference}' and state='provider_success'`,
    ) === "t",
  );
  const observations = JSON.parse(
    bsql(
      "select json_agg(json_build_object('event_id',o.id,'reference',o.reference,'order_id',a.order_id,'amount_kobo',a.amount_kobo,'environment',a.environment,'state',o.state,'evidence',o.evidence)) from hardware_payment_observations o join hardware_payment_attempts a using(reference)",
    ),
  );
  for (const e of observations)
    run(`select hardware_financial_observe(${quote(e)})`);
  const e = observations[0];
  run(`select hardware_financial_observe(${quote(e)})`);
  check(
    "E-OUTBOX",
    "altered event replay rejected",
    psql(
      `select hardware_financial_observe(${quote({ ...e, state: "provider_failed" })})`,
    ).status !== 0,
  );
  check(
    "E-HISTORY",
    "Office financial facts immutable",
    psql("delete from hardware_financial_observations").status !== 0,
  );
  let denied = false;
  try {
    bsql("delete from hardware_refund_events");
  } catch {
    denied = true;
  }
  check("E-IMMUTABLE", "Backend refund history immutable", denied);
  for (const role of ["anon", "authenticated"]) {
    check(
      "E-RLS",
      "Office " + role + " denied",
      psql(`set role ${role};select * from hardware_refund_requests`).status !==
        0,
    );
    let no = false;
    try {
      bsql(`set role ${role};select * from hardware_refunds`);
    } catch {
      no = true;
    }
    check("E-RLS", "Backend " + role + " denied", no);
  }
  const raw = Buffer.from(
    JSON.stringify({
      event: "refund.processed",
      data: { transaction_reference: a.reference },
    }),
  );
  const sig = crypto
    .createHmac("sha512", deps.secret)
    .update(raw)
    .digest("hex");
  await service.webhook(raw, sig);
  await service.webhook(raw, sig);
  check(
    "E-REFUND-WEBHOOK",
    "duplicate refund webhook durably deduplicated",
    bsql(
      `select count(*) from hardware_payment_inbox where reference='${a.reference}' and event_type='refund.processed'`,
    ) === "1",
  );
  const safe = JSON.parse(
    run(
      `select hardware_payment_quote('payment-test','${"a".repeat(64)}','${a.order_id}')`,
    ),
  );
  check(
    "E-GUEST",
    "guest sees refund label without staff/provider data",
    safe.refund_state === "refund_processed" &&
      !JSON.stringify(safe).includes("fixture.test") &&
      !("evidence" in safe),
  );
  check(
    "E-NOTIFY",
    "refund review creates targeted notification",
    Number(
      one(
        `select count(*) from notifications where related_id='${a.order_id}' and recipient_email is not null`,
      ),
    ) > 0,
  );
  check(
    "E-ROLLBACK-PROTECT",
    "rollback refuses to erase financial history",
    psql(
      fs.readFileSync(path.join(ROOT, "release/phase4e/rollback.sql"), "utf8"),
    ).status !== 0,
  );
  check(
    "E-FINANCIAL-FACT",
    "refund leaves original paid fact intact",
    one(
      `select payment_state from hardware_orders where id='${a.order_id}'`,
    ) === "paid",
  );
  run(
    `select hardware_reservation_finish('${pending.order_id}','released','fixture','Isolated pending-payment cleanup')`,
  );
  if(process.env.TEST_BOUNDED_EXECUTOR==='true') await require(path.join(backend,'scripts/test-bounded-executor-cases.js'))({run,one,check,bsql,rpc,backend,make,auth,deps,quote});
};
