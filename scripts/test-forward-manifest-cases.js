"use strict";
// Called ONLY by the disposable PostgreSQL harness. Never accepts a database URL.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
module.exports = async ({psql,one,check,ROOT}) => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT,'release/commerce/migration-manifest.json')));
  const run = sql => {const r=psql(sql);if(r.status)throw Error(r.err);return r.out;};
  const q = s => "'"+s.replaceAll("'","''")+"'";
  const fingerprint = () => one("select md5(string_agg(pg_get_functiondef(p.oid),'|' order by p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f'");
  // The production package baseline is constructed by the existing harness.
  const first=manifest.steps[0];
  run('create schema forward_rehearsal;create table forward_rehearsal.receipts(position int primary key, file text unique not null, sha256 text not null);');
  run(`insert into forward_rehearsal.receipts values(1,${q(first.file)},${q(first.sha256)})`);
  let applications=0;
  const apply = step => {
    const raw=fs.readFileSync(path.join(ROOT,step.file),'utf8');
    if(crypto.createHash('sha256').update(raw).digest('hex')!==step.sha256)throw Error('source_hash_mismatch');
    const receipt=one(`select sha256 from forward_rehearsal.receipts where position=${step.position}`);
    if(receipt){if(receipt!==step.sha256)throw Error('installed_hash_mismatch');return 'skip';}
    if(Number(one('select count(*) from forward_rehearsal.receipts'))!==step.position-1)throw Error('noncontiguous_history');
    // Strip only whole-line top-level transaction delimiters, retaining actual migration SQL.
    const body=raw.replace(/^\s*(?:begin|commit);\s*$/gmi,'');
    run(`begin;${body}\ninsert into forward_rehearsal.receipts values(${step.position},${q(step.file)},${q(step.sha256)});commit;`);
    applications++;return 'applied';
  };
  check('FM-SKIP','installed package step never runs again',apply(first)==='skip');
  const gateAt={12:['security-gate.sql'],13:['delivery-first-gate.sql'],14:['customer-access-gate.sql'],15:['refund-completion-gate.sql','customer-access-gate.sql','delivery-first-gate.sql']};
  for(const step of manifest.steps.slice(1)){
    check('FM-APPLY',`ordered step ${step.position}: ${step.file}`,apply(step)==='applied');
    for(const gate of gateAt[step.position]||[]){
      const r=psql(fs.readFileSync(path.join(ROOT,'release/commerce',gate),'utf8'));
      check('FM-GATE',`step ${step.position} ${gate}`,r.status===0&&r.out.includes('PASS')&&!r.out.includes('FAIL'),r);
      if(r.status||r.out.includes('FAIL'))throw Error('forward_security_gate_failed');
    }
  }
  const before=fingerprint();
  check('FM-RESUME','all receipts resume without executing any migration',manifest.steps.every(s=>apply(s)==='skip')&&applications===manifest.steps.length-1&&before===fingerprint());
  run("begin;update forward_rehearsal.receipts set sha256=repeat('0',64) where position=15;commit;");
  let refused=false;try{apply(manifest.steps[14]);}catch(e){refused=e.message==='installed_hash_mismatch';}
  check('FM-DRIFT','checksum drift refuses resume',refused&&before===fingerprint());
  run(`update forward_rehearsal.receipts set sha256=${q(manifest.steps[14].sha256)} where position=15`);
  check('FM-EMPTY','no synthetic order/payment created by migration rehearsal',one('select (select count(*) from hardware_orders)+(select count(*) from hardware_payment_confirmations)+(select count(*) from hardware_financial_observations)')==='0');
};
