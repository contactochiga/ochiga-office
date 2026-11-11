"""Refund request/approval through the REAL service_role privilege path (local only; synthetic accepted snapshot).

Usage: python3 scripts/test-refund-lock-compat-postgres.py <accepted synthetic pg_dump>

Restores the snapshot into a disposable database on an internal-only Docker network (no host port, no internet), with PostgREST and a
throwaway Node client on the same network. Nothing reaches a provider, mail service, Backend or production. The snapshot file is only
read (its SHA-256 is checked before and after). Every container and the network are removed at the end.

Proves, as service_role (SET ROLE and PostgREST RPC with a service_role JWT, i.e. the privileges Office really has):
  * the 2 Nov defect: hardware_refund_request fails with "permission denied" before the fix;
  * after db/commerce/20261104090000_hardware_refund_lock_compat.sql: request creation, independent reviewer approval, genuine audit
    timestamps, idempotent retries, conflict answers, self-approval refusal, scope separation, and a real concurrent race (one row,
    both callers answered with it);
  * no table privilege, RLS setting or immutability trigger changed; the payment confirmations are byte-identical;
  * the rollback restores the previous definitions (and with them the defect).
"""
import sys, subprocess, time, secrets, json, hashlib, base64, hmac, threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIX = ROOT / 'db/commerce/20261104090000_hardware_refund_lock_compat.sql'
GATE = ROOT / 'release/commerce/refund-lock-gate.sql'
DOWN = ROOT / 'db/rollback/20261104090000_hardware_refund_lock_compat.down.sql'
TAG = secrets.token_hex(4)
NET, PG, REST, CLIENT = f'refund-lock-net-{TAG}', f'refund-lock-pg-{TAG}', f'refund-lock-rest-{TAG}', f'refund-lock-client-{TAG}'
JWT_SECRET = secrets.token_hex(32)
AUTH_PW = secrets.token_hex(16)
REQUESTER, REVIEWER, OTHER_REVIEWER = 'refund-request.lock@fixture.test', 'refund-review.lock@fixture.test', 'refund-review2.lock@fixture.test'
n = 0
results = []


def call(*a, input=None, check=True):
    r = subprocess.run(a, input=input, capture_output=True)
    if check and r.returncode:
        raise RuntimeError(r.stderr.decode()[:900])
    return r


