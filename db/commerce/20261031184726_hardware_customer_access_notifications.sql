-- LOCAL: apply after Phase 5D. No existing orders are backfilled or notified.
-- Service-only invoker functions. Customer email proof never conveys financial authority.
create table hardware_customer_challenges (
 id uuid primary key, client text not null, order_id uuid references hardware_orders(id),
 identity_hash text not null check(identity_hash ~ '^[0-9a-f]{64}$'),
 code_hash text not null check(code_hash ~ '^[0-9a-f]{64}$'),
 attempts integer not null default 0 check(attempts between 0 and 5),
 consumed_at timestamptz, created_at timestamptz not null default now(), expires_at timestamptz not null default now()+interval '10 minutes'
);
create index hardware_customer_challenges_rate on hardware_customer_challenges(client,identity_hash,created_at);
create table hardware_customer_grants (
 token_hash text primary key check(token_hash ~ '^[0-9a-f]{64}$'), client text not null,
 order_id uuid not null references hardware_orders(id), challenge_id uuid not null unique references hardware_customer_challenges(id),
 created_at timestamptz not null default now(), expires_at timestamptz not null default now()+interval '24 hours', revoked_at timestamptz
);
create table hardware_customer_email_outbox (
 id uuid primary key default gen_random_uuid(), event_key text not null unique,
 order_id uuid not null references hardware_orders(id), kind text not null,
 payload jsonb not null, created_at timestamptz not null default now(),
 state text not null default 'pending' check(state in ('pending','leased','accepted','review')),
 attempts integer not null default 0 check(attempts between 0 and 10),
 next_at timestamptz not null default now(), first_attempt_at timestamptz,
 lease_id uuid, lease_until timestamptz, accepted_at timestamptz,
 check(kind in ('access_code','created','cancelled','delivery_confirmed','paid','payment_failed','under_review','packed','dispatched','delivered','installed','closed','installation_requested','installation_scheduled','installation_rescheduled','installation_started','installation_completed','installation_cancelled'))
);
create index hardware_customer_email_due on hardware_customer_email_outbox(next_at) where state in ('pending','leased');
create table hardware_customer_access_events (
 id uuid primary key default gen_random_uuid(), order_id uuid references hardware_orders(id),
 action text not null, target_id uuid, created_at timestamptz not null default now()
);
create trigger customer_access_events_immutable before update or delete on hardware_customer_access_events for each row execute function hardware_order_immutable();
create trigger customer_access_events_no_truncate before truncate on hardware_customer_access_events for each statement execute function hardware_order_immutable();
do $$declare t text;begin
 foreach t in array array['hardware_customer_challenges','hardware_customer_grants','hardware_customer_email_outbox','hardware_customer_access_events'] loop
 execute format('alter table %I enable row level security',t);
 execute format('revoke all on %I from public,anon,authenticated,service_role',t);
 execute format('grant select,insert,update on %I to service_role',t);
 end loop;end$$;

create function hardware_customer_email_enqueue(p_order uuid,p_key text,p_kind text,p_extra jsonb default '{}') returns void
 language plpgsql set search_path=public,pg_temp as $$begin
 insert into hardware_customer_email_outbox(event_key,order_id,kind,payload)
 select p_key,o.id,p_kind,jsonb_build_object('version',1,'goods_kobo',o.goods_total_kobo,'delivery_kobo',o.delivery_total_kobo,'total_kobo',o.payable_total_kobo,'tax_kobo',o.goods_tax_kobo,'at',now())||p_extra
 from hardware_orders o where o.id=p_order on conflict(event_key) do nothing;
end$$;

create function hardware_customer_access_request(p_client text,p_reference text,p_email text,p_identity_hash text,p_id uuid,p_code_hash text) returns void
 language plpgsql set search_path=public,pg_temp as $$declare ids uuid[]; oid uuid;begin
 if p_client is null or p_client !~ '^[a-z0-9_-]{1,40}$' or p_identity_hash is null or p_identity_hash !~ '^[0-9a-f]{64}$' or p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' or p_id is null
 or length(p_email)>254 or p_email is null or p_reference is null or length(p_reference)>36 then raise exception 'invalid_access_request' using errcode='PT400';end if;
 -- Shared identity throttle survives restarts. All well-formed requests have the same external response.
 perform pg_advisory_xact_lock(hashtextextended('customer-access:'||p_client||':'||p_identity_hash,0));
 if (select count(*) from hardware_customer_challenges where client=p_client and identity_hash=p_identity_hash and created_at>now()-interval '1 hour')>=5 then return;end if;
 select array_agg(r.order_id) into ids from hardware_checkout_receipts r join hardware_order_private p on p.order_id=r.order_id
 where r.client=p_client and lower(trim(p.customer->>'email'))=lower(trim(p_email))
 and (r.order_id::text=lower(p_reference) or 'HW-'||upper(left(replace(r.order_id::text,'-',''),8))=upper(p_reference));
 -- A short-reference collision is never resolved arbitrarily.
 if cardinality(ids)=1 then oid:=ids[1];end if;
 insert into hardware_customer_challenges(id,client,order_id,identity_hash,code_hash) values(p_id,p_client,oid,p_identity_hash,p_code_hash);
 if oid is not null then
 perform hardware_customer_email_enqueue(oid,'access:'||p_id,'access_code',jsonb_build_object('challenge_id',p_id));
 insert into hardware_customer_access_events(order_id,action,target_id) values(oid,'code_requested',p_id);
 end if;
