-- Replace the legacy Luna/Terra middle with post-first commercial ideation.
-- Existing Terra columns and functions remain for historical rows, but the
-- production workflow now stores shortlist units and their isolated generation
-- results in the existing run-scoped clusters table.

begin;

alter table public.runs
  drop constraint if exists runs_stage_check;

alter table public.runs
  add constraint runs_stage_check
  check (
    stage is null or stage in (
      'fetching',
      'extracting',
      'shortlisting',
      'clustering',
      'generating',
      'research_queued',
      'researching',
      'validating',
      'saving'
    )
  );

alter table public.posts
  add column source_context jsonb not null default '{}'::jsonb
    constraint posts_source_context_object_check
    check (jsonb_typeof(source_context) = 'object');

alter table public.run_posts
  add column filter_decision text
    constraint run_posts_filter_decision_check
    check (
      filter_decision is null
      or filter_decision in ('keep', 'reject', 'needs_context')
    ),
  add column filter_reason text,
  add column commercial_element text
    constraint run_posts_commercial_element_check
    check (
      commercial_element is null
      or commercial_element in (
        'capability',
        'problem',
        'request',
        'result',
        'spending',
        'change',
        'none'
      )
    ),
  add column hydrated_context jsonb
    constraint run_posts_hydrated_context_object_check
    check (
      hydrated_context is null
      or jsonb_typeof(hydrated_context) = 'object'
    ),
  add column shortlist_assessment jsonb
    constraint run_posts_shortlist_assessment_object_check
    check (
      shortlist_assessment is null
      or jsonb_typeof(shortlist_assessment) = 'object'
    );

alter table public.clusters
  add column source_post_id text,
  add column candidate_result jsonb
    constraint clusters_candidate_result_object_check
    check (
      candidate_result is null
      or jsonb_typeof(candidate_result) = 'object'
    ),
  add column candidate_usage jsonb
    constraint clusters_candidate_usage_object_check
    check (
      candidate_usage is null
      or jsonb_typeof(candidate_usage) = 'object'
    ),
  add constraint clusters_source_post_owner_fkey
    foreign key (source_post_id, owner_id)
    references public.posts(x_post_id, owner_id);

create index clusters_run_source_post_idx
  on public.clusters (run_id, source_post_id);

alter table public.clusters
  add constraint clusters_run_source_post_fkey
    foreign key (run_id, source_post_id)
    references public.run_posts(run_id, post_id)
    on delete cascade;

create unique index clusters_run_source_post_unique
  on public.clusters (run_id, source_post_id)
  where source_post_id is not null;

