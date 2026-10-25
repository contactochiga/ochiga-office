from pathlib import Path
import json,hashlib
root=Path(__file__).parent
base=root/'phase2-base.sql'
s=base.read_text()
assert hashlib.sha256(base.read_bytes()).hexdigest()=='ffdf5628f13032b94fe9c5b0b29893bbc325d1f54a4c54734ac4f2216ae62e8d'
assert hashlib.sha256((root/'reviewed-shape.json').read_bytes()).hexdigest()=='ede41c0da4b35a6882984561f131e43bb842422c0367b624da491dc748816a2b', 'Manifest changed: independent re-review required'
shape=(root/'catalogue-shape.sql').read_text().strip()
expected=json.dumps(json.loads((root/'reviewed-shape.json').read_text()),separators=(',',':'))
# The snapshot contains exact definitions of the transition and shared immutable guard,
# including independent authorship, expected-version compare, row lock and audit version logic.
p3=f'''p3_shape as ({shape}),
p3_state as (
 select *, case when object_count=0 then 'ABSENT' when intact then 'APPLIED' else 'PARTIAL' end as status
 from (select jsonb_build_object = $p3review${expected}$p3review$::jsonb as intact,
 jsonb_array_length(jsonb_build_object->'relations')+(select count(*) from pg_proc where pronamespace='public'::regnamespace and proname='catalogue_merchandising_transition') as object_count
 from p3_shape) x
),
'''
s=s.replace('with\n','with\n'+p3,1)
old="and c.oid not in (select t.oid from p0_tbl t where t.approved and has_table_privilege('service_role', t.oid, 'SELECT'))"
assert s.count(old)==1
s=s.replace(old,old+"\n              -- Only these three relations, and only while the ENTIRE reviewed Phase 3 shape is intact.\n              and not (c.relname in ('catalogue_merchandising','catalogue_merchandising_versions','catalogue_merchandising_events') and (select intact from p3_state))")
s=s.replace('),\nstage_rows as (',"  union all select 'B14 campaign schema: exact reviewed owners, ACLs, RLS, constraints, immutable guards and transition definition',\n    case when object_count=0 or intact then 'PASS' else 'FAIL' end,\n    case when object_count=0 then 'not installed' when intact then 'intact' else 'schema differs from reviewed Phase 3 manifest; B6 exception denied' end from p3_state\n),\nstage_rows as (",1)
s=s.replace('),\norders as (',"  union all select 'STAGE P3 (20261106 merchandising)', status, 'exact reviewed shape or wholly absent; partial/drift requires investigation' from p3_state\n),\norders as (",1)
s=s.replace('),\nall_rows as (',"  union all select 'ORDER P3 needs P2P APPLIED', case when (select object_count from p3_state)>0 and not exists(select 1 from stage_rows where gate like 'STAGE P2P %' and status='APPLIED') then 'FAIL' else 'PASS' end, ''\n),\nall_rows as (",1)
header='''-- PHASE 3 READ-ONLY GATE. No DDL/DML, no credential or customer-row access.
-- Derived from the frozen Phase 2 gate. All old rows/conditions retained.
-- Sole old-condition change: B6 excludes exactly three campaign tables ONLY
-- while their complete reviewed shape, sequence, transition and shared guard match.
-- B14 and P3 fail closed for missing/altered/extra components. No rollback DDL is approved.
-- Recovery: rollback uncommitted transaction; otherwise retain schema/history and roll back code.
-- Manifest is frozen from the hash-pinned migration in an isolated production-shaped database.
-- Do not regenerate the manifest from production or a tampered database to make the gate pass.
'''
(root/'production-rollout-gates.sql').write_text(header+s)
print('Gate generated',hashlib.sha256((header+s).encode()).hexdigest())
