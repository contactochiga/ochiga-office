-- Rollback of 20261103: restores the 20261102 definition of catalogue_transition (archived products could again receive review decisions).
create or replace function catalogue_transition(p_product_id uuid, p_expected_row_version integer, p_action text, p_actor text, p_note text, p_override_reason text)
returns jsonb language plpgsql set search_path = public, pg_temp as $f$
declare p catalogue_products%rowtype; path text; reason text := coalesce(p_override_reason, '');
begin
  if p_action = 'submit' then
    update catalogue_products set workflow_status = 'in_review', review_version = current_version, row_version = row_version + 1, updated_by = p_actor, updated_at = now()
     where id = p_product_id and row_version = p_expected_row_version and workflow_status in ('draft', 'changes_requested') and publication_status <> 'archived'
    returning * into p;
    if not found then perform catalogue_state_changed(p_product_id); end if;
    insert into catalogue_reviews (product_id, version, decision, actor, note) values (p.id, p.review_version, 'submitted', p_actor, coalesce(p_note, ''));

  elsif p_action in ('approve', 'request_changes') then
    -- second person (D2): the reviewer is not an author of any version in the change set (after the published version, up to the reviewed one)
    if exists (select 1 from catalogue_products c join catalogue_product_versions v on v.product_id = c.id
                where c.id = p_product_id and c.row_version = p_expected_row_version and c.workflow_status = 'in_review'
                  and v.version > coalesce(c.published_version, 0) and v.version <= c.review_version and v.author = p_actor) then
      raise exception 'own_change' using errcode = 'PT403';
    end if;
    update catalogue_products
       set workflow_status = case when p_action = 'approve' then 'approved' else 'changes_requested' end,
           approved_version = case when p_action = 'approve' then review_version else null end,
           row_version = row_version + 1, updated_by = p_actor, updated_at = now()
     where id = p_product_id and row_version = p_expected_row_version and workflow_status = 'in_review' and review_version = current_version
       and not exists (select 1 from catalogue_product_versions v where v.product_id = catalogue_products.id and v.version > coalesce(catalogue_products.published_version, 0)
                         and v.version <= catalogue_products.review_version and v.author = p_actor)
    returning * into p;
    if not found then perform catalogue_state_changed(p_product_id); end if;
    insert into catalogue_reviews (product_id, version, decision, actor, note)
    values (p.id, p.review_version, case when p_action = 'approve' then 'approved' else 'changes_requested' end, p_actor, coalesce(p_note, ''));

  elsif p_action = 'publish' then
    if length(reason) > 0 and length(reason) < 20 then raise exception 'override_reason_too_short' using errcode = 'PT400'; end if;
    update catalogue_products c
       set publication_status = 'published', published_version = current_version, published_at = now(), first_published_at = coalesce(first_published_at, now()),
           workflow_status = 'approved', approved_version = current_version, review_version = null, last_publish_error = null,
           row_version = row_version + 1, updated_by = p_actor, updated_at = now()
     where id = p_product_id and row_version = p_expected_row_version and publication_status <> 'archived'
       and (   (workflow_status = 'approved' and approved_version = current_version and (published_version is distinct from current_version or publication_status <> 'published'))
            or (length(reason) >= 20 and (published_version is distinct from current_version or publication_status <> 'published')))
    returning * into p;
    if not found then
      if exists (select 1 from catalogue_products where id = p_product_id and row_version = p_expected_row_version and publication_status <> 'archived') then
        raise exception 'review_required' using errcode = 'PT409';
      end if;
      perform catalogue_state_changed(p_product_id);
    end if;
    -- which path was taken: an approval of this exact version, otherwise the audited override
    path := case
      when exists (select 1 from catalogue_reviews r where r.product_id = p.id and r.version = p.current_version and r.decision = 'approved') then 'published'
      else 'published_override' end;
    if path = 'published_override' then
      insert into catalogue_reviews (product_id, version, decision, actor, note) values (p.id, p.current_version, 'override', p_actor, reason);
    end if;
    insert into catalogue_publication_events (product_id, version, action, actor, override, override_reason)
    values (p.id, p.current_version, path, p_actor, path = 'published_override', case when path = 'published_override' then reason else '' end);

  elsif p_action = 'unpublish' then
    update catalogue_products set publication_status = 'unpublished', row_version = row_version + 1, updated_by = p_actor, updated_at = now()
     where id = p_product_id and row_version = p_expected_row_version and publication_status = 'published'
    returning * into p;
    if not found then perform catalogue_state_changed(p_product_id); end if;
    insert into catalogue_publication_events (product_id, version, action, actor) values (p.id, p.published_version, 'unpublished', p_actor);

  elsif p_action = 'archive' then
    update catalogue_products set publication_status = 'archived', archived_at = now(), row_version = row_version + 1, updated_by = p_actor, updated_at = now()
     where id = p_product_id and row_version = p_expected_row_version and publication_status <> 'archived'
    returning * into p;
    if not found then perform catalogue_state_changed(p_product_id); end if;
    insert into catalogue_publication_events (product_id, version, action, actor) values (p.id, p.published_version, 'archived', p_actor);

  else
    raise exception 'invalid_action' using errcode = 'PT400';
  end if;
  return to_jsonb(p);
end $f$;