end$$;

create function hardware_customer_access_verify(p_client text,p_id uuid,p_code_hash text,p_token_hash text) returns jsonb
 language plpgsql set search_path=public,pg_temp as $$declare c hardware_customer_challenges%rowtype;begin
 if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'invalid_access_request' using errcode='PT400';end if;
 select * into c from hardware_customer_challenges where id=p_id and client=p_client for update;
 if not found or c.consumed_at is not null or c.expires_at<=now() or c.attempts>=5 then return null;end if;
 update hardware_customer_challenges set attempts=attempts+1 where id=c.id;
 -- Returning null instead of throwing preserves failed-attempt accounting.
 if c.order_id is null or c.code_hash is distinct from p_code_hash then return null;end if;
 perform pg_advisory_xact_lock(hashtextextended('customer-grant:'||c.order_id::text,0));
 update hardware_customer_challenges set consumed_at=now() where id=c.id;
 update hardware_customer_grants set revoked_at=now() where token_hash in (
 select token_hash from hardware_customer_grants where order_id=c.order_id and revoked_at is null and expires_at>now() order by created_at desc offset 4);
 insert into hardware_customer_grants(token_hash,client,order_id,challenge_id) values(p_token_hash,p_client,c.order_id,c.id);
 insert into hardware_customer_access_events(order_id,action,target_id) values(c.order_id,'access_verified',p_id);
 return jsonb_build_object('order_id',c.order_id,'expires_at',now()+interval '24 hours');
end$$;

create function hardware_customer_access_owner(p_client text,p_order uuid,p_token_hash text) returns text
 language plpgsql stable set search_path=public,pg_temp as $$declare g text;begin
 select r.guest_hash into g from hardware_customer_grants a join hardware_checkout_receipts r on r.order_id=a.order_id and r.client=a.client
 where a.client=p_client and a.order_id=p_order and a.token_hash=p_token_hash and a.revoked_at is null and a.expires_at>now();
 if g is null then raise exception 'order_not_found' using errcode='PT404';end if;return g;
end$$;
create function hardware_customer_access_progress(p_client text,p_order uuid,p_token_hash text) returns jsonb
 language sql stable set search_path=public,pg_temp as $$select hardware_order_public_progress(p_client,hardware_customer_access_owner(p_client,p_order,p_token_hash),p_order)$$;
-- Email proof for one order permits a bounded history of the same verified mailbox/client.
-- Financial actions remain individually order-bound; this never returns a grant or guest hash.
create function hardware_customer_access_history(p_client text,p_order uuid,p_token_hash text) returns jsonb
 language plpgsql stable set search_path=public,pg_temp as $$declare email text;result jsonb;begin
 perform hardware_customer_access_owner(p_client,p_order,p_token_hash);
 select lower(trim(customer->>'email')) into email from hardware_order_private where order_id=p_order;
 select coalesce(jsonb_agg(hardware_order_public_progress(p_client,r.guest_hash,r.order_id) order by r.created_at desc,r.order_id),'[]') into result
 from (select c.* from hardware_checkout_receipts c join hardware_order_private p on p.order_id=c.order_id
 where c.client=p_client and lower(trim(p.customer->>'email'))=email order by c.created_at desc,c.order_id limit 50) r;
 return result;
end$$;
create function hardware_customer_access_revoke(p_client text,p_order uuid,p_token_hash text) returns void
 language plpgsql set search_path=public,pg_temp as $$begin
 perform hardware_customer_access_owner(p_client,p_order,p_token_hash);
 update hardware_customer_grants set revoked_at=now() where token_hash=p_token_hash;
 insert into hardware_customer_access_events(order_id,action) values(p_order,'signed_out');end$$;

