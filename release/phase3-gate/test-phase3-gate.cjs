'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const S7=process.env.S7_DIR || '/Users/ochigaidoko/s7-work';
process.env.SUT_DIR=S7;
const L=require(path.join(S7,'scripts/final-cert/C/lib'));
const office=path.resolve(__dirname,'../..');
const read=f=>fs.readFileSync(f,'utf8').trim().replace(/;\s*$/,'');
const G=read(path.join(__dirname,'production-rollout-gates.sql'));
const G2=read(path.join(__dirname,'phase2-base.sql'));
const migration=fs.readFileSync(path.join(office,'db/20261106_catalogue_merchandising.sql'),'utf8');
if(crypto.createHash('sha256').update(migration).digest('hex')!=='d78ef310b1417d7ca9ba134a7e024d9e5709000e0eac1135a9778474c0434e7c')throw Error('Migration hash changed');
const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'reviewed-shape.json')));
const transition=manifest.functions.find(f=>f.signature.startsWith('catalogue_merchandising_transition')).definition;
fs.mkdirSync(path.join(__dirname,'evidence'),{recursive:true});
const s=new L.Suite('phase3-gate','P3G');
const originalCheck=s.check.bind(s);s.check=(id,msg,ok,data)=>{if(ok)console.log('PASS '+id+' '+msg);return originalCheck(id,msg,ok,data);};
function q(st,sql){const r=L.sh('docker',['exec','-i',st.container,'psql','-X','-q','-At','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],{input:sql});return {status:r.status,out:r.stdout.trim(),err:r.stderr.trim()};}
function gate(st,sql=G,mutation=''){const r=q(st,`begin; ${mutation};\nselect jsonb_agg(t) from (${sql}) t; rollback;`);if(r.status)throw Error(r.err);const rows=JSON.parse(r.out.split('\n').filter(Boolean).pop());return {rows,verdict:rows.find(r=>r.gate.startsWith('VERDICT')).status,status:id=>rows.find(r=>r.gate.startsWith(id+' '))?.status};}
const rpc=(action,expected,actor,content='null')=>`select catalogue_merchandising_transition('${action}',${expected},${content},'${actor}','LOCAL TEST ONLY');`;
const empty=`'{"slides":[],"featured":[],"new_arrivals":[],"collections":[]}'::jsonb`;
s.main(async()=>{
 const st=await L.DbStack.create({tag:'p3gate',suite:s});
 const base=st.applyBase();const ms=st.applyMigrations(L.dbFiles().filter(f=>f.slice(0,8)<='20261018'));
 st.run('create index if not exists admin_invites_admin_user_id_idx on admin_invites(admin_user_id)');
 const hard=st.applyFile(path.join(S7,'docs/settings-domain/evidence/r11-production-catalog/ochiga_office_p0_access_hardening.sql'));
 const applied=['20261101_office_intake_receipts.sql','20261102_catalogue_foundation.sql','20261103_catalogue_archived_review_guard.sql','20261104_catalogue_media.sql','20261105_catalogue_public_release.sql'].map(f=>st.applyFile(path.join(office,'db',f)));
 if(base.secondErrors||ms.some(x=>x.status)||hard.status||applied.some(x=>x.status))throw Error('Production-shaped fixture failed');
 s.check('A1','production-shaped baseline prepared without production connections',true);
 const a=gate(st),old=gate(st,G2);
 s.check('A2','current production shape GO, P3 ABSENT',a.verdict==='GO'&&a.status('STAGE P3')==='ABSENT',a);
 s.check('A3','every existing Phase 0/1/2 gate row/status/detail preserved before migration',old.rows.filter(r=>!r.gate.startsWith('VERDICT')).every(r=>a.rows.some(n=>JSON.stringify(n)===JSON.stringify(r))));
 const tx=q(st,`begin;${migration}\nrollback;`);
 s.check('A4','transaction rollback leaves P3 wholly absent and baseline GO',tx.status===0&&gate(st).status('STAGE P3')==='ABSENT'&&gate(st).verdict==='GO');
 const apply=q(st,`begin;${migration}\ncommit;`);if(apply.status)throw Error(apply.err);
 const b=gate(st);s.check('B1','applied migration GO, all 15 baseline rows PASS, P3 APPLIED',b.verdict==='GO'&&b.status('STAGE P3')==='APPLIED'&&b.rows.filter(x=>/^B\d/.test(x.gate)&&x.status==='PASS').length===15,b);
 s.check('B2','old gate rejects narrowed campaign privileges (exception is necessary)',gate(st,G2).status('B6')==='FAIL');
 s.check('B3','all previous rows remain passing after migration with conditional B6 exception',old.rows.filter(r=>!r.gate.startsWith('VERDICT')).every(r=>b.rows.some(n=>n.gate===r.gate&&n.status===r.status)));
 fs.writeFileSync(path.join(__dirname,'evidence/baseline-gate.json'),JSON.stringify(a.rows,null,2));fs.writeFileSync(path.join(__dirname,'evidence/applied-gate.json'),JSON.stringify(b.rows,null,2));
 const sig='catalogue_merchandising_transition(text,integer,jsonb,text,text)';
 const negatives=[
 ['RLS disabled','alter table catalogue_merchandising disable row level security;'],
 ['state owner changed','grant create on schema public to service_role; alter table catalogue_merchandising owner to service_role;'],
 ['history UPDATE granted','grant update on catalogue_merchandising_versions to service_role;'],
 ['history DELETE granted','grant delete on catalogue_merchandising_events to service_role;'],
 ['history TRUNCATE granted','grant truncate on catalogue_merchandising_events to service_role;'],
 ['state DELETE granted','grant delete on catalogue_merchandising to service_role;'],
 ['required state UPDATE removed','revoke update on catalogue_merchandising from service_role;'],
 ['anon relation SELECT','grant select on catalogue_merchandising to anon;'],
 ['authenticated column UPDATE','grant update(note) on catalogue_merchandising_events to authenticated;'],
 ['PUBLIC relation SELECT','grant select on catalogue_merchandising to public;'],
 ['unexpected grantee','grant select on catalogue_merchandising to authenticator;'],
 ['policy introduced','create policy unexpected on catalogue_merchandising using(true);'],
 ['sequence UPDATE inherited','grant update on sequence catalogue_merchandising_events_id_seq to service_role;'],
 ['sequence anon usage','grant usage on sequence catalogue_merchandising_events_id_seq to anon;'],
 ['sequence required usage removed','revoke usage on sequence catalogue_merchandising_events_id_seq from service_role;'],
 ['function owner changed',`grant create on schema public to service_role; alter function ${sig} owner to service_role;`],
 ['function SECURITY DEFINER',`alter function ${sig} security definer;`],
 ['function unsafe search_path',`alter function ${sig} set search_path=public;`],
 ['function PUBLIC execute',`grant execute on function ${sig} to public;`],
 ['function authenticated execute',`grant execute on function ${sig} to authenticated;`],
 ['function required execute removed',`revoke execute on function ${sig} from service_role;`],
 ['function volatility changed',`alter function ${sig} stable;`],
 ['function removed',`drop function ${sig};`],
 ['trigger disabled','alter table catalogue_merchandising_versions disable trigger merchandising_versions_immutable;'],
 ['trigger removed','drop trigger merchandising_events_immutable on catalogue_merchandising_events;'],
 ['truncate guard removed','drop trigger merchandising_events_no_truncate on catalogue_merchandising_events;'],
 ['trigger event changed','drop trigger merchandising_versions_immutable on catalogue_merchandising_versions; create trigger merchandising_versions_immutable before update on catalogue_merchandising_versions for each row execute function catalogue_refuse_change();'],
 ['shared immutable function bypassed',`create or replace function catalogue_refuse_change() returns trigger language plpgsql as $$begin return new; end$$;`],
 ['expected-version check bypassed',transition.replace('s.row_version <> p_expected','false')],
 ['row lock removed',transition.replace(/for update/i,'')],
 ['self approval check bypassed',transition.replace('p_actor=any(s.authors)','false')],
 ['history column removed','alter table catalogue_merchandising_events drop column previous_published_version;'],
 ['constraint removed','alter table catalogue_merchandising drop constraint catalogue_merchandising_check1;'],
 ['unreviewed overload',`create function catalogue_merchandising_transition(text) returns integer language sql as $$select 1$$;`],
 ['partial table drop','drop table catalogue_merchandising_events cascade;'],
 ['unrelated table narrowed','revoke delete on catalogue_categories from service_role;'],
 ['P2 dependency removed','drop function catalogue_public_schema_version();']
 ];
 // pg_get_functiondef keeps the PL/pgSQL source formatting, so match its actual source spelling.
 negatives.find(x=>x[0]==='expected-version check bypassed')[1]=transition.replace('s.row_version<>p_expected','false');
 const mutationResults=[];
 for(let i=0;i<negatives.length;i++){
  const [label,sql]=negatives[i]; if(['expected-version check bypassed','row lock removed','self approval check bypassed'].includes(label)&&sql===transition)throw Error('mutation did not alter function: '+label);
  const g=gate(st,G,sql);const ok=g.verdict==='NO-GO';s.check('N'+(i+1),label+' rejected',ok,g);mutationResults.push({label,verdict:g.verdict,failed:g.rows.filter(r=>['FAIL','PARTIAL'].includes(r.status))});
 }
 fs.writeFileSync(path.join(__dirname,'evidence/tampered-gates.json'),JSON.stringify(mutationResults,null,2));
 s.check('Nclean','every tamper transaction rolled back: clean gate GO',gate(st).verdict==='GO');
 for(const role of ['anon','authenticated']){
  for(const op of ['select * from public.catalogue_merchandising;',rpc('save',0,'a@test.invalid',empty).replace('select catalogue_', 'select public.catalogue_')]){
   const r=q(st,`begin;set local role ${role};${op}rollback;`);s.check('D'+role+op.slice(0,8),role+' denied table/RPC',r.status!==0&&/permission denied/.test(r.err),r.err);
  }
 }
 const seq=q(st,`begin;set local role service_role;select setval('catalogue_merchandising_events_id_seq',999);rollback;`);
 s.check('Dseq','service_role cannot reset event sequence',seq.status!==0&&/permission denied/.test(seq.err),seq.err);
 const save=q(st,'set role service_role;'+rpc('save',0,'author@test.invalid',empty)+rpc('submit',1,'author@test.invalid'));if(save.status)throw Error(save.err);
 const self=q(st,'begin;set local role service_role;'+rpc('approve',2,'author@test.invalid')+'rollback;');s.check('W1','author self-approval forbidden in database',self.status!==0&&/self_review_forbidden/.test(self.err),self.err);
 const stale=q(st,'begin;set local role service_role;'+rpc('approve',1,'reviewer@test.invalid')+'rollback;');s.check('W2','stale expected version rejected',stale.status!==0&&/state_changed/.test(stale.err),stale.err);
 const unapproved=q(st,'begin;set local role service_role;'+rpc('publish',2,'publisher@test.invalid')+'rollback;');s.check('W3','unapproved publication rejected',unapproved.status!==0&&/invalid_campaign_transition/.test(unapproved.err),unapproved.err);
 const approved=q(st,'set role service_role;'+rpc('approve',2,'reviewer@test.invalid')+rpc('publish',3,'publisher@test.invalid')+rpc('save',4,'author@test.invalid',empty)+rpc('withdraw',5,'publisher@test.invalid'));
 s.check('W4','separate reviewer, publication, new draft and withdrawal succeed',approved.status===0,approved.err);
 const event=q(st,"select version||':'||current_version||':'||previous_published_version from catalogue_merchandising_events where action='withdraw';");s.check('W5','withdrawn live v1 and draft v2 recorded',event.out==='1:2:1',event);
 for(const role of ['postgres','service_role'])for(const table of ['catalogue_merchandising_versions','catalogue_merchandising_events'])for(const action of ['update','delete','truncate']){
  const sql=action==='update'?`update ${table} set ${table.endsWith('versions')?'version=version':'note=note'}`:`${action==='delete'?'delete from':'truncate'} ${table}`;
  const r=q(st,`begin;set local role ${role};${sql};rollback;`);s.check('I'+role+table+action,role+' cannot '+action+' history',r.status!==0&&/append_only|permission denied/.test(r.err),r.err);
 }
 const before=q(st,'select jsonb_build_array((select count(*) from catalogue_merchandising_versions),(select count(*) from catalogue_merchandising_events));').out;
 // Application rollback needs no SQL: old code ignores these additive tables. Preserve data and ACLs.
 const retained=gate(st);s.check('R1','retained schema/history remains GO for application rollback',retained.verdict==='GO');
 const rerun=q(st,`begin;${migration}\ncommit;`);const after=q(st,'select jsonb_build_array((select count(*) from catalogue_merchandising_versions),(select count(*) from catalogue_merchandising_events));').out;
 s.check('R2','isolated re-apply preserves every version/event and secure shape',rerun.status===0&&before===after&&gate(st).verdict==='GO',{before,after});
 fs.writeFileSync(path.join(__dirname,'evidence/rollback.json'),JSON.stringify({transactionRollback:'ABSENT/GO',applicationRollback:'retained schema/GO',before,after,reapplyExit:rerun.status},null,2));
});
