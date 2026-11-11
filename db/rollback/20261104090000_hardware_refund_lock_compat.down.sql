-- Rollback of 20261104090000_hardware_refund_lock_compat.sql: restores the phase 4e definitions byte for byte (row locks included).
-- Privileges are untouched in both directions (CREATE OR REPLACE keeps EXECUTE grants).
create or replace function hardware_refund_request(p_actor text,p_order uuid,p_reason text) returns jsonb language plpgsql set search_path=public,pg_temp as $$declare c hardware_payment_confirmations%rowtype;r hardware_refund_requests%rowtype;begin
 perform hardware_order_require_actor(p_actor,'commerce.orders.refund.request');
 select * into c from hardware_payment_confirmations where order_id=p_order for update;
 if not found then raise exception 'verified_payment_required' using errcode='PT409';end if;
 select * into r from hardware_refund_requests where order_id=p_order;
 if found then if r.requested_by<>p_actor or r.reason<>p_reason then raise exception 'refund_request_conflict' using errcode='PT409';end if;return to_jsonb(r);end if;
 insert into hardware_refund_requests(order_id,reference,amount_kobo,requested_by,reason) values(p_order,c.reference,c.amount_kobo,p_actor,p_reason) returning * into r;
 perform hardware_payment_log(p_order,'refund_requested',p_actor,jsonb_build_object('request_id',r.id,'amount_kobo',r.amount_kobo));
 return to_jsonb(r);end$$;
create or replace function hardware_refund_approve(p_actor text,p_id uuid) returns jsonb language plpgsql set search_path=public,pg_temp as $$declare r hardware_refund_requests%rowtype;d hardware_refund_decisions%rowtype;begin
 perform hardware_order_require_actor(p_actor,'commerce.orders.refund.approve');select * into r from hardware_refund_requests where id=p_id for update;
 if not found then raise exception 'refund_not_found' using errcode='PT404';end if;
 if p_actor=r.requested_by then raise exception 'self_approval_denied' using errcode='PT403';end if;
 if exists(select 1 from hardware_financial_observations where order_id=r.order_id and state in ('disputed','dispute_review','reversed_unreconciled','amount_mismatch')) then raise exception 'manual_reconciliation_required' using errcode='PT409';end if;
 select * into d from hardware_refund_decisions where request_id=p_id;
 if found then if d.approved_by<>p_actor then raise exception 'refund_already_approved' using errcode='PT409';end if;return to_jsonb(d);end if;
 insert into hardware_refund_decisions values(p_id,p_actor,now()) returning * into d;
 perform hardware_payment_log(r.order_id,'refund_approved',p_actor,jsonb_build_object('request_id',r.id));return to_jsonb(d);end$$;
