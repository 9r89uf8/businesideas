begin;

-- Historical comparisons stay shadow forever. Only newly created runs may
-- explicitly select primary, and only when their source snapshot chose cloud.
alter table public.cloud_ideation_runs
  drop constraint cloud_ideation_runs_mode_check,
  add constraint cloud_ideation_runs_mode_check check (mode in ('shadow', 'primary'));

create function public.sync_primary_cloud_progress()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  source_run public.runs%rowtype;
begin
  if new.mode <> 'primary' then return new; end if;
  select r.* into source_run from public.runs r
  where r.id = new.id and r.owner_id = new.owner_id for update;
  if not found or source_run.settings_snapshot ->> 'ideation_provider' is distinct from 'chatgpt_cloud' then
    raise exception 'Primary cloud processing requires a cloud source run.' using errcode = '55000';
  end if;
  if tg_op = 'INSERT' and source_run.status not in ('queued', 'running') then
    raise exception 'A terminal source run cannot become primary cloud work.' using errcode = '55000';
  end if;
  if new.status in ('pending', 'running') then
    if source_run.status not in ('queued', 'running') then
      raise exception 'The primary source run is no longer active.' using errcode = '55000';
    end if;
    update public.runs r
    set status = 'running', stage = case new.phase
      when 'shortlist' then 'shortlisting'
      when 'generating' then 'generating'
      when 'researching' then 'researching'
      when 'validating' then 'validating'
      else r.stage end,
      started_at = coalesce(r.started_at, now())
    where r.id = new.id and r.owner_id = new.owner_id
      and r.status in ('queued', 'running');
  elsif source_run.status is distinct from new.status then
    raise exception 'Primary cloud completion must atomically close its source run.' using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger primary_cloud_progress
  after insert or update of status, phase on public.cloud_ideation_runs
  for each row execute function public.sync_primary_cloud_progress();
revoke all on function public.sync_primary_cloud_progress() from public, anon, authenticated;

