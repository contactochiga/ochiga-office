// Isolated bootstrap only. Refuses a changed migration; never connects to production.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const S7=process.env.S7_DIR || '/Users/ochigaidoko/s7-work';
process.env.SUT_DIR=S7;
const L=require(path.join(S7,'scripts/final-cert/C/lib'));
const office=path.resolve(__dirname,'../..');
const file=path.join(office,'db/20261106_catalogue_merchandising.sql');
if(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!=='d78ef310b1417d7ca9ba134a7e024d9e5709000e0eac1135a9778474c0434e7c')throw Error('Unreviewed migration');
fs.mkdirSync(path.join(__dirname,'evidence'),{recursive:true});
if(fs.existsSync(path.join(__dirname,'reviewed-shape.json'))&&!process.argv.includes('--reviewed-regeneration'))throw Error('Frozen manifest exists. Regeneration requires explicit review, not a production snapshot.');
const s=new L.Suite('phase3-capture','P3');
s.main(async()=>{
 const st=await L.DbStack.create({tag:'p3shape',suite:s});
 const base=st.applyBase(); if(base.secondErrors) throw Error('base failed');
 const ms=st.applyMigrations(L.dbFiles().filter(f=>f.slice(0,8)<='20261018'));if(ms.some(x=>x.status))throw Error('migrations failed');
 st.run('create index if not exists admin_invites_admin_user_id_idx on admin_invites(admin_user_id)');
 const hard=st.applyFile(path.join(S7,'docs/settings-domain/evidence/r11-production-catalog/ochiga_office_p0_access_hardening.sql'));if(hard.status)throw Error(hard.out);
 for(const f of ['20261101_office_intake_receipts.sql','20261102_catalogue_foundation.sql','20261103_catalogue_archived_review_guard.sql','20261104_catalogue_media.sql','20261105_catalogue_public_release.sql','20261106_catalogue_merchandising.sql']){const r=st.applyFile(path.join(office,'db',f));if(r.status)throw Error(r.out);}
 const r=st.one(fs.readFileSync(path.join(__dirname,'catalogue-shape.sql'),'utf8'));
 if(r.status)throw Error(r.err); const shape=JSON.parse(r.out);
 fs.writeFileSync(path.join(__dirname,'reviewed-shape.json'),JSON.stringify(shape,null,2)+'\n');
 s.check('capture','three tables, one sequence and two pinned functions',shape.relations.length===4&&shape.functions.length===2);
});
