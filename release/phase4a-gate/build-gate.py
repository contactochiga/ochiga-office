"""Generate additive read-only gate. Frozen Phase 3 checks are retained verbatim."""
import json, hashlib
from pathlib import Path
root=Path(__file__).resolve().parent
base=(root.parent/'phase3-gate/production-rollout-gates.sql').read_text()
assert hashlib.sha256(base.encode()).hexdigest()=='f54f615f5b3cbd4e4f262ea66452933436d5180cce6f9d38c34b7d8e2ed67e1d'
shape=(root/'order-shape.sql').read_text().strip().rstrip(';')
assert hashlib.sha256((root/'reviewed-shape.json').read_bytes()).hexdigest()=='20ab0b5a2bb470e651237dc0626d060a5ec5674959f24f3dc0fbe69cb9da799d', 'Manifest drift: review required'
assert hashlib.sha256((root.parent.parent/'db/20261107_hardware_orders.sql').read_bytes()).hexdigest()=='1bd14ac80de64e8b9ec0f768a41469dad0fecbbee25a360b5f6d4959af76e70b', 'Migration drift: review required'
manifest=json.loads((root/'reviewed-shape.json').read_text())
expected=json.dumps(manifest,separators=(',',':'))
p4=f'''p4_shape as ({shape}),
p4_state as (
 select *, case when object_count=0 then 'ABSENT' when intact then 'APPLIED' else 'PARTIAL' end as status
 from (select jsonb_build_object=$p4review${expected}$p4review$::jsonb as intact,
 jsonb_array_length(jsonb_build_object->'relations')+jsonb_array_length(jsonb_build_object->'functions') as object_count from p4_shape) x
),
'''
s=base.replace('with\n','with\n'+p4,1)
s=s.replace('),\nstage_rows as (',"  union all select 'B15 hardware order schema: exact owner, grants, RLS, constraints, immutable guards and functions', case when object_count=0 or intact then 'PASS' else 'FAIL' end, case when object_count=0 then 'not installed' when intact then 'intact' else 'order schema differs from reviewed manifest' end from p4_state\n),\nstage_rows as (",1)
s=s.replace('),\norders as (',"  union all select 'STAGE P4A (hardware orders)',status,'staff-only non-payable order foundation' from p4_state\n),\norders as (",1)
s=s.replace('),\nall_rows as (',"  union all select 'ORDER P4A needs P3 APPLIED', case when (select object_count from p4_state)>0 and not exists(select 1 from stage_rows where gate like 'STAGE P3 %' and status='APPLIED') then 'FAIL' else 'PASS' end,''\n),\nall_rows as (",1)
assert s!=base and 'B15 hardware' in s
(root/'production-rollout-gates.sql').write_text('-- Phase 4A additive gate: no Phase 0-3 exception or condition changed. Read-only.\n'+s)
print(hashlib.sha256(s.encode()).hexdigest())
