begin;

-- Cloud Work runs beside the production Responses API pipeline. Neither these
-- tables nor their RPCs can claim research_jobs or publish production ideas.
create table public.cloud_ideation_runs (
  id uuid primary key references public.runs(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  mode text not null default 'shadow' check (mode = 'shadow'),
  status text not null default 'pending'
    check (status in ('pending', 'running', 'completed', 'no_ideas', 'failed')),
  phase text not null default 'shortlist'
    check (phase in ('shortlist', 'generating', 'researching', 'validating', 'done')),
  input jsonb not null
    check (jsonb_typeof(input) = 'object' and octet_length(input::text) <= 1048576),
  shortlist_result jsonb
    check (shortlist_result is null or (
      jsonb_typeof(shortlist_result) = 'object'
      and octet_length(shortlist_result::text) <= 262144
    )),
  result jsonb
    check (result is null or (
      jsonb_typeof(result) = 'object' and octet_length(result::text) <= 1048576
    )),
  workflow_run_id text
    check (workflow_run_id is null or length(workflow_run_id) between 1 and 200),
  error_message text
    check (error_message is null or length(error_message) between 1 and 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  deadline_at timestamptz not null default (now() + interval '6 hours'),
  unique (id, owner_id),
  foreign key (id, owner_id) references public.runs(id, owner_id) on delete cascade,
  check (deadline_at > created_at)
);

create index cloud_ideation_runs_owner_created_idx
  on public.cloud_ideation_runs (owner_id, created_at desc);
create index cloud_ideation_runs_active_deadline_idx
  on public.cloud_ideation_runs (owner_id, deadline_at)
  where status in ('pending', 'running');

create table public.cloud_model_jobs (
  id uuid primary key default gen_random_uuid(),
  cloud_run_id uuid not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  job_key text not null check (length(btrim(job_key)) between 1 and 100),
  kind text not null check (kind in ('shortlist', 'candidate', 'research')),
  source_post_id text
    check (source_post_id is null or source_post_id ~ '^[0-9]{1,32}$'),
  payload jsonb not null
    check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 1048576),
  result jsonb
    check (result is null or (
      jsonb_typeof(result) = 'object' and octet_length(result::text) <= 262144
    )),
  status text not null default 'pending'
    check (status in ('pending', 'claimed', 'submitted', 'completed', 'failed')),
  claim_id uuid,
  lease_expires_at timestamptz,
  attempts integer not null default 0 check (attempts between 0 and 3),
  available_at timestamptz not null default now(),
  requested_model text
    check (requested_model is null or length(requested_model) between 1 and 100),
  requested_reasoning text
    check (requested_reasoning is null or length(requested_reasoning) between 1 and 30),
  runtime_metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(runtime_metadata) = 'object'
      and octet_length(runtime_metadata::text) <= 8192),
  error_message text
    check (error_message is null or length(error_message) between 1 and 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  submitted_at timestamptz,
  completed_at timestamptz,
  unique (cloud_run_id, job_key),
  foreign key (cloud_run_id, owner_id)
    references public.cloud_ideation_runs(id, owner_id) on delete cascade,
  check (kind <> 'candidate' or source_post_id is not null),
  check (status <> 'claimed' or (claim_id is not null and lease_expires_at is not null)),
  check (status not in ('submitted', 'completed') or (
    result is not null and submitted_at is not null and claim_id is not null
  ))
);

create index cloud_model_jobs_run_owner_idx
  on public.cloud_model_jobs (cloud_run_id, owner_id, created_at);
create index cloud_model_jobs_owner_created_idx
  on public.cloud_model_jobs (owner_id, created_at desc);
create index cloud_model_jobs_pending_idx
  on public.cloud_model_jobs (owner_id, available_at, created_at, id)
  where status = 'pending';
create index cloud_model_jobs_expired_claim_idx
  on public.cloud_model_jobs (owner_id, lease_expires_at)
  where status = 'claimed';

alter table public.cloud_ideation_runs enable row level security;
alter table public.cloud_model_jobs enable row level security;

create policy cloud_ideation_runs_owner_browser_read
  on public.cloud_ideation_runs for select to authenticated
  using (
    owner_id = (select auth.uid())
    and coalesce((select auth.jwt()) ->> 'client_id', '') = ''
  );
create policy cloud_model_jobs_owner_browser_read
  on public.cloud_model_jobs for select to authenticated
  using (
    owner_id = (select auth.uid())
    and coalesce((select auth.jwt()) ->> 'client_id', '') = ''
  );

revoke all on public.cloud_ideation_runs, public.cloud_model_jobs
  from public, anon, authenticated;
grant select on public.cloud_ideation_runs, public.cloud_model_jobs to authenticated;
grant all on public.cloud_ideation_runs, public.cloud_model_jobs to service_role;

-- Protect immutable handoff context and accepted results from accidental
-- coordinator updates. Only terminal snapshots older than 48h may be erased.
create function public.protect_cloud_ideation_snapshot()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
    or new.owner_id is distinct from old.owner_id
    or new.mode is distinct from old.mode
    or new.created_at is distinct from old.created_at
    or new.deadline_at is distinct from old.deadline_at
  then
    raise exception 'Cloud run identity and deadline are immutable.' using errcode = '55000';
  end if;
  if new.input is distinct from old.input and not (
    new.input = '{}'::jsonb
    and old.status in ('completed', 'no_ideas', 'failed')
    and old.created_at <= now() - interval '48 hours'
  ) then
    raise exception 'Cloud run input is immutable.' using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger cloud_ideation_snapshot_immutable
  before update on public.cloud_ideation_runs
  for each row execute function public.protect_cloud_ideation_snapshot();

create function public.protect_cloud_model_snapshot()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
    or new.cloud_run_id is distinct from old.cloud_run_id
    or new.owner_id is distinct from old.owner_id
    or new.job_key is distinct from old.job_key
    or new.kind is distinct from old.kind
    or new.source_post_id is distinct from old.source_post_id
    or new.requested_model is distinct from old.requested_model
    or new.requested_reasoning is distinct from old.requested_reasoning
    or new.created_at is distinct from old.created_at
  then
    raise exception 'Cloud job identity and requested model are immutable.' using errcode = '55000';
  end if;
  if new.payload is distinct from old.payload and not (
    new.payload = '{}'::jsonb
    and exists (
      select 1 from public.cloud_ideation_runs r
      where r.id = old.cloud_run_id and r.owner_id = old.owner_id
        and r.status in ('completed', 'no_ideas', 'failed')
        and r.created_at <= now() - interval '48 hours'
    )
  ) then
    raise exception 'Cloud job payload is immutable.' using errcode = '55000';
  end if;
  if old.submitted_at is not null and (
    new.result is distinct from old.result
    or new.claim_id is distinct from old.claim_id
    or new.submitted_at is distinct from old.submitted_at
  ) then
    raise exception 'Accepted cloud model results are immutable.' using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger cloud_model_snapshot_immutable
  before update on public.cloud_model_jobs
  for each row execute function public.protect_cloud_model_snapshot();

revoke all on function public.protect_cloud_ideation_snapshot()
  from public, anon, authenticated;
revoke all on function public.protect_cloud_model_snapshot()
  from public, anon, authenticated;

-- Invoker functions are callable by the service-role coordinator and by the
-- authenticated Supabase administration connector's postgres session only.
-- Browser sessions, OAuth access tokens, and anon cannot mutate this queue.
create function public.claim_cloud_model_job(
  p_owner_id uuid,
  p_job_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  candidate public.cloud_model_jobs%rowtype;
  run_deadline timestamptz;
begin
  if p_owner_id is null then
    raise exception 'Owner is required.' using errcode = '22023';
  end if;

  update public.cloud_model_jobs j
  set status = 'failed', claim_id = null, lease_expires_at = null,
      error_message = 'Cloud model worker exhausted three claim attempts.',
      updated_at = now(), completed_at = now()
  where j.owner_id = p_owner_id
    and (p_job_id is null or j.id = p_job_id)
    and j.status = 'claimed' and j.lease_expires_at <= now()
    and j.attempts >= 3;

  select j.* into candidate
  from public.cloud_model_jobs j
  join public.cloud_ideation_runs r
    on r.id = j.cloud_run_id and r.owner_id = j.owner_id
  where j.owner_id = p_owner_id
    and (p_job_id is null or j.id = p_job_id)
    and r.mode = 'shadow' and r.status in ('pending', 'running')
    and r.deadline_at > now() and j.attempts < 3
    and (
      (j.status = 'pending' and j.available_at <= now())
      or (j.status = 'claimed' and j.lease_expires_at <= now())
    )
  order by j.available_at, j.created_at, j.id
  limit 1
  for update of j, r skip locked;

  if not found then
    return jsonb_build_object('status', 'empty');
  end if;

  update public.cloud_ideation_runs r
  set status = 'running', updated_at = now()
  where r.id = candidate.cloud_run_id and r.owner_id = p_owner_id
  returning r.deadline_at into run_deadline;

  update public.cloud_model_jobs j
  set status = 'claimed', claim_id = gen_random_uuid(),
      lease_expires_at = least(now() + interval '30 minutes', run_deadline),
      attempts = j.attempts + 1, error_message = null, updated_at = now()
  where j.id = candidate.id and j.owner_id = p_owner_id
  returning j.* into candidate;

  return jsonb_build_object(
    'status', 'claimed', 'job_id', candidate.id,
    'claim_id', candidate.claim_id, 'cloud_run_id', candidate.cloud_run_id,
    'kind', candidate.kind, 'source_post_id', candidate.source_post_id,
    'payload', candidate.payload, 'requested_model', candidate.requested_model,
    'requested_reasoning', candidate.requested_reasoning,
    'lease_expires_at', candidate.lease_expires_at
  );
end;
$$;

create function public.submit_cloud_model_job(
  p_owner_id uuid,
  p_job_id uuid,
  p_claim_id uuid,
  p_result jsonb,
  p_runtime_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  candidate public.cloud_model_jobs%rowtype;
  safe_metadata jsonb;
begin
  if p_owner_id is null or p_job_id is null or p_claim_id is null
    or p_result is null or jsonb_typeof(p_result) is distinct from 'object'
    or octet_length(p_result::text) > 262144
    or p_runtime_metadata is null
    or jsonb_typeof(p_runtime_metadata) is distinct from 'object'
    or octet_length(p_runtime_metadata::text) > 8192
  then
    raise exception 'Invalid cloud model submission.' using errcode = '22023';
  end if;

  select j.* into candidate from public.cloud_model_jobs j
  where j.id = p_job_id and j.owner_id = p_owner_id
  for update;
  if not found then
    raise exception 'Cloud model job not found.' using errcode = 'P0002';
  end if;

  if candidate.submitted_at is not null then
    if candidate.claim_id = p_claim_id and candidate.result = p_result then
      return jsonb_build_object('status', candidate.status, 'job_id', candidate.id,
        'cloud_run_id', candidate.cloud_run_id, 'idempotent', true);
    end if;
    raise exception 'Cloud model job already has a different accepted result.' using errcode = '55000';
  end if;

  if candidate.status <> 'claimed' or candidate.claim_id is distinct from p_claim_id
    or candidate.lease_expires_at is null or candidate.lease_expires_at <= now()
  then
    raise exception 'Cloud model claim is invalid or expired.' using errcode = '55000';
  end if;

  -- Serialize acceptance with a coordinator closing the parent run.
  perform 1 from public.cloud_ideation_runs r
  where r.id = candidate.cloud_run_id and r.owner_id = p_owner_id
    and r.status in ('pending', 'running') and r.deadline_at > now()
  for update;
  if not found then
    raise exception 'Cloud model run is closed or expired.' using errcode = '55000';
  end if;

  -- A worker's description of its model is self-reported, never verification.
  safe_metadata := jsonb_strip_nulls(jsonb_build_object(
    'runtime', left(p_runtime_metadata ->> 'runtime', 100),
    'reported_model', left(p_runtime_metadata ->> 'reported_model', 100),
    'reported_reasoning', left(p_runtime_metadata ->> 'reported_reasoning', 30),
    'task_url', left(p_runtime_metadata ->> 'task_url', 2048),
    'model_verified', false
  ));

  update public.cloud_model_jobs j
  set status = 'submitted', result = p_result, runtime_metadata = safe_metadata,
      submitted_at = now(), updated_at = now(), error_message = null
  where j.id = candidate.id and j.owner_id = p_owner_id;

  return jsonb_build_object('status', 'submitted', 'job_id', candidate.id,
    'cloud_run_id', candidate.cloud_run_id, 'idempotent', false);
end;
$$;

create function public.report_cloud_model_failure(
  p_owner_id uuid,
  p_job_id uuid,
  p_claim_id uuid,
  p_error text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  candidate public.cloud_model_jobs%rowtype;
  next_status text;
  safe_error text;
begin
  if p_owner_id is null or p_job_id is null or p_claim_id is null
    or p_error is null or nullif(btrim(p_error), '') is null
  then
    raise exception 'Invalid cloud model failure report.' using errcode = '22023';
  end if;

  select j.* into candidate from public.cloud_model_jobs j
  where j.id = p_job_id and j.owner_id = p_owner_id
  for update;
  if not found then
    raise exception 'Cloud model job not found.' using errcode = 'P0002';
  end if;
  if candidate.status <> 'claimed' or candidate.claim_id is distinct from p_claim_id
    or candidate.lease_expires_at is null or candidate.lease_expires_at <= now()
  then
    raise exception 'Cloud model claim is invalid or expired.' using errcode = '55000';
  end if;

  safe_error := left(btrim(regexp_replace(p_error, '[[:cntrl:]]', ' ', 'g')), 500);
  -- Error messages are operational summaries, never credential-bearing traces.
  if safe_error ~* '(bearer[[:space:]]|sb_secret_|sk-[A-Za-z0-9]|eyJ[A-Za-z0-9_-]+\.)' then
    safe_error := 'Cloud model worker failed; sensitive diagnostic text was omitted.';
  end if;
  safe_error := coalesce(nullif(safe_error, ''), 'Cloud model worker failed.');
  next_status := case when candidate.attempts >= 3 or not exists (
    select 1 from public.cloud_ideation_runs r
    where r.id = candidate.cloud_run_id and r.owner_id = p_owner_id
      and r.status in ('pending', 'running') and r.deadline_at > now()
  ) then 'failed' else 'pending' end;

  update public.cloud_model_jobs j
  set status = next_status, claim_id = null, lease_expires_at = null,
      available_at = now() + interval '1 minute', error_message = safe_error,
      updated_at = now(), completed_at = case when next_status = 'failed' then now() else null end
  where j.id = candidate.id and j.owner_id = p_owner_id;

  return jsonb_build_object('status', next_status, 'job_id', candidate.id,
    'cloud_run_id', candidate.cloud_run_id);
end;
$$;

-- Called by the existing server-side retention pass. Results remain available
-- for comparison, while duplicate raw post input snapshots have a short life.
create function public.purge_cloud_model_payloads(
  p_owner_id uuid,
  p_before timestamptz default (now() - interval '48 hours')
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  safe_cutoff timestamptz;
  run_count integer;
  job_count integer;
begin
  if p_owner_id is null or p_before is null then
    raise exception 'Invalid cloud retention request.' using errcode = '22023';
  end if;
  safe_cutoff := least(p_before, now() - interval '48 hours');
  update public.cloud_model_jobs j
  set payload = '{}'::jsonb, updated_at = now()
  from public.cloud_ideation_runs r
  where r.id = j.cloud_run_id and r.owner_id = j.owner_id
    and j.owner_id = p_owner_id
    and r.status in ('completed', 'no_ideas', 'failed')
    and r.created_at <= safe_cutoff and j.payload <> '{}'::jsonb;
  get diagnostics job_count = row_count;

  update public.cloud_ideation_runs r
  set input = '{}'::jsonb, updated_at = now()
  where r.owner_id = p_owner_id
    and r.status in ('completed', 'no_ideas', 'failed')
    and r.created_at <= safe_cutoff and r.input <> '{}'::jsonb;
  get diagnostics run_count = row_count;
  return jsonb_build_object('runs', run_count, 'jobs', job_count);
end;
$$;

revoke all on function public.claim_cloud_model_job(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.submit_cloud_model_job(uuid, uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated;
revoke all on function public.report_cloud_model_failure(uuid, uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.purge_cloud_model_payloads(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.claim_cloud_model_job(uuid, uuid) to service_role;
grant execute on function public.submit_cloud_model_job(uuid, uuid, uuid, jsonb, jsonb) to service_role;
grant execute on function public.report_cloud_model_failure(uuid, uuid, uuid, text) to service_role;
grant execute on function public.purge_cloud_model_payloads(uuid, timestamptz) to service_role;

comment on table public.cloud_ideation_runs is
  'Additive shadow-only Cloud Work comparison runs; cannot publish or disable API processing.';
comment on table public.cloud_model_jobs is
  'Bounded immutable model jobs for the cloud schedule, isolated from the API research queue.';
comment on column public.cloud_model_jobs.runtime_metadata is
  'Worker-reported runtime details. model_verified=false; these fields do not attest to the model used.';

commit;
