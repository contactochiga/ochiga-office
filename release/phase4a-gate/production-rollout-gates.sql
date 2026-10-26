-- Phase 4A additive gate: no Phase 0-3 exception or condition changed. Read-only.
-- PHASE 3 READ-ONLY GATE. No DDL/DML, no credential or customer-row access.
-- Derived from the frozen Phase 2 gate. All old rows/conditions retained.
-- Sole old-condition change: B6 excludes exactly three campaign tables ONLY
-- while their complete reviewed shape, sequence, transition and shared guard match.
-- B14 and P3 fail closed for missing/altered/extra components. No rollback DDL is approved.
-- Recovery: rollback uncommitted transaction; otherwise retain schema/history and roll back code.
-- Manifest is frozen from the hash-pinned migration in an isolated production-shaped database.
-- Do not regenerate the manifest from production or a tampered database to make the gate pass.
-- Phase 2 stage 4 addition (db/20261105_catalogue_public_release.sql): NO new exception either (SECURITY INVOKER functions, B11 shape,
-- service_role keeps its rights).
--   * NEW B13 FAILS when installed public-release objects deviate from the reviewed design: public events / slug redirects not append-only
--     or truncatable; listings deletable or truncatable; preview grants changeable other than by revocation; service_role holding TRUNCATE
--     on any of them; a foreign key that is not ON DELETE RESTRICT; or, while the functions are installed, the slug-redirect check on
--     catalogue_products missing or disabled.
--   * NEW STAGE P2P reads ABSENT / APPLIED / ROLLED_BACK (tables, rows and guards kept; functions and the slug check removed) / PARTIAL.
--
-- Phase 2 (stage 3) revision of the READ-ONLY production rollout gate (= the Phase 1 revision, phase1/gate/production-rollout-gates.sql,
-- unchanged in every row, plus the product-gallery migration db/20261104_catalogue_media.sql). Media needs NO new exception: its functions
-- are SECURITY INVOKER (B5) with pinned search_path and EXECUTE service_role only (already enforced for every catalogue_% function by B11),
-- and service_role keeps SELECT/INSERT/UPDATE/DELETE on both new tables (B6).
--   * NEW B12 FAILS when installed media objects deviate from the reviewed design: the media guard trigger (only active -> removed, and
--     never while referenced) missing/disabled or not on catalogue_media_guard(); an append-only / no-truncate trigger missing or disabled
--     on the renditions table or the no-truncate trigger on catalogue_media; service_role holding TRUNCATE on either; a media foreign key
--     (to catalogue_products, office_files, catalogue_media) that is not ON DELETE RESTRICT; or, while the media functions are installed,
--     the version gallery check trigger on catalogue_product_versions missing or disabled.
--   * NEW STAGE P2M reads ABSENT / APPLIED / ROLLED_BACK (tables, rows and guards kept, functions + version check removed: the documented
--     rollback, GO-WITH-REVIEW) / PARTIAL.
--
-- Phase 1 revision of the READ-ONLY production rollout gate (= the Phase 0 revision, phase0/gate/production-rollout-gates.sql, unchanged in
-- every row, plus the product-catalogue migration db/20261102_catalogue_foundation.sql). The catalogue needs NO new exception: its
-- functions are SECURITY INVOKER (B5 unaffected) and service_role keeps SELECT/INSERT/UPDATE/DELETE on its tables (B6 unaffected).
--   * NEW B11 FAILS when installed catalogue objects deviate from the reviewed design: an append-only/no-truncate trigger missing or
--     disabled on a history table, service_role holding TRUNCATE on a history table, a catalogue function that is SECURITY DEFINER, lacks
--     the pinned search_path, or is executable by anyone but service_role (and its owner), or any function body referencing the internal
--     cost table catalogue_variant_costs.
--   * NEW STAGE P1 reads ABSENT / APPLIED / ROLLED_BACK (tables kept, functions removed: the documented rollback, GO-WITH-REVIEW) / PARTIAL.
--
-- Phase 0 revision of the S7 R11 READ-ONLY rollout gates (source: S7 branch scripts/sql/production-rollout-gates.sql @ 820346a, kept unchanged there).
-- Every R11 row is kept with its original meaning. The ONLY relaxations are two named exceptions for the reviewed intake-receipts migration
-- db/20261101_office_intake_receipts.sql (Office Phase 0, commit c613d04), and each applies only while that design is intact:
--   * B5 does not count the three reviewed SECURITY DEFINER functions office_intake_claim / _complete / _fail, identified by exact signature AND by a
--     fingerprint of their definition (result type, language, SECURITY DEFINER flag, volatility, settings incl. the pinned search_path, body), AND owned by
--     postgres, AND executable by service_role and nobody else (no PUBLIC, anon, authenticated or other grantee).
--   * B6 does not demand INSERT/UPDATE/DELETE from service_role on office_intake_receipts (writes go only through those functions), and only while
--     the table is in its reviewed restricted state (B10).
--   * NEW B10 FAILS when any receipts object deviates: table not owned by postgres, RLS off, any policy or trigger, any service_role table or column
--     write right, anything for PUBLIC/anon/authenticated/other roles, or a function whose fingerprint, owner or EXECUTE list differs.
--   * NEW STAGE P0 reads ABSENT / APPLIED / ROLLED_BACK (table kept, functions removed: the documented rollback, verdict GO-WITH-REVIEW) / PARTIAL (NO-GO).
-- Any other SECURITY DEFINER function or view still makes B5 REVIEW; any other table lacking service_role writes still makes B6 FAIL.
-- Changing the receipts functions requires a new review and new fingerprints here.
--
-- ---- original R11 header ----
-- S7 R11: READ-ONLY rollout gates for the Office production database (Supabase project "Ochiga marketing and sales agent").
-- One statement, pg_catalog / information_schema metadata only: it never selects a row, hash, token or personal record from any application table, and it changes nothing.
-- Run it in the Supabase SQL editor (or `supabase db query --linked -f`) BEFORE and AFTER each rollout stage and keep the output with the change record.
--
--   BASELINE rows must read PASS at every moment (they describe the protections production has today and must keep).
--   STAGE rows read ABSENT (nothing of that stage exists), APPLIED (everything exists) or PARTIAL (some objects exist: STOP, a stage was interrupted or applied by hand).
--   ORDER rows read PASS unless a later stage exists without the earlier stage it needs.
--   FOLLOW-UP reads PENDING while a credential/history table created by an earlier stage still carries broad service_role rights (run 20261027).
--   The last row, VERDICT, reads GO only when every BASELINE row is PASS, no stage is PARTIAL, no ORDER row failed and nothing is PENDING (GO-WITH-REVIEW otherwise; NO-GO on any FAIL/PARTIAL).
-- Stages (see docs/settings-domain/54_S7_R11_PRODUCTION_DB_RECONCILIATION.md):
--   S1 = 20261019 + 20261020 + 20261021   S2 = 20261026   S3 = 20261028   S4 = 20261022-20261025 + 20261029-20261031   S5 = 20261027 (after S1 and, when present, S4)
with
p4_shape as (-- Read-only stable metadata, no row data or credentials. Names, not database-local OIDs.
select jsonb_build_object(
 'relations', coalesce((select jsonb_agg(jsonb_build_object(
  'name',c.relname,'kind',c.relkind,'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
  'acl',(select coalesce(jsonb_agg(jsonb_build_array(case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,a.privilege_type,a.is_grantable) order by a.grantee=0,pg_get_userbyid(a.grantee),a.privilege_type),'[]') from aclexplode(coalesce(c.relacl,acldefault(case when c.relkind='S' then 's'::"char" else 'r'::"char" end,c.relowner))) a),
  'columns',(select coalesce(jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'default',pg_get_expr(d.adbin,d.adrelid),'acl',a.attacl::text) order by a.attnum),'[]') from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
  'constraints',(select coalesce(jsonb_agg(jsonb_build_array(k.conname,pg_get_constraintdef(k.oid),k.convalidated,k.condeferrable,k.condeferred) order by k.conname),'[]') from pg_constraint k where k.conrelid=c.oid),
  'triggers',(select coalesce(jsonb_agg(jsonb_build_array(t.tgname,pg_get_triggerdef(t.oid),t.tgenabled) order by t.tgname),'[]') from pg_trigger t where t.tgrelid=c.oid and not t.tgisinternal),
  'policies',(select count(*) from pg_policy p where p.polrelid=c.oid)
 ) order by c.relname) from pg_class c where c.relnamespace='public'::regnamespace and c.relname in ('hardware_orders','hardware_order_private','hardware_order_lines','hardware_order_events')),'[]'),
 'functions',coalesce((select jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'owner',pg_get_userbyid(p.proowner),'definition',pg_get_functiondef(p.oid),
 'acl',(select coalesce(jsonb_agg(jsonb_build_array(case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,a.privilege_type,a.is_grantable) order by a.grantee=0,pg_get_userbyid(a.grantee),a.privilege_type),'[]') from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a)) order by p.oid::regprocedure::text) from pg_proc p where p.pronamespace='public'::regnamespace and p.proname like 'hardware_order_%'),'[]')
)),
p4_state as (
 select *, case when object_count=0 then 'ABSENT' when intact then 'APPLIED' else 'PARTIAL' end as status
 from (select jsonb_build_object=$p4review${"functions":[{"acl":[["postgres","EXECUTE",false],["service_role","EXECUTE",false]],"owner":"postgres","signature":"hardware_order_cancel(text,uuid,integer)","definition":"CREATE OR REPLACE FUNCTION public.hardware_order_cancel(p_actor text, p_id uuid, p_expected integer)\n RETURNS jsonb\n LANGUAGE plpgsql\n SET search_path TO 'public', 'pg_temp'\nAS $function$\ndeclare o hardware_orders%rowtype;\nbegin\n perform hardware_order_require_actor(p_actor,'commerce.orders.cancel');\n select * into o from hardware_orders where id=p_id for update;\n if not found then raise exception 'order_not_found' using errcode='PT404'; end if;\n if o.order_state='cancelled' and o.row_version=p_expected+1 then return jsonb_build_object('id',o.id,'row_version',o.row_version,'order_state',o.order_state,'replayed',true); end if;\n if o.row_version<>p_expected or o.order_state<>'awaiting_confirmation' then raise exception 'order_state_changed' using errcode='PT409'; end if;\n update hardware_orders set order_state='cancelled',row_version=row_version+1,updated_at=now() where id=p_id returning * into o;\n insert into hardware_order_events(order_id,event_type,row_version,actor) values(o.id,'cancelled',o.row_version,p_actor);\n insert into audit_events(actor_email,action,target_type,target_id,metadata) values(p_actor,'hardware_order_cancelled','hardware_order',o.id::text,jsonb_build_object('row_version',o.row_version));\n insert into crm_activities(contact_id,organization_id,opportunity_id,related_type,related_id,activity_type,title,source,actor,metadata) values(o.contact_id,o.organization_id,o.opportunity_id,'hardware_order',o.id::text,'hardware_order_cancelled','Hardware order cancelled','office',p_actor,jsonb_build_object('order_id',o.id));\n return jsonb_build_object('id',o.id,'row_version',o.row_version,'order_state',o.order_state);\nend $function$\n"},{"acl":[["postgres","EXECUTE",false],["service_role","EXECUTE",false]],"owner":"postgres","signature":"hardware_order_consistency()","definition":"CREATE OR REPLACE FUNCTION public.hardware_order_consistency()\n RETURNS trigger\n LANGUAGE plpgsql\n SET search_path TO 'public', 'pg_temp'\nAS $function$\ndeclare oid uuid; o hardware_orders%rowtype; n integer; gross bigint; tax bigint;\nbegin\n oid:=coalesce((to_jsonb(new)->>'order_id')::uuid,(to_jsonb(new)->>'id')::uuid);\n select * into o from hardware_orders where id=oid;\n select count(*),sum(gross_kobo),sum(tax_kobo) into n,gross,tax from hardware_order_lines where order_id=oid;\n if n not between 1 and 50 or gross is distinct from o.goods_total_kobo or tax is distinct from o.goods_tax_kobo\n or not exists(select 1 from hardware_order_private where order_id=oid)\n or (select count(*) from hardware_order_events where order_id=oid)<>o.row_version\n or not exists(select 1 from hardware_order_events where order_id=oid and row_version=1 and event_type='created' and actor=o.created_by)\n or (o.order_state='cancelled' and not exists(select 1 from hardware_order_events where order_id=oid and row_version=o.row_version and event_type='cancelled'))\n or exists(select 1 from hardware_order_events e where e.order_id=oid and (not exists(select 1 from audit_events a where a.target_type='hardware_order' and a.target_id=oid::text and a.action='hardware_order_'||e.event_type and a.actor_email=e.actor and (a.metadata->>'row_version')::integer=e.row_version)\n or not exists(select 1 from crm_activities a where a.related_type='hardware_order' and a.related_id=oid::text and a.activity_type='hardware_order_'||e.event_type and a.actor=e.actor and a.contact_id=o.contact_id)))\n or exists(select 1 from hardware_order_lines l join catalogue_variants v on v.id=l.variant_id where l.order_id=oid and (l.product_id<>v.product_id or l.sku<>v.sku or l.tax_kobo<>round(l.gross_kobo::numeric*l.vat_rate_bp/(10000+l.vat_rate_bp))::bigint)) then\n raise exception 'order_integrity_violation' using errcode='PT409'; end if;\n return null;\nend $function$\n"},{"acl":[["postgres","EXECUTE",false],["service_role","EXECUTE",false]],"owner":"postgres","signature":"hardware_order_create(text,text,jsonb)","definition":"CREATE OR REPLACE FUNCTION public.hardware_order_create(p_actor text, p_key text, p_request jsonb)\n RETURNS jsonb\n LANGUAGE plpgsql\n SET search_path TO 'public', 'pg_temp'\nAS $function$\ndeclare o hardware_orders%rowtype; c crm_contacts%rowtype; v catalogue_variants%rowtype; p catalogue_products%rowtype;\n item jsonb; content jsonb; lines jsonb:='[]'; line jsonb; d jsonb; h text; pc uuid; cid uuid; oid uuid; opid uuid;\n q integer; pos integer:=0; gross bigint; tax bigint; total bigint:=0; taxes bigint:=0;\nbegin\n perform hardware_order_require_actor(p_actor,'commerce.orders.create');\n perform hardware_order_require_actor(p_actor,'crm.read');\n if p_key is null or p_key !~ '^[A-Za-z0-9_-]{16,128}$' or jsonb_typeof(p_request) is distinct from 'object' or\n (p_request-array['contact_id','organization_id','opportunity_id','delivery','installation_requested','lines'])<>'{}'::jsonb then\n raise exception 'invalid_order_input' using errcode='PT400'; end if;\n h:=encode(sha256(convert_to(p_request::text,'UTF8')),'hex');\n -- Serialize same actor/key before looking at changing catalogue state; successful retries return the same order.\n perform pg_advisory_xact_lock(hashtextextended(p_actor||':'||p_key,0));\n select * into o from hardware_orders where created_by=p_actor and idempotency_key=p_key;\n if found then\n if o.request_hash<>h then raise exception 'idempotency_conflict' using errcode='PT409'; end if;\n return jsonb_build_object('id',o.id,'replayed',true); end if;\n begin cid:=(p_request->>'contact_id')::uuid; oid:=(p_request->>'organization_id')::uuid; opid:=(p_request->>'opportunity_id')::uuid;\n exception when invalid_text_representation then raise exception 'invalid_crm_reference' using errcode='PT400'; end;\n select * into c from crm_contacts where id=cid for share;\n if not found or (oid is not null and c.organization_id is distinct from oid) then raise exception 'invalid_crm_reference' using errcode='PT400'; end if;\n oid:=coalesce(oid,c.organization_id);\n if opid is not null and not exists(select 1 from crm_opportunities where id=opid and contact_id=cid and organization_id is not distinct from oid) then\n raise exception 'invalid_crm_reference' using errcode='PT400'; end if;\n d:=p_request->'delivery';\n if jsonb_typeof(d) is distinct from 'object' or (d-array['country','state','city','address','postcode'])<>'{}'::jsonb\n or d->>'country' is distinct from 'NG' or exists(select 1 from jsonb_each(d) x where jsonb_typeof(x.value)<>'string' or length(x.value#>>'{}')>500)\n or coalesce(length(trim(d->>'state')),0)=0 or coalesce(length(trim(d->>'city')),0)=0 or coalesce(length(trim(d->>'address')),0)=0\n or (p_request ? 'installation_requested' and jsonb_typeof(p_request->'installation_requested')<>'boolean') then raise exception 'invalid_delivery' using errcode='PT400'; end if;\n if jsonb_typeof(p_request->'lines') is distinct from 'array' or jsonb_array_length(p_request->'lines') not between 1 and 50 then raise exception 'invalid_order_lines' using errcode='PT400'; end if;\n -- Lock products before variants, matching catalogue edit order; requests use stable ID ordering.\n perform cp.id from catalogue_products cp where cp.id in\n (select cv.product_id from catalogue_variants cv join jsonb_array_elements(p_request->'lines') x on cv.id::text=x->>'variant_id') order by cp.id for share;\n for item in select value from jsonb_array_elements(p_request->'lines') order by value->>'variant_id' loop\n if jsonb_typeof(item) is distinct from 'object' or item-array['variant_id','quantity']<>'{}'::jsonb\n or jsonb_typeof(item->'quantity') is distinct from 'number' or (item->>'quantity') !~ '^[0-9]{1,4}$' then raise exception 'invalid_order_lines' using errcode='PT400'; end if;\n q:=(item->>'quantity')::integer; if q not between 1 and 1000 then raise exception 'invalid_quantity' using errcode='PT400'; end if;\n begin select * into v from catalogue_variants where id=(item->>'variant_id')::uuid for share;\n exception when invalid_text_representation then raise exception 'invalid_variant' using errcode='PT400'; end;\n if v.id is null or v.status<>'active' or v.sourcing='discontinued' then raise exception 'variant_unavailable' using errcode='PT409'; end if;\n if exists(select 1 from jsonb_array_elements(lines) x where x->>'variant_id'=v.id::text) then raise exception 'duplicate_variant' using errcode='PT400'; end if;\n select * into p from catalogue_products where id=v.product_id for share;\n if p.publication_status<>'published' or p.published_version is null or not exists(select 1 from catalogue_reviews r where r.product_id=p.id and r.version=p.published_version and r.decision='approved') then raise exception 'product_not_approved' using errcode='PT409'; end if;\n select pv.content into content from catalogue_product_versions pv where product_id=p.id and version=p.published_version;\n if not exists(select 1 from jsonb_array_elements(content->'variants') x where x->>'sku'=v.sku) then raise exception 'variant_not_published' using errcode='PT409'; end if;\n select x.id into pc from catalogue_price_changes x where x.variant_id=v.id and x.new_price_ngn_kobo=v.price_ngn_kobo\n and x.new_vat_treatment=v.vat_treatment and x.new_vat_rate_bp=v.vat_rate_bp\n and exists(select 1 from catalogue_price_decisions a where a.price_change_id=x.id and a.decision='approved' and a.actor<>x.requested_by)\n and exists(select 1 from catalogue_price_decisions b where b.price_change_id=x.id and b.decision='published') order by x.requested_at desc,x.id limit 1;\n if pc is null or v.price_ngn_kobo is null or v.price_ngn_kobo not between 1 and 900000000 then raise exception 'price_not_verified' using errcode='PT409'; end if;\n gross:=v.price_ngn_kobo*q; tax:=round(gross::numeric*v.vat_rate_bp/(10000+v.vat_rate_bp))::bigint;\n total:=total+gross; taxes:=taxes+tax; pos:=pos+1;\n line:=jsonb_build_object('position',pos,'product_id',p.id,'product_version',p.published_version,'variant_id',v.id,'variant_row_version',v.row_version,'price_change_id',pc,\n 'sku',v.sku,'product_name',content->>'name','variant_name',(select x->>'name' from jsonb_array_elements(content->'variants') x where x->>'sku'=v.sku limit 1),\n 'variant_options',coalesce((select x->'options' from jsonb_array_elements(content->'variants') x where x->>'sku'=v.sku limit 1),'{}'::jsonb),\n 'quantity',q,'unit_price_kobo',v.price_ngn_kobo,'vat_treatment',v.vat_treatment,'vat_rate_bp',v.vat_rate_bp,'gross_kobo',gross,'tax_kobo',tax,\n 'sourcing',v.sourcing,'availability_at_creation',case when v.sourcing='in_stock' and v.stock_on_hand-v.stock_reserved>=q then 'in_stock' else 'confirmation_required' end);\n lines:=lines||jsonb_build_array(line);\n end loop;\n if total>900000000000 then raise exception 'order_total_limit' using errcode='PT400'; end if;\n insert into hardware_orders(contact_id,organization_id,opportunity_id,created_by,idempotency_key,request_hash,goods_total_kobo,goods_tax_kobo,installation_requested)\n values(cid,oid,opid,p_actor,p_key,h,total,taxes,coalesce((p_request->>'installation_requested')::boolean,false)) returning * into o;\n insert into hardware_order_private values(o.id,jsonb_strip_nulls(jsonb_build_object('name',c.name,'email',c.email,'phone',c.phone)),d);\n insert into hardware_order_lines select o.id,x.* from jsonb_to_recordset(lines) as x(position integer,product_id uuid,product_version integer,variant_id uuid,variant_row_version integer,price_change_id uuid,sku text,product_name text,variant_name text,variant_options jsonb,quantity integer,unit_price_kobo bigint,vat_treatment text,vat_rate_bp integer,gross_kobo bigint,tax_kobo bigint,sourcing text,availability_at_creation text);\n insert into hardware_order_events(order_id,event_type,row_version,actor,metadata) values(o.id,'created',1,p_actor,jsonb_build_object('currency','NGN','goods_total_kobo',total,'goods_tax_kobo',taxes,'payment_eligible',false));\n insert into audit_events(actor_email,action,target_type,target_id,metadata) values(p_actor,'hardware_order_created','hardware_order',o.id::text,jsonb_build_object('row_version',1,'line_count',pos,'payment_eligible',false));\n insert into crm_activities(contact_id,organization_id,opportunity_id,related_type,related_id,activity_type,title,source,actor,metadata) values(cid,oid,opid,'hardware_order',o.id::text,'hardware_order_created','Hardware order awaiting confirmation','office',p_actor,jsonb_build_object('order_id',o.id));\n return jsonb_build_object('id',o.id,'replayed',false);\nend $function$\n"},{"acl":[["postgres","EXECUTE",false],["service_role","EXECUTE",false]],"owner":"postgres","signature":"hardware_order_immutable()","definition":"CREATE OR REPLACE FUNCTION public.hardware_order_immutable()\n RETURNS trigger\n LANGUAGE plpgsql\n SET search_path TO 'public', 'pg_temp'\nAS $function$\nbegin raise exception 'order_history_immutable' using errcode='PT409'; end $function$\n"},{"acl":[["postgres","EXECUTE",false],["service_role","EXECUTE",false]],"owner":"postgres","signature":"hardware_order_require_actor(text,text)","definition":"CREATE OR REPLACE FUNCTION public.hardware_order_require_actor(p_actor text, p_permission text)\n RETURNS void\n LANGUAGE plpgsql\n SET search_path TO 'public', 'pg_temp'\nAS $function$\nbegin\n if not exists(select 1 from admin_users where lower(email)=p_actor and status='active' and removed_at is null\n and role in ('super_admin','ochiga_admin','ochiga_staff') and (role='super_admin' or p_permission='crm.read' or p_permission=any(coalesce(permission_scopes,'{}')))) then\n raise exception 'forbidden' using errcode='PT403'; end if;\nend $function$\n"},{"acl":[["postgres","EXECUTE",false],["service_role","EXECUTE",false]],"owner":"postgres","signature":"hardware_order_state_guard()","definition":"CREATE OR REPLACE FUNCTION public.hardware_order_state_guard()\n RETURNS trigger\n LANGUAGE plpgsql\n SET search_path TO 'public', 'pg_temp'\nAS $function$\nbegin\n if tg_op<>'UPDATE' then raise exception 'order_history_immutable' using errcode='PT409'; end if;\n if (to_jsonb(new)-array['order_state','row_version','updated_at']) is distinct from (to_jsonb(old)-array['order_state','row_version','updated_at'])\n or old.order_state<>'awaiting_confirmation' or new.order_state<>'cancelled' or new.row_version<>old.row_version+1 then\n raise exception 'invalid_order_transition' using errcode='PT409'; end if;\n return new;\nend $function$\n"}],"relations":[{"acl":[["postgres","DELETE",false],["postgres","INSERT",false],["postgres","MAINTAIN",false],["postgres","REFERENCES",false],["postgres","SELECT",false],["postgres","TRIGGER",false],["postgres","TRUNCATE",false],["postgres","UPDATE",false],["service_role","DELETE",false],["service_role","INSERT",false],["service_role","SELECT",false],["service_role","UPDATE",false]],"rls":true,"kind":"r","name":"hardware_order_events","owner":"postgres","columns":[{"acl":null,"name":"id","type":"uuid","default":"gen_random_uuid()","identity":"","not_null":true,"generated":""},{"acl":null,"name":"order_id","type":"uuid","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"event_type","type":"text","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"row_version","type":"integer","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"actor","type":"text","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"metadata","type":"jsonb","default":"'{}'::jsonb","identity":"","not_null":true,"generated":""},{"acl":null,"name":"created_at","type":"timestamp with time zone","default":"now()","identity":"","not_null":true,"generated":""}],"policies":0,"triggers":[["order_consistency","CREATE CONSTRAINT TRIGGER order_consistency AFTER INSERT OR UPDATE ON public.hardware_order_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hardware_order_consistency()","O"],["order_immutable","CREATE TRIGGER order_immutable BEFORE DELETE OR UPDATE ON public.hardware_order_events FOR EACH ROW EXECUTE FUNCTION hardware_order_immutable()","O"],["order_no_truncate","CREATE TRIGGER order_no_truncate BEFORE TRUNCATE ON public.hardware_order_events FOR EACH STATEMENT EXECUTE FUNCTION hardware_order_immutable()","O"]],"force_rls":false,"constraints":[["hardware_order_events_event_type_check","CHECK ((event_type = ANY (ARRAY['created'::text, 'cancelled'::text])))",true,false,false],["hardware_order_events_order_id_fkey","FOREIGN KEY (order_id) REFERENCES hardware_orders(id) ON DELETE RESTRICT",true,false,false],["hardware_order_events_order_id_row_version_key","UNIQUE (order_id, row_version)",true,false,false],["hardware_order_events_pkey","PRIMARY KEY (id)",true,false,false],["order_consistency","TRIGGER DEFERRABLE INITIALLY DEFERRED",true,true,true]]},{"acl":[["postgres","DELETE",false],["postgres","INSERT",false],["postgres","MAINTAIN",false],["postgres","REFERENCES",false],["postgres","SELECT",false],["postgres","TRIGGER",false],["postgres","TRUNCATE",false],["postgres","UPDATE",false],["service_role","DELETE",false],["service_role","INSERT",false],["service_role","SELECT",false],["service_role","UPDATE",false]],"rls":true,"kind":"r","name":"hardware_order_lines","owner":"postgres","columns":[{"acl":null,"name":"order_id","type":"uuid","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"position","type":"integer","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"product_id","type":"uuid","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"product_version","type":"integer","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"variant_id","type":"uuid","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"variant_row_version","type":"integer","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"price_change_id","type":"uuid","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"sku","type":"text","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"product_name","type":"text","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"variant_name","type":"text","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"variant_options","type":"jsonb","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"quantity","type":"integer","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"unit_price_kobo","type":"bigint","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"vat_treatment","type":"text","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"vat_rate_bp","type":"integer","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"gross_kobo","type":"bigint","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"tax_kobo","type":"bigint","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"sourcing","type":"text","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"availability_at_creation","type":"text","default":null,"identity":"","not_null":true,"generated":""}],"policies":0,"triggers":[["order_consistency","CREATE CONSTRAINT TRIGGER order_consistency AFTER INSERT OR UPDATE ON public.hardware_order_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hardware_order_consistency()","O"],["order_immutable","CREATE TRIGGER order_immutable BEFORE DELETE OR UPDATE ON public.hardware_order_lines FOR EACH ROW EXECUTE FUNCTION hardware_order_immutable()","O"],["order_no_truncate","CREATE TRIGGER order_no_truncate BEFORE TRUNCATE ON public.hardware_order_lines FOR EACH STATEMENT EXECUTE FUNCTION hardware_order_immutable()","O"]],"force_rls":false,"constraints":[["hardware_order_lines_availability_at_creation_check","CHECK ((availability_at_creation = ANY (ARRAY['in_stock'::text, 'confirmation_required'::text])))",true,false,false],["hardware_order_lines_check","CHECK ((gross_kobo = (unit_price_kobo * quantity)))",true,false,false],["hardware_order_lines_check1","CHECK (((tax_kobo >= 0) AND (tax_kobo <= gross_kobo)))",true,false,false],["hardware_order_lines_order_id_fkey","FOREIGN KEY (order_id) REFERENCES hardware_orders(id) ON DELETE RESTRICT",true,false,false],["hardware_order_lines_order_id_variant_id_key","UNIQUE (order_id, variant_id)",true,false,false],["hardware_order_lines_pkey","PRIMARY KEY (order_id, \"position\")",true,false,false],["hardware_order_lines_position_check","CHECK (((\"position\" >= 1) AND (\"position\" <= 50)))",true,false,false],["hardware_order_lines_price_change_id_fkey","FOREIGN KEY (price_change_id) REFERENCES catalogue_price_changes(id) ON DELETE RESTRICT",true,false,false],["hardware_order_lines_product_id_fkey","FOREIGN KEY (product_id) REFERENCES catalogue_products(id) ON DELETE RESTRICT",true,false,false],["hardware_order_lines_product_id_product_version_fkey","FOREIGN KEY (product_id, product_version) REFERENCES catalogue_product_versions(product_id, version) ON DELETE RESTRICT",true,false,false],["hardware_order_lines_quantity_check","CHECK (((quantity >= 1) AND (quantity <= 1000)))",true,false,false],["hardware_order_lines_unit_price_kobo_check","CHECK (((unit_price_kobo >= 1) AND (unit_price_kobo <= 900000000)))",true,false,false],["hardware_order_lines_variant_id_fkey","FOREIGN KEY (variant_id) REFERENCES catalogue_variants(id) ON DELETE RESTRICT",true,false,false],["hardware_order_lines_variant_options_check","CHECK ((jsonb_typeof(variant_options) = 'object'::text))",true,false,false],["hardware_order_lines_vat_rate_bp_check","CHECK (((vat_rate_bp >= 0) AND (vat_rate_bp <= 10000)))",true,false,false],["hardware_order_lines_vat_treatment_check","CHECK ((vat_treatment = ANY (ARRAY['standard'::text, 'exempt'::text, 'zero_rated'::text])))",true,false,false],["order_consistency","TRIGGER DEFERRABLE INITIALLY DEFERRED",true,true,true]]},{"acl":[["postgres","DELETE",false],["postgres","INSERT",false],["postgres","MAINTAIN",false],["postgres","REFERENCES",false],["postgres","SELECT",false],["postgres","TRIGGER",false],["postgres","TRUNCATE",false],["postgres","UPDATE",false],["service_role","DELETE",false],["service_role","INSERT",false],["service_role","SELECT",false],["service_role","UPDATE",false]],"rls":true,"kind":"r","name":"hardware_order_private","owner":"postgres","columns":[{"acl":null,"name":"order_id","type":"uuid","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"customer","type":"jsonb","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"delivery","type":"jsonb","default":null,"identity":"","not_null":true,"generated":""}],"policies":0,"triggers":[["order_consistency","CREATE CONSTRAINT TRIGGER order_consistency AFTER INSERT OR UPDATE ON public.hardware_order_private DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hardware_order_consistency()","O"],["order_immutable","CREATE TRIGGER order_immutable BEFORE DELETE OR UPDATE ON public.hardware_order_private FOR EACH ROW EXECUTE FUNCTION hardware_order_immutable()","O"],["order_no_truncate","CREATE TRIGGER order_no_truncate BEFORE TRUNCATE ON public.hardware_order_private FOR EACH STATEMENT EXECUTE FUNCTION hardware_order_immutable()","O"]],"force_rls":false,"constraints":[["hardware_order_private_customer_check","CHECK ((jsonb_typeof(customer) = 'object'::text))",true,false,false],["hardware_order_private_delivery_check","CHECK ((jsonb_typeof(delivery) = 'object'::text))",true,false,false],["hardware_order_private_order_id_fkey","FOREIGN KEY (order_id) REFERENCES hardware_orders(id) ON DELETE RESTRICT",true,false,false],["hardware_order_private_pkey","PRIMARY KEY (order_id)",true,false,false],["order_consistency","TRIGGER DEFERRABLE INITIALLY DEFERRED",true,true,true]]},{"acl":[["postgres","DELETE",false],["postgres","INSERT",false],["postgres","MAINTAIN",false],["postgres","REFERENCES",false],["postgres","SELECT",false],["postgres","TRIGGER",false],["postgres","TRUNCATE",false],["postgres","UPDATE",false],["service_role","DELETE",false],["service_role","INSERT",false],["service_role","SELECT",false],["service_role","UPDATE",false]],"rls":true,"kind":"r","name":"hardware_orders","owner":"postgres","columns":[{"acl":null,"name":"id","type":"uuid","default":"gen_random_uuid()","identity":"","not_null":true,"generated":""},{"acl":null,"name":"contact_id","type":"uuid","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"organization_id","type":"uuid","default":null,"identity":"","not_null":false,"generated":""},{"acl":null,"name":"opportunity_id","type":"uuid","default":null,"identity":"","not_null":false,"generated":""},{"acl":null,"name":"created_by","type":"text","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"idempotency_key","type":"text","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"request_hash","type":"text","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"currency","type":"text","default":"'NGN'::text","identity":"","not_null":true,"generated":""},{"acl":null,"name":"goods_total_kobo","type":"bigint","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"goods_tax_kobo","type":"bigint","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"delivery_total_kobo","type":"bigint","default":null,"identity":"","not_null":false,"generated":""},{"acl":null,"name":"payable_total_kobo","type":"bigint","default":null,"identity":"","not_null":false,"generated":""},{"acl":null,"name":"delivery_state","type":"text","default":"'unconfirmed'::text","identity":"","not_null":true,"generated":""},{"acl":null,"name":"installation_requested","type":"boolean","default":"false","identity":"","not_null":true,"generated":""},{"acl":null,"name":"order_state","type":"text","default":"'awaiting_confirmation'::text","identity":"","not_null":true,"generated":""},{"acl":null,"name":"payment_state","type":"text","default":"'not_started'::text","identity":"","not_null":true,"generated":""},{"acl":null,"name":"fulfilment_state","type":"text","default":"'unallocated'::text","identity":"","not_null":true,"generated":""},{"acl":null,"name":"reservation_state","type":"text","default":"'not_reserved'::text","identity":"","not_null":true,"generated":""},{"acl":null,"name":"row_version","type":"integer","default":"1","identity":"","not_null":true,"generated":""},{"acl":null,"name":"created_at","type":"timestamp with time zone","default":"now()","identity":"","not_null":true,"generated":""},{"acl":null,"name":"updated_at","type":"timestamp with time zone","default":"now()","identity":"","not_null":true,"generated":""}],"policies":0,"triggers":[["order_consistency","CREATE CONSTRAINT TRIGGER order_consistency AFTER INSERT OR UPDATE ON public.hardware_orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hardware_order_consistency()","O"],["order_no_truncate","CREATE TRIGGER order_no_truncate BEFORE TRUNCATE ON public.hardware_orders FOR EACH STATEMENT EXECUTE FUNCTION hardware_order_immutable()","O"],["order_state_guard","CREATE TRIGGER order_state_guard BEFORE DELETE OR UPDATE ON public.hardware_orders FOR EACH ROW EXECUTE FUNCTION hardware_order_state_guard()","O"]],"force_rls":false,"constraints":[["hardware_orders_check","CHECK (((goods_tax_kobo >= 0) AND (goods_tax_kobo <= goods_total_kobo)))",true,false,false],["hardware_orders_contact_id_fkey","FOREIGN KEY (contact_id) REFERENCES crm_contacts(id) ON DELETE RESTRICT",true,false,false],["hardware_orders_created_by_idempotency_key_key","UNIQUE (created_by, idempotency_key)",true,false,false],["hardware_orders_currency_check","CHECK ((currency = 'NGN'::text))",true,false,false],["hardware_orders_delivery_state_check","CHECK ((delivery_state = 'unconfirmed'::text))",true,false,false],["hardware_orders_delivery_total_kobo_check","CHECK ((delivery_total_kobo IS NULL))",true,false,false],["hardware_orders_fulfilment_state_check","CHECK ((fulfilment_state = 'unallocated'::text))",true,false,false],["hardware_orders_goods_total_kobo_check","CHECK (((goods_total_kobo >= 1) AND (goods_total_kobo <= '900000000000'::bigint)))",true,false,false],["hardware_orders_idempotency_key_check","CHECK (((length(idempotency_key) >= 16) AND (length(idempotency_key) <= 128)))",true,false,false],["hardware_orders_opportunity_id_fkey","FOREIGN KEY (opportunity_id) REFERENCES crm_opportunities(id) ON DELETE RESTRICT",true,false,false],["hardware_orders_order_state_check","CHECK ((order_state = ANY (ARRAY['awaiting_confirmation'::text, 'cancelled'::text])))",true,false,false],["hardware_orders_organization_id_fkey","FOREIGN KEY (organization_id) REFERENCES crm_organizations(id) ON DELETE RESTRICT",true,false,false],["hardware_orders_payable_total_kobo_check","CHECK ((payable_total_kobo IS NULL))",true,false,false],["hardware_orders_payment_state_check","CHECK ((payment_state = 'not_started'::text))",true,false,false],["hardware_orders_pkey","PRIMARY KEY (id)",true,false,false],["hardware_orders_request_hash_check","CHECK ((length(request_hash) = 64))",true,false,false],["hardware_orders_reservation_state_check","CHECK ((reservation_state = 'not_reserved'::text))",true,false,false],["hardware_orders_row_version_check","CHECK ((row_version > 0))",true,false,false],["order_consistency","TRIGGER DEFERRABLE INITIALLY DEFERRED",true,true,true]]}]}$p4review$::jsonb as intact,
 jsonb_array_length(jsonb_build_object->'relations')+jsonb_array_length(jsonb_build_object->'functions') as object_count from p4_shape) x
),
p3_shape as (-- Read-only stable metadata, no row data or credentials. Names, not database-local OIDs.
select jsonb_build_object(
 'relations', coalesce((select jsonb_agg(jsonb_build_object(
  'name',c.relname,'kind',c.relkind,'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
  'acl',(select coalesce(jsonb_agg(jsonb_build_array(case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,a.privilege_type,a.is_grantable) order by a.grantee=0,pg_get_userbyid(a.grantee),a.privilege_type),'[]') from aclexplode(coalesce(c.relacl,acldefault(case when c.relkind='S' then 's'::"char" else 'r'::"char" end,c.relowner))) a),
  'columns',(select coalesce(jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'default',pg_get_expr(d.adbin,d.adrelid),'acl',a.attacl::text) order by a.attnum),'[]') from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
  'constraints',(select coalesce(jsonb_agg(jsonb_build_array(k.conname,pg_get_constraintdef(k.oid),k.convalidated,k.condeferrable,k.condeferred) order by k.conname),'[]') from pg_constraint k where k.conrelid=c.oid),
  'triggers',(select coalesce(jsonb_agg(jsonb_build_array(t.tgname,pg_get_triggerdef(t.oid),t.tgenabled) order by t.tgname),'[]') from pg_trigger t where t.tgrelid=c.oid and not t.tgisinternal),
  'policies',(select count(*) from pg_policy p where p.polrelid=c.oid)
 ) order by c.relname) from pg_class c where c.relnamespace='public'::regnamespace and c.relname in ('catalogue_merchandising','catalogue_merchandising_versions','catalogue_merchandising_events','catalogue_merchandising_events_id_seq')),'[]'),
 'functions',coalesce((select jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'owner',pg_get_userbyid(p.proowner),'definition',pg_get_functiondef(p.oid),
 'acl',(select coalesce(jsonb_agg(jsonb_build_array(case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,a.privilege_type,a.is_grantable) order by a.grantee=0,pg_get_userbyid(a.grantee),a.privilege_type),'[]') from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a)) order by p.oid::regprocedure::text) from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('catalogue_merchandising_transition','catalogue_refuse_change')),'[]')
)),
p3_state as (
 select *, case when object_count=0 then 'ABSENT' when intact then 'APPLIED' else 'PARTIAL' end as status
 from (select jsonb_build_object = $p3review${"functions":[{"acl":[["postgres","EXECUTE",false],["service_role","EXECUTE",false]],"owner":"postgres","signature":"catalogue_merchandising_transition(text,integer,jsonb,text,text)","definition":"CREATE OR REPLACE FUNCTION public.catalogue_merchandising_transition(p_action text, p_expected integer, p_content jsonb, p_actor text, p_note text DEFAULT ''::text)\n RETURNS jsonb\n LANGUAGE plpgsql\n SET search_path TO 'public', 'pg_temp'\nAS $function$\ndeclare s catalogue_merchandising%rowtype; v_authors text[]; v_previous_published integer;\nbegin\n if p_actor is null or length(trim(p_actor))=0 or length(p_actor)>320 then raise exception using errcode='PT400',message='invalid_actor'; end if;\n p_actor:=lower(trim(p_actor));\n select * into s from catalogue_merchandising where id=1 for update;\n if not found or p_expected is null or s.row_version<>p_expected then raise exception using errcode='PT409',message='state_changed'; end if;\n v_previous_published:=s.published_version;\n if p_action='save' then\n   if p_content is null or not (p_content ?& array['slides','featured','new_arrivals','collections']) then raise exception using errcode='PT400',message='invalid_merchandising'; end if;\n   select array_agg(distinct a) into v_authors from unnest(case when s.workflow='published' then array[p_actor] else array_append(s.authors,p_actor) end) as a;\n   s.current_version:=s.current_version+1; s.authors:=v_authors; s.workflow:='draft';\n   insert into catalogue_merchandising_versions(version,content,authors) values(s.current_version,p_content,s.authors);\n elsif p_action='submit' and s.current_version>0 and s.workflow='draft' then s.workflow:='in_review';\n elsif p_action in ('approve','reject') and s.workflow='in_review' then\n   if p_actor=any(s.authors) then raise exception using errcode='PT403',message='self_review_forbidden'; end if;\n   s.workflow:=case when p_action='approve' then 'approved' else 'draft' end;\n elsif p_action='publish' and s.workflow='approved' then s.published_version:=s.current_version; s.workflow:='published';\n elsif p_action='withdraw' and s.published_version is not null then s.published_version:=null;\n else raise exception using errcode='PT409',message='invalid_campaign_transition'; end if;\n s.row_version:=s.row_version+1;\n update catalogue_merchandising set row_version=s.row_version,current_version=s.current_version,published_version=s.published_version,workflow=s.workflow,authors=s.authors where id=1;\n insert into catalogue_merchandising_events(action,version,current_version,previous_published_version,actor,note) values(p_action,case when p_action='withdraw' then v_previous_published else s.current_version end,s.current_version,v_previous_published,p_actor,coalesce(p_note,''));\n return to_jsonb(s);\nend $function$\n"},{"acl":[["postgres","EXECUTE",false],["service_role","EXECUTE",false]],"owner":"postgres","signature":"catalogue_refuse_change()","definition":"CREATE OR REPLACE FUNCTION public.catalogue_refuse_change()\n RETURNS trigger\n LANGUAGE plpgsql\n SET search_path TO 'public', 'pg_temp'\nAS $function$\nbegin\n  raise exception 'append_only: % on % is not allowed', tg_op, tg_table_name using errcode = '42501';\nend $function$\n"}],"relations":[{"acl":[["postgres","DELETE",false],["postgres","INSERT",false],["postgres","MAINTAIN",false],["postgres","REFERENCES",false],["postgres","SELECT",false],["postgres","TRIGGER",false],["postgres","TRUNCATE",false],["postgres","UPDATE",false],["service_role","INSERT",false],["service_role","SELECT",false],["service_role","UPDATE",false]],"rls":true,"kind":"r","name":"catalogue_merchandising","owner":"postgres","columns":[{"acl":null,"name":"id","type":"integer","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"row_version","type":"integer","default":"0","identity":"","not_null":true,"generated":""},{"acl":null,"name":"current_version","type":"integer","default":"0","identity":"","not_null":true,"generated":""},{"acl":null,"name":"published_version","type":"integer","default":null,"identity":"","not_null":false,"generated":""},{"acl":null,"name":"workflow","type":"text","default":"'draft'::text","identity":"","not_null":true,"generated":""},{"acl":null,"name":"authors","type":"text[]","default":"'{}'::text[]","identity":"","not_null":true,"generated":""}],"policies":0,"triggers":[],"force_rls":false,"constraints":[["catalogue_merchandising_check","CHECK (((row_version >= 0) AND (current_version >= 0)))",true,false,false],["catalogue_merchandising_check1","CHECK (((published_version IS NULL) OR ((published_version > 0) AND (published_version <= current_version))))",true,false,false],["catalogue_merchandising_id_check","CHECK ((id = 1))",true,false,false],["catalogue_merchandising_pkey","PRIMARY KEY (id)",true,false,false],["catalogue_merchandising_workflow_check","CHECK ((workflow = ANY (ARRAY['draft'::text, 'in_review'::text, 'approved'::text, 'published'::text])))",true,false,false]]},{"acl":[["postgres","DELETE",false],["postgres","INSERT",false],["postgres","MAINTAIN",false],["postgres","REFERENCES",false],["postgres","SELECT",false],["postgres","TRIGGER",false],["postgres","TRUNCATE",false],["postgres","UPDATE",false],["service_role","INSERT",false],["service_role","SELECT",false]],"rls":true,"kind":"r","name":"catalogue_merchandising_events","owner":"postgres","columns":[{"acl":null,"name":"id","type":"bigint","default":null,"identity":"a","not_null":true,"generated":""},{"acl":null,"name":"action","type":"text","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"version","type":"integer","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"current_version","type":"integer","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"previous_published_version","type":"integer","default":null,"identity":"","not_null":false,"generated":""},{"acl":null,"name":"actor","type":"text","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"note","type":"text","default":"''::text","identity":"","not_null":true,"generated":""},{"acl":null,"name":"created_at","type":"timestamp with time zone","default":"now()","identity":"","not_null":true,"generated":""}],"policies":0,"triggers":[["merchandising_events_immutable","CREATE TRIGGER merchandising_events_immutable BEFORE DELETE OR UPDATE ON public.catalogue_merchandising_events FOR EACH ROW EXECUTE FUNCTION catalogue_refuse_change()","O"],["merchandising_events_no_truncate","CREATE TRIGGER merchandising_events_no_truncate BEFORE TRUNCATE ON public.catalogue_merchandising_events FOR EACH STATEMENT EXECUTE FUNCTION catalogue_refuse_change()","O"]],"force_rls":false,"constraints":[["catalogue_merchandising_events_actor_check","CHECK (((length(actor) >= 1) AND (length(actor) <= 320)))",true,false,false],["catalogue_merchandising_events_note_check","CHECK ((length(note) <= 500))",true,false,false],["catalogue_merchandising_events_pkey","PRIMARY KEY (id)",true,false,false]]},{"acl":[["postgres","SELECT",false],["postgres","UPDATE",false],["postgres","USAGE",false],["service_role","SELECT",false],["service_role","USAGE",false]],"rls":false,"kind":"S","name":"catalogue_merchandising_events_id_seq","owner":"postgres","columns":[{"acl":null,"name":"last_value","type":"bigint","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"log_cnt","type":"bigint","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"is_called","type":"boolean","default":null,"identity":"","not_null":true,"generated":""}],"policies":0,"triggers":[],"force_rls":false,"constraints":[]},{"acl":[["postgres","DELETE",false],["postgres","INSERT",false],["postgres","MAINTAIN",false],["postgres","REFERENCES",false],["postgres","SELECT",false],["postgres","TRIGGER",false],["postgres","TRUNCATE",false],["postgres","UPDATE",false],["service_role","INSERT",false],["service_role","SELECT",false]],"rls":true,"kind":"r","name":"catalogue_merchandising_versions","owner":"postgres","columns":[{"acl":null,"name":"version","type":"integer","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"content","type":"jsonb","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"authors","type":"text[]","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"created_at","type":"timestamp with time zone","default":"now()","identity":"","not_null":true,"generated":""}],"policies":0,"triggers":[["merchandising_versions_immutable","CREATE TRIGGER merchandising_versions_immutable BEFORE DELETE OR UPDATE ON public.catalogue_merchandising_versions FOR EACH ROW EXECUTE FUNCTION catalogue_refuse_change()","O"],["merchandising_versions_no_truncate","CREATE TRIGGER merchandising_versions_no_truncate BEFORE TRUNCATE ON public.catalogue_merchandising_versions FOR EACH STATEMENT EXECUTE FUNCTION catalogue_refuse_change()","O"]],"force_rls":false,"constraints":[["catalogue_merchandising_versions_content_check","CHECK ((jsonb_typeof(content) = 'object'::text))",true,false,false],["catalogue_merchandising_versions_content_check1","CHECK (((jsonb_typeof((content -> 'slides'::text)) = 'array'::text) AND (jsonb_array_length((content -> 'slides'::text)) <= 8)))",true,false,false],["catalogue_merchandising_versions_content_check2","CHECK (((jsonb_typeof((content -> 'collections'::text)) = 'array'::text) AND (jsonb_array_length((content -> 'collections'::text)) <= 8)))",true,false,false],["catalogue_merchandising_versions_content_check3","CHECK (((jsonb_typeof((content -> 'featured'::text)) = 'array'::text) AND (jsonb_array_length((content -> 'featured'::text)) <= 24)))",true,false,false],["catalogue_merchandising_versions_content_check4","CHECK (((jsonb_typeof((content -> 'new_arrivals'::text)) = 'array'::text) AND (jsonb_array_length((content -> 'new_arrivals'::text)) <= 24)))",true,false,false],["catalogue_merchandising_versions_pkey","PRIMARY KEY (version)",true,false,false],["catalogue_merchandising_versions_version_check","CHECK ((version > 0))",true,false,false]]}]}$p3review$::jsonb as intact,
 jsonb_array_length(jsonb_build_object->'relations')+(select count(*) from pg_proc where pronamespace='public'::regnamespace and proname='catalogue_merchandising_transition') as object_count
 from p3_shape) x
),
objs(stage, kind, name) as (values
  ('S1','col','admin_users.session_generation'), ('S1','col','admin_users.sessions_revoked_at'), ('S1','col','admin_users.sessions_revoked_by'),
  ('S1','col','office_runtime_settings.version'), ('S1','table','office_runtime_setting_history'),
  ('S1','fn','office_runtime_setting_write'), ('S1','fn','office_runtime_setting_record_attempt'), ('S1','fn','office_runtime_setting_history_immutable'),
  ('S1','fn','office_revoke_admin_sessions'), ('S1','fn','office_admin_update_revoking_sessions'), ('S1','trigger','office_runtime_setting_history_no_change'),
  ('S2','table','admin_revoked_sessions'), ('S2','fn','office_revoke_session'), ('S2','fn','office_is_session_revoked'), ('S2','fn','office_session_revocation_version'),
  ('S3','table','admin_rate_limits'), ('S3','fn','office_rate_limit_hit'), ('S3','fn','office_rate_limit_peek'), ('S3','fn','office_rate_limit_reset'), ('S3','fn','office_rate_limit_version'),
  ('S4','table','admin_mfa_credentials'), ('S4','table','admin_mfa_recovery_codes'), ('S4','table','admin_mfa_challenges'), ('S4','table','admin_mfa_mailbox_attempts'),
  ('S4','col','admin_users.mfa_active_count'), ('S4','col','admin_users.mfa_failed_attempts'), ('S4','col','admin_users.mfa_locked_until'), ('S4','col','admin_users.mfa_required_after'),
  ('S4','col','admin_users.mfa_reset_at'), ('S4','col','admin_users.mfa_reset_by'), ('S4','col','admin_mfa_recovery_codes.key_id'), ('S4','trigger','admin_mfa_credentials_active_count'),
  ('S4','fn','office_mfa_schema_version'), ('S4','fn','office_mfa_management_version'), ('S4','fn','office_mfa_webauthn_version'), ('S4','fn','office_mfa_evidence_version'), ('S4','fn','office_mfa_mailbox_version'),
  ('S4','fn','office_mfa_consume_totp_step'), ('S4','fn','office_mfa_consume_recovery_code'), ('S4','fn','office_mfa_consume_recovery_code_revoking'), ('S4','fn','office_mfa_replace_recovery_codes'),
  ('S4','fn','office_mfa_create_challenge'), ('S4','fn','office_mfa_consume_challenge'), ('S4','fn','office_mfa_record_failure'), ('S4','fn','office_mfa_clear_failures'), ('S4','fn','office_mfa_reset'),
  ('S4','fn','office_mfa_prune_challenges'), ('S4','fn','office_mfa_activate_credential'), ('S4','fn','office_mfa_revoke_credential'), ('S4','fn','office_mfa_webauthn_record_use'),
  ('S4','fn','office_mfa_active_count_trigger'), ('S4','fn','office_mfa_sync_active_count'), ('S4','fn','office_mfa_mailbox_attempt')
),
present as (
  select stage, kind, name,
    case kind
      when 'col'     then exists (select 1 from information_schema.columns c where c.table_schema = 'public' and c.table_name || '.' || c.column_name = name)
      when 'table'   then to_regclass('public.' || name) is not null
      when 'fn'      then exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = name)
      when 'trigger' then exists (select 1 from pg_trigger t where t.tgname = name and not t.tgisinternal)
    end as ok
  from objs
),
stage_status as (
  select stage,
    case when bool_and(ok) then 'APPLIED' when not bool_or(ok) then 'ABSENT' else 'PARTIAL' end as status,
    coalesce(string_agg(kind || ':' || name, ', ' order by kind, name) filter (where not ok), '') as missing,
    count(*) as objects, count(*) filter (where ok) as present
  from present group by stage
),
-- 20261027: what it narrows on the tables other stages create (service_role must not be able to truncate or delete the credential/history evidence)
narrow as (
  select t.tbl, to_regclass('public.' || t.tbl) is not null as exists_,
    case when to_regclass('public.' || t.tbl) is null then null
         else not exists (select 1 from unnest(t.privs) p where has_table_privilege('service_role', ('public.' || t.tbl)::regclass, p)) end as narrowed
  from (values ('admin_mfa_credentials', array['DELETE','TRUNCATE','REFERENCES','TRIGGER']), ('admin_mfa_recovery_codes', array['TRUNCATE','REFERENCES','TRIGGER']),
               ('admin_mfa_challenges', array['TRUNCATE','REFERENCES','TRIGGER']), ('office_runtime_setting_history', array['TRUNCATE','DELETE','UPDATE','REFERENCES','TRIGGER'])) as t(tbl, privs)
),
p0_fn(sig, secdef, fp) as (values
  ('office_intake_receipts_version()', false, '51c59b7b78d9b5ab695a425d3ef578f5'),
  ('office_intake_claim(text,text,text,text,integer)', true, '72adbec673c7b96dc503d946b717f28a'),
  ('office_intake_complete(text,integer,uuid)', true, '085795fef451e6cd9d2ff207b841f9d4'),
  ('office_intake_fail(text,integer,uuid,text)', true, 'af596bdeeb5487077d0b81ff1eee4084')
),
p0_fn_state as (
  select f.sig, f.secdef as want_secdef, p.oid, p.oid is not null as present,
    coalesce(p.oid is not null
      and p.prosecdef = f.secdef
      and md5(concat_ws('|', pg_get_function_result(p.oid), l.lanname, p.prosecdef::text, p.provolatile::text, coalesce(array_to_string(p.proconfig, ';'), ''), p.prosrc)) = f.fp
      and (not f.secdef or p.proconfig = array['search_path=public, pg_temp'])
      and pg_get_userbyid(p.proowner) = 'postgres'
      and has_function_privilege('service_role', p.oid, 'EXECUTE')
      and not has_function_privilege('anon', p.oid, 'EXECUTE') and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and not exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                       where a.grantee <> p.proowner and a.grantee <> (select oid from pg_roles where rolname = 'service_role')), false) as approved
  from p0_fn f
  left join pg_proc p on p.oid = to_regprocedure('public.' || f.sig)
  left join pg_language l on l.oid = p.prolang
),
p0_tbl as (
  select c.oid,
    (c.relkind = 'r' and pg_get_userbyid(c.relowner) = 'postgres' and c.relrowsecurity
     and not exists (select 1 from pg_policy pp where pp.polrelid = c.oid)
     and not exists (select 1 from pg_trigger t where t.tgrelid = c.oid and not t.tgisinternal)
     and has_table_privilege('service_role', c.oid, 'SELECT')
     and not exists (select 1 from (values ('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) v(p) where has_table_privilege('service_role', c.oid, v.p))
     and not has_any_column_privilege('service_role', c.oid, 'INSERT') and not has_any_column_privilege('service_role', c.oid, 'UPDATE') and not has_any_column_privilege('service_role', c.oid, 'REFERENCES')
     and not exists (select 1 from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
                      where a.grantee <> c.relowner and not (a.grantee = (select oid from pg_roles where rolname = 'service_role') and a.privilege_type = 'SELECT'))
     and not exists (select 1 from pg_attribute att where att.attrelid = c.oid and att.attnum > 0 and att.attacl is not null)) as approved
  from pg_class c where c.oid = to_regclass('public.office_intake_receipts')
),
p0_status as (
  select
    case when not exists (select 1 from p0_tbl) and not exists (select 1 from p0_fn_state where present) then 'ABSENT'
         when exists (select 1 from p0_tbl) and (select bool_and(present) from p0_fn_state) then 'APPLIED'
         when exists (select 1 from p0_tbl) and not exists (select 1 from p0_fn_state where present) then 'ROLLED_BACK'
         else 'PARTIAL' end as status,
    coalesce((select bool_and(approved) from p0_tbl), true) and coalesce((select bool_and(approved) from p0_fn_state where present), true) as all_present_approved,
    (select string_agg(sig, ', ' order by sig) from p0_fn_state where present and not approved) as bad_fns,
    (select not approved from p0_tbl) as bad_tbl,
    (select string_agg(sig, ', ' order by sig) from p0_fn_state where not present) as missing_fns
),
p1_tables(name, history) as (values
  ('office_suppliers', false), ('catalogue_categories', false), ('catalogue_brands', false), ('catalogue_products', false),
  ('catalogue_product_versions', true), ('catalogue_reviews', true), ('catalogue_publication_events', true), ('catalogue_variants', false),
  ('catalogue_price_changes', true), ('catalogue_price_decisions', true), ('catalogue_inventory_changes', true), ('catalogue_variant_costs', true)
),
p1_functions(sig) as (values
  ('catalogue_refuse_change()'), ('catalogue_schema_version()'), ('catalogue_state_changed(uuid)'), ('catalogue_register_variants(uuid,jsonb)'),
  ('catalogue_create_product(text,uuid,uuid,jsonb,text)'), ('catalogue_save_version(uuid,integer,text,uuid,uuid,jsonb,text,text)'),
  ('catalogue_transition(uuid,integer,text,text,text,text)'), ('catalogue_request_price_change(uuid,bigint,text,integer,text,text)'),
  ('catalogue_decide_price_change(uuid,text,text,text)'), ('catalogue_publish_price_change(uuid,text)'), ('catalogue_update_inventory(uuid,integer,jsonb,text,text)')
),
p1_state as (
  select
    (select count(*) from p1_tables t where to_regclass('public.' || t.name) is not null) as tables_present,
    (select count(*) from p1_tables) as tables_total,
    (select count(*) from p1_functions f where to_regprocedure('public.' || f.sig) is not null) as functions_present,
    (select count(*) from p1_functions) as functions_total,
    to_regprocedure('public.catalogue_refuse_change()') is not null as guard_present
),
p1_problems as (
  -- history tables: both triggers present, enabled, on the guard function; no TRUNCATE for service_role
  select 'history ' || t.name || ': append-only/no-truncate trigger missing or disabled' as problem
    from p1_tables t where t.history and to_regclass('public.' || t.name) is not null
     and (select count(*) from pg_trigger g where g.tgrelid = to_regclass('public.' || t.name) and not g.tgisinternal and g.tgenabled <> 'D'
            and g.tgfoid = to_regprocedure('public.catalogue_refuse_change()') and g.tgname in (t.name || '_append_only', t.name || '_no_truncate')) <> 2
  union all
  select 'history ' || t.name || ': service_role holds TRUNCATE'
    from p1_tables t where t.history and to_regclass('public.' || t.name) is not null and has_table_privilege('service_role', to_regclass('public.' || t.name), 'TRUNCATE')
  union all
  -- every catalogue function present: invoker, pinned search_path, EXECUTE service_role (+ owner) only
  select 'function ' || p.oid::regprocedure::text || ': not the reviewed security shape'
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'catalogue\_%'
     and (p.prosecdef or p.proconfig is distinct from array['search_path=public, pg_temp']
          or not has_function_privilege('service_role', p.oid, 'EXECUTE')
          or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                      where a.grantee <> p.proowner and a.grantee <> (select oid from pg_roles where rolname = 'service_role')))
  union all
  select 'function ' || p.oid::regprocedure::text || ': references the internal cost table'
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosrc ilike '%catalogue_variant_costs%'
),
p2m_tables(name) as (values ('catalogue_media'), ('catalogue_media_derivatives')),
p2m_functions(sig) as (values
  ('catalogue_version_media_check()'), ('catalogue_media_schema_version()'),
  ('catalogue_register_media(uuid,text,text,text,integer,integer,integer,text,jsonb,text)'), ('catalogue_remove_media(uuid,text)')
),
p2m_state as (
  select
    (select count(*) from p2m_tables t where to_regclass('public.' || t.name) is not null) as tables_present,
    (select count(*) from p2m_tables) as tables_total,
    (select count(*) from p2m_functions f where to_regprocedure('public.' || f.sig) is not null) as functions_present,
    (select count(*) from p2m_functions) as functions_total,
    to_regprocedure('public.catalogue_media_guard()') is not null as guard_present,
    exists (select 1 from pg_trigger g where g.tgname = 'catalogue_product_versions_media_check' and g.tgrelid = to_regclass('public.catalogue_product_versions') and not g.tgisinternal) as version_check_present
),
p2m_problems as (
  select 'catalogue_media: guard trigger (active -> removed only, never while referenced) missing, disabled or not on catalogue_media_guard()' as problem
   where to_regclass('public.catalogue_media') is not null
     and not exists (select 1 from pg_trigger g where g.tgrelid = to_regclass('public.catalogue_media') and g.tgname = 'catalogue_media_guarded' and not g.tgisinternal and g.tgenabled <> 'D'
                       and g.tgfoid = to_regprocedure('public.catalogue_media_guard()') and (g.tgtype & 1) = 1 and (g.tgtype & 2) = 2 and (g.tgtype & 8) = 8 and (g.tgtype & 16) = 16)
  union all
  select 'catalogue_media: no-truncate trigger missing or disabled'
   where to_regclass('public.catalogue_media') is not null
     and not exists (select 1 from pg_trigger g where g.tgrelid = to_regclass('public.catalogue_media') and g.tgname = 'catalogue_media_no_truncate' and not g.tgisinternal and g.tgenabled <> 'D' and g.tgfoid = to_regprocedure('public.catalogue_refuse_change()'))
  union all
  select 'catalogue_media_derivatives: append-only/no-truncate trigger missing or disabled'
   where to_regclass('public.catalogue_media_derivatives') is not null
     and (select count(*) from pg_trigger g where g.tgrelid = to_regclass('public.catalogue_media_derivatives') and not g.tgisinternal and g.tgenabled <> 'D'
            and g.tgfoid = to_regprocedure('public.catalogue_refuse_change()') and g.tgname in ('catalogue_media_derivatives_append_only', 'catalogue_media_derivatives_no_truncate')) <> 2
  union all
  select t.name || ': service_role holds TRUNCATE'
    from p2m_tables t where to_regclass('public.' || t.name) is not null and has_table_privilege('service_role', to_regclass('public.' || t.name), 'TRUNCATE')
  union all
  select t.name || ': a foreign key is not ON DELETE RESTRICT (' || pg_get_constraintdef(c.oid) || ')'
    from p2m_tables t join pg_constraint c on c.conrelid = to_regclass('public.' || t.name) and c.contype = 'f'
   where c.confdeltype <> 'r'
  union all
  select t.name || ': expected foreign keys missing'
    from p2m_tables t where to_regclass('public.' || t.name) is not null
     and (select count(*) from pg_constraint c where c.conrelid = to_regclass('public.' || t.name) and c.contype = 'f' and c.confdeltype = 'r') <> 2
  union all
  select 'catalogue_product_versions: gallery check trigger missing or disabled while the media functions are installed'
   where to_regprocedure('public.catalogue_version_media_check()') is not null
     and not exists (select 1 from pg_trigger g where g.tgrelid = to_regclass('public.catalogue_product_versions') and g.tgname = 'catalogue_product_versions_media_check' and not g.tgisinternal
                       and g.tgenabled <> 'D' and g.tgfoid = to_regprocedure('public.catalogue_version_media_check()'))
),
p2p_tables(name) as (values ('catalogue_public_listings'), ('catalogue_public_events'), ('catalogue_slug_redirects'), ('catalogue_preview_grants')),
p2p_functions(sig) as (values
  ('catalogue_slug_redirect_check()'), ('catalogue_public_schema_version()'), ('catalogue_public_requirements(uuid)'), ('catalogue_public_release(uuid,integer,integer,text)'),
  ('catalogue_public_withdraw(uuid,integer,text,text)'), ('catalogue_change_slug(uuid,integer,text,text)'), ('catalogue_public_request_refresh(uuid)'),
  ('catalogue_public_record_refresh(uuid,integer,text,text)'), ('catalogue_create_preview_grant(uuid,text,integer)'), ('catalogue_revoke_preview_grants(uuid,text)')
),
p2p_state as (
  select
    (select count(*) from p2p_tables t where to_regclass('public.' || t.name) is not null) as tables_present,
    (select count(*) from p2p_tables) as tables_total,
    (select count(*) from p2p_functions f where to_regprocedure('public.' || f.sig) is not null) as functions_present,
    (select count(*) from p2p_functions) as functions_total,
    to_regprocedure('public.catalogue_public_listing_guard()') is not null and to_regprocedure('public.catalogue_preview_grant_guard()') is not null as guards_present,
    exists (select 1 from pg_trigger g where g.tgname = 'catalogue_products_slug_redirect_check' and g.tgrelid = to_regclass('public.catalogue_products') and not g.tgisinternal) as slug_check_present
),
p2p_trigger(tbl, tgname, fn, row_level, ev_update, ev_delete, ev_truncate) as (values
  ('catalogue_public_events', 'catalogue_public_events_append_only', 'catalogue_refuse_change()', true, true, true, false),
  ('catalogue_public_events', 'catalogue_public_events_no_truncate', 'catalogue_refuse_change()', false, false, false, true),
  ('catalogue_slug_redirects', 'catalogue_slug_redirects_append_only', 'catalogue_refuse_change()', true, true, true, false),
  ('catalogue_slug_redirects', 'catalogue_slug_redirects_no_truncate', 'catalogue_refuse_change()', false, false, false, true),
  ('catalogue_public_listings', 'catalogue_public_listings_no_delete', 'catalogue_public_listing_guard()', true, false, true, false),
  ('catalogue_public_listings', 'catalogue_public_listings_no_truncate', 'catalogue_refuse_change()', false, false, false, true),
  ('catalogue_preview_grants', 'catalogue_preview_grants_guarded', 'catalogue_preview_grant_guard()', true, true, true, false),
  ('catalogue_preview_grants', 'catalogue_preview_grants_no_truncate', 'catalogue_refuse_change()', false, false, false, true)
),
p2p_problems as (
  select x.tbl || ': trigger ' || x.tgname || ' missing, disabled or changed' as problem
    from p2p_trigger x where to_regclass('public.' || x.tbl) is not null
     and not exists (select 1 from pg_trigger g where g.tgrelid = to_regclass('public.' || x.tbl) and g.tgname = x.tgname and not g.tgisinternal and g.tgenabled <> 'D'
                       and g.tgfoid = to_regprocedure('public.' || x.fn) and ((g.tgtype & 1) = 1) = x.row_level and ((g.tgtype & 16) = 16) = x.ev_update
                       and ((g.tgtype & 8) = 8) = x.ev_delete and ((g.tgtype & 32) = 32) = x.ev_truncate)
  union all
  select t.name || ': service_role holds TRUNCATE'
    from p2p_tables t where to_regclass('public.' || t.name) is not null and has_table_privilege('service_role', to_regclass('public.' || t.name), 'TRUNCATE')
  union all
  select t.name || ': a foreign key is not ON DELETE RESTRICT (' || pg_get_constraintdef(c.oid) || ')'
    from p2p_tables t join pg_constraint c on c.conrelid = to_regclass('public.' || t.name) and c.contype = 'f' where c.confdeltype <> 'r'
  union all
  select t.name || ': expected foreign key missing'
    from p2p_tables t where to_regclass('public.' || t.name) is not null
     and (select count(*) from pg_constraint c where c.conrelid = to_regclass('public.' || t.name) and c.contype = 'f' and c.confdeltype = 'r') <> 1
  union all
  select 'catalogue_products: slug-redirect check missing or disabled while the public-release functions are installed'
   where to_regprocedure('public.catalogue_public_release(uuid,integer,integer,text)') is not null
     and not exists (select 1 from pg_trigger g where g.tgrelid = to_regclass('public.catalogue_products') and g.tgname = 'catalogue_products_slug_redirect_check' and not g.tgisinternal
                       and g.tgenabled <> 'D' and g.tgfoid = to_regprocedure('public.catalogue_slug_redirect_check()'))
),
baseline as (
  select 'B1 schema public is closed to the Data API roles (no USAGE for anon/authenticated)' as gate,
         case when not has_schema_privilege('anon','public','USAGE') and not has_schema_privilege('authenticated','public','USAGE') then 'PASS' else 'FAIL' end as status, '' as detail
  union all select 'B2 row level security on every public table',
         case when n = 0 then 'PASS' else 'FAIL' end, n || ' table(s) without RLS' from (select count(*) n from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r','p') and not relrowsecurity) x
  union all select 'B3 anon/authenticated hold no privilege on any public relation, column or sequence',
         case when n = 0 then 'PASS' else 'FAIL' end, n || ' grant(s)' from (
           select count(*) n from pg_class c, (values ('anon'),('authenticated')) r(r), (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(p)
            where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v','m','f') and has_table_privilege(r.r, c.oid, p.p)) a
  union all select 'B3b …and no column-level or sequence privilege',
         case when n = 0 then 'PASS' else 'FAIL' end, n || ' grant(s)' from (
           select (select count(*) from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped, (values ('anon'),('authenticated')) r(r)
                    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v','m','f') and (has_column_privilege(r.r, c.oid, a.attnum, 'SELECT') or has_column_privilege(r.r, c.oid, a.attnum, 'INSERT') or has_column_privilege(r.r, c.oid, a.attnum, 'UPDATE')))
                + (select count(*) from pg_class c, (values ('anon'),('authenticated')) r(r) where c.relnamespace = 'public'::regnamespace and c.relkind = 'S' and (has_sequence_privilege(r.r, c.oid, 'USAGE') or has_sequence_privilege(r.r, c.oid, 'SELECT'))) as n) y
  union all select 'B4 no public function is executable by anon/authenticated',
         case when n = 0 then 'PASS' else 'FAIL' end, n || ' function(s)' from (select count(*) n from pg_proc p where p.pronamespace = 'public'::regnamespace and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))) x
  union all select 'B5 no SECURITY DEFINER function and no view in public (nothing runs with the owner''s rights on a caller''s behalf) -- except the three reviewed intake-receipt functions while B10 holds for them',
         case when n = 0 then 'PASS' else 'REVIEW' end, n || ' object(s)' from (
           select (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef
                     and p.oid not in (select s.oid from p0_fn_state s where s.approved and s.want_secdef)) + (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('v','m')) as n) x
  union all select 'B6 service_role keeps the rights the application uses on every public table (20261027 intentionally withholds UPDATE/DELETE on the append-only settings history and DELETE on MFA credentials; office_intake_receipts is SELECT-only by design while B10 holds)',
         case when n = 0 then 'PASS' else 'FAIL' end, n || ' table(s) lacking a right' from (
           select count(*) n from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p')
              and c.oid not in (select t.oid from p0_tbl t where t.approved and has_table_privilege('service_role', t.oid, 'SELECT'))
              -- Only these three relations, and only while the ENTIRE reviewed Phase 3 shape is intact.
              and not (c.relname in ('catalogue_merchandising','catalogue_merchandising_versions','catalogue_merchandising_events') and (select intact from p3_state))
              and (not (has_table_privilege('service_role', c.oid, 'SELECT') and has_table_privilege('service_role', c.oid, 'INSERT'))
                   or (c.relname <> 'office_runtime_setting_history' and not has_table_privilege('service_role', c.oid, 'UPDATE'))
                   or (c.relname not in ('office_runtime_setting_history', 'admin_mfa_credentials') and not has_table_privilege('service_role', c.oid, 'DELETE')))) x
  union all select 'B7 no row level security policy in public (deny by default stays deny by default)',
         case when n = 0 then 'PASS' else 'REVIEW' end, n || ' policy(ies)' from (select count(*) n from pg_policy p join pg_class c on c.oid = p.polrelid where c.relnamespace = 'public'::regnamespace) x
  union all select 'B8 PUBLIC holds nothing on any public relation',
         case when n = 0 then 'PASS' else 'FAIL' end, n || ' relation(s)' from (select count(*) n from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v','m','f','S') and exists (select 1 from aclexplode(c.relacl) a where a.grantee = 0)) x
  union all select 'B9 the four credential tables and the settings table: RLS on and no privilege for anon/authenticated/PUBLIC',
         case when n = 0 then 'PASS' else 'FAIL' end, n || ' problem(s)' from (
           select count(*) n from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname in ('admin_users','admin_invites','password_reset_tokens','audit_events','office_runtime_settings')
              and (not c.relrowsecurity or has_table_privilege('anon', c.oid, 'SELECT') or has_table_privilege('authenticated', c.oid, 'SELECT') or exists (select 1 from aclexplode(c.relacl) a where a.grantee = 0))) x
  union all select 'B10 intake receipts (20261101): reviewed restricted design intact (table RLS on, no policy/trigger, service_role SELECT only, no column grants; functions match reviewed fingerprints, owner postgres, EXECUTE service_role only)',
         case when s.all_present_approved then 'PASS' else 'FAIL' end,
         case when s.status = 'ABSENT' then 'not installed'
              when s.all_present_approved then 'intact (' || lower(s.status) || ')'
              else 'deviates: ' || concat_ws('; ', case when s.bad_tbl then 'table office_intake_receipts' end, case when s.bad_fns is not null then 'functions ' || s.bad_fns end) end
  from p0_status s
  union all select 'B11 product catalogue (20261102): reviewed design intact (history append-only + no truncate, SECURITY INVOKER functions with pinned search_path, EXECUTE service_role only, no function touches costs)',
         case when (select count(*) from p1_problems) = 0 then 'PASS' else 'FAIL' end,
         case when (select tables_present from p1_state) = 0 and (select functions_present from p1_state) = 0 then 'not installed'
              when (select count(*) from p1_problems) = 0 then 'intact'
              else 'deviates: ' || (select string_agg(problem, '; ' order by problem) from p1_problems) end
  union all select 'B12 product gallery media (20261104): reviewed design intact (media immutable except unreferenced removal, renditions append-only, no truncate, ON DELETE RESTRICT to products/office_files, version gallery check installed with the functions)',
         case when (select count(*) from p2m_problems) = 0 then 'PASS' else 'FAIL' end,
         case when (select tables_present from p2m_state) = 0 and (select functions_present from p2m_state) = 0 then 'not installed'
              when (select count(*) from p2m_problems) = 0 then 'intact'
              else 'deviates: ' || (select string_agg(problem, '; ' order by problem) from p2m_problems) end
  union all select 'B13 public release (20261105): reviewed design intact (events and redirects append-only, listings undeletable, preview grants revocable only, no truncate, ON DELETE RESTRICT, slug-redirect check installed with the functions)',
         case when (select count(*) from p2p_problems) = 0 then 'PASS' else 'FAIL' end,
         case when (select tables_present from p2p_state) = 0 and (select functions_present from p2p_state) = 0 then 'not installed'
              when (select count(*) from p2p_problems) = 0 then 'intact'
              else 'deviates: ' || (select string_agg(problem, '; ' order by problem) from p2p_problems) end
  union all select 'B14 campaign schema: exact reviewed owners, ACLs, RLS, constraints, immutable guards and transition definition',
    case when object_count=0 or intact then 'PASS' else 'FAIL' end,
    case when object_count=0 then 'not installed' when intact then 'intact' else 'schema differs from reviewed Phase 3 manifest; B6 exception denied' end from p3_state
  union all select 'B15 hardware order schema: exact owner, grants, RLS, constraints, immutable guards and functions', case when object_count=0 or intact then 'PASS' else 'FAIL' end, case when object_count=0 then 'not installed' when intact then 'intact' else 'order schema differs from reviewed manifest' end from p4_state
),
stage_rows as (
  select 'STAGE ' || s.stage || ' (' || case s.stage when 'S1' then '20261019 + 20261020 + 20261021' when 'S2' then '20261026' when 'S3' then '20261028' when 'S4' then '20261022-20261025 + 20261029-20261031' end || ')' as gate,
         s.status, case when s.status = 'APPLIED' then s.present || ' of ' || s.objects || ' objects present' else s.present || ' of ' || s.objects || ' present; missing: ' || s.missing end as detail
  from stage_status s
  union all select 'STAGE S5 (20261027 service_role narrowing on credential/history tables)',
         case when not bool_or(exists_) then 'NOT_APPLICABLE' when bool_and(narrowed) filter (where exists_) then 'APPLIED' when not bool_or(narrowed) filter (where exists_) then 'ABSENT' else 'PARTIAL' end,
         coalesce(string_agg(tbl || case when narrowed then ':narrowed' else ':BROAD' end, ', ' order by tbl) filter (where exists_), 'none of its tables exist yet')
  from narrow
  union all select 'STAGE P0 (20261101 office intake receipts)', s.status,
         case s.status when 'ABSENT' then 'table and 4 functions absent' when 'APPLIED' then 'table + 4 functions present'
              when 'ROLLED_BACK' then 'table kept, functions removed (documented rollback: Office falls back; review crm_failed rows)'
              else 'PARTIAL: missing ' || coalesce(s.missing_fns, case when s.bad_tbl is null then 'table office_intake_receipts' end, '?') end
  from p0_status s
  union all select 'STAGE P1 (20261102 product catalogue)',
         case when s.tables_present = 0 and s.functions_present = 0 then 'ABSENT'
              when s.tables_present = s.tables_total and s.functions_present = s.functions_total then 'APPLIED'
              when s.tables_present = s.tables_total and s.functions_present = 1 and s.guard_present then 'ROLLED_BACK'
              else 'PARTIAL' end,
         s.tables_present || ' of ' || s.tables_total || ' tables, ' || s.functions_present || ' of ' || s.functions_total || ' functions'
  from p1_state s
  union all select 'STAGE P2M (20261104 product gallery media)',
         case when s.tables_present = 0 and s.functions_present = 0 and not s.guard_present then 'ABSENT'
              when s.tables_present = s.tables_total and s.functions_present = s.functions_total and s.guard_present and s.version_check_present then 'APPLIED'
              when s.tables_present = s.tables_total and s.functions_present = 0 and s.guard_present and not s.version_check_present then 'ROLLED_BACK'
              else 'PARTIAL' end,
         s.tables_present || ' of ' || s.tables_total || ' tables, ' || s.functions_present || ' of ' || s.functions_total || ' functions, guard ' || case when s.guard_present then 'present' else 'absent' end
           || ', version check ' || case when s.version_check_present then 'present' else 'absent' end
  from p2m_state s
  union all select 'STAGE P2P (20261105 public release, slugs, previews)',
         case when s.tables_present = 0 and s.functions_present = 0 and not s.guards_present then 'ABSENT'
              when s.tables_present = s.tables_total and s.functions_present = s.functions_total and s.guards_present and s.slug_check_present then 'APPLIED'
              when s.tables_present = s.tables_total and s.functions_present = 0 and s.guards_present and not s.slug_check_present then 'ROLLED_BACK'
              else 'PARTIAL' end,
         s.tables_present || ' of ' || s.tables_total || ' tables, ' || s.functions_present || ' of ' || s.functions_total || ' functions, guards ' || case when s.guards_present then 'present' else 'absent' end
           || ', slug check ' || case when s.slug_check_present then 'present' else 'absent' end
  from p2p_state s
  union all select 'STAGE P3 (20261106 merchandising)', status, 'exact reviewed shape or wholly absent; partial/drift requires investigation' from p3_state
  union all select 'STAGE P4A (hardware orders)',status,'staff-only non-payable order foundation' from p4_state
),
orders as (
  select 'ORDER S2 needs S1 (admin_users.session_generation)' as gate,
         case when (select status from stage_status where stage = 'S2') <> 'ABSENT' and (select status from stage_status where stage = 'S1') <> 'APPLIED' then 'FAIL' else 'PASS' end as status, '' as detail
  union all select 'ORDER S4 needs S1 (session generation) before any MFA object',
         case when (select status from stage_status where stage = 'S4') <> 'ABSENT' and (select status from stage_status where stage = 'S1') <> 'APPLIED' then 'FAIL' else 'PASS' end, ''
  union all select 'ORDER P2M needs P1 (20261104 requires the 20261102 catalogue)',
         case when (select tables_present from p2m_state) > 0 and (select tables_present from p1_state) < (select tables_total from p1_state) then 'FAIL' else 'PASS' end, ''
  union all select 'ORDER P2P needs P2M (20261105 requires 20261104)',
         case when (select tables_present from p2p_state) > 0 and (select tables_present from p2m_state) < (select tables_total from p2m_state) then 'FAIL' else 'PASS' end, ''
  union all select 'FOLLOW-UP S5: every credential/history table created by an earlier stage is narrowed for service_role',
         case when exists (select 1 from narrow where exists_ and not narrowed) then 'PENDING' else 'PASS' end, 'run 20261027 after S1 and again after S4; re-run it after any later table it covers'
  union all select 'ORDER P3 needs P2P APPLIED', case when (select object_count from p3_state)>0 and not exists(select 1 from stage_rows where gate like 'STAGE P2P %' and status='APPLIED') then 'FAIL' else 'PASS' end, ''
  union all select 'ORDER P4A needs P3 APPLIED', case when (select object_count from p4_state)>0 and not exists(select 1 from stage_rows where gate like 'STAGE P3 %' and status='APPLIED') then 'FAIL' else 'PASS' end,''
),
all_rows as (
  select 1 as o, gate, status, detail from baseline
  union all select 2, gate, status, detail from stage_rows
  union all select 3, gate, status, detail from orders
)
select gate, status, detail from (
  select o, gate, status, detail from all_rows
  union all select 4, 'VERDICT (GO = every BASELINE row PASS, no stage PARTIAL, no ORDER failure, nothing pending)',
         case when exists (select 1 from all_rows where (o = 1 and status = 'FAIL') or (o = 2 and status = 'PARTIAL') or (o = 3 and status = 'FAIL')) then 'NO-GO'
              when exists (select 1 from all_rows where (o = 1 and status = 'REVIEW') or (o = 2 and status = 'ROLLED_BACK') or (o = 3 and status = 'PENDING')) then 'GO-WITH-REVIEW' else 'GO' end,
         (select count(*) from all_rows where o = 1 and status = 'PASS') || ' of ' || (select count(*) from all_rows where o = 1) || ' baseline rows PASS'
) z order by o, gate;
