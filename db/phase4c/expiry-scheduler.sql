-- Separate, explicitly approved LOCAL scheduler setup. No application process required.
-- Prerequisite: pg_cron loaded by Postgres; stop if unavailable. No external network call.
create extension if not exists pg_cron;
do $$begin
 if exists(select 1 from cron.job where jobname='getoyi-hardware-reservation-expiry' and (username<>'postgres' or database<>current_database() or schedule<>'* * * * *' or command<>'select public.hardware_reservation_expire(500);' or not active)) then
 raise exception 'reservation_scheduler_configuration_mismatch';end if;
 if not exists(select 1 from cron.job where jobname='getoyi-hardware-reservation-expiry') then
 perform cron.schedule('getoyi-hardware-reservation-expiry','* * * * *','select public.hardware_reservation_expire(500);');end if;
end $$;
