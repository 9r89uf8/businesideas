begin;

-- ---------------------------------------------------------
-- RUN STAGES
-- Terra still checkpoints into `generating`. The scheduled research worker
-- then owns the run through the three new externally visible stages.
-- ---------------------------------------------------------

alter table public.runs
  drop constraint if exists runs_stage_check;

alter table public.runs
  add constraint runs_stage_check
  check (
    stage is null or stage in (
      'fetching',
      'extracting',
      'clustering',
      'generating',
      'research_queued',
      'researching',
      'validating',
      'saving'
    )
  );

-- This redundant key lets external evidence links enforce that an idea and
-- its research source belong to the same run and owner.
alter table public.ideas
  add constraint ideas_id_run_owner_key
  unique (id, run_id, owner_id);

-- ---------------------------------------------------------
-- RESEARCH JOBS
-- One immutable, bounded handoff per run. The payload and accepted result
-- hashes are computed by trusted application code and cannot be replaced once
-- accepted. Claim IDs are capabilities scoped to one two-hour lease.
-- ---------------------------------------------------------

create table public.research_jobs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  owner_id uuid not null references auth.users(id) on delete cascade,

  status text not null default 'pending'
    constraint research_jobs_status_check
    check (
      status in (
        'pending',
        'claimed',
        'submitted',
        'validating',
        'completed',
        'failed'
      )
    ),

  schema_version integer not null default 1
    constraint research_jobs_schema_version_check
    check (schema_version > 0),

  prompt_version text not null
    constraint research_jobs_prompt_version_check
    check (length(btrim(prompt_version)) between 1 and 100),

  payload jsonb not null
    constraint research_jobs_payload_check
    check (
      jsonb_typeof(payload) = 'object'
      and octet_length(payload::text) <= 1048576
    ),

  payload_hash text not null
    constraint research_jobs_payload_hash_check
    check (payload_hash ~ '^[0-9a-f]{64}$'),

  result jsonb
    constraint research_jobs_result_check
    check (
      result is null
      or (
        jsonb_typeof(result) = 'object'
        and octet_length(result::text) <= 1048576
      )
    ),

  result_hash text
    constraint research_jobs_result_hash_check
    check (
      result_hash is null
      or result_hash ~ '^[0-9a-f]{64}$'
    ),

  claim_id uuid,
  lease_expires_at timestamptz,

  attempt_count integer not null default 0
    constraint research_jobs_attempt_count_check
    check (attempt_count between 0 and 3),

  available_at timestamptz not null default now(),

  last_error_code text
    constraint research_jobs_error_code_check
    check (
      last_error_code is null
      or length(last_error_code) between 1 and 64
    ),

  last_error_message text
    constraint research_jobs_error_message_check
    check (
      last_error_message is null
      or length(last_error_message) between 1 and 500
    ),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  claimed_at timestamptz,
  submitted_at timestamptz,
  validation_started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,

  unique (run_id),
  unique (id, owner_id),
  unique (id, run_id, owner_id),

  foreign key (run_id, owner_id)
    references public.runs(id, owner_id) on delete cascade,

  constraint research_jobs_state_check
  check (
    (
      status = 'pending'
      and claim_id is null
      and lease_expires_at is null
      and result is null
      and result_hash is null
      and submitted_at is null
      and validation_started_at is null
      and completed_at is null
      and failed_at is null
    )
    or (
      status = 'claimed'
      and claim_id is not null
      and lease_expires_at is not null
      and claimed_at is not null
      and result is null
      and result_hash is null
      and submitted_at is null
      and validation_started_at is null
      and completed_at is null
      and failed_at is null
    )
    or (
      status = 'submitted'
      and claim_id is null
      and lease_expires_at is null
      and result is not null
      and result_hash is not null
      and submitted_at is not null
      and validation_started_at is null
      and completed_at is null
      and failed_at is null
    )
    or (
      status = 'validating'
      and claim_id is null
      and lease_expires_at is null
      and result is not null
      and result_hash is not null
      and submitted_at is not null
      and validation_started_at is not null
      and completed_at is null
      and failed_at is null
    )
    or (
      status = 'completed'
      and claim_id is null
      and lease_expires_at is null
      and result is not null
      and result_hash is not null
      and submitted_at is not null
      and completed_at is not null
      and failed_at is null
    )
    or (
      status = 'failed'
      and claim_id is null
      and lease_expires_at is null
      and completed_at is null
      and failed_at is not null
    )
  )
);

create index research_jobs_claim_idx
  on public.research_jobs (owner_id, available_at, created_at)
  where status = 'pending';

create index research_jobs_expired_lease_idx
  on public.research_jobs (owner_id, lease_expires_at)
  where status = 'claimed';

-- ---------------------------------------------------------
-- EXTERNAL RESEARCH SOURCES
-- These are separate from idea_sources, whose meaning remains X evidence.
-- Only concise metadata and supported claims are stored, never full pages.
-- ---------------------------------------------------------

create table public.research_sources (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null,
  run_id uuid not null,
  owner_id uuid not null references auth.users(id) on delete cascade,

  source_id text not null
    constraint research_sources_source_id_check
    check (length(btrim(source_id)) between 1 and 80),

  url text not null
    constraint research_sources_url_check
    check (
      length(url) between 8 and 2048
      and url ~* '^https?://'
    ),

  title text not null
    constraint research_sources_title_check
    check (length(btrim(title)) between 1 and 500),

  publisher text
    constraint research_sources_publisher_check
    check (
      publisher is null
      or length(btrim(publisher)) between 1 and 300
    ),

  published_at timestamptz,
  accessed_at timestamptz not null,

  source_type text not null
    constraint research_sources_type_check
    check (
      source_type in (
        'competitor',
        'competitor_pricing',
        'customer_evidence',
        'feasibility',
        'distribution',
        'latam_fit',
        'risk',
        'other'
      )
    ),

  supported_claims text[] not null
    constraint research_sources_claims_check
    check (cardinality(supported_claims) between 1 and 20),

  created_at timestamptz not null default now(),

  unique (job_id, source_id),
  unique (job_id, url),
  unique (id, run_id, owner_id),

  foreign key (job_id, run_id, owner_id)
    references public.research_jobs(id, run_id, owner_id)
    on delete cascade
);

create index research_sources_job_idx
  on public.research_sources (job_id, created_at);

-- ---------------------------------------------------------
-- IDEA / EXTERNAL-SOURCE LINKS
-- One source can support several concise claims for the same idea.
-- ---------------------------------------------------------

create table public.idea_research_sources (
  idea_id uuid not null,
  research_source_id uuid not null,
  run_id uuid not null,
  owner_id uuid not null references auth.users(id) on delete cascade,

  supported_claims text[] not null
    constraint idea_research_sources_claims_check
    check (cardinality(supported_claims) between 1 and 20),

  created_at timestamptz not null default now(),

  primary key (idea_id, research_source_id),

  foreign key (idea_id, run_id, owner_id)
    references public.ideas(id, run_id, owner_id)
    on delete cascade,

  foreign key (research_source_id, run_id, owner_id)
    references public.research_sources(id, run_id, owner_id)
    on delete cascade
);

