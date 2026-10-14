-- EMERGENCY CONTAINMENT (not the full fix): removes the Data API roles' privileges on existing objects in schema public and changes nothing else (no RLS change,
-- no schema-USAGE change, no default-privilege change). Use only if the full migration must be delayed. Re-run the full migration afterwards; it is a superset.
begin;
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
do $$
declare exposed int; svc_missing int;
begin
  select count(*) into exposed from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join (values ('anon'), ('authenticated')) r(role_name) cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) p(priv)
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f') and has_table_privilege(r.role_name, c.oid, p.priv);
  if exposed > 0 then raise exception 'containment failed: % privileges remain', exposed; end if;
  select count(*) into svc_missing from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p')
    and not (has_table_privilege('service_role', c.oid, 'SELECT') and has_table_privilege('service_role', c.oid, 'INSERT') and has_table_privilege('service_role', c.oid, 'UPDATE') and has_table_privilege('service_role', c.oid, 'DELETE'));
  if svc_missing > 0 then raise exception 'containment failed: service_role lost access to % tables', svc_missing; end if;
end $$;
commit;
