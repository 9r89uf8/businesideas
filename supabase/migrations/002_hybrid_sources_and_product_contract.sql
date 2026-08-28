begin;

-- User-approved hybrid X retrieval settings and per-run provenance.
alter table public.settings
  add column if not exists followed_x_usernames text[] not null default '{}';

alter table public.run_posts
  add column if not exists source_channel text not null default 'topic';

-- Structured product-fit fields are nullable only in meaning: historical ideas
-- receive empty objects, while the new publication function requires complete
-- objects for every newly published idea.
alter table public.ideas
  add column if not exists product_spec jsonb not null default '{}';

alter table public.ideas
  add column if not exists hard_filter_checks jsonb not null default '{}';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.settings'::regclass
      and conname = 'settings_followed_x_usernames_limit'
  ) then
    alter table public.settings
      add constraint settings_followed_x_usernames_limit
      check (cardinality(followed_x_usernames) <= 12);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.run_posts'::regclass
      and conname = 'run_posts_source_channel_check'
  ) then
    alter table public.run_posts
      add constraint run_posts_source_channel_check
      check (source_channel in ('followed', 'topic'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.ideas'::regclass
      and conname = 'ideas_product_spec_object_check'
  ) then
    alter table public.ideas
      add constraint ideas_product_spec_object_check
      check (jsonb_typeof(product_spec) = 'object');
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.ideas'::regclass
      and conname = 'ideas_hard_filter_checks_object_check'
  ) then
    alter table public.ideas
      add constraint ideas_hard_filter_checks_object_check
      check (jsonb_typeof(hard_filter_checks) = 'object');
  end if;
end;
$$;

-- Retire the old service-first default without overwriting an intentional,
-- already-modern custom emphasis.
update public.settings
set preferences = jsonb_set(
      coalesce(preferences, '{}'::jsonb),
      '{offer_bias}',
      '"self_serve_web_products_first"'::jsonb,
      true
    ),
    updated_at = now()
where coalesce(preferences ->> 'offer_bias', '') in (
  '',
  'services_first',
  'balanced',
  'software_first'
);

-- The existing publication RPC still owns the all-or-nothing insert, evidence
-- checks, run completion, and retry semantics. This contract-aware wrapper
-- validates the new fields before calling it, then attaches the structured
-- product data in the same outer transaction. Any failure rolls everything
-- back, including the nested publication call.
create or replace function public.publish_run_product_ideas(
  p_owner_id uuid,
  p_run_id uuid,
  p_ideas jsonb,
  p_sources jsonb,
  p_counts jsonb,
  p_usage jsonb
)
returns table (idea_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  item jsonb;
  published_count integer;
begin
  if p_ideas is null
    or jsonb_typeof(p_ideas) is distinct from 'array'
    or jsonb_array_length(p_ideas) not between 1 and 3
  then
    raise exception 'Invalid product-idea publication payload.' using errcode = '22023';
  end if;

  for item in select value from jsonb_array_elements(p_ideas)
  loop
    if jsonb_typeof(item -> 'product_spec') is distinct from 'object'
      or coalesce(btrim(item #>> '{product_spec,archetype}'), '') = ''
      or coalesce(btrim(item #>> '{product_spec,core_action}'), '') = ''
      or coalesce(item #>> '{product_spec,delivery_mode}', '') <> 'self_serve_web_app'
      or coalesce(item #>> '{product_spec,sales_motion}', '') not in (
        'self_serve_checkout',
        'online_trial_then_self_serve'
      )
      or coalesce(btrim(item #>> '{product_spec,business_model}'), '') = ''
      or coalesce(btrim(item #>> '{product_spec,mvp_scope}'), '') = ''
      or coalesce(item #>> '{product_spec,mvp_build_weeks}', '') !~ '^[2-6]$'
      or coalesce(btrim(item #>> '{product_spec,recurring_trigger}'), '') = ''
      or coalesce(btrim(item #>> '{product_spec,latam_fit}'), '') = ''
      or coalesce(btrim(item #>> '{product_spec,latam_rationale}'), '') = ''
    then
      raise exception 'Idea failed the self-serve product contract.' using errcode = '23514';
    end if;

    if jsonb_typeof(item #> '{product_spec,value_mechanisms}') is distinct from 'array'
    then
      raise exception 'Idea requires a concrete value mechanism.' using errcode = '23514';
    end if;

    if jsonb_array_length(item #> '{product_spec,value_mechanisms}') not between 1 and 3
      or exists (
        select 1
        from jsonb_array_elements_text(item #> '{product_spec,value_mechanisms}') as mechanism(value)
        where value not in (
          'save_time',
          'save_money',
          'make_money',
          'information_advantage',
          'distribution_advantage'
        )
      )
    then
      raise exception 'Idea requires an allowed value mechanism.' using errcode = '23514';
    end if;

    if jsonb_typeof(item -> 'hard_filter_checks') is distinct from 'object'
    then
      raise exception 'Idea hard-filter checks are missing.' using errcode = '23514';
    end if;

    if not ((item -> 'hard_filter_checks') ?& array[
      'website_deliverable',
      'self_serve_without_call',
      'solo_mvp_feasible',
      'recurring_use',
      'creates_allowed_value',
      'specific_action_not_chat',
      'no_hardware',
      'no_healthcare_therapy_or_medical',
      'no_consulting_agency_audit_or_workshop',
      'no_custom_implementation',
      'no_enterprise_sales',
      'no_translation',
      'no_generic_chat_or_companion'
    ]) or exists (
      select 1
      from jsonb_each(item -> 'hard_filter_checks') as hard_filter(name, passed)
      where passed is distinct from 'true'::jsonb
    )
    then
      raise exception 'Idea failed a hard publication filter.' using errcode = '23514';
    end if;

    if coalesce(item ->> 'evidence_score', '') !~ '^([0-9]|[1-9][0-9]|100)$'
      or (item ->> 'evidence_score')::integer < 65
    then
      raise exception 'Idea evidence is too weak to publish.' using errcode = '23514';
    end if;
  end loop;

  select count(*)::integer
    into published_count
  from public.publish_run_ideas(
    p_owner_id,
    p_run_id,
    p_ideas,
    p_sources,
    p_counts,
    p_usage
  );

  if published_count <> jsonb_array_length(p_ideas) then
    raise exception 'Published idea count does not match the validated payload.' using errcode = '23514';
  end if;

  for item in select value from jsonb_array_elements(p_ideas)
  loop
    update public.ideas i
    set product_spec = item -> 'product_spec',
        hard_filter_checks = item -> 'hard_filter_checks'
    where i.owner_id = p_owner_id
      and i.run_id = p_run_id
      and i.fingerprint_hash = item ->> 'fingerprint_hash';

    if not found then
      raise exception 'Validated product data could not be attached to its idea.' using errcode = '23514';
    end if;
  end loop;

  return query
    select i.id
    from public.ideas i
    where i.owner_id = p_owner_id
      and i.run_id = p_run_id
    order by i.rank;
end;
$$;

revoke all on function public.publish_run_product_ideas(
  uuid,
  uuid,
  jsonb,
  jsonb,
  jsonb,
  jsonb
) from public, anon, authenticated;

grant execute on function public.publish_run_product_ideas(
  uuid,
  uuid,
  jsonb,
  jsonb,
  jsonb,
  jsonb
) to service_role;

commit;
