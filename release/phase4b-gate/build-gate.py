"""Generate additive read-only gate. Frozen Phase 4A checks are retained verbatim."""
import json, hashlib
from pathlib import Path
root=Path(__file__).resolve().parent
base=(root.parent/'phase4a-gate/production-rollout-gates.sql').read_text()
assert hashlib.sha256(base.encode()).hexdigest()=='785ad0daaa478ea8e39279c97c2af0f8689d903db9b4f82f2a11a8794cbba40a'
shape=(root/'checkout-shape.sql').read_text().strip().rstrip(';')
assert hashlib.sha256((root/'reviewed-shape.json').read_bytes()).hexdigest()=='72a1d545e6b741beb39a6a068729bf49bfc24a870e922bfbd67e01bba0caaa8a', 'Manifest drift: review required'
assert hashlib.sha256((root.parent.parent/'db/20261108_hardware_checkout.sql').read_bytes()).hexdigest()=='9047cc4eb0faf4f5f7e0913848a77ca66f7e363386a900fa4cc8c76a28491d65', 'Migration drift: review required'
manifest=json.loads((root/'reviewed-shape.json').read_text())
expected=json.dumps(manifest,separators=(',',':'))
p4=f'''p4b_shape as ({shape}),
p4b_state as (
 select *, case when object_count=0 then 'ABSENT' when intact then 'APPLIED' else 'PARTIAL' end as status
 from (select jsonb_build_object=$p4review${expected}$p4review$::jsonb as intact,
 jsonb_array_length(jsonb_build_object->'relations')+jsonb_array_length(jsonb_build_object->'functions') as object_count from p4b_shape) x
),
'''
s=base.replace('with\n','with\n'+p4,1)
s=s.replace('),\nstage_rows as (',"  union all select 'B16 guest checkout schema: exact owner, grants, RLS, constraints, immutable guards and functions', case when object_count=0 or intact then 'PASS' else 'FAIL' end, case when object_count=0 then 'not installed' when intact then 'intact' else 'order schema differs from reviewed manifest' end from p4b_state\n),\nstage_rows as (",1)
s=s.replace('),\norders as (',"  union all select 'STAGE P4B (guest requests)',status,'guest non-payable order requests' from p4b_state\n),\norders as (",1)
s=s.replace('),\nall_rows as (',"  union all select 'ORDER P4B needs P4A APPLIED', case when (select object_count from p4b_state)>0 and not exists(select 1 from stage_rows where gate like 'STAGE P4A %' and status='APPLIED') then 'FAIL' else 'PASS' end,''\n),\nall_rows as (",1)
assert s!=base and 'B16 guest' in s
(root/'production-rollout-gates.sql').write_text('-- Phase 4B additive gate: no Phase 0-4A exception or condition changed. Read-only.\n'+s)
print(hashlib.sha256(s.encode()).hexdigest())
