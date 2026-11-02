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

  const quoteReasons = fs.readFileSync(
    path.join(ROOT, "db/phase4f/20261026143000_hardware_payment_quote_reasons.sql"),
    "utf8",
  );
  run("begin;" + quoteReasons + "rollback;");
  const rollbackState = psql("select (to_regprocedure('hardware_payment_quote(text,text,uuid)') is not null)::text||':'||(to_regclass('hardware_financial_observations') is not null)::text");
  check(
    "F-ROLLBACK",
    "quote-diagnostic migration rolls back without removing Phase 4E objects",
    rollbackState.status === 0 && rollbackState.out === "true:true",
    rollbackState.out || rollbackState.err,
  );
  const quoteRollback = psql(
    "begin;" + quoteReasons + fs.readFileSync(path.join(ROOT, "db/phase4f/rollback.sql"), "utf8") +
    "select (pg_get_functiondef('hardware_payment_quote(text,text,uuid)'::regprocedure) like '%refund_state%') and (pg_get_functiondef('hardware_payment_quote(text,text,uuid)'::regprocedure) not like '%eligibility_code%');rollback;",
  );
  check(
    "F-DOWN",
    "forward and rollback restore the Phase 4E quote projection",
    quoteRollback.status === 0 && quoteRollback.out === "t",
    quoteRollback.err,
  );
  run(quoteReasons);
  const quoteAcl=psql("select (has_function_privilege('anon','hardware_payment_quote(text,text,uuid)','execute') is false)::text||':'||(has_function_privilege('authenticated','hardware_payment_quote(text,text,uuid)','execute') is false)::text||':'||has_function_privilege('service_role','hardware_payment_quote(text,text,uuid)','execute')::text||':'||(select proconfig @> array['search_path=public, pg_temp'] from pg_proc where oid='hardware_payment_quote(text,text,uuid)'::regprocedure)::text");
  check(
    "F-ACL",
    "quote diagnostics remain service-role-only with a fixed search path",
    quoteAcl.status === 0 && quoteAcl.out === "true:true:true:true",
    quoteAcl.out || quoteAcl.err,
  );
  const quoteGate=fs.readFileSync(path.join(ROOT,"release/phase4f/security-gate.sql"),"utf8");
  check("F-GATE","Phase 4F owner, invoker, path, grants and Phase 4E delegation gate passes",psql(quoteGate).out==="PASS");
  check("F-TAMPER","Phase 4F gate rejects public execution grant",psql("begin;grant execute on function hardware_payment_quote(text,text,uuid) to anon;"+quoteGate+"rollback;").out==="FAIL");
  // Exact schema: the reviewed Phase 4E shape with only the two pinned Phase 4F quote differences (release/phase4f/verify-shape.py).
  const shapeSql=fs.readFileSync(path.join(ROOT,"release/phase4e/shape.sql"),"utf8").trim().replace(/;\s*$/,"");
  const verifyShape=(shapeOut)=>require("child_process").spawnSync("python3",[path.join(ROOT,"release/phase4f/verify-shape.py"),"--shape-json","-"],{input:shapeOut,encoding:"utf8"});
  const exact=verifyShape(psql(shapeSql+";").out);
  check("F-SHAPE","Phase 4F exact schema: reviewed Phase 4E shape plus only the pinned quote wrapper and the name-only renamed delegate",exact.status===0&&/"phase4f_exact_schema": "PASS"/.test(exact.stdout),exact.stdout.slice(0,400)||exact.stderr);
  // the original defect class: same logic, different formatting of the Phase 4E delegate, must be rejected (inside a rolled-back transaction)
  const reformatted=psql("begin;do $x$ declare d text; begin select pg_get_functiondef('public.hardware_financial_phase4e_quote(text,text,uuid)'::regprocedure) into d; execute replace(d,'begin',E'begin\\n'); end $x$;"+shapeSql+";rollback;");
  const tampered=verifyShape(reformatted.out);
  check("F-SHAPE-TAMPER","Phase 4F exact schema rejects a re-created delegate that differs only in formatting",tampered.status===1&&/"definition"/.test(tampered.stdout),tampered.stdout.slice(0,300)||reformatted.err);
  check("F-SHAPE-INTACT","…and the rolled-back tamper left the delegate exactly as reviewed",verifyShape(psql(shapeSql+";").out).status===0);
  const diagnosticCancelled=make();
  run(`select hardware_order_cancel('canceller@fixture.test','${diagnosticCancelled}',1)`);
  const cancelEventsBefore=one(`select count(*) from hardware_reservation_events e join hardware_reservations r on r.id=e.reservation_id where r.order_id='${diagnosticCancelled}'`);
  const cancelQuote=JSON.parse(run(`select hardware_payment_quote('payment-test','${'a'.repeat(64)}','${diagnosticCancelled}'::uuid)`));
  const cancelEventsAfter=one(`select count(*) from hardware_reservation_events e join hardware_reservations r on r.id=e.reservation_id where r.order_id='${diagnosticCancelled}'`);
  check(
    "F-CANCEL-REASON",
    "owned cancelled-order quote returns an allowlisted reason without changing reservation history",
    cancelQuote.eligible===false&&cancelQuote.eligibility_code==='order_cancelled'&&cancelEventsBefore===cancelEventsAfter,
  );
  // The earlier D expiry fixture has since been reconciled and is therefore
  // correctly classified as payment-already-started. Use a fresh, unattempted
  // hold so this assertion specifically exercises reservation expiry.
  const diagnosticExpired=make(true,60);
  await new Promise(resolve=>setTimeout(resolve,62000));
  const expiryEventsBefore=one(`select count(*) from hardware_reservation_events e join hardware_reservations r on r.id=e.reservation_id where r.order_id='${diagnosticExpired}'`);
  const expiryQuote=JSON.parse(run(`select hardware_payment_quote('payment-test','${'a'.repeat(64)}','${diagnosticExpired}'::uuid)`));
  const expiryEventsAfter=one(`select count(*) from hardware_reservation_events e join hardware_reservations r on r.id=e.reservation_id where r.order_id='${diagnosticExpired}'`);
  check(
    "F-EXPIRED-REASON",
    "expired reservation quote returns a reason without mutating reservation history",
    expiryQuote.eligible===false&&expiryQuote.eligibility_code==='reservation_expired'&&expiryEventsBefore===expiryEventsAfter,
  );

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