create index idea_research_sources_source_idx
  on public.idea_research_sources (research_source_id);

-- ---------------------------------------------------------
-- QUEUE CHECKPOINT
-- Inserts the immutable handoff and advances the run atomically. A failed
-- same-day run can reuse the same job only when its payload contract matches.
-- ---------------------------------------------------------

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

  if jsonb_typeof(p_payload -> 'clusters') is distinct from 'array'
    or jsonb_array_length(p_payload -> 'clusters') not between 1 and 8
    or jsonb_typeof(p_payload -> 'preferences') is distinct from 'object'
    or jsonb_typeof(p_payload -> 'product_contract') is distinct from 'object'
    or jsonb_typeof(p_payload -> 'historical_ideas') is distinct from 'array'
    or jsonb_array_length(p_payload -> 'historical_ideas') > 20
  then
    raise exception 'Research-job payload has an invalid structure.' using errcode = '23514';
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
        -- Accepted results are immutable. Reopening one after a terminal
        -- finalizer failure would create a submitted job with no component
        -- responsible for dispatching it. Fail the same-day retry safely; a
        -- manual or next-day run creates a fresh run and research job.
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

    -- startRun() deliberately reuses a failed scheduled run ID. Restore the
    -- parent state from its durable job instead of leaving that run queued.
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

-- ---------------------------------------------------------
-- CLAIM
-- A claim is atomic and returns the complete bounded payload. Expired claims
-- can be reclaimed with a fresh capability until the third attempt expires.
-- ---------------------------------------------------------

create or replace function public.claim_pending_research_job(
  p_owner_id uuid,
  p_lease_seconds integer default 7200
)
returns table (
  research_job_id uuid,
  run_id uuid,
  schema_version integer,
  prompt_version text,
  job_payload jsonb,
  payload_hash text,
  claim_id uuid,
  lease_expires_at timestamptz,
  attempt_count integer
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  candidate public.research_jobs%rowtype;
  new_claim_id uuid;
  lease_seconds integer;
begin
  if p_owner_id is null or p_lease_seconds is null then
    raise exception 'Invalid research claim request.' using errcode = '22023';
  end if;

  lease_seconds := greatest(300, least(p_lease_seconds, 7200));

  -- A crashed third attempt cannot leave an immortal active run.
  with exhausted as (
    update public.research_jobs j
    set status = 'failed',
        claim_id = null,
        lease_expires_at = null,
        last_error_code = 'tool_error',
        last_error_message = 'The scheduled research worker exhausted its claim attempts.',
        updated_at = now(),
        failed_at = now()
    where j.owner_id = p_owner_id
      and j.status = 'claimed'
      and j.lease_expires_at <= now()
      and j.attempt_count >= 3
    returning j.run_id
  )
  update public.runs r
  set status = 'failed',
      error_message = 'External research failed after three attempts.',
      completed_at = now()
  where r.owner_id = p_owner_id
    and r.status in ('queued', 'running')
    and r.id in (select exhausted.run_id from exhausted);

  select j.*
    into candidate
  from public.research_jobs j
  join public.runs r
    on r.id = j.run_id
    and r.owner_id = j.owner_id
  where j.owner_id = p_owner_id
    and r.status = 'running'
    and r.stage in ('research_queued', 'researching')
    and j.attempt_count < 3
    and (
      (j.status = 'pending' and j.available_at <= now())
      or (
        j.status = 'claimed'
        and j.lease_expires_at <= now()
      )
    )
  order by j.available_at, j.created_at, j.id
  for update of j skip locked
  limit 1;

  if not found then
    return;
  end if;

  update public.runs r
  set stage = 'researching',
      error_message = null
  where r.id = candidate.run_id
    and r.owner_id = p_owner_id
    and r.status = 'running'
    and r.stage in ('research_queued', 'researching');

  if not found then
    return;
  end if;

  new_claim_id := gen_random_uuid();

  update public.research_jobs j
  set status = 'claimed',
      claim_id = new_claim_id,
      lease_expires_at = now() + make_interval(secs => lease_seconds),
      attempt_count = j.attempt_count + 1,
      last_error_code = null,
      last_error_message = null,
      claimed_at = now(),
      updated_at = now()
  where j.id = candidate.id
    and j.owner_id = p_owner_id;

  return query
    select
      j.id,
      j.run_id,
      j.schema_version,
      j.prompt_version,
      j.payload,
      j.payload_hash,
      j.claim_id,
      j.lease_expires_at,
      j.attempt_count
    from public.research_jobs j
    where j.id = candidate.id
      and j.owner_id = p_owner_id;
end;
$$;

revoke all on function public.claim_pending_research_job(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_pending_research_job(uuid, integer)
  to service_role;

-- ---------------------------------------------------------
-- SUBMISSION
-- The worker can submit only against its active claim. Once accepted, a
-- result is immutable; a byte-for-byte canonical retry is idempotent.
-- ---------------------------------------------------------

create or replace function public.submit_research_result(
  p_owner_id uuid,
  p_job_id uuid,
  p_claim_id uuid,
  p_result jsonb,
  p_result_hash text
)
returns table (
  research_job_id uuid,
  run_id uuid,
  research_status text,
  newly_submitted boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_job public.research_jobs%rowtype;
  parent_status text;
  parent_stage text;
  iso_timestamp_pattern constant text :=
    '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$';
  iso_date_or_timestamp_pattern constant text :=
    '^[0-9]{4}-[0-9]{2}-[0-9]{2}($|T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$)';
begin
  if p_owner_id is null
    or p_job_id is null
    or p_claim_id is null
    or p_result is null
    or jsonb_typeof(p_result) is distinct from 'object'
    or octet_length(p_result::text) > 1048576
    or p_result_hash is null
    or p_result_hash !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_result -> 'sources') is distinct from 'array'
    or jsonb_array_length(p_result -> 'sources') > 40
    or jsonb_typeof(p_result -> 'ideas') is distinct from 'array'
    or jsonb_array_length(p_result -> 'ideas') > 5
  then
    raise exception 'Invalid research result.' using errcode = '22023';
  end if;

  select j.*
    into current_job
  from public.research_jobs j
  where j.id = p_job_id
    and j.owner_id = p_owner_id
  for update;

  if not found then
    raise exception 'Research job not found.' using errcode = 'P0002';
  end if;

  if current_job.status in ('submitted', 'validating', 'completed') then
    if current_job.result_hash = p_result_hash then
      return query
        select current_job.id, current_job.run_id, current_job.status, false;
      return;
    end if;

    raise exception 'A different research result was already accepted.' using errcode = '23514';
  end if;

  if current_job.status is distinct from 'claimed'
    or current_job.claim_id is distinct from p_claim_id
    or current_job.lease_expires_at is null
    or current_job.lease_expires_at <= now()
  then
    raise exception 'The research claim is invalid or expired.' using errcode = '55000';
  end if;

  if coalesce(p_result ->> 'schema_version', '') !~ '^[1-9][0-9]*$'
    or (p_result ->> 'schema_version')::integer <> current_job.schema_version
  then
    raise exception 'The research result schema version is invalid.' using errcode = '23514';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_result -> 'sources') source(item)
    where jsonb_typeof(source.item) is distinct from 'object'
      or nullif(btrim(source.item ->> 'source_id'), '') is null
      or nullif(btrim(source.item ->> 'url'), '') is null
      or nullif(btrim(source.item ->> 'title'), '') is null
      or nullif(btrim(source.item ->> 'source_type'), '') is null
      or nullif(btrim(source.item ->> 'accessed_at'), '') is null
      or (source.item ->> 'accessed_at') !~ iso_timestamp_pattern
      or (
        source.item ->> 'published_at' is not null
        and (source.item ->> 'published_at') !~ iso_date_or_timestamp_pattern
      )
      or jsonb_typeof(source.item -> 'supported_claims') is distinct from 'array'
      or jsonb_array_length(source.item -> 'supported_claims') not between 1 and 20
  ) then
    raise exception 'The research result contains invalid sources.' using errcode = '23514';
  end if;

  if jsonb_array_length(p_result -> 'sources') <> (
    select count(distinct source.item ->> 'source_id')
    from jsonb_array_elements(p_result -> 'sources') source(item)
  ) then
    raise exception 'The research result contains duplicate source IDs.' using errcode = '23514';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_result -> 'ideas') idea(item)
    where jsonb_typeof(idea.item) is distinct from 'object'
  ) then
    raise exception 'The research result contains invalid ideas.' using errcode = '23514';
  end if;

  select r.status, r.stage
    into parent_status, parent_stage
  from public.runs r
  where r.id = current_job.run_id
    and r.owner_id = p_owner_id
  for update;

  if not found
    or parent_status is distinct from 'running'
    or parent_stage is distinct from 'researching'
  then
    raise exception 'The parent run is not accepting research.' using errcode = '55000';
  end if;

  update public.research_jobs j
  set status = 'submitted',
      result = p_result,
      result_hash = p_result_hash,
      claim_id = null,
      lease_expires_at = null,
      submitted_at = now(),
      last_error_code = null,
      last_error_message = null,
      updated_at = now()
  where j.id = current_job.id
    and j.owner_id = p_owner_id;

  return query
    select current_job.id, current_job.run_id, 'submitted'::text, true;