-- Keep the durable queue implementation unchanged while accepting the new
-- candidate envelope. The legacy cluster envelope remains accepted during the
-- migration/deployment window so an old application instance cannot strand a
-- run between the database and Vercel rollouts.
create or replace function public.persist_research_job(
  p_owner_id uuid,
  p_run_id uuid,
  p_schema_version integer,
  p_prompt_version text,
  p_payload jsonb,
  p_payload_hash text,
  p_counts jsonb,
  p_usage jsonb
)
returns table (research_job_id uuid, research_status text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_run_status text;
  current_run_stage text;
  existing_job public.research_jobs%rowtype;
  inserted_id uuid;
  legacy_payload boolean;
  candidate_payload boolean;
begin
  if p_schema_version is null
    or p_schema_version <= 0
    or nullif(btrim(p_prompt_version), '') is null
    or length(btrim(p_prompt_version)) > 100
    or p_payload is null
    or jsonb_typeof(p_payload) is distinct from 'object'
    or octet_length(p_payload::text) > 1048576
    or p_payload_hash is null
    or p_payload_hash !~ '^[0-9a-f]{64}$'
    or p_counts is null
    or jsonb_typeof(p_counts) is distinct from 'object'
    or p_usage is null
    or jsonb_typeof(p_usage) is distinct from 'object'
  then
    raise exception 'Invalid research-job payload.' using errcode = '22023';
  end if;

  legacy_payload := case
    when jsonb_typeof(p_payload -> 'clusters') = 'array'
      and jsonb_typeof(p_payload -> 'historical_ideas') = 'array'
    then jsonb_array_length(p_payload -> 'clusters') between 1 and 8
      and jsonb_array_length(p_payload -> 'historical_ideas') <= 20
    else false
  end;
  candidate_payload := case
    when jsonb_typeof(p_payload -> 'candidates') = 'array'
      and jsonb_typeof(p_payload -> 'historical_ideas') = 'array'
    then jsonb_array_length(p_payload -> 'candidates') between 1 and 3
      and jsonb_array_length(p_payload -> 'historical_ideas') <= 20
    else false
  end;

  if coalesce(legacy_payload, false) = coalesce(candidate_payload, false)
    or (legacy_payload and p_schema_version <> 1)
    or (candidate_payload and p_schema_version <> 2)
    or coalesce(p_payload ->> 'schema_version', '') <> p_schema_version::text
    or coalesce(p_payload ->> 'prompt_version', '') <> btrim(p_prompt_version)
    or coalesce(p_payload ->> 'run_id', '') <> p_run_id::text
    or jsonb_typeof(p_payload -> 'preferences') is distinct from 'object'
    or jsonb_typeof(p_payload -> 'product_contract') is distinct from 'object'
  then
    raise exception 'Research-job payload has an invalid structure.' using errcode = '23514';
  end if;

  if candidate_payload and (
    exists (
      select 1
      from jsonb_array_elements(p_payload -> 'candidates') candidate
      where jsonb_typeof(candidate) is distinct from 'object'
        or coalesce(candidate ->> 'candidate_id', '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
        or jsonb_typeof(candidate -> 'source_post') is distinct from 'object'
        or coalesce(candidate #>> '{source_post,post_id}', '') !~ '^[0-9]{1,32}$'
        or jsonb_typeof(candidate -> 'selected_idea') is distinct from 'object'
    )
    or (
      select count(distinct candidate ->> 'candidate_id')
      from jsonb_array_elements(p_payload -> 'candidates') candidate
    ) <> jsonb_array_length(p_payload -> 'candidates')
    or (
      select count(distinct candidate #>> '{source_post,post_id}')
      from jsonb_array_elements(p_payload -> 'candidates') candidate
    ) <> jsonb_array_length(p_payload -> 'candidates')
  ) then
    raise exception 'Research candidates have an invalid structure.' using errcode = '23514';
  end if;

  select r.status, r.stage
    into current_run_status, current_run_stage
  from public.runs r
  where r.id = p_run_id
    and r.owner_id = p_owner_id
  for update;

  if not found then
    raise exception 'Run not found.' using errcode = 'P0002';
  end if;

  select j.*
    into existing_job
  from public.research_jobs j
  where j.run_id = p_run_id
    and j.owner_id = p_owner_id
  for update;

  if found then
    if existing_job.payload_hash <> p_payload_hash
      or existing_job.schema_version <> p_schema_version
      or existing_job.prompt_version <> btrim(p_prompt_version)
    then
      raise exception 'The run already has a different research payload.' using errcode = '23514';
    end if;

    if existing_job.status = 'failed'
      and current_run_status in ('queued', 'running')
    then
      if existing_job.result is not null then
        raise exception 'A failed research result cannot be reused.' using errcode = '55000';
      end if;

      update public.research_jobs j
      set status = 'pending',
          claim_id = null,
          lease_expires_at = null,
          attempt_count = 0,
          available_at = now(),
          last_error_code = null,
          last_error_message = null,
          updated_at = now(),
          claimed_at = null,
          submitted_at = null,
          validation_started_at = null,
          completed_at = null,
          failed_at = null
      where j.id = existing_job.id;

      update public.runs r
      set status = 'running',
          stage = 'research_queued',
          counts = coalesce(r.counts, '{}'::jsonb) || p_counts,
          usage = coalesce(r.usage, '{}'::jsonb) || p_usage,
          error_message = null,
          completed_at = null,
          started_at = coalesce(r.started_at, now())
      where r.id = p_run_id
        and r.owner_id = p_owner_id;

      return query select existing_job.id, 'pending'::text;
      return;
    end if;

    if current_run_status in ('completed', 'no_ideas')
      and existing_job.status = 'completed'
    then
      return query select existing_job.id, existing_job.status;
      return;
    end if;

    if current_run_status not in ('queued', 'running')
      or existing_job.status = 'failed'
    then
      raise exception 'The research job is not reusable.' using errcode = '55000';
    end if;

    if current_run_status = 'queued' then
      if existing_job.status not in (
        'pending',
        'claimed',
        'submitted',
        'validating'
      ) then
        raise exception 'The queued run has an incompatible research job.' using errcode = '55000';
      end if;

      update public.runs r
      set status = 'running',
          stage = case existing_job.status
            when 'pending' then 'research_queued'
            when 'claimed' then 'researching'
            when 'submitted' then 'researching'
            else 'validating'
          end,
          counts = coalesce(r.counts, '{}'::jsonb) || p_counts,
          usage = coalesce(r.usage, '{}'::jsonb) || p_usage,
          error_message = null,
          completed_at = null,
          started_at = coalesce(r.started_at, now())
      where r.id = p_run_id
        and r.owner_id = p_owner_id;
    end if;

    return query select existing_job.id, existing_job.status;
    return;
  end if;

  if current_run_status is distinct from 'running'
    or current_run_stage is distinct from 'generating'
  then
    raise exception 'Run is not ready for a research job.' using errcode = '55000';
  end if;

  insert into public.research_jobs (
    run_id,
    owner_id,
    status,
    schema_version,
    prompt_version,
    payload,
    payload_hash
  )
  values (
    p_run_id,
    p_owner_id,
    'pending',
    p_schema_version,
    btrim(p_prompt_version),
    p_payload,
    p_payload_hash
  )
  returning id into inserted_id;

  update public.runs r
  set status = 'running',
      stage = 'research_queued',
      counts = coalesce(r.counts, '{}'::jsonb) || p_counts,
      usage = coalesce(r.usage, '{}'::jsonb) || p_usage,
      error_message = null,
      started_at = coalesce(r.started_at, now())
  where r.id = p_run_id
    and r.owner_id = p_owner_id;

  return query select inserted_id, 'pending'::text;
end;
$$;

revoke all on function public.persist_research_job(
  uuid, uuid, integer, text, jsonb, text, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.persist_research_job(
  uuid, uuid, integer, text, jsonb, text, jsonb, jsonb
) to service_role;

-- Candidate generation intentionally starts from one independently analyzed X
-- post. External research remains mandatory before publication, but the final
-- evidence link no longer pretends that three source posts inspired the idea.
create or replace function public.publish_run_ideas(
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
  run_status text;
  research_schema_version integer;
  item jsonb;
begin
  if p_ideas is null
    or jsonb_typeof(p_ideas) is distinct from 'array'
    or p_sources is null
    or jsonb_typeof(p_sources) is distinct from 'array'
    or (
      p_counts is not null
      and jsonb_typeof(p_counts) is distinct from 'object'
    )
    or (
      p_usage is not null
      and jsonb_typeof(p_usage) is distinct from 'object'
    )
  then
    raise exception 'Invalid publication payload.' using errcode = '22023';
  end if;

  if jsonb_array_length(p_ideas) not between 1 and 3 then
    raise exception 'Invalid publication payload.' using errcode = '22023';
  end if;

  select r.status
    into run_status
  from public.runs r
  where r.id = p_run_id
    and r.owner_id = p_owner_id
  for update;

  if not found then
    raise exception 'Run not found.' using errcode = 'P0002';
  end if;

  select j.schema_version
    into research_schema_version
  from public.research_jobs j
  where j.run_id = p_run_id
    and j.owner_id = p_owner_id;
  research_schema_version := coalesce(research_schema_version, 1);

  if run_status = 'completed' then
    return query
      select i.id
      from public.ideas i
      where i.run_id = p_run_id
        and i.owner_id = p_owner_id
      order by i.rank;
    return;
  end if;

  if run_status not in ('queued', 'running') then
    raise exception 'Run is already terminal.' using errcode = '55000';
  end if;

  delete from public.ideas i
  where i.run_id = p_run_id
    and i.owner_id = p_owner_id;

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
      or jsonb_array_length(item #> '{product_spec,value_mechanisms}') not between 1 and 3
    then
      raise exception 'Idea requires a concrete value mechanism.' using errcode = '23514';
    end if;

    if jsonb_typeof(item -> 'hard_filter_checks') is distinct from 'object'
      or not ((item -> 'hard_filter_checks') ?& array[
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
      ])
      or exists (
        select 1
        from jsonb_each(item -> 'hard_filter_checks') as hard_filter(name, passed)
        where passed is distinct from 'true'::jsonb
      )
    then
      raise exception 'Idea failed a hard publication filter.' using errcode = '23514';
    end if;

    if (item ->> 'evidence_score')::integer < 65 then
      raise exception 'Idea evidence is too weak to publish.' using errcode = '23514';
    end if;

    insert into public.ideas (
      run_id,
      owner_id,
      rank,
      title,
      target_customer,
      problem,
      offer,
      why_pay,
      why_now,
      initial_price,
      differentiation,
      speed_to_first_revenue,
      validation_plan,
      product_spec,
      hard_filter_checks,
      risks,
      assumptions,
      evidence_score,
      fingerprint,
      fingerprint_hash,
      embedding
    )
    values (
      p_run_id,
      p_owner_id,
      (item ->> 'rank')::integer,
      item ->> 'title',
      item ->> 'target_customer',
      item ->> 'problem',
      item ->> 'offer',
      item ->> 'why_pay',
      nullif(item ->> 'why_now', ''),
      nullif(item ->> 'initial_price', ''),
      nullif(item ->> 'differentiation', ''),
      nullif(item ->> 'speed_to_first_revenue', ''),
      item ->> 'validation_plan',
      item -> 'product_spec',
      item -> 'hard_filter_checks',
      array(select jsonb_array_elements_text(item -> 'risks')),
      array(select jsonb_array_elements_text(item -> 'assumptions')),
      (item ->> 'evidence_score')::smallint,
      item ->> 'fingerprint',
      item ->> 'fingerprint_hash',
      (item ->> 'embedding')::extensions.vector(1536)
    );
  end loop;

  insert into public.idea_sources (
    idea_id,
    post_id,
    owner_id,
    signal_type,
    evidence_summary
  )
  select
    i.id,
    source.post_id,
    p_owner_id,
    source.signal_type,
    source.evidence_summary
  from jsonb_to_recordset(p_sources) as source(
    fingerprint_hash text,
    post_id text,
    signal_type text,
    evidence_summary text
  )
  join public.ideas i
    on i.owner_id = p_owner_id
    and i.run_id = p_run_id
    and i.fingerprint_hash = source.fingerprint_hash;

  if exists (
    select 1
    from public.idea_sources source
    where source.owner_id = p_owner_id
      and source.idea_id in (
        select i.id
        from public.ideas i
        where i.owner_id = p_owner_id
          and i.run_id = p_run_id
      )
      and not exists (
        select 1
        from public.run_posts rp
        where rp.owner_id = p_owner_id
          and rp.run_id = p_run_id
          and rp.post_id = source.post_id
      )
  ) then
    raise exception 'An idea source is outside the current run.' using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.ideas i
    where i.owner_id = p_owner_id
      and i.run_id = p_run_id
      and (
        (
          research_schema_version >= 2
          and (
            select count(*)
            from public.idea_sources source
            where source.owner_id = p_owner_id
              and source.idea_id = i.id
          ) <> 1
        )
        or (
          research_schema_version < 2
          and (
            select count(*)
            from public.idea_sources source
            where source.owner_id = p_owner_id
              and source.idea_id = i.id
          ) < 3
        )
      )
  ) or exists (
    select 1
    from public.ideas i
    where i.owner_id = p_owner_id
      and i.run_id = p_run_id
      and (
        select count(distinct p.author_id)
        from public.idea_sources source
        join public.posts p
          on p.owner_id = source.owner_id
          and p.x_post_id = source.post_id
        where source.owner_id = p_owner_id
          and source.idea_id = i.id
      ) < case when research_schema_version >= 2 then 1 else 3 end
  ) then
    raise exception 'Published ideas require their originating post and author.' using errcode = '23514';
  end if;

  update public.runs r
  set status = 'completed',
      stage = null,
      counts = coalesce(p_counts, '{}'::jsonb),
      usage = coalesce(p_usage, '{}'::jsonb),
      error_message = null,
      completed_at = now()
  where r.id = p_run_id
    and r.owner_id = p_owner_id;

  return query
    select i.id
    from public.ideas i
    where i.run_id = p_run_id
      and i.owner_id = p_owner_id
    order by i.rank;
end;
$$;

revoke all on function public.publish_run_ideas(
  uuid, uuid, jsonb, jsonb, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.publish_run_ideas(
  uuid, uuid, jsonb, jsonb, jsonb, jsonb
) to service_role;

commit;
