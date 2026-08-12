alter table crm_tasks add column if not exists private_relationship_id text;
alter table crm_tasks add column if not exists partnership_relationship_id text;

create index if not exists crm_tasks_private_relationship_idx
on crm_tasks (private_relationship_id, status, due_at);

create index if not exists crm_tasks_partnership_relationship_idx
on crm_tasks (partnership_relationship_id, status, due_at);
