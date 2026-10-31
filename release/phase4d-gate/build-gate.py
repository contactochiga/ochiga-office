"""Rebuild reviewed Stage 4D gate without weakening earlier phase checks."""
from pathlib import Path
import json,hashlib
repo=Path(__file__).resolve().parents[2];root=Path(__file__).resolve().parent
PINS={'release/phase4c-gate/production-rollout-gates.sql': '1265556c5107fa5abb51450a86204dbdfbf1413489971991adf0359e8ed18804', 'db/phase4d/20261026094828_hardware_payment_confirmation.sql': '46380b7d0b8782c0707a0b4508701e18664a7c5e06a9a3d163d8e5ae519567b8', 'release/phase4d-gate/payment-reviewed.json': '26b426a9d523a871e0447d3ed223cefdd26accd392571b031fba98bdd86b3346', 'release/phase4d-gate/order-reviewed.json': '53f84ccd3732f570d2598ee20637ec1fc6909020a096f138a00f79a5737825e2', 'release/phase4d-gate/reservation-reviewed.json': '3ca60b499987f0b146d035c4b004d93fe72fe3f0c31442cac15032fdfc0464b3'}
for name,digest in PINS.items():
 assert hashlib.sha256((repo/name).read_bytes()).hexdigest()==digest,'Review required: '+name
compact=lambda p:json.dumps(json.loads(p.read_text()),separators=(',',':'))
base=(repo/'release/phase4c-gate/production-rollout-gates.sql').read_text()
shape=(root/'payment-shape.sql').read_text().strip().rstrip(';')
payment=compact(root/'payment-reviewed.json');orders=compact(root/'order-reviewed.json');reservations=compact(root/'reservation-reviewed.json')
ctes=f"""p4d_shape as ({shape}),
p4d_state as (select jsonb_build_object=$p4dpay${payment}$p4dpay$::jsonb intact,
 case when jsonb_build_object='{{"relations":[],"functions":[]}}'::jsonb then 'ABSENT' when jsonb_build_object=$p4dpay${payment}$p4dpay$::jsonb then 'APPLIED' else 'PARTIAL' end status from p4d_shape),
"""
base=base.replace('with\n','with\n'+ctes,1)
old=compact(repo/'release/phase4c-gate/reviewed-shape.json')
needle=f'jsonb_build_object=$p4c${old}$p4c$::jsonb intact'
assert needle in base
base=base.replace(needle,f'(jsonb_build_object=$p4c${old}$p4c$::jsonb OR ((select intact from p4d_state) AND jsonb_build_object=$p4dres${reservations}$p4dres$::jsonb)) intact',1)
oldorder=compact(repo/'release/phase4c-gate/reviewed-order-shape.json')
needle=f'jsonb_build_object=$p4corder${oldorder}$p4corder$::jsonb'
assert needle in base
base=base.replace(needle,f'(jsonb_build_object=$p4corder${oldorder}$p4corder$::jsonb OR ((select intact from p4d_state) AND jsonb_build_object=$p4dorder${orders}$p4dorder$::jsonb))',1)
# Only the four immutable payment evidence tables, and only for the exact reviewed shape.
needle="and not (c.relname in ('catalogue_merchandising','catalogue_merchandising_versions','catalogue_merchandising_events') and (select intact from p3_state))"
assert needle in base
base=base.replace(needle,needle+"\n              and not (c.relname in ('hardware_payment_delivery','hardware_payment_authorizations','hardware_payment_confirmations','hardware_payment_history') and (select intact from p4d_state))",1)
base=base.replace('),\nstage_rows as (',"  union all select 'B18 payments: reviewed schema and authorization',case when status in ('ABSENT','APPLIED') then 'PASS' else 'FAIL' end,status from p4d_state\n),\nstage_rows as (",1)
base=base.replace('),\norders as (',"  union all select 'STAGE P4D payments',status,'Provider and scheduler runtime gates remain separate' from p4d_state\n),\norders as (",1)
base=base.replace('),\nall_rows as (',"  union all select 'ORDER P4D needs P4C APPLIED',case when (select status from p4d_state)<>'ABSENT' and (select status from p4c_state)<>'APPLIED' then 'FAIL' else 'PASS' end,''\n),\nall_rows as (",1)
(root/'production-rollout-gates.sql').write_text(base)
