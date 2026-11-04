-- Refund request/approval serialization compatible with immutable financial evidence (fixes the 2 Nov two-account rehearsal 503).
--
-- Defect: hardware_refund_request locked hardware_payment_confirmations and hardware_refund_approve locked hardware_refund_requests with
-- SELECT ... FOR UPDATE. Every PostgreSQL row-lock clause (FOR UPDATE / NO KEY UPDATE / SHARE / KEY SHARE) needs UPDATE privilege, and
-- service_role deliberately holds only SELECT and INSERT on these append-only tables (an immutability trigger also refuses UPDATE and
-- DELETE). Through the real service-role API both functions therefore failed with "permission denied"; tests that ran as the
-- postgres superuser never saw it.
--
-- Fix: the row lock only serialized "check for an existing row, then insert". The rows themselves cannot change, so the same
-- serialization is taken with a transaction-scoped advisory lock keyed by the ORDER (the established pattern of 20261107/20261108):
-- concurrent requests or approvals for one order wait for each other, then see the committed row and answer idempotently. The unique
-- constraints (one request per order, one decision per request) remain the database backstop.
--
-- Unchanged: signatures, SECURITY INVOKER, pinned search_path, EXECUTE grants (CREATE OR REPLACE keeps them), permission checks
-- (hardware_order_require_actor), self-approval refusal, the reconciliation guard, conflict and idempotency answers, history logging and
-- notifications. NO table privilege, policy or immutability trigger is changed; no financial row is written by this migration.
do $$ begin
  if to_regprocedure('public.hardware_refund_request(text,uuid,text)') is null or to_regprocedure('public.hardware_refund_approve(text,uuid)') is null then
    raise exception 'apply db/phase4e/20261026102637_hardware_financial_operations.sql first';
  end if;
end $$;

create or replace function hardware_refund_request(p_actor text,p_order uuid,p_reason text) returns jsonb language plpgsql set search_path=public,pg_temp as $$declare c hardware_payment_confirmations%rowtype;r hardware_refund_requests%rowtype;begin
 perform hardware_order_require_actor(p_actor,'commerce.orders.refund.request');
 -- serializes request and approval for this order (no row lock on immutable evidence: service_role has no UPDATE there)
 perform pg_advisory_xact_lock(hashtextextended('hardware_refund:'||p_order::text,0));
 select * into c from hardware_payment_confirmations where order_id=p_order;
 if not found then raise exception 'verified_payment_required' using errcode='PT409';end if;
 select * into r from hardware_refund_requests where order_id=p_order;
 if found then if r.requested_by<>p_actor or r.reason<>p_reason then raise exception 'refund_request_conflict' using errcode='PT409';end if;return to_jsonb(r);end if;
 insert into hardware_refund_requests(order_id,reference,amount_kobo,requested_by,reason) values(p_order,c.reference,c.amount_kobo,p_actor,p_reason) returning * into r;
 perform hardware_payment_log(p_order,'refund_requested',p_actor,jsonb_build_object('request_id',r.id,'amount_kobo',r.amount_kobo));
 return to_jsonb(r);end$$;

create or replace function hardware_refund_approve(p_actor text,p_id uuid) returns jsonb language plpgsql set search_path=public,pg_temp as $$declare r hardware_refund_requests%rowtype;d hardware_refund_decisions%rowtype;begin
 perform hardware_order_require_actor(p_actor,'commerce.orders.refund.approve');
 select * into r from hardware_refund_requests where id=p_id;
 if not found then raise exception 'refund_not_found' using errcode='PT404';end if;
 -- same order-scoped lock as hardware_refund_request; the request row is immutable, so reading it before the lock is exact
 perform pg_advisory_xact_lock(hashtextextended('hardware_refund:'||r.order_id::text,0));
 if p_actor=r.requested_by then raise exception 'self_approval_denied' using errcode='PT403';end if;
 if exists(select 1 from hardware_financial_observations where order_id=r.order_id and state in ('disputed','dispute_review','reversed_unreconciled','amount_mismatch')) then raise exception 'manual_reconciliation_required' using errcode='PT409';end if;
 select * into d from hardware_refund_decisions where request_id=p_id;
 if found then if d.approved_by<>p_actor then raise exception 'refund_already_approved' using errcode='PT409';end if;return to_jsonb(d);end if;
 insert into hardware_refund_decisions values(p_id,p_actor,now()) returning * into d;
 perform hardware_payment_log(r.order_id,'refund_approved',p_actor,jsonb_build_object('request_id',r.id));return to_jsonb(d);end$$;
