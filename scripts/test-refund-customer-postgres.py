"""Local-only migration/ownership/notification regression. No network, provider, or historical writes.
Usage: python3 scripts/test-refund-customer-postgres.py <accepted synthetic pg_dump>
Restores the supplied snapshot into a disposable network-none database and removes only that container.
"""
import sys,subprocess,time,secrets,json,hashlib
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];name='refund-regression-'+secrets.token_hex(4);n=0
M=ROOT/'db/commerce/20261101120350_hardware_refund_customer_completion.sql';D=ROOT/'db/rollback/20261101120350_hardware_refund_customer_completion.down.sql'
def call(*a,input=None,check=True):
 r=subprocess.run(a,input=input,capture_output=True)
 if check and r.returncode:raise RuntimeError(r.stderr.decode()[:900])
 return r

def sql(s,fail=False):
 r=call('docker','exec','-i',name,'psql','-X','-Atq','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1',input=s.encode(),check=not fail)
 return r if fail else r.stdout.decode().strip()
def ok(v,label):
 global n
 assert v,label;n+=1;print('PASS '+label,flush=True)
def q(v):return "'"+str(v).replace("'","''")+"'"
def observe(event,state,evidence):
 p=dict(event_id=event,state=state,evidence=evidence,reference=ref,order_id=oid,amount_kobo=10000,environment='test')
 return "select hardware_financial_observe("+q(json.dumps(p))+"::jsonb);"