create function hardware_customer_event_email() returns trigger language plpgsql set search_path=public,pg_temp as $$
declare oid uuid; k text; event_key text;begin
 if tg_table_name='hardware_order_events' then oid:=new.order_id;k:=new.event_type;event_key:=new.id::text;
 elsif tg_table_name='hardware_payment_history' then oid:=new.order_id;k:=case when new.event_type='delivery_confirmed' then 'delivery_confirmed' end;event_key:=new.id::text;
 elsif tg_table_name='hardware_payment_confirmations' then oid:=new.order_id;k:=case when new.outcome='paid' then 'paid' else 'under_review' end;event_key:=new.reference;
 elsif tg_table_name='hardware_financial_observations' then oid:=new.order_id;k:=case when new.state='provider_failed' then 'payment_failed' when new.state in ('disputed','amount_mismatch','refund_processed','refund_escalated') then 'under_review' end;event_key:=new.event_id::text;
 elsif tg_table_name='hardware_fulfilment_events' then oid:=new.order_id;k:=case when new.to_state in ('packed','dispatched','delivered','installed','closed') then new.to_state end;event_key:=new.id::text;
 elsif tg_table_name='hardware_service_visit_events' then
 select order_id into oid from hardware_service_visits where id=new.visit_id and kind='installation';
 k:=case when new.event_type in ('requested','scheduled','rescheduled','started','completed','cancelled') then 'installation_'||new.event_type end;event_key:=new.id::text;
 end if;
 if oid is not null and k is not null then perform hardware_customer_email_enqueue(oid,tg_table_name||':'||event_key,k);end if;
 if oid is not null and k in ('cancelled','under_review') then
 update hardware_customer_grants set revoked_at=now() where order_id=oid and revoked_at is null;
 insert into hardware_customer_access_events(order_id,action) values(oid,'grants_revoked');end if;
 return new;
end$$;
do $$declare t text;begin foreach t in array array['hardware_order_events','hardware_payment_history','hardware_payment_confirmations','hardware_financial_observations','hardware_fulfilment_events','hardware_service_visit_events'] loop
 execute format('create trigger customer_event_email after insert on %I for each row execute function hardware_customer_event_email()',t);end loop;end$$;

-- Durable lease/CAS plus provider idempotency; no retry after the provider's 24-hour retention.
create function hardware_customer_email_claim() returns jsonb language plpgsql set search_path=public,pg_temp as $$
declare q hardware_customer_email_outbox%rowtype;recipient text;begin
 update hardware_customer_email_outbox set state='review',lease_id=null,lease_until=null where state in ('pending','leased') and (first_attempt_at<now()-interval '23 hours' or attempts>=10)
 and (lease_until is null or lease_until<now());
 select * into q from hardware_customer_email_outbox where (state='pending' or (state='leased' and lease_until<now())) and next_at<=now()
 and attempts<10 and (first_attempt_at is null or first_attempt_at>now()-interval '23 hours') order by created_at,id for update skip locked limit 1;
 if not found then return null;end if;
 update hardware_customer_email_outbox set state='leased',attempts=attempts+1,first_attempt_at=coalesce(first_attempt_at,now()),lease_id=gen_random_uuid(),lease_until=now()+interval '90 seconds' where id=q.id returning * into q;
 select customer->>'email' into recipient from hardware_order_private where order_id=q.order_id;
 insert into hardware_customer_access_events(order_id,action,target_id) values(q.order_id,'email_attempt',q.id);
 return to_jsonb(q)||jsonb_build_object('recipient',recipient);
end$$;
create function hardware_customer_email_finish(p_id uuid,p_lease uuid,p_result text,p_delay integer) returns boolean language plpgsql set search_path=public,pg_temp as $$
declare oid uuid;begin
 if p_result not in ('accepted','retry','review') or p_delay not between 30 and 3600 then raise exception 'invalid_delivery_result' using errcode='PT400';end if;
 update hardware_customer_email_outbox set state=case when p_result='retry' then 'pending' else p_result end,
 accepted_at=case when p_result='accepted' then now() else null end, next_at=now()+make_interval(secs=>p_delay),lease_id=null,lease_until=null
 where id=p_id and lease_id=p_lease and state='leased' and lease_until>now() returning order_id into oid;
 if not found then return false;end if;
 insert into hardware_customer_access_events(order_id,action,target_id) values(oid,'email_'||p_result,p_id);return true;
end$$;
-- Guard immutable envelopes: repeated delivery uses exactly the original body/recipient facts.
create function hardware_customer_email_guard() returns trigger language plpgsql set search_path=public,pg_temp as $$begin
 if tg_op<>'UPDATE' or (to_jsonb(new)-array['state','attempts','next_at','first_attempt_at','lease_id','lease_until','accepted_at']) is distinct from (to_jsonb(old)-array['state','attempts','next_at','first_attempt_at','lease_id','lease_until','accepted_at']) then raise exception 'immutable_email_envelope';end if;return new;end$$;
create trigger customer_email_guard before update or delete on hardware_customer_email_outbox for each row execute function hardware_customer_email_guard();
create trigger customer_email_no_truncate before truncate on hardware_customer_email_outbox for each statement execute function hardware_order_immutable();
do $$declare f record;begin for f in select oid::regprocedure as signature from pg_proc where pronamespace='public'::regnamespace and proname like 'hardware_customer_%' loop
 execute format('revoke all on function %s from public,anon,authenticated',f.signature);
 execute format('grant execute on function %s to service_role',f.signature);end loop;end$$;
