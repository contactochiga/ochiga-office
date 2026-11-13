-- Read-only gate for the Office security baseline. Raises an exception listing every violation;
-- succeeds silently otherwise. Run after office-security-baseline.sql (see db/migration-order.txt).
do $$
declare
  v text[] := '{}';
  r record;
  blocked oid[] := array[0::oid, 'anon'::regrole::oid, 'authenticated'::regrole::oid];
begin
  -- 1. schema access
  if exists (select 1 from pg_namespace n cross join lateral aclexplode(coalesce(n.nspacl, acldefault('n'::"char", n.nspowner))) x
             where n.nspname = 'public' and x.grantee = any (blocked)) then
    v := array_append(v, 'schema public: PUBLIC/anon/authenticated has USAGE or CREATE');
  end if;
  if not has_schema_privilege('service_role', 'public', 'USAGE') then
    v := array_append(v, 'schema public: service_role lacks USAGE');
  end if;

  -- 2. relations (tables, partitions, views, materialized views, sequences, foreign tables)
  for r in select c.oid::regclass::text as rel, x.grantee::regrole::text as who, x.privilege_type as priv
           from pg_class c cross join lateral aclexplode(coalesce(c.relacl, acldefault((case when c.relkind = 'S' then 's' else 'r' end)::"char", c.relowner))) x
           where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f') and x.grantee = any (blocked)
  loop
    v := array_append(v, format('%s: %s has %s', r.rel, case when r.who = '-' then 'PUBLIC' else r.who end, r.priv));
  end loop;

  -- 3. column grants
  for r in select c.oid::regclass::text as rel, a.attname as col, x.grantee
           from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped and a.attacl is not null
           cross join lateral aclexplode(a.attacl) x
           where c.relnamespace = 'public'::regnamespace and x.grantee = any (blocked)
  loop
    v := array_append(v, format('%s.%s: column grant to %s', r.rel, r.col, case when r.grantee = 0 then 'PUBLIC' else r.grantee::regrole::text end));
  end loop;

  -- 4. routines (a NULL ACL means the default, which includes PUBLIC EXECUTE)
  for r in select p.oid::regprocedure::text as fn, x.grantee
           from pg_proc p cross join lateral aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) x
           where p.pronamespace = 'public'::regnamespace and x.grantee = any (blocked)
  loop
    v := array_append(v, format('%s: EXECUTE for %s', r.fn, case when r.grantee = 0 then 'PUBLIC' else r.grantee::regrole::text end));
  end loop;

  -- 5. RLS on every table
  for r in select c.oid::regclass::text as rel from pg_class c
           where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relrowsecurity
  loop
    v := array_append(v, format('%s: RLS disabled', r.rel));
  end loop;

  -- 6. default privileges of the migration owner
  for r in select coalesce(n.nspname, '(all schemas)') as scope, d.defaclobjtype::text as kind, x.grantee
           from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
           cross join lateral aclexplode(d.defaclacl) x
           where d.defaclrole = 'postgres'::regrole and coalesce(n.nspname, 'public') = 'public' and x.grantee = any (blocked)
  loop
    v := array_append(v, format('default privileges (postgres, %s, type %s) grant to %s', r.scope, r.kind,
      case when r.grantee = 0 then 'PUBLIC' else r.grantee::regrole::text end));
  end loop;
  if not exists (select 1 from pg_default_acl d where d.defaclrole = 'postgres'::regrole and d.defaclnamespace = 0 and d.defaclobjtype = 'f') then
    v := array_append(v, 'default privileges (postgres, all schemas): PUBLIC EXECUTE on new routines not revoked');
  end if;

  -- 7. objects owned by another role are not covered by the owner's default privileges
  for r in select c.oid::regclass::text as obj, pg_get_userbyid(c.relowner) as owner from pg_class c
           where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f') and c.relowner <> 'postgres'::regrole
           union all
           select p.oid::regprocedure::text, pg_get_userbyid(p.proowner) from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.proowner <> 'postgres'::regrole
  loop
    v := array_append(v, format('%s: owned by %s, not postgres', r.obj, r.owner));
  end loop;

  -- 8. required trusted-server access: service_role reads every table and view
  for r in select c.oid::regclass::text as rel from pg_class c
           where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm')
             and not has_table_privilege('service_role', c.oid, 'SELECT')
  loop
    v := array_append(v, format('%s: service_role cannot SELECT', r.rel));
  end loop;

  if cardinality(v) > 0 then
    raise exception 'office security baseline violated (% finding(s)): %', cardinality(v), array_to_string(v, '; ');
  end if;
end;
$$;