try:
 dump=Path(sys.argv[1]);original=hashlib.sha256(dump.read_bytes()).hexdigest()
 call('docker','run','-d','--rm','--name',name,'--network','none','--pull','never','-e','POSTGRES_HOST_AUTH_METHOD=trust','postgres:17.6-alpine')
 for _ in range(80):
  if call('docker','exec',name,'pg_isready','-h','127.0.0.1','-U','postgres',check=False).returncode==0:break
  time.sleep(.15)
 sql('create role supabase_admin nologin;create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;create role authenticator nologin;')
 raw=call('docker','exec','-i',name,'pg_restore','--no-owner','--file=-',input=dump.read_bytes()).stdout
 sql(raw.decode());ok(True,'accepted synthetic snapshot restored in network-none disposable database')
 before=sql("select md5(jsonb_agg(to_jsonb(x) order by reference)::text) from hardware_payment_confirmations x")
 sql('begin;'+M.read_text()+'rollback;');ok(sql("select to_regprocedure('hardware_refund_customer_status(uuid)') is null")=='t','transactional migration rollback')
 sql('begin;'+M.read_text()+'commit;');sql('begin;'+D.read_text()+'commit;');ok(sql("select to_regprocedure('hardware_refund_customer_status(uuid)') is null")=='t','pre-use down migration restores previous functions')
 sql('begin;'+M.read_text()+'commit;');ok(sql('begin;'+M.read_text()+'commit;',True).returncode!=0,'duplicate migration fails atomically without replacing historical functions')
 row=json.loads(sql("select row_to_json(x) from (select c.order_id,c.reference,c.provider_id,r.client,r.guest_hash from hardware_payment_confirmations c join hardware_checkout_receipts r on r.order_id=c.order_id where c.outcome='paid' and c.amount_kobo=10000 limit 1)x"));oid=row['order_id'];ref=row['reference']
 progress="select hardware_order_public_progress("+','.join(q(row[k]) for k in ('client','guest_hash','order_id'))+")"
 baseline=json.loads(sql(progress));ok('refund' not in baseline,'unchanged paid order before refund')
 ok(sql("select hardware_order_public_progress('wrong',repeat('0',64),"+q(oid)+")",True).returncode!=0,'wrong owner denied')
 ok(sql("set role anon;select hardware_refund_customer_status("+q(oid)+")",True).returncode!=0,'anonymous refund status denied')
 ok(sql("select bool_and(not prosecdef and proconfig @> array['search_path=public, pg_temp'] and not has_function_privilege('anon',oid,'execute') and not has_function_privilege('authenticated',oid,'execute')) from pg_proc where proname in ('hardware_refund_customer_status','hardware_order_public_progress','hardware_financial_list')")=='t','fixed search paths and service-only execution')
 for gate in ['customer-access-gate.sql','refund-completion-gate.sql']:
  ok('FAIL' not in sql((ROOT/'release/commerce'/gate).read_text()),'exact security gate '+gate)
 weakened=sql('begin;grant execute on function hardware_refund_customer_status(uuid) to anon;'+(ROOT/'release/commerce/refund-completion-gate.sql').read_text()+'rollback;')
 ok('FAIL' in weakened,'security gate detects unauthorized execution grant')
 # Synthetic independent staff; existing permission checks and APIs. No production users.
 actors=['refund-request@fixture.test','refund-approve@fixture.test']
 sql("insert into admin_users(email,password_hash,role,status,permission_scopes) values ('refund-request@fixture.test','disabled-no-login','super_admin','active',array['commerce.orders.read','commerce.orders.refund.request']),('refund-approve@fixture.test','disabled-no-login','ochiga_staff','active',array['commerce.orders.refund.approve']);")
 req=json.loads(sql("select hardware_refund_request("+q(actors[0])+','+q(oid)+",'Synthetic refund regression only')"));aid=req['id']
 ok(sql("select hardware_refund_approve("+q(actors[0])+','+q(aid)+")",True).returncode!=0,'super-admin self approval denied')
 sql("select hardware_refund_approve("+q(actors[1])+','+q(aid)+")")
 pending=dict(approval_id=aid,status='pending',amount_kobo=10000,currency='NGN',environment='test',transaction_id=row['provider_id'],refund_id='987654321')
 sql(observe(900000001,'refund_pending',pending));v=json.loads(sql(progress));ok(v['refund']['state']=='pending' and v['refund']['amount_kobo'] is None,'pending is not money returned')
 invalid={**pending,'status':'processed','amount_kobo':9999};ok(sql(observe(900000002,'refund_processed',invalid),True).returncode!=0,'mismatched amount cannot complete refund')
 invalid={**pending,'status':'processed','transaction_id':'999999999'};ok(sql(observe(900000002,'refund_processed',invalid),True).returncode!=0,'wrong provider transaction cannot complete refund')
 evidence={**pending,'status':'processed'};sql(observe(900000002,'refund_processed',evidence));sql(observe(900000002,'refund_processed',evidence));sql(observe(900000003,'refund_processed',evidence))
 v=json.loads(sql(progress));ok(v['kind']=='refunded' and v['refund']['amount_kobo']==10000,'verified full refund appears in owned customer view')
 ok(v['stages']==baseline['stages'],'payment and fulfilment history unchanged')
 ok(sql("select count(*) from hardware_customer_email_outbox where kind='refund_completed'")=='1','repeated equivalent events produce one refund-completed notification')
 ok(sql("select payload->>'refund_kobo' from hardware_customer_email_outbox where kind='refund_completed'")=='10000','notice uses exact verified refund amount')
 sql(observe(900000004,'refund_pending',pending));ok(json.loads(sql(progress))['kind']=='refunded','late pending cannot downgrade verified completion')
 view=json.loads(sql("select hardware_financial_list("+q(actors[0])+")"));ok(next(x for x in view if x['id']==oid)['financial_state']=='refund_processed','Office financial view retains authoritative completion')
 ok(sql("update hardware_financial_observations set state='refund_pending' where event_id=900000002",True).returncode!=0,'financial evidence immutable')
 ok(sql('begin;'+D.read_text()+'commit;',True).returncode!=0,'post-use destructive down migration refused')
 ok(sql("select md5(jsonb_agg(to_jsonb(x) order by reference)::text) from hardware_payment_confirmations x")==before,'accepted payment rows byte-equivalent')
 ok(hashlib.sha256(dump.read_bytes()).hexdigest()==original,'historical snapshot unchanged')
 print(f'RESULT {n}/{n} PASS; no provider or email traffic')
finally:call('docker','rm','-f',name,check=False)