def sql(s, fail=False, role=None):
    prefix = f'set role {role};' if role else ''
    r = call('docker', 'exec', '-i', PG, 'psql', '-X', '-Atq', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', input=(prefix + s).encode(), check=not fail)
    return r if fail else r.stdout.decode().strip()


def ok(v, label, detail=None):
    global n
    results.append({'check': label, 'passed': bool(v)})
    if not v:
        raise AssertionError(f'{label} :: {detail}')
    n += 1
    print('PASS ' + label, flush=True)


def q(v):
    return "'" + str(v).replace("'", "''") + "'"


def jwt(role):
    b = lambda d: base64.urlsafe_b64encode(json.dumps(d, separators=(',', ':')).encode()).rstrip(b'=').decode()
    head, body = b({'alg': 'HS256', 'typ': 'JWT'}), b({'role': role, 'exp': int(time.time()) + 3600})
    sig = base64.urlsafe_b64encode(hmac.new(JWT_SECRET.encode(), f'{head}.{body}'.encode(), hashlib.sha256).digest()).rstrip(b'=').decode()
    return f'{head}.{body}.{sig}'


def rpc(fn, args, role='service_role'):
    """POST /rpc/<fn> to PostgREST from a container on the internal network; returns (status, json)."""
    js = (f"fetch('http://{REST}:3000/rpc/{fn}',{{method:'POST',headers:{{'content-type':'application/json',authorization:'Bearer {jwt(role)}'}},"
          f"body:JSON.stringify({json.dumps(args)})}}).then(async r=>{{console.log(JSON.stringify({{status:r.status,body:await r.text()}}))}})")
    out = call('docker', 'exec', CLIENT, 'node', '-e', js).stdout.decode().strip()
    o = json.loads(out)
    try:
        body = json.loads(o['body'])
    except Exception:
        body = o['body']
    return o['status'], body


def hashes():
    return sql("select jsonb_build_object("
               "'confirmations',(select md5(coalesce(jsonb_agg(to_jsonb(x) order by reference),'[]')::text) from hardware_payment_confirmations x),"
               "'authorizations',(select md5(coalesce(jsonb_agg(to_jsonb(x) order by reference),'[]')::text) from hardware_payment_authorizations x),"
               "'orders',(select md5(coalesce(jsonb_agg(to_jsonb(x) order by id),'[]')::text) from hardware_orders x))")


def privileges():
    return sql("select jsonb_object_agg(t, jsonb_build_object('update',has_table_privilege('service_role',t,'UPDATE'),'delete',has_table_privilege('service_role',t,'DELETE'),"
               "'select',has_table_privilege('service_role',t,'SELECT'),'insert',has_table_privilege('service_role',t,'INSERT'),"
               "'rls',(select relrowsecurity from pg_class where oid=t::regclass))) from unnest(array['hardware_payment_confirmations','hardware_refund_requests',"
               "'hardware_refund_decisions','hardware_financial_observations','hardware_payment_history']) t")


try:
    dump = Path(sys.argv[1])
    original = hashlib.sha256(dump.read_bytes()).hexdigest()
    call('docker', 'network', 'create', '--internal', NET)
    call('docker', 'run', '-d', '--rm', '--name', PG, '--network', NET, '--pull', 'never', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:17.6-alpine')
    for _ in range(100):
        if call('docker', 'exec', PG, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', check=False).returncode == 0:
            break
        time.sleep(.15)
    time.sleep(1)
    sql(f"create role supabase_admin nologin;create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;"
        f"create role authenticator login noinherit password {q(AUTH_PW)};grant anon, authenticated, service_role to authenticator;")
    raw = call('docker', 'exec', '-i', PG, 'pg_restore', '--no-owner', '--file=-', input=dump.read_bytes()).stdout
    sql(raw.decode())
    ok(True, 'accepted synthetic snapshot restored into a disposable database on an internal-only network (no host port)')
    sql("grant usage on schema public to anon, authenticated, service_role;")
    call('docker', 'run', '-d', '--rm', '--name', REST, '--network', NET, '--pull', 'never',
         '-e', f'PGRST_DB_URI=postgres://authenticator:{AUTH_PW}@{PG}:5432/postgres', '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_ANON_ROLE=anon',
         '-e', f'PGRST_JWT_SECRET={JWT_SECRET}', 'public.ecr.aws/supabase/postgrest:v14.12')
    call('docker', 'run', '-d', '--rm', '--name', CLIENT, '--network', NET, '--pull', 'never', 'node:22-bookworm-slim', 'sleep', '900')
    for _ in range(100):
        probe = call('docker', 'exec', CLIENT, 'node', '-e', f"fetch('http://{REST}:3000/').then(r=>console.log(r.status)).catch(()=>console.log(0))", check=False).stdout.decode().strip()
        if probe and probe != '0':
            break
        time.sleep(.3)
    ok(probe not in ('', '0'), 'PostgREST (the API Office uses) reachable only inside the internal network', probe)
    before_hashes, before_priv = hashes(), privileges()
    paid = json.loads(sql("select coalesce(jsonb_agg(order_id order by order_id),'[]') from hardware_payment_confirmations c where not exists(select 1 from hardware_refund_requests r where r.order_id=c.order_id) and not exists(select 1 from hardware_financial_observations f where f.order_id=c.order_id and f.state in ('disputed','dispute_review','reversed_unreconciled','amount_mismatch'))"))
    ok(len(paid) >= 1, 'snapshot has a verified payment without a refund request or dispute to rehearse against', paid)
    oid = paid[0]
    ok(sql('select count(*) from hardware_refund_requests') == '0' and sql('select count(*) from hardware_refund_decisions') == '0', 'starting state: 0 refund requests and 0 decisions (pre-refund snapshot)')

    # synthetic staff with EXACT scopes (same shape as the two-account rehearsal; no super_admin)
    for email, scope in [(REQUESTER, 'commerce.orders.refund.request'), (REVIEWER, 'commerce.orders.refund.approve'), (OTHER_REVIEWER, 'commerce.orders.refund.approve')]:
        sql(f"insert into admin_users(email,password_hash,role,status,permission_scopes) values ({q(email)},'disabled-no-login','ochiga_staff','active',array['commerce.orders.read',{q(scope)}])")

    # 1. the defect, reproduced through the real privilege path
    fail = sql(f"select hardware_refund_request({q(REQUESTER)},{q(oid)},'Synthetic lock-compat check')", fail=True, role='service_role')
    ok(fail.returncode != 0 and b'permission denied for table hardware_payment_confirmations' in fail.stderr, 'BEFORE the fix: service_role request fails with permission denied on hardware_payment_confirmations (the 2 Nov root cause)', fail.stderr[:300])
    ok(sql('select count(*) from hardware_refund_requests') == '0', '...and nothing was written')

    # 2. migration: transactional, idempotent, privileges untouched
    sql('begin;' + FIX.read_text() + 'rollback;')
    ok(sql("select prosrc not ilike '%for update%' from pg_proc where oid='hardware_refund_request(text,uuid,text)'::regprocedure") == 'f', 'migration inside a rolled-back transaction leaves the old definition')
    sql('begin;' + FIX.read_text() + 'commit;')
    sql('begin;' + FIX.read_text() + 'commit;')
    defs = json.loads(sql("select jsonb_object_agg(proname, jsonb_build_object('rowlock', prosrc ~* 'for (update|share|no key update|key share)','advisory', prosrc ilike '%pg_advisory_xact_lock%','secdef',prosecdef,'config',proconfig,"
                          "'anon',has_function_privilege('anon',oid,'EXECUTE'),'auth',has_function_privilege('authenticated',oid,'EXECUTE'),'service',has_function_privilege('service_role',oid,'EXECUTE'))) "
                          "from pg_proc where oid in ('hardware_refund_request(text,uuid,text)'::regprocedure,'hardware_refund_approve(text,uuid)'::regprocedure)"))
    ok(all(not d['rowlock'] and d['advisory'] and not d['secdef'] and d['config'] == ['search_path=public, pg_temp'] and not d['anon'] and not d['auth'] and d['service'] for d in defs.values()),
       'after the fix (applied twice, idempotent): no row lock, advisory lock instead; still SECURITY INVOKER, pinned search_path, EXECUTE service_role only', defs)
    gate = sql(GATE.read_text())
    ok('FAIL' not in gate and gate.count('PASS') == 4, 'release gate refund-lock-gate.sql: every row PASS after the fix', gate)
    ok(privileges() == before_priv, 'NO privilege widened: service_role still has no UPDATE/DELETE on confirmations, refund requests/decisions, observations or history; RLS unchanged', privileges())

    # 3. request creation through PostgREST as service_role (the path Office uses)
    t0 = sql("select now()")
    s, req = rpc('hardware_refund_request', {'p_actor': REQUESTER, 'p_order': oid, 'p_reason': 'Synthetic lock-compat check'})
    ok(s == 200 and req.get('order_id') == oid and req.get('requested_by') == REQUESTER and req.get('amount_kobo') > 0, 'service_role HTTP (PostgREST RPC): requester creates the refund request (200)', (s, req))
    s2, req2 = rpc('hardware_refund_request', {'p_actor': REQUESTER, 'p_order': oid, 'p_reason': 'Synthetic lock-compat check'})
    ok(s2 == 200 and req2['id'] == req['id'] and req2['created_at'] == req['created_at'], 'retry of the same request is idempotent: same id and the ORIGINAL created_at, no second row', (s2, req2))
    s3, c3 = rpc('hardware_refund_request', {'p_actor': REQUESTER, 'p_order': oid, 'p_reason': 'A different synthetic reason'})
    ok(s3 >= 400 and 'refund_request_conflict' in json.dumps(c3), 'a changed retry is refused (refund_request_conflict)', (s3, c3))
    s4, c4 = rpc('hardware_refund_request', {'p_actor': REVIEWER, 'p_order': oid, 'p_reason': 'Synthetic lock-compat check'})
    ok(s4 >= 400 and 'forbidden' in json.dumps(c4), 'scope separation: the reviewer cannot create a request', (s4, c4))
    s5, c5 = rpc('hardware_refund_request', {'p_actor': REQUESTER, 'p_order': oid, 'p_reason': 'Synthetic lock-compat check'}, role='anon')
    ok(s5 in (401, 403, 404), 'anonymous role cannot call the refund function at all', (s5, c5))

    # 4. approval
    s6, c6 = rpc('hardware_refund_approve', {'p_actor': REQUESTER, 'p_id': req['id']})
    ok(s6 >= 400 and 'forbidden' in json.dumps(c6), 'scope separation: the requester cannot approve (no approval scope)', (s6, c6))
    sql(f"update admin_users set permission_scopes=permission_scopes||array['commerce.orders.refund.approve'] where email={q(REQUESTER)}")
    s7, c7 = sql(f"select hardware_refund_approve({q(REQUESTER)},{q(req['id'])})", fail=True, role='service_role').returncode, None
    sql(f"update admin_users set permission_scopes=array_remove(permission_scopes,'commerce.orders.refund.approve') where email={q(REQUESTER)}")
    ok(s7 != 0, 'self-approval guard executes: even holding the approval scope, the requester cannot approve their own request')
    s8, dec = rpc('hardware_refund_approve', {'p_actor': REVIEWER, 'p_id': req['id']})
    ok(s8 == 200 and dec.get('request_id') == req['id'] and dec.get('approved_by') == REVIEWER, 'service_role HTTP: the independent reviewer approves (200)', (s8, dec))
    s9, dec2 = rpc('hardware_refund_approve', {'p_actor': REVIEWER, 'p_id': req['id']})
    ok(s9 == 200 and dec2['created_at'] == dec['created_at'], 'retry of the approval is idempotent: the ORIGINAL decision timestamp, no second decision', (s9, dec2))
    s10, c10 = rpc('hardware_refund_approve', {'p_actor': OTHER_REVIEWER, 'p_id': req['id']})
    ok(s10 >= 400 and 'refund_already_approved' in json.dumps(c10), 'a second, different approver is refused (refund_already_approved)', (s10, c10))

    # 5. audit timestamps: genuine database clock values, ordered, one of each
    audit = json.loads(sql("select jsonb_build_object("
                           f"'request',(select to_jsonb(r) from hardware_refund_requests r where id={q(req['id'])}),"
                           f"'decision',(select to_jsonb(d) from hardware_refund_decisions d where request_id={q(req['id'])}),"
                           f"'history',(select jsonb_agg(jsonb_build_object('event',event_type,'actor',actor,'at',created_at) order by created_at) from hardware_payment_history where order_id={q(oid)} and event_type in ('refund_requested','refund_approved')),"
                           f"'audit',(select jsonb_agg(jsonb_build_object('action',action,'actor',actor_email,'at',created_at) order by created_at) from audit_events where target_id={q(oid)} and action in ('hardware_payment_refund_requested','hardware_payment_refund_approved')),"
                           f"'notifications',(select jsonb_agg(jsonb_build_object('reason',reason,'to',recipient_email)) from notifications where related_id={q(oid)} and reason like 'hardware_refund_%'),"
                           f"'t0',{q(t0)}::timestamptz,'now',now())"))
    hist = audit['history'] or []
    ok(len(hist) == 2 and [h['event'] for h in hist] == ['refund_requested', 'refund_approved'] and hist[0]['actor'] == REQUESTER and hist[1]['actor'] == REVIEWER,
       'payment history: exactly one refund_requested (requester) and one refund_approved (reviewer) despite the retries', hist)
    ok(audit['request']['created_at'] >= audit['t0'] and audit['decision']['created_at'] >= audit['request']['created_at'] and audit['decision']['created_at'] <= audit['now'],
       'timestamps are genuine and ordered: request after test start, decision after request, both before now (database clock, nothing supplied)', {k: audit[k] for k in ('t0', 'now')})
    ok(len(audit['audit'] or []) == 2 and {a['actor'] for a in audit['audit']} == {REQUESTER, REVIEWER}, 'audit_events: one requested + one approved entry with the right actors', audit['audit'])
    notes = audit['notifications'] or []
    ok(any(x['reason'] == 'hardware_refund_review' and x['to'] != REQUESTER for x in notes) and any(x['reason'] == 'hardware_refund_approved' and x['to'] == REQUESTER for x in notes),
       'internal Office inbox notifications only (review to approvers, approval to requester); no customer or external message', notes)

    # 6. concurrency: two service_role callers race on a fresh order -> one row, both answered with it, no unique_violation
    if len(paid) > 1:
        oid2 = paid[1]
        outs = [None, None]

        def racer(i):
            p = subprocess.run(['docker', 'exec', '-i', PG, 'psql', '-X', '-Atq', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'],
                               input=f"begin;set role service_role;select hardware_refund_request({q(REQUESTER)},{q(oid2)},'Synthetic race check')->>'id';select pg_sleep(1.5);commit;".encode(), capture_output=True)
            outs[i] = (p.returncode, p.stdout.decode().split('\n')[0].strip(), p.stderr.decode()[:200])
        th = [threading.Thread(target=racer, args=(i,)) for i in range(2)]
        start = time.time()
        th[0].start(); time.sleep(0.3); th[1].start()
        for t in th:
            t.join()
        took = time.time() - start
        ok(outs[0][0] == 0 and outs[1][0] == 0 and outs[0][1] == outs[1][1] and sql(f"select count(*) from hardware_refund_requests where order_id={q(oid2)}") == '1' and took >= 2.8,
           f'concurrent requests are serialized by the advisory lock: both succeed with the SAME id, one row, second waited ({took:.1f}s)', outs)
    else:
        ok(True, 'concurrency check skipped: snapshot has only one eligible paid order (documented, not counted as a race proof)')

    # 7. preservation and immutability
    ok(hashes() == before_hashes, 'payment confirmations, authorizations and orders are byte-identical to the snapshot (no financial evidence modified)')
    upd = sql(f"update hardware_refund_requests set reason='tamper' where id={q(req['id'])}", fail=True)
    ok(upd.returncode != 0, 'immutability trigger still refuses UPDATE of a refund request (even as the database owner)', upd.stderr[:200])
    ok(sql(f"update hardware_payment_confirmations set amount_kobo=amount_kobo where order_id={q(oid)}", fail=True, role='service_role').returncode != 0, 'service_role still cannot UPDATE payment confirmations')

    # 8. rollback restores the previous definition (and with it the defect)
    sql('begin;' + DOWN.read_text() + 'commit;')
    third = paid[2] if len(paid) > 2 else None
    if third:
        back = sql(f"select hardware_refund_request({q(REQUESTER)},{q(third)},'Synthetic rollback check')", fail=True, role='service_role')
        ok(back.returncode != 0 and b'permission denied' in back.stderr, 'rollback restores the phase 4e definition exactly (the row-lock defect returns)', back.stderr[:200])
    else:
        ok(sql("select prosrc ilike '%for update%' from pg_proc where oid='hardware_refund_request(text,uuid,text)'::regprocedure") == 't', 'rollback restores the phase 4e definition (row lock present again)')
    ok(privileges() == before_priv, 'privileges identical after rollback')
    ok('FAIL' in sql(GATE.read_text()), 'release gate detects the rolled-back (row-lock) definition')
finally:
    for c in (CLIENT, REST, PG):
        call('docker', 'rm', '-f', c, check=False)
    call('docker', 'network', 'rm', NET, check=False)
    if len(sys.argv) > 1:
        after = hashlib.sha256(Path(sys.argv[1]).read_bytes()).hexdigest()
        print(json.dumps({'snapshot_sha256_unchanged': after == original if 'original' in dir() else None}))
print(json.dumps({'suite': 'refund-lock-compat-postgres', 'passed': n, 'provider_requests': 0, 'external_messages': 0, 'production_connections': 0}))
