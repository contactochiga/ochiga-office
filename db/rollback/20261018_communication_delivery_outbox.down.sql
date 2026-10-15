-- Rollback only while the queue holds nothing undelivered (check: select count(*) from communication_delivery_outbox where status <> 'delivered').
drop table if exists communication_delivery_outbox;