end;
$$;

revoke all on function public.submit_research_result(
  uuid, uuid, uuid, jsonb, text
) from public, anon, authenticated;
grant execute on function public.submit_research_result(
  uuid, uuid, uuid, jsonb, text
) to service_role;

-- ---------------------------------------------------------
-- WORKER FAILURE / RETRY
-- Messages are selected here, not copied from untrusted model output.
-- ---------------------------------------------------------

create or replace function public.report_research_job_failure(
  p_owner_id uuid,
  p_job_id uuid,
  p_claim_id uuid,
  p_error_code text,
  p_retry_delay_seconds integer default 900
)
returns table (
  research_job_id uuid,
  research_status text,
  retry_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_job public.research_jobs%rowtype;
  safe_message text;
  next_available_at timestamptz;
begin
  if p_error_code is null or p_error_code not in (
    'research_unavailable',
    'source_access_failed',
    'submission_invalid',
    'tool_error'
  ) or p_retry_delay_seconds is null
  then
    raise exception 'Invalid research failure report.' using errcode = '22023';
  end if;

  safe_message := case p_error_code
    when 'research_unavailable' then 'Current web research was unavailable.'
    when 'source_access_failed' then 'One or more research sources could not be accessed.'
    when 'submission_invalid' then 'The research result did not satisfy the submission contract.'
    else 'The scheduled research worker encountered a tool error.'
  end;

  select j.*
    into current_job
  from public.research_jobs j
  where j.id = p_job_id
    and j.owner_id = p_owner_id
  for update;

  if not found then
    raise exception 'Research job not found.' using errcode = 'P0002';
  end if;

  if current_job.status = 'failed' then
    return query select current_job.id, current_job.status, null::timestamptz;
    return;
  end if;

  if current_job.status is distinct from 'claimed'
    or current_job.claim_id is distinct from p_claim_id
    or current_job.lease_expires_at is null
    or current_job.lease_expires_at <= now()
  then
    raise exception 'The research claim is invalid or expired.' using errcode = '55000';
  end if;

  if current_job.attempt_count >= 3 then
    update public.research_jobs j
    set status = 'failed',
        claim_id = null,
        lease_expires_at = null,
        last_error_code = p_error_code,
        last_error_message = safe_message,
        updated_at = now(),
        failed_at = now()
    where j.id = current_job.id;

    update public.runs r
    set status = 'failed',
        error_message = 'External research failed after three attempts.',
        completed_at = now()
    where r.id = current_job.run_id
      and r.owner_id = p_owner_id
      and r.status in ('queued', 'running');

    return query select current_job.id, 'failed'::text, null::timestamptz;
    return;
  end if;

  next_available_at := now()
    + make_interval(secs => greatest(60, least(p_retry_delay_seconds, 3600)));

  update public.research_jobs j
  set status = 'pending',
      claim_id = null,
      lease_expires_at = null,
      available_at = next_available_at,
      last_error_code = p_error_code,
      last_error_message = safe_message,
      updated_at = now(),
      claimed_at = null
  where j.id = current_job.id;

  update public.runs r
  set stage = 'research_queued',
      error_message = null
  where r.id = current_job.run_id
    and r.owner_id = p_owner_id
    and r.status = 'running'
    and r.stage = 'researching';

  if not found then
    raise exception 'The parent run is not retryable.' using errcode = '55000';
  end if;

  return query select current_job.id, 'pending'::text, next_available_at;
end;
$$;

revoke all on function public.report_research_job_failure(
  uuid, uuid, uuid, text, integer
) from public, anon, authenticated;
grant execute on function public.report_research_job_failure(
  uuid, uuid, uuid, text, integer
) to service_role;

-- ---------------------------------------------------------
-- FINALIZER CLAIM
-- The accepted result stays durable in Supabase. Vercel reloads it here and
-- becomes the only component allowed to validate and publish it.
-- ---------------------------------------------------------

create or replace function public.begin_research_validation(
  p_owner_id uuid,
  p_job_id uuid
)
returns table (
  research_job_id uuid,
  run_id uuid,
  job_payload jsonb,
  job_result jsonb,
  payload_hash text,
  result_hash text,
  already_completed boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_job public.research_jobs%rowtype;
  parent_status text;
  parent_stage text;
begin
  select j.*
    into current_job
  from public.research_jobs j
  where j.id = p_job_id
    and j.owner_id = p_owner_id
  for update;

  if not found then
    raise exception 'Research job not found.' using errcode = 'P0002';
  end if;

  select r.status, r.stage
    into parent_status, parent_stage
  from public.runs r
  where r.id = current_job.run_id
    and r.owner_id = p_owner_id
  for update;

  if not found then
    raise exception 'Parent run not found.' using errcode = 'P0002';
  end if;

  if current_job.status = 'completed'
    and parent_status in ('completed', 'no_ideas')
  then
    return query
      select
        current_job.id,
        current_job.run_id,
        current_job.payload,
        current_job.result,
        current_job.payload_hash,
        current_job.result_hash,
        true;
    return;
  end if;

  if current_job.status = 'submitted'
    and parent_status = 'running'
    and parent_stage = 'researching'
  then
    update public.research_jobs j
    set status = 'validating',
        validation_started_at = now(),
        updated_at = now()
    where j.id = current_job.id;

    update public.runs r
    set stage = 'validating',
        error_message = null
    where r.id = current_job.run_id
      and r.owner_id = p_owner_id;

    current_job.status := 'validating';
  elsif current_job.status = 'validating'
    and parent_status = 'running'
    and parent_stage in ('validating', 'saving')
  then
    null;
  else
    raise exception 'Research job is not ready for validation.' using errcode = '55000';
  end if;

  return query
    select
      current_job.id,
      current_job.run_id,
      current_job.payload,
      current_job.result,
      current_job.payload_hash,
      current_job.result_hash,
      false;
end;
$$;

revoke all on function public.begin_research_validation(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.begin_research_validation(uuid, uuid)
  to service_role;

-- ---------------------------------------------------------
-- ATOMIC RESEARCHED PUBLICATION
-- The existing product publication function remains authoritative for idea
-- and X-evidence checks. This outer transaction adds validated web evidence
-- and closes the durable research job. Zero accepted ideas is also a valid,
-- atomic completion.
-- ---------------------------------------------------------

create or replace function public.publish_run_researched_ideas(
  p_owner_id uuid,
  p_job_id uuid,
  p_ideas jsonb,
  p_x_sources jsonb,
  p_research_sources jsonb,
  p_idea_research_sources jsonb,
  p_counts jsonb,
  p_usage jsonb
)
returns table (idea_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_job public.research_jobs%rowtype;
  parent_status text;
  parent_stage text;
  research_source_count integer;
  research_link_count integer;
  published_count integer;
  iso_timestamp_pattern constant text :=
    '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$';
  iso_date_or_timestamp_pattern constant text :=
    '^[0-9]{4}-[0-9]{2}-[0-9]{2}($|T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$)';
begin
  if p_owner_id is null
    or p_job_id is null
    or p_ideas is null
    or jsonb_typeof(p_ideas) is distinct from 'array'
    or jsonb_array_length(p_ideas) > 3
    or p_x_sources is null
    or jsonb_typeof(p_x_sources) is distinct from 'array'
    or p_research_sources is null
    or jsonb_typeof(p_research_sources) is distinct from 'array'
    or jsonb_array_length(p_research_sources) > 40
    or p_idea_research_sources is null
    or jsonb_typeof(p_idea_research_sources) is distinct from 'array'
    or p_counts is null
    or jsonb_typeof(p_counts) is distinct from 'object'
    or p_usage is null
    or jsonb_typeof(p_usage) is distinct from 'object'
  then
    raise exception 'Invalid researched-publication payload.' using errcode = '22023';
  end if;

  select j.*
    into current_job
  from public.research_jobs j
  where j.id = p_job_id
    and j.owner_id = p_owner_id
  for update;

  if not found then
    raise exception 'Research job not found.' using errcode = 'P0002';
  end if;

  if current_job.status = 'completed' then
    return query
      select i.id
      from public.ideas i
      where i.run_id = current_job.run_id
        and i.owner_id = p_owner_id
      order by i.rank;
    return;
  end if;

  select r.status, r.stage
    into parent_status, parent_stage
  from public.runs r
  where r.id = current_job.run_id
    and r.owner_id = p_owner_id
  for update;

  if not found then
    raise exception 'Parent run not found.' using errcode = 'P0002';
  end if;

  if current_job.status is distinct from 'validating'
    or parent_status is distinct from 'running'
    or parent_stage not in ('validating', 'saving')
  then
    raise exception 'Research job is not ready for publication.' using errcode = '55000';
  end if;

  if jsonb_array_length(p_research_sources) > 0 and exists (
    select 1
    from jsonb_array_elements(p_research_sources) source(item)
    where jsonb_typeof(source.item) is distinct from 'object'
      or nullif(btrim(source.item ->> 'source_id'), '') is null
      or length(btrim(source.item ->> 'source_id')) > 80
      or nullif(btrim(source.item ->> 'url'), '') is null
      or length(source.item ->> 'url') > 2048
      or (source.item ->> 'url') !~* '^https?://'
      or nullif(btrim(source.item ->> 'title'), '') is null
      or length(btrim(source.item ->> 'title')) > 500
      or (
        source.item ? 'publisher'
        and source.item ->> 'publisher' is not null
        and (
          nullif(btrim(source.item ->> 'publisher'), '') is null
          or length(btrim(source.item ->> 'publisher')) > 300
        )
      )
      or nullif(btrim(source.item ->> 'accessed_at'), '') is null
      or (source.item ->> 'accessed_at') !~ iso_timestamp_pattern
      or (
        source.item ->> 'published_at' is not null
        and (source.item ->> 'published_at') !~ iso_date_or_timestamp_pattern
      )
      or nullif(btrim(source.item ->> 'source_type'), '') is null
      or (source.item ->> 'source_type') not in (
        'competitor',
        'competitor_pricing',
        'customer_evidence',
        'feasibility',
        'distribution',
        'latam_fit',
        'risk',
        'other'
      )
      or jsonb_typeof(source.item -> 'supported_claims') is distinct from 'array'
      or jsonb_array_length(source.item -> 'supported_claims') not between 1 and 20
      or exists (
        select 1
        from jsonb_array_elements_text(source.item -> 'supported_claims') claim(value)
        where nullif(btrim(claim.value), '') is null
          or length(claim.value) > 1000
      )
  ) then
    raise exception 'External research sources are invalid.' using errcode = '23514';
  end if;

  if jsonb_array_length(p_research_sources) <> (
    select count(distinct source.item ->> 'source_id')
    from jsonb_array_elements(p_research_sources) source(item)
  ) then
    raise exception 'External research source IDs must be unique.' using errcode = '23514';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_research_sources) source(item)
    where not exists (
      select 1
      from jsonb_array_elements(current_job.result -> 'sources') submitted(item)
      where submitted.item ->> 'source_id' = source.item ->> 'source_id'
    )
  ) then
    raise exception 'An external source was not part of the accepted result.' using errcode = '23514';
  end if;

  if jsonb_array_length(p_ideas) = 0 then
    if jsonb_array_length(p_x_sources) <> 0
      or jsonb_array_length(p_idea_research_sources) <> 0
    then
      raise exception 'A zero-idea result cannot contain idea links.' using errcode = '23514';
    end if;
  else
    if jsonb_array_length(p_idea_research_sources) = 0 then
      raise exception 'Published ideas require external research links.' using errcode = '23514';
    end if;

    if exists (
      select 1
      from jsonb_array_elements(p_idea_research_sources) link(item)
      where jsonb_typeof(link.item) is distinct from 'object'
        or nullif(btrim(link.item ->> 'fingerprint_hash'), '') is null
        or (link.item ->> 'fingerprint_hash') !~ '^[0-9a-f]{64}$'
        or nullif(btrim(link.item ->> 'source_id'), '') is null
        or jsonb_typeof(link.item -> 'supported_claims') is distinct from 'array'
        or jsonb_array_length(link.item -> 'supported_claims') not between 1 and 20
        or exists (
          select 1
          from jsonb_array_elements_text(link.item -> 'supported_claims') claim(value)
          where nullif(btrim(claim.value), '') is null
            or length(claim.value) > 1000
        )
    ) then
      raise exception 'Idea research links are invalid.' using errcode = '23514';
    end if;

    if exists (
      select 1
      from jsonb_array_elements(p_idea_research_sources) link(item)
      group by link.item ->> 'fingerprint_hash', link.item ->> 'source_id'
      having count(*) > 1
    ) then
      raise exception 'Idea research links must be unique.' using errcode = '23514';
    end if;

    if exists (
      select 1
      from jsonb_array_elements(p_idea_research_sources) link(item)
      where not exists (
        select 1
        from jsonb_array_elements(p_ideas) idea(item)
        where idea.item ->> 'fingerprint_hash'
          = link.item ->> 'fingerprint_hash'
      )
      or not exists (
        select 1
        from jsonb_array_elements(p_research_sources) source(item)
        where source.item ->> 'source_id' = link.item ->> 'source_id'
      )
    ) then
      raise exception 'An idea research link is outside the publication payload.' using errcode = '23514';
    end if;
  end if;

  update public.runs r
  set stage = 'saving',
      error_message = null
  where r.id = current_job.run_id
    and r.owner_id = p_owner_id;

  with inserted as (
    insert into public.research_sources (
      job_id,
      run_id,
      owner_id,
      source_id,
      url,
      title,
      publisher,
      published_at,
      accessed_at,
      source_type,
      supported_claims
    )
    select
      current_job.id,
      current_job.run_id,
      p_owner_id,
      btrim(source.item ->> 'source_id'),
      source.item ->> 'url',
      btrim(source.item ->> 'title'),
      nullif(btrim(source.item ->> 'publisher'), ''),
      nullif(source.item ->> 'published_at', '')::timestamptz,
      (source.item ->> 'accessed_at')::timestamptz,
      source.item ->> 'source_type',
      array(
        select claim.value
        from jsonb_array_elements_text(source.item -> 'supported_claims') claim(value)
      )
    from jsonb_array_elements(p_research_sources) source(item)
    returning id
  )
  select count(*)::integer into research_source_count from inserted;

  if research_source_count <> jsonb_array_length(p_research_sources) then
    raise exception 'Not every external research source was stored.' using errcode = '23514';
  end if;

  if jsonb_array_length(p_ideas) = 0 then
    update public.runs r
    set status = 'no_ideas',
        stage = null,
        counts = p_counts || jsonb_build_object('ideas_saved', 0),
        usage = p_usage,
        error_message = null,
        completed_at = now()
    where r.id = current_job.run_id
      and r.owner_id = p_owner_id;

    update public.research_jobs j
    set status = 'completed',
        updated_at = now(),
        completed_at = now()
    where j.id = current_job.id
      and j.owner_id = p_owner_id;

    return;
  end if;

  select count(*)::integer
    into published_count
  from public.publish_run_product_ideas(
    p_owner_id,
    current_job.run_id,
    p_ideas,
    p_x_sources,
    p_counts,
    p_usage
  );

  if published_count <> jsonb_array_length(p_ideas) then
    raise exception 'Published idea count does not match the researched payload.' using errcode = '23514';
  end if;

  with inserted as (
    insert into public.idea_research_sources as inserted_link (
      idea_id,
      research_source_id,
      run_id,
      owner_id,
      supported_claims
    )
    select
      i.id,
      source.id,
      current_job.run_id,
      p_owner_id,
      array(
        select claim.value
        from jsonb_array_elements_text(link.item -> 'supported_claims') claim(value)
      )
    from jsonb_array_elements(p_idea_research_sources) link(item)
    join public.ideas i
      on i.owner_id = p_owner_id
      and i.run_id = current_job.run_id
      and i.fingerprint_hash = link.item ->> 'fingerprint_hash'
    join public.research_sources source
      on source.owner_id = p_owner_id
      and source.run_id = current_job.run_id
      and source.job_id = current_job.id
      and source.source_id = link.item ->> 'source_id'
    returning inserted_link.idea_id
  )
  select count(*)::integer into research_link_count from inserted;

  if research_link_count <> jsonb_array_length(p_idea_research_sources) then
    raise exception 'Not every idea research link was stored.' using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.ideas i
    where i.owner_id = p_owner_id
      and i.run_id = current_job.run_id
      and not exists (
        select 1
        from public.idea_research_sources link
        where link.owner_id = p_owner_id
          and link.run_id = current_job.run_id
          and link.idea_id = i.id
      )
  ) then
    raise exception 'Every published idea requires external research.' using errcode = '23514';
  end if;

  update public.research_jobs j
  set status = 'completed',
      updated_at = now(),
      completed_at = now()
  where j.id = current_job.id
    and j.owner_id = p_owner_id;

  return query
    select i.id
    from public.ideas i
    where i.owner_id = p_owner_id
      and i.run_id = current_job.run_id
    order by i.rank;
end;
$$;

revoke all on function public.publish_run_researched_ideas(
  uuid, uuid, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.publish_run_researched_ideas(
  uuid, uuid, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb
) to service_role;

-- ---------------------------------------------------------
-- TERMINAL FINALIZER FAILURE
-- Detailed provider/tool failures stay in Vercel logs. Only bounded text is
-- retained on the private job, and the run receives a fixed safe message.
-- ---------------------------------------------------------

create or replace function public.fail_research_job(
  p_owner_id uuid,
  p_job_id uuid,
  p_error_message text
)
returns table (research_job_id uuid, research_status text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_job public.research_jobs%rowtype;
  bounded_message text;
begin
  bounded_message := left(
    coalesce(
      nullif(btrim(p_error_message), ''),
      'The submitted research could not be validated.'
    ),
    500
  );

  select j.*
    into current_job
  from public.research_jobs j
  where j.id = p_job_id
    and j.owner_id = p_owner_id
  for update;

  if not found then
    raise exception 'Research job not found.' using errcode = 'P0002';
  end if;

  if current_job.status = 'completed' then
    return query select current_job.id, current_job.status;
    return;
  end if;

  if current_job.status <> 'failed' then
    update public.research_jobs j
    set status = 'failed',
        claim_id = null,
        lease_expires_at = null,
        last_error_code = 'submission_invalid',
        last_error_message = bounded_message,
        updated_at = now(),
        completed_at = null,
        failed_at = now()
    where j.id = current_job.id
      and j.owner_id = p_owner_id;

    update public.runs r
    set status = 'failed',
        error_message = 'External research validation failed after retries.',
        completed_at = now()
    where r.id = current_job.run_id
      and r.owner_id = p_owner_id
      and r.status in ('queued', 'running');
  end if;

  return query select current_job.id, 'failed'::text;
end;
$$;

revoke all on function public.fail_research_job(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.fail_research_job(uuid, uuid, text)
  to service_role;

-- ---------------------------------------------------------
-- MCP OAUTH AUDIENCE
-- Supabase must be configured separately in the Dashboard to use this
-- function as the Custom Access Token Hook. SQL cannot enable that setting.
-- Ordinary browser/session tokens have no client_id claim and retain their
-- existing audience. OAuth-issued tokens receive the MCP resource audience.
-- ---------------------------------------------------------

create or replace function public.signal_foundry_access_token_hook(
  event jsonb
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  claims jsonb;
begin
  if event is null or jsonb_typeof(event) is distinct from 'object' then
    return event;
  end if;

  claims := event -> 'claims';

  if claims is null or jsonb_typeof(claims) is distinct from 'object' then
    return event;
  end if;

  -- Supabase places the OAuth client identifier inside the claims object in
  -- the Postgres Custom Access Token Hook event. Ordinary browser sessions do
  -- not have this claim and must retain their normal `authenticated` audience.
  if nullif(btrim(claims ->> 'client_id'), '') is null then
    return jsonb_build_object('claims', claims);
  end if;

  claims := jsonb_set(
    claims,
    '{aud}',
    to_jsonb('https://admins-projects-d500137d.vercel.app/mcp'::text),
    true
  );

  -- The documented hook output contains the claims object only.
  return jsonb_build_object('claims', claims);
end;
$$;

comment on function public.signal_foundry_access_token_hook(jsonb) is
  'Custom Access Token Hook: sets the production MCP audience only for OAuth tokens with client_id. Enable it in the Supabase Dashboard.';

revoke all on function public.signal_foundry_access_token_hook(jsonb)
  from public, anon, authenticated;
grant usage on schema public to supabase_auth_admin;
grant execute on function public.signal_foundry_access_token_hook(jsonb)
  to supabase_auth_admin;

-- ---------------------------------------------------------
-- ROW LEVEL SECURITY
-- The owner may inspect queue and citation records. Browser writes are not
-- permitted; every state mutation goes through a service-role function.
-- Supabase OAuth access tokens otherwise inherit the same database access as
-- an ordinary owner session. Reject every token with an OAuth `client_id` at
-- the table boundary so the scheduled worker can act only through /mcp.
-- ---------------------------------------------------------

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'settings',
    'runs',
    'posts',
    'run_posts',
    'clusters',
    'ideas',
    'idea_sources'
  ]
  loop
    execute format(
      'drop policy if exists owner_only on public.%I',
      table_name
    );

    execute format(
      'create policy owner_browser_only on public.%I
       for all
       to authenticated
       using (
         owner_id = auth.uid()
         and coalesce(auth.jwt() ->> ''client_id'', '''') = ''''
       )
       with check (
         owner_id = auth.uid()
         and coalesce(auth.jwt() ->> ''client_id'', '''') = ''''
       )',
      table_name
    );
  end loop;
end $$;

alter table public.research_jobs enable row level security;
alter table public.research_sources enable row level security;
alter table public.idea_research_sources enable row level security;

create policy research_jobs_owner_read
  on public.research_jobs
  for select
  to authenticated
  using (
    owner_id = auth.uid()
    and coalesce(auth.jwt() ->> 'client_id', '') = ''
  );

create policy research_sources_owner_read
  on public.research_sources
  for select
  to authenticated
  using (
    owner_id = auth.uid()
    and coalesce(auth.jwt() ->> 'client_id', '') = ''
  );

create policy idea_research_sources_owner_read
  on public.idea_research_sources
  for select
  to authenticated
  using (
    owner_id = auth.uid()
    and coalesce(auth.jwt() ->> 'client_id', '') = ''
  );

revoke all on public.research_jobs from anon, authenticated;
revoke all on public.research_sources from anon, authenticated;
revoke all on public.idea_research_sources from anon, authenticated;

grant select on public.research_jobs to authenticated;
grant select on public.research_sources to authenticated;
grant select on public.idea_research_sources to authenticated;

grant select, insert, update, delete on public.research_jobs to service_role;
grant select, insert, update, delete on public.research_sources to service_role;
grant select, insert, update, delete on public.idea_research_sources to service_role;

comment on table public.research_jobs is
  'Durable bounded handoffs to the scheduled external research worker.';
comment on table public.research_sources is
  'Validated external source metadata and concise supported claims.';
comment on table public.idea_research_sources is
  'Run-safe links from published ideas to validated external sources.';

-- ---------------------------------------------------------
-- CHECKPOINT RECOVERY
-- A same-day retry starts at fetch again. These existing checkpoint functions
-- must therefore recognize every later research stage and return their saved
-- outputs instead of attempting to overwrite an already-advanced run.
-- ---------------------------------------------------------

create or replace function public.persist_luna_checkpoint(
  p_owner_id uuid,
  p_run_id uuid,
  p_analyses jsonb,
  p_counts jsonb,
  p_luna_usage jsonb,
  p_no_ideas boolean
)
returns table (signal_post_id text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_status text;
  current_stage text;
  selected_count integer;
  payload_count integer;
  qualifying_count integer;
  updated_count integer;
begin
  if p_analyses is null
    or jsonb_typeof(p_analyses) is distinct from 'array'
    or p_counts is null
    or jsonb_typeof(p_counts) is distinct from 'object'
    or p_luna_usage is null
    or jsonb_typeof(p_luna_usage) is distinct from 'object'
    or p_no_ideas is null
  then
    raise exception 'Invalid Luna checkpoint payload.' using errcode = '22023';
  end if;

  select r.status, r.stage
    into current_status, current_stage
  from public.runs r
  where r.id = p_run_id
    and r.owner_id = p_owner_id
  for update;

  if not found then
    raise exception 'Run not found.' using errcode = 'P0002';
  end if;

  if current_status in ('completed', 'no_ideas', 'failed')
    or current_stage in (
      'clustering',
      'generating',
      'research_queued',
      'researching',
      'validating',
      'saving'
    )
  then
    return query
      select rp.post_id
      from public.run_posts rp
      join public.posts p
        on p.owner_id = rp.owner_id
        and p.x_post_id = rp.post_id
      where rp.run_id = p_run_id
        and rp.owner_id = p_owner_id
        and rp.selected_for_ai = true
        and rp.relevant = true
        and rp.commercial_score >= 50
        and rp.hype_score <= 75
        and nullif(btrim(rp.problem), '') is not null
        and nullif(btrim(rp.signal_summary), '') is not null
        and nullif(btrim(p.author_id), '') is not null
      order by rp.opportunity_score desc nulls last,
        rp.commercial_score desc,
        rp.hype_score,
        rp.post_id
      limit 70;
    return;
  end if;

  if current_status not in ('queued', 'running')
    or current_stage is distinct from 'extracting'
  then
    raise exception 'Run is not ready for the Luna checkpoint.' using errcode = '55000';
  end if;

  payload_count := jsonb_array_length(p_analyses);

  select count(*)
    into selected_count
  from public.run_posts rp
  where rp.run_id = p_run_id
    and rp.owner_id = p_owner_id
    and rp.selected_for_ai = true;

  if payload_count < 5 or payload_count <> selected_count then
    raise exception 'Luna checkpoint must contain every selected post.' using errcode = '23514';
  end if;

  if payload_count <> (
    select count(distinct analysis.post_id)
    from jsonb_to_recordset(p_analyses) as analysis(post_id text)
  ) then
    raise exception 'Luna checkpoint contains duplicate or missing post IDs.' using errcode = '23514';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_analyses) as analysis(
      post_id text,
      relevant boolean,
      signal_type text,
      evidence_excerpt text,
      commercial_score smallint,
      hype_score smallint,
      opportunity_score real
    )
    left join public.run_posts rp
      on rp.run_id = p_run_id
      and rp.owner_id = p_owner_id
      and rp.post_id = analysis.post_id
      and rp.selected_for_ai = true
    left join public.posts p
      on p.owner_id = p_owner_id
      and p.x_post_id = analysis.post_id
    where analysis.post_id is null
      or rp.post_id is null
      or p.x_post_id is null
      or analysis.relevant is null
      or analysis.signal_type is null
      or analysis.signal_type not in (
        'pain',
        'request',
        'workaround',
        'spending',
        'new_capability',
        'hype',
        'none'
      )
      or analysis.commercial_score is null
      or analysis.commercial_score not between 0 and 100
      or analysis.hype_score is null
      or analysis.hype_score not between 0 and 100
      or analysis.opportunity_score is null
      or (
        nullif(analysis.evidence_excerpt, '') is not null
        and (
          p.text is null
          or position(analysis.evidence_excerpt in p.text) = 0
        )
      )
  ) then
    raise exception 'Luna checkpoint contains invalid analysis data.' using errcode = '23514';
  end if;

  with analysis as (
    select *
    from jsonb_to_recordset(p_analyses) as payload(
      post_id text,
      relevant boolean,
      signal_type text,
      target_customer text,
      problem text,
      evidence_excerpt text,
      signal_summary text,
      commercial_score smallint,
      hype_score smallint,
      opportunity_score real
    )
  ), updated as (
    update public.run_posts rp
    set relevant = analysis.relevant,
        signal_type = analysis.signal_type,
        target_customer = nullif(analysis.target_customer, ''),
        problem = nullif(analysis.problem, ''),
        evidence_excerpt = nullif(analysis.evidence_excerpt, ''),
        signal_summary = nullif(analysis.signal_summary, ''),
        commercial_score = analysis.commercial_score,
        hype_score = analysis.hype_score,
        opportunity_score = analysis.opportunity_score
    from analysis
    where rp.run_id = p_run_id
      and rp.owner_id = p_owner_id
      and rp.post_id = analysis.post_id
      and rp.selected_for_ai = true
    returning rp.post_id
  )
  select count(*) into updated_count from updated;

  if updated_count <> selected_count then
    raise exception 'Luna checkpoint did not update every selected post.' using errcode = '23514';
  end if;

  select count(*)
    into qualifying_count
  from (
    select rp.post_id
    from public.run_posts rp
    join public.posts p
      on p.owner_id = rp.owner_id
      and p.x_post_id = rp.post_id
    where rp.run_id = p_run_id
      and rp.owner_id = p_owner_id
      and rp.selected_for_ai = true
      and rp.relevant = true
      and rp.commercial_score >= 50
      and rp.hype_score <= 75
      and nullif(btrim(rp.problem), '') is not null
      and nullif(btrim(rp.signal_summary), '') is not null
      and nullif(btrim(p.author_id), '') is not null
    order by rp.opportunity_score desc nulls last,
      rp.commercial_score desc,
      rp.hype_score,
      rp.post_id
    limit 70
  ) signals;

  if p_no_ideas is distinct from (qualifying_count < 5) then
    raise exception 'Luna checkpoint terminal state does not match its signals.' using errcode = '23514';
  end if;

  update public.runs r
  set status = case when p_no_ideas then 'no_ideas' else 'running' end,
      stage = case when p_no_ideas then null else 'clustering' end,
      counts = coalesce(r.counts, '{}'::jsonb)
        || p_counts
        || jsonb_build_object(
          'sent_to_luna', selected_count,
          'relevant_signals', qualifying_count
        )
        || case
          when p_no_ideas then jsonb_build_object('ideas_saved', 0)
          else '{}'::jsonb
        end,
      usage = coalesce(r.usage, '{}'::jsonb)
        || jsonb_build_object('luna', p_luna_usage),
      error_message = null,
      completed_at = case when p_no_ideas then now() else null end
  where r.id = p_run_id
    and r.owner_id = p_owner_id;

  return query
    select rp.post_id
    from public.run_posts rp
    join public.posts p
      on p.owner_id = rp.owner_id
      and p.x_post_id = rp.post_id
    where rp.run_id = p_run_id
      and rp.owner_id = p_owner_id
      and rp.selected_for_ai = true
      and rp.relevant = true
      and rp.commercial_score >= 50
      and rp.hype_score <= 75
      and nullif(btrim(rp.problem), '') is not null
      and nullif(btrim(rp.signal_summary), '') is not null
      and nullif(btrim(p.author_id), '') is not null
    order by rp.opportunity_score desc nulls last,
      rp.commercial_score desc,
      rp.hype_score,
      rp.post_id
    limit 70;
end;
$$;

revoke all on function public.persist_luna_checkpoint(
  uuid, uuid, jsonb, jsonb, jsonb, boolean
) from public, anon, authenticated;
grant execute on function public.persist_luna_checkpoint(
  uuid, uuid, jsonb, jsonb, jsonb, boolean
) to service_role;

create or replace function public.persist_terra_checkpoint(
  p_owner_id uuid,
  p_run_id uuid,
  p_clusters jsonb,
  p_counts jsonb,
  p_terra_usage jsonb,
  p_no_ideas boolean
)
returns table (cluster_id uuid, eligible boolean)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_status text;
  current_stage text;
  payload_count integer;
  eligible_count integer;
  inserted_count integer;
begin
  if p_clusters is null
    or jsonb_typeof(p_clusters) is distinct from 'array'
    or p_counts is null
    or jsonb_typeof(p_counts) is distinct from 'object'
    or p_terra_usage is null
    or jsonb_typeof(p_terra_usage) is distinct from 'object'
    or p_no_ideas is null
  then
    raise exception 'Invalid Terra checkpoint payload.' using errcode = '22023';
  end if;

  select r.status, r.stage
    into current_status, current_stage
  from public.runs r
  where r.id = p_run_id
    and r.owner_id = p_owner_id
  for update;

  if not found then
    raise exception 'Run not found.' using errcode = 'P0002';
  end if;

  if current_status in ('completed', 'no_ideas', 'failed')
    or current_stage in (
      'generating',
      'research_queued',
      'researching',
      'validating',
      'saving'
    )
  then
    return query
      select c.id, c.eligible
      from public.clusters c
      where c.run_id = p_run_id
        and c.owner_id = p_owner_id
      order by c.evidence_strength desc, c.id;
    return;
  end if;

  if current_status not in ('queued', 'running')
    or current_stage is distinct from 'clustering'
  then
    raise exception 'Run is not ready for the Terra checkpoint.' using errcode = '55000';
  end if;

  payload_count := jsonb_array_length(p_clusters);

  if payload_count > 8 then
    raise exception 'Terra checkpoint cannot contain more than eight clusters.' using errcode = '23514';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_clusters) cluster(item)
    where jsonb_typeof(cluster.item) is distinct from 'object'
      or nullif(btrim(cluster.item ->> 'title'), '') is null
      or nullif(btrim(cluster.item ->> 'target_customer'), '') is null
      or nullif(btrim(cluster.item ->> 'problem'), '') is null
      or nullif(btrim(cluster.item ->> 'summary'), '') is null
      or jsonb_typeof(cluster.item -> 'evidence_post_ids') is distinct from 'array'
      or jsonb_typeof(cluster.item -> 'evidence_strength') is distinct from 'number'
      or jsonb_typeof(cluster.item -> 'payment_signal') is distinct from 'number'
      or jsonb_typeof(cluster.item -> 'eligible') is distinct from 'boolean'
  ) then
    raise exception 'Terra checkpoint contains invalid cluster data.' using errcode = '23514';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_clusters) cluster(item)
    cross join lateral jsonb_array_elements_text(
      cluster.item -> 'evidence_post_ids'
    ) source(post_id)
    left join public.run_posts rp
      on rp.run_id = p_run_id
      and rp.owner_id = p_owner_id
      and rp.post_id = source.post_id
      and rp.selected_for_ai = true
      and rp.relevant = true
      and rp.commercial_score >= 50
      and rp.hype_score <= 75
      and nullif(btrim(rp.problem), '') is not null
      and nullif(btrim(rp.signal_summary), '') is not null
    where nullif(btrim(source.post_id), '') is null
      or rp.post_id is null
  ) then
    raise exception 'Terra checkpoint references a non-signal post.' using errcode = '23514';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_clusters) cluster(item)
    where jsonb_array_length(cluster.item -> 'evidence_post_ids') <> (
      select count(distinct source.post_id)
      from jsonb_array_elements_text(
        cluster.item -> 'evidence_post_ids'
      ) source(post_id)
    )
  ) then
    raise exception 'Terra checkpoint contains duplicate source IDs.' using errcode = '23514';
  end if;

  select count(*)
    into eligible_count
  from jsonb_array_elements(p_clusters) cluster(item)
  where (cluster.item ->> 'eligible')::boolean = true;

  if eligible_count > 8
    or p_no_ideas is distinct from (eligible_count = 0)
  then
    raise exception 'Terra checkpoint terminal state does not match its clusters.' using errcode = '23514';
  end if;

  delete from public.clusters c
  where c.run_id = p_run_id
    and c.owner_id = p_owner_id;

  with inserted as (
    insert into public.clusters (
      run_id,
      owner_id,
      title,
      target_customer,
      problem,
      why_now,
      summary,
      evidence_post_ids,
      evidence_strength,
      payment_signal,
      eligible
    )
    select
      p_run_id,
      p_owner_id,
      cluster.item ->> 'title',
      cluster.item ->> 'target_customer',
      cluster.item ->> 'problem',
      nullif(cluster.item ->> 'why_now', ''),
      cluster.item ->> 'summary',
      array(
        select jsonb_array_elements_text(
          cluster.item -> 'evidence_post_ids'
        )
      ),
      (cluster.item ->> 'evidence_strength')::smallint,
      (cluster.item ->> 'payment_signal')::smallint,
      (cluster.item ->> 'eligible')::boolean
    from jsonb_array_elements(p_clusters) cluster(item)
    returning id
  )
  select count(*) into inserted_count from inserted;

  if inserted_count <> payload_count then
    raise exception 'Terra checkpoint did not insert every cluster.' using errcode = '23514';
  end if;

  update public.runs r
  set status = case when p_no_ideas then 'no_ideas' else 'running' end,
      stage = case when p_no_ideas then null else 'generating' end,
      counts = coalesce(r.counts, '{}'::jsonb)
        || p_counts
        || jsonb_build_object(
          'clusters_created', payload_count,
          'eligible_clusters', eligible_count
        )
        || case
          when p_no_ideas then jsonb_build_object('ideas_saved', 0)
          else '{}'::jsonb
        end,
      usage = coalesce(r.usage, '{}'::jsonb)
        || jsonb_build_object('terra', p_terra_usage),
      error_message = null,
      completed_at = case when p_no_ideas then now() else null end
  where r.id = p_run_id
    and r.owner_id = p_owner_id;

  return query
    select c.id, c.eligible
    from public.clusters c
    where c.run_id = p_run_id
      and c.owner_id = p_owner_id
    order by c.evidence_strength desc, c.id;
end;
$$;

revoke all on function public.persist_terra_checkpoint(
  uuid, uuid, jsonb, jsonb, jsonb, boolean
) from public, anon, authenticated;
grant execute on function public.persist_terra_checkpoint(
  uuid, uuid, jsonb, jsonb, jsonb, boolean
) to service_role;

commit;
