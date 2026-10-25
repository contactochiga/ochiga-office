-- DRAFT FOR RELEASE REVIEW ONLY. Not applied to production.
-- Additive merchandising snapshots; products/prices/media remain in the existing catalogue.
-- Same SECURITY INVOKER / RLS / service-role boundary as catalogue foundation.
create table if not exists catalogue_merchandising (
 id integer primary key check(id=1), row_version integer not null default 0,
 current_version integer not null default 0, published_version integer,
 workflow text not null default 'draft' check(workflow in ('draft','in_review','approved','published')),
 authors text[] not null default '{}', check(row_version>=0 and current_version>=0),
 check(published_version is null or (published_version>0 and published_version<=current_version))
);
insert into catalogue_merchandising(id) values(1) on conflict do nothing;
create table if not exists catalogue_merchandising_versions (
 version integer primary key check(version>0), content jsonb not null,
 authors text[] not null, created_at timestamptz not null default now(),
 check(jsonb_typeof(content)='object'),
 check(jsonb_typeof(content->'slides')='array' and jsonb_array_length(content->'slides')<=8),
 check(jsonb_typeof(content->'collections')='array' and jsonb_array_length(content->'collections')<=8),
 check(jsonb_typeof(content->'featured')='array' and jsonb_array_length(content->'featured')<=24),
 check(jsonb_typeof(content->'new_arrivals')='array' and jsonb_array_length(content->'new_arrivals')<=24)
);
create table if not exists catalogue_merchandising_events (
 id bigint generated always as identity primary key, action text not null,
 version integer not null, current_version integer not null, previous_published_version integer, actor text not null check(length(actor) between 1 and 320),
 note text not null default '' check(length(note)<=500), created_at timestamptz not null default now()
);
alter table catalogue_merchandising enable row level security;
alter table catalogue_merchandising_versions enable row level security;
alter table catalogue_merchandising_events enable row level security;
revoke all on catalogue_merchandising,catalogue_merchandising_versions,catalogue_merchandising_events from public,anon,authenticated,service_role;
grant select,insert,update on catalogue_merchandising to service_role;
grant select,insert on catalogue_merchandising_versions,catalogue_merchandising_events to service_role;
-- Clear inherited default sequence grants: UPDATE would permit setval().
revoke all on sequence catalogue_merchandising_events_id_seq from public,anon,authenticated,service_role;
grant usage,select on sequence catalogue_merchandising_events_id_seq to service_role;
drop trigger if exists merchandising_versions_immutable on catalogue_merchandising_versions;
create trigger merchandising_versions_immutable before update or delete on catalogue_merchandising_versions for each row execute function catalogue_refuse_change();
drop trigger if exists merchandising_events_immutable on catalogue_merchandising_events;
create trigger merchandising_events_immutable before update or delete on catalogue_merchandising_events for each row execute function catalogue_refuse_change();

create or replace function catalogue_merchandising_transition(p_action text,p_expected integer,p_content jsonb,p_actor text,p_note text default '')
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare s catalogue_merchandising%rowtype; v_authors text[]; v_previous_published integer;
begin
 if p_actor is null or length(trim(p_actor))=0 or length(p_actor)>320 then raise exception using errcode='PT400',message='invalid_actor'; end if;
 p_actor:=lower(trim(p_actor));
 select * into s from catalogue_merchandising where id=1 for update;
 if not found or p_expected is null or s.row_version<>p_expected then raise exception using errcode='PT409',message='state_changed'; end if;
 v_previous_published:=s.published_version;
 if p_action='save' then
   if p_content is null or not (p_content ?& array['slides','featured','new_arrivals','collections']) then raise exception using errcode='PT400',message='invalid_merchandising'; end if;
   select array_agg(distinct a) into v_authors from unnest(case when s.workflow='published' then array[p_actor] else array_append(s.authors,p_actor) end) as a;
   s.current_version:=s.current_version+1; s.authors:=v_authors; s.workflow:='draft';
   insert into catalogue_merchandising_versions(version,content,authors) values(s.current_version,p_content,s.authors);
 elsif p_action='submit' and s.current_version>0 and s.workflow='draft' then s.workflow:='in_review';
 elsif p_action in ('approve','reject') and s.workflow='in_review' then
   if p_actor=any(s.authors) then raise exception using errcode='PT403',message='self_review_forbidden'; end if;
   s.workflow:=case when p_action='approve' then 'approved' else 'draft' end;
 elsif p_action='publish' and s.workflow='approved' then s.published_version:=s.current_version; s.workflow:='published';
 elsif p_action='withdraw' and s.published_version is not null then s.published_version:=null;
 else raise exception using errcode='PT409',message='invalid_campaign_transition'; end if;
 s.row_version:=s.row_version+1;
 update catalogue_merchandising set row_version=s.row_version,current_version=s.current_version,published_version=s.published_version,workflow=s.workflow,authors=s.authors where id=1;
 insert into catalogue_merchandising_events(action,version,current_version,previous_published_version,actor,note) values(p_action,case when p_action='withdraw' then v_previous_published else s.current_version end,s.current_version,v_previous_published,p_actor,coalesce(p_note,''));
 return to_jsonb(s);
end $$;
revoke all on function catalogue_merchandising_transition(text,integer,jsonb,text,text) from public,anon,authenticated;
grant execute on function catalogue_merchandising_transition(text,integer,jsonb,text,text) to service_role;

-- History cannot be truncated even by its owner.
drop trigger if exists merchandising_versions_no_truncate on catalogue_merchandising_versions;
create trigger merchandising_versions_no_truncate before truncate on catalogue_merchandising_versions for each statement execute function catalogue_refuse_change();
drop trigger if exists merchandising_events_no_truncate on catalogue_merchandising_events;
create trigger merchandising_events_no_truncate before truncate on catalogue_merchandising_events for each statement execute function catalogue_refuse_change();