-- Cloud usage is a patch, not a replacement for the retained Luna/API history.
-- Terminal guards in the callers ensure the embedding total is added once.
create function public.merge_primary_cloud_usage(p_existing jsonb, p_patch jsonb)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  merged jsonb;
begin
  if jsonb_typeof(p_existing) is distinct from 'object'
    or jsonb_typeof(p_patch) is distinct from 'object'
    or octet_length(p_patch::text) > 65536
    or p_patch - array['embeddings', 'chatgpt_cloud'] <> '{}'::jsonb
    or (p_patch ? 'embeddings' and jsonb_typeof(p_patch -> 'embeddings') is distinct from 'object')
    or (p_patch ? 'chatgpt_cloud' and jsonb_typeof(p_patch -> 'chatgpt_cloud') is distinct from 'object')
    or coalesce(p_patch #>> '{embeddings,input_tokens}', '0') !~ '^[0-9]{1,15}$'
  then
    raise exception 'Invalid primary cloud usage patch.' using errcode = '22023';
  end if;
  merged := p_existing || (p_patch - 'embeddings');
  if p_patch ? 'chatgpt_cloud' then
    merged := jsonb_set(merged, '{chatgpt_cloud}',
      (p_patch -> 'chatgpt_cloud') || '{"model_verified":false}'::jsonb);
  end if;
  if p_patch ? 'embeddings' then
    merged := jsonb_set(merged, '{embeddings}',
      coalesce(p_existing -> 'embeddings', '{}'::jsonb) || (p_patch -> 'embeddings') ||
      jsonb_build_object('input_tokens',
        coalesce((p_existing #>> '{embeddings,input_tokens}')::bigint, 0) +
        coalesce((p_patch #>> '{embeddings,input_tokens}')::bigint, 0)));
  end if;
  return merged;
end;
$$;
revoke all on function public.merge_primary_cloud_usage(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.merge_primary_cloud_usage(jsonb, jsonb) to service_role;

-- Zero ideas before research, and failures at any stage, must release the
-- original run's active-owner lock together with the cloud run and its jobs.
create function public.finish_primary_cloud_ideation(
  p_owner_id uuid,
  p_run_id uuid,
  p_report jsonb default null,
  p_error_message text default null
)
returns setof public.cloud_ideation_runs
language plpgsql
security invoker
set search_path = ''
as $$
declare
  cloud_run public.cloud_ideation_runs%rowtype;
  source_run public.runs%rowtype;
  terminal_status text;
  safe_error text;
  report jsonb;
  merged_usage jsonb;
begin
  if p_owner_id is null or p_run_id is null
    or (p_report is not null and (jsonb_typeof(p_report) is distinct from 'object' or octet_length(p_report::text) > 1048576))
  then
    raise exception 'Invalid primary cloud completion.' using errcode = '22023';
  end if;
  select c.* into cloud_run from public.cloud_ideation_runs c
  where c.id = p_run_id and c.owner_id = p_owner_id for update;
  if not found then raise exception 'Cloud run not found.' using errcode = 'P0002'; end if;
  if cloud_run.mode <> 'primary' then
    raise exception 'Shadow comparisons cannot complete a production run.' using errcode = '55000';
  end if;
  select r.* into source_run from public.runs r
  where r.id = p_run_id and r.owner_id = p_owner_id for update;
  if source_run.settings_snapshot ->> 'ideation_provider' is distinct from 'chatgpt_cloud' then
    raise exception 'The source run did not select cloud ideation.' using errcode = '55000';
  end if;
  if cloud_run.status in ('completed', 'no_ideas', 'failed') then
    return next cloud_run; return;
  end if;

  terminal_status := case when p_error_message is null then 'no_ideas' else 'failed' end;
  if terminal_status = 'no_ideas' then
    if source_run.status not in ('queued', 'running') or cloud_run.deadline_at <= now()
      or jsonb_typeof(p_report -> 'ideas') is distinct from 'array'
      or p_report -> 'ideas' <> '[]'::jsonb
      or exists (select 1 from public.cloud_model_jobs j
        where j.cloud_run_id = p_run_id and j.owner_id = p_owner_id
          and (j.kind = 'research' or j.status not in ('completed', 'failed')))
    then
      raise exception 'Primary no-idea completion is not ready.' using errcode = '55000';
    end if;
  elsif source_run.status not in ('queued', 'running', 'failed') then
    raise exception 'A finished production run cannot be failed.' using errcode = '55000';
  end if;
  if exists (select 1 from public.research_jobs j where j.run_id = p_run_id and j.owner_id = p_owner_id) then
    raise exception 'A primary run with a publication bridge cannot be terminalized here.' using errcode = '55000';
  end if;

  report := coalesce(p_report, cloud_run.result, '{}'::jsonb);
  if jsonb_typeof(coalesce(report -> 'counts', '{}'::jsonb)) is distinct from 'object'
    or jsonb_typeof(coalesce(report -> 'usage', '{}'::jsonb)) is distinct from 'object'
  then raise exception 'Invalid cloud completion report.' using errcode = '22023'; end if;
  merged_usage := public.merge_primary_cloud_usage(source_run.usage, coalesce(report -> 'usage', '{}'::jsonb));
  safe_error := case when terminal_status <> 'failed' then null
    when cloud_run.deadline_at <= now() then 'Cloud research exceeded its 24-hour deadline.'
    else 'Cloud ideation could not be completed.' end;
  report := report || jsonb_build_object('mode', 'primary', 'published', false, 'idea_ids', '[]'::jsonb);

  update public.runs r set status = terminal_status, stage = null,
    counts = r.counts || coalesce(report -> 'counts', '{}'::jsonb) || '{"ideas_saved":0}'::jsonb,
    usage = merged_usage, error_message = safe_error, completed_at = now()
  where r.id = p_run_id and r.owner_id = p_owner_id and r.status in ('queued', 'running', 'failed');
  update public.cloud_ideation_runs c set status = terminal_status, phase = 'done',
    result = report, error_message = safe_error, completed_at = now(), updated_at = now()
  where c.id = p_run_id and c.owner_id = p_owner_id;
  update public.cloud_model_jobs j set status = 'failed',
    error_message = coalesce(safe_error, 'Cloud ideation finished without an idea.'),
    completed_at = now(), updated_at = now()
  where j.cloud_run_id = p_run_id and j.owner_id = p_owner_id
    and j.status in ('pending', 'claimed', 'submitted');
  return query select c.* from public.cloud_ideation_runs c
  where c.id = p_run_id and c.owner_id = p_owner_id;
end;
$$;

-- The trusted coordinator supplies validated/deduplicated publication mappings.
-- The original research publisher still owns all product/evidence checks and
-- relational inserts. A completed cloud job is bridged directly into validating
-- within this transaction; it is never an API-claimable research queue item.
create function public.publish_primary_cloud_ideas(
  p_owner_id uuid,
  p_run_id uuid,
  p_cloud_job_id uuid,
  p_payload_hash text,
  p_result_hash text,
  p_ideas jsonb,
  p_x_sources jsonb,
  p_research_sources jsonb,
  p_idea_research_sources jsonb,
  p_counts jsonb,
  p_usage jsonb,
  p_report jsonb
)
returns setof public.cloud_ideation_runs
language plpgsql
security invoker
set search_path = ''
as $$
declare
  cloud_run public.cloud_ideation_runs%rowtype;
  source_run public.runs%rowtype;
  cloud_job public.cloud_model_jobs%rowtype;
  payload jsonb;
  merged_counts jsonb;
  merged_usage jsonb;
  saved_ids uuid[];
  final_status text;
begin
  if p_owner_id is null or p_run_id is null or p_cloud_job_id is null
    or p_payload_hash is null or p_payload_hash !~ '^[0-9a-f]{64}$'
    or p_result_hash is null or p_result_hash !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_ideas) is distinct from 'array'
    or jsonb_typeof(p_x_sources) is distinct from 'array'
    or jsonb_typeof(p_research_sources) is distinct from 'array'
    or jsonb_typeof(p_idea_research_sources) is distinct from 'array'
    or jsonb_typeof(p_counts) is distinct from 'object'
    or jsonb_typeof(p_usage) is distinct from 'object'
    or jsonb_typeof(p_report) is distinct from 'object'
  then raise exception 'Invalid primary cloud publication.' using errcode = '22023'; end if;
  if jsonb_array_length(p_ideas) > 3 or jsonb_array_length(p_x_sources) > 3
    or jsonb_array_length(p_research_sources) > 40 or jsonb_array_length(p_idea_research_sources) > 30
    or octet_length(p_report::text) > 1048576 or octet_length(p_ideas::text) > 1048576
    or octet_length(p_x_sources::text) > 65536 or octet_length(p_research_sources::text) > 1048576
    or octet_length(p_idea_research_sources::text) > 262144 or octet_length(p_counts::text) > 65536
  then raise exception 'Primary cloud publication exceeds its bounds.' using errcode = '22023'; end if;

  select c.* into cloud_run from public.cloud_ideation_runs c
  where c.id = p_run_id and c.owner_id = p_owner_id for update;
  if not found then raise exception 'Cloud run not found.' using errcode = 'P0002'; end if;
  if cloud_run.mode <> 'primary' then
    raise exception 'Shadow comparisons cannot publish production ideas.' using errcode = '55000';
  end if;
  select r.* into source_run from public.runs r
  where r.id = p_run_id and r.owner_id = p_owner_id for update;
  if source_run.settings_snapshot ->> 'ideation_provider' is distinct from 'chatgpt_cloud' then
    raise exception 'The source run did not select cloud ideation.' using errcode = '55000';
  end if;
  select j.* into cloud_job from public.cloud_model_jobs j
  where j.id = p_cloud_job_id and j.cloud_run_id = p_run_id and j.owner_id = p_owner_id
    and j.kind = 'research' and j.job_key = 'research' for update;
  if not found or cloud_job.status <> 'completed' or cloud_job.result is null then
    raise exception 'A completed cloud research job is required.' using errcode = '55000';
  end if;
  if cloud_run.status in ('completed', 'no_ideas') then
    if source_run.status is distinct from cloud_run.status or not exists (
      select 1 from public.research_jobs j where j.id = p_cloud_job_id
        and j.run_id = p_run_id and j.owner_id = p_owner_id and j.status = 'completed'
        and j.payload_hash = p_payload_hash and j.result_hash = p_result_hash
    ) then raise exception 'Primary publication replay does not match its committed result.' using errcode = '55000'; end if;
    return next cloud_run; return;
  end if;
  if cloud_run.status not in ('pending', 'running') or cloud_run.phase <> 'validating'
    or cloud_run.deadline_at <= now() or source_run.status not in ('queued', 'running')
    or exists (select 1 from public.research_jobs j where j.run_id = p_run_id and j.owner_id = p_owner_id)
    or exists (select 1 from public.ideas i where i.run_id = p_run_id and i.owner_id = p_owner_id)
    or exists (select 1 from public.cloud_model_jobs j where j.cloud_run_id = p_run_id
      and j.owner_id = p_owner_id and j.status not in ('completed', 'failed'))
  then raise exception 'Primary cloud research is not ready for publication.' using errcode = '55000'; end if;

  payload := cloud_job.payload -> 'input';
  if jsonb_typeof(payload) is distinct from 'object'
    or payload ->> 'run_id' is distinct from p_run_id::text
    or payload ->> 'schema_version' is distinct from '2'
    or payload ->> 'prompt_version' is distinct from 'candidate_research_v2'
    or jsonb_typeof(payload -> 'candidates') is distinct from 'array'
    or jsonb_typeof(cloud_job.result -> 'ideas') is distinct from 'array'
    or jsonb_typeof(cloud_job.result -> 'sources') is distinct from 'array'
    or cloud_job.result ->> 'schema_version' is distinct from '2'
    or jsonb_typeof(p_report -> 'ideas') is distinct from 'array'
    or jsonb_typeof(p_report -> 'research_candidate_ids') is distinct from 'array'
  then raise exception 'Cloud publication has an invalid research identity.' using errcode = '23514'; end if;
  if jsonb_array_length(payload -> 'candidates') not between 1 and 3
    or jsonb_array_length(p_report -> 'ideas') <> jsonb_array_length(p_ideas)
    or p_report -> 'research_candidate_ids' is distinct from cloud_run.result -> 'research_candidate_ids'
    or (select array_agg(x ->> 'candidate_id' order by x ->> 'candidate_id') from jsonb_array_elements(payload -> 'candidates') x)
      is distinct from (select array_agg(x order by x) from jsonb_array_elements_text(p_report -> 'research_candidate_ids') x)
    or (select count(distinct x ->> 'candidate_id') from jsonb_array_elements(payload -> 'candidates') x) <> jsonb_array_length(payload -> 'candidates')
  then raise exception 'Cloud research candidates do not match the selected checkpoint.' using errcode = '23514'; end if;

  if exists (
    select 1 from jsonb_array_elements(payload -> 'candidates') candidate
    where not exists (
      select 1 from public.cloud_model_jobs j
      where j.id::text = candidate ->> 'candidate_id' and j.cloud_run_id = p_run_id and j.owner_id = p_owner_id
        and j.kind = 'candidate' and j.status = 'completed' and j.result ->> 'status' = 'candidate'
        and j.source_post_id = candidate #>> '{source_post,post_id}'
        and j.result ->> 'source_post_id' = j.source_post_id
    ) or not exists (
      select 1 from jsonb_array_elements(cloud_run.input -> 'posts') post
      where post ->> 'post_id' = candidate #>> '{source_post,post_id}'
        and post ->> 'author_id' = candidate #>> '{source_post,author_id}'
    )
  ) or exists (
    select 1 from jsonb_array_elements(cloud_job.result -> 'ideas') idea
    where not exists (select 1 from jsonb_array_elements(payload -> 'candidates') candidate
      where candidate ->> 'candidate_id' = idea ->> 'candidate_id'
        and idea -> 'source_post_ids' = jsonb_build_array(candidate #>> '{source_post,post_id}'))
  ) or exists (
    select 1 from jsonb_array_elements(p_report -> 'ideas') idea
    where not exists (select 1 from jsonb_array_elements(cloud_job.result -> 'ideas') submitted
      where submitted ->> 'candidate_id' = idea ->> 'candidate_id'
        and submitted -> 'source_post_ids' = idea -> 'source_post_ids')
      or not exists (select 1 from jsonb_array_elements(p_ideas) publication
        where publication ->> 'fingerprint_hash' = idea ->> 'fingerprint_hash')
  ) or exists (
    select 1 from jsonb_array_elements(p_x_sources) source
    where not exists (select 1 from jsonb_array_elements(p_report -> 'ideas') idea
      where idea ->> 'fingerprint_hash' = source ->> 'fingerprint_hash'
        and idea -> 'source_post_ids' = jsonb_build_array(source ->> 'post_id'))
  ) then raise exception 'Cloud publication is not bound to its accepted source candidates.' using errcode = '23514'; end if;

  merged_counts := source_run.counts || p_counts || jsonb_build_object('ideas_saved', jsonb_array_length(p_ideas));
  merged_usage := public.merge_primary_cloud_usage(source_run.usage, p_usage);
  insert into public.research_jobs (
    id, run_id, owner_id, status, schema_version, prompt_version,
    payload, payload_hash, result, result_hash, submitted_at, validation_started_at
  ) values (
    p_cloud_job_id, p_run_id, p_owner_id, 'validating', 2, 'candidate_research_v2',
    payload, p_payload_hash, cloud_job.result, p_result_hash, cloud_job.submitted_at, now()
  );
  update public.runs r set status = 'running', stage = 'validating'
  where r.id = p_run_id and r.owner_id = p_owner_id;

  select coalesce(array_agg(p.idea_id), array[]::uuid[]) into saved_ids
  from public.publish_run_researched_ideas(p_owner_id, p_cloud_job_id, p_ideas,
    p_x_sources, p_research_sources, p_idea_research_sources, merged_counts, merged_usage) p;
  final_status := case when cardinality(saved_ids) > 0 then 'completed' else 'no_ideas' end;
  update public.cloud_ideation_runs c set status = final_status, phase = 'done',
    result = p_report || jsonb_build_object('mode', 'primary', 'published', cardinality(saved_ids) > 0,
      'idea_ids', to_jsonb(saved_ids)), error_message = null, completed_at = now(), updated_at = now()
  where c.id = p_run_id and c.owner_id = p_owner_id;
  return query select c.* from public.cloud_ideation_runs c
  where c.id = p_run_id and c.owner_id = p_owner_id;
end;
$$;

revoke all on function public.finish_primary_cloud_ideation(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.finish_primary_cloud_ideation(uuid, uuid, jsonb, text) to service_role;
revoke all on function public.publish_primary_cloud_ideas(uuid, uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.publish_primary_cloud_ideas(uuid, uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb) to service_role;

comment on table public.cloud_ideation_runs is
  'Immutable shadow comparisons or explicitly selected primary cloud runs; historical shadow runs never publish.';

-- Both modes share the existing single-job lease contract. Primary work also
-- requires its production source run to remain active and cloud-selected.
create or replace function public.claim_cloud_model_job(p_owner_id uuid, p_job_id uuid default null)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  candidate public.cloud_model_jobs%rowtype;
  run_deadline timestamptz;
begin
  if p_owner_id is null then raise exception 'Owner is required.' using errcode = '22023'; end if;
  update public.cloud_model_jobs j
  set status = 'failed', claim_id = null, lease_expires_at = null,
    error_message = 'Cloud model worker exhausted three claim attempts.', updated_at = now(), completed_at = now()
  where j.owner_id = p_owner_id and (p_job_id is null or j.id = p_job_id)
    and j.status = 'claimed' and j.lease_expires_at <= now() and j.attempts >= 3;
  select j.* into candidate from public.cloud_model_jobs j
  join public.cloud_ideation_runs r on r.id = j.cloud_run_id and r.owner_id = j.owner_id
  where j.owner_id = p_owner_id and (p_job_id is null or j.id = p_job_id)
    and r.mode in ('shadow', 'primary') and r.status in ('pending', 'running')
    and r.deadline_at > now() and j.attempts < 3
    and (r.mode = 'shadow' or exists (
      select 1 from public.runs source_run where source_run.id = r.id and source_run.owner_id = r.owner_id
        and source_run.status in ('queued', 'running')
        and source_run.settings_snapshot ->> 'ideation_provider' = 'chatgpt_cloud'))
    and ((j.status = 'pending' and j.available_at <= now())
      or (j.status = 'claimed' and j.lease_expires_at <= now()))
  order by j.available_at, j.created_at, j.id limit 1 for update of j, r skip locked;
  if not found then return jsonb_build_object('status', 'empty'); end if;
  update public.cloud_ideation_runs r set status = 'running', updated_at = now()
  where r.id = candidate.cloud_run_id and r.owner_id = p_owner_id returning r.deadline_at into run_deadline;
  update public.cloud_model_jobs j set status = 'claimed', claim_id = gen_random_uuid(),
    lease_expires_at = least(now() + interval '30 minutes', run_deadline),
    attempts = j.attempts + 1, error_message = null, updated_at = now()
  where j.id = candidate.id and j.owner_id = p_owner_id returning j.* into candidate;
  return jsonb_build_object('status', 'claimed', 'job_id', candidate.id,
    'claim_id', candidate.claim_id, 'cloud_run_id', candidate.cloud_run_id,
    'kind', candidate.kind, 'source_post_id', candidate.source_post_id,
    'payload', candidate.payload, 'requested_model', candidate.requested_model,
    'requested_reasoning', candidate.requested_reasoning, 'lease_expires_at', candidate.lease_expires_at);
end;
$$;
revoke all on function public.claim_cloud_model_job(uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_cloud_model_job(uuid, uuid) to service_role;

commit;
