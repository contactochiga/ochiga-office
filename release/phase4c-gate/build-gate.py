"""Migration-aware Stage 4C gate. Preserve earlier conditions; allow ONLY reviewed 4C order shape."""
import json,hashlib
from pathlib import Path
repo=Path(__file__).resolve().parents[2]
root=Path(__file__).resolve().parent
PINS={'release/phase4b-gate/production-rollout-gates.sql': '64580c1be4d4060a9785bf8fb0254d7b210cfc545b6d335d53530b6c0440d41c', 'db/phase4c/20261026090615_hardware_reservations.sql': 'e144d9ffd4a547079b340f1a6ef608cd9266bd2ad0398520b53ae81ba5860da5', 'release/phase4c-gate/baseline-shape.json': '144783d9c40a51ba4d9dca0348d094fe42d55600ab1ee7ed963fc0b5bf44d420', 'release/phase4c-gate/reviewed-shape.json': 'dc0ab0991479039bb6df48bd786c53cd836f8c5acd16b495d77204ed69abd49d', 'release/phase4c-gate/reviewed-order-shape.json': '2e7c7d40e2ccfbc94f8ca4e05dc83b76d22bcc28031863997eba5b18fc8eee91'}
for name,digest in PINS.items():
 assert hashlib.sha256((repo/name).read_bytes()).hexdigest()==digest, 'Review required: '+name
compact=lambda path:json.dumps(json.loads(path.read_text()),separators=(',',':'))
base=(repo/'release/phase4b-gate/production-rollout-gates.sql').read_text()
shape=(root/'reservation-shape.sql').read_text().strip().rstrip(';')
reviewed=compact(root/'reviewed-shape.json');prior=compact(root/'baseline-shape.json')
neworder=compact(root/'reviewed-order-shape.json');oldorder=compact(repo/'release/phase4a-gate/reviewed-shape.json')
ctes=f"""p4c_shape as ({shape}),
p4c_state as (
 select *,case when object_count=0 and baseline_intact then 'ABSENT' when object_count>0 and intact then 'APPLIED' else 'PARTIAL' end status from (
 select jsonb_build_object=$p4c${reviewed}$p4c$::jsonb intact,
 (jsonb_build_object=$p4c${prior}$p4c$::jsonb or jsonb_build_object='{{"relations":[],"functions":[]}}'::jsonb) baseline_intact,
 (select count(*) from jsonb_array_elements(jsonb_build_object->'relations') x where x->>'name' like 'hardware_reservation%')+
 (select count(*) from jsonb_array_elements(jsonb_build_object->'functions') x where x->>'signature' like 'hardware_reservation%') object_count from p4c_shape) x
),
"""
s=base.replace('with\n','with\n'+ctes,1)
old=f'jsonb_build_object=$p4review${oldorder}$p4review$::jsonb as intact'
new=f'(jsonb_build_object=$p4review${oldorder}$p4review$::jsonb OR ((select intact from p4c_state) AND jsonb_build_object=$p4corder${neworder}$p4corder$::jsonb)) as intact'
assert s.count(old)==1
s=s.replace(old,new,1)
s=s.replace('),\nstage_rows as (',"  union all select 'B17 reservations: reviewed owners grants RLS history stock and functions',case when status in ('ABSENT','APPLIED') then 'PASS' else 'FAIL' end,status from p4c_state\n),\nstage_rows as (",1)
s=s.replace('),\norders as (',"  union all select 'STAGE P4C reservations',status,'Database expiry scheduler requires separate runtime gate' from p4c_state\n),\norders as (",1)
s=s.replace('),\nall_rows as (',"  union all select 'ORDER P4C needs P4B APPLIED',case when (select object_count from p4c_state)>0 and not exists(select 1 from stage_rows where gate like 'STAGE P4B %' and status='APPLIED') then 'FAIL' else 'PASS' end,''\n),\nall_rows as (",1)
(root/'production-rollout-gates.sql').write_text('-- Stage 4C reviewed migration-aware schema gate. Read-only.\n'+s)
print(hashlib.sha256((root/'production-rollout-gates.sql').read_bytes()).hexdigest())
