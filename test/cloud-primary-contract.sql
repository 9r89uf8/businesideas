-- Administrator-only integration test. Uses the completed shadow comparison as
-- read-only evidence and rolls back every fixture, publication, and helper.
begin;

create function pg_temp.cloud_test_canonical(value jsonb)
returns text language plpgsql immutable set search_path = '' as $$
declare output text;
begin
  if jsonb_typeof(value) = 'object' then
    select '{' || coalesce(string_agg(to_jsonb(e.key)::text || ':' || pg_temp.cloud_test_canonical(e.value), ',' order by e.key collate "C"), '') || '}'
    into output from jsonb_each(value) e;
  elsif jsonb_typeof(value) = 'array' then
    select '[' || coalesce(string_agg(pg_temp.cloud_test_canonical(e.value), ',' order by e.ordinality), '') || ']'
    into output from jsonb_array_elements(value) with ordinality e(value, ordinality);
  else output := value::text;
  end if;
  return output;
end;
$$;

do $test$
#variable_conflict use_variable
declare
  owner_id uuid := 'f8682895-57c5-4a3f-ad65-238386718274';
  shadow_id uuid := '69245cd0-67be-48f6-8c50-9ec615abbd3c';
  primary_id uuid := gen_random_uuid();
  empty_id uuid := gen_random_uuid();
  failure_id uuid := gen_random_uuid();
  research_id uuid := gen_random_uuid();
  pending_id uuid := gen_random_uuid();
  submitted_id uuid := gen_random_uuid();
  job public.cloud_model_jobs%rowtype;
  old_research public.cloud_model_jobs%rowtype;
  shadow public.cloud_ideation_runs%rowtype;
  saved public.cloud_ideation_runs%rowtype;
  replay public.cloud_ideation_runs%rowtype;
  mapping jsonb := '{}'::jsonb;
  pair record;
  new_job_id uuid;
  original_cloud_hash text;
  original_run_hash text;
  baseline_ideas integer;
  raw_payload jsonb;
  raw_result jsonb;
  report jsonb;
  idea jsonb;
  ideas jsonb;
  sources jsonb;
  x_sources jsonb;
  links jsonb;
  payload_hash text;
  result_hash text;
  claim jsonb;
  submission jsonb;
  cloud_tokens bigint;
  first_idea_id uuid;
begin
  assert not exists(select 1 from public.runs r where r.owner_id = owner_id and r.status in ('queued', 'running')),
    'Run this rollback test only when the owner has no active production run.';
  assert not has_function_privilege('authenticated', 'public.publish_primary_cloud_ideas(uuid,uuid,uuid,text,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)', 'execute');
  assert not has_function_privilege('anon', 'public.finish_primary_cloud_ideation(uuid,uuid,jsonb,text)', 'execute');
  assert has_function_privilege('service_role', 'public.publish_primary_cloud_ideas(uuid,uuid,uuid,text,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)', 'execute');
  select c.* into shadow from public.cloud_ideation_runs c where c.id = shadow_id and c.owner_id = owner_id;
  select md5(row_to_json(c)::text) into original_cloud_hash
    from public.cloud_ideation_runs c where c.id = shadow_id and c.owner_id = owner_id;
  assert shadow.mode = 'shadow' and shadow.status = 'completed' and jsonb_array_length(shadow.result -> 'ideas') = 1;
  select md5(row_to_json(r)::text) into original_run_hash from public.runs r where r.id = shadow_id;
  select count(*) into baseline_ideas from public.ideas i where i.owner_id = owner_id;
  select j.* into old_research from public.cloud_model_jobs j
    where j.cloud_run_id = shadow_id and j.owner_id = owner_id and j.kind = 'research';

  -- A fresh source snapshot explicitly selects primary. The original API run
  -- and immutable shadow comparison are never promoted or rewritten.
  insert into public.runs(id, owner_id, run_key, trigger, status, window_start, window_end, settings_snapshot, counts, usage)
  select primary_id, owner_id, 'manual:primary-contract:' || primary_id, 'manual', 'running', r.window_start, r.window_end,
    r.settings_snapshot || '{"ideation_provider":"chatgpt_cloud"}'::jsonb,
    '{"collected_posts":26}', '{"luna":{"input_tokens":123},"embeddings":{"input_tokens":7}}'
  from public.runs r where r.id = shadow_id;
  insert into public.run_posts(run_id, post_id, owner_id, selected_for_ai, signal_type, signal_summary)
  select primary_id, rp.post_id, owner_id, rp.selected_for_ai, rp.signal_type, rp.signal_summary
  from public.run_posts rp where rp.run_id = shadow_id and rp.owner_id = owner_id;
  insert into public.cloud_ideation_runs(id, owner_id, mode, status, phase, input)
  values(primary_id, owner_id, 'primary', 'running', 'generating',
    jsonb_set(shadow.input, '{source_run_id}', to_jsonb(primary_id::text)));
  assert (select r.stage from public.runs r where r.id = primary_id) = 'generating';

  for job in select j.* from public.cloud_model_jobs j
    where j.cloud_run_id = shadow_id and j.owner_id = owner_id and j.kind <> 'research'
  loop
    new_job_id := gen_random_uuid();
    mapping := mapping || jsonb_build_object(job.id::text, new_job_id::text);
    insert into public.cloud_model_jobs(id, cloud_run_id, owner_id, job_key, kind, source_post_id,
      payload, result, status, claim_id, submitted_at, completed_at)
    values(new_job_id, primary_id, owner_id, job.job_key, job.kind, job.source_post_id,
      job.payload, job.result, 'completed', gen_random_uuid(), now(), now());
  end loop;
  raw_payload := old_research.payload -> 'input';
  raw_result := old_research.result;
  report := shadow.result;
  for pair in select key, value from jsonb_each_text(mapping) loop
    raw_payload := replace(raw_payload::text, pair.key, pair.value)::jsonb;
    raw_result := replace(raw_result::text, pair.key, pair.value)::jsonb;
    report := replace(report::text, pair.key, pair.value)::jsonb;
  end loop;
  raw_payload := jsonb_set(raw_payload, '{run_id}', to_jsonb(primary_id::text));
  -- Publication mechanics need a unique fixture fingerprint; the real supplied
  -- idea, citation metadata, claims, product rules and evidence stay unchanged.
  idea := report #> '{ideas,0}';
  idea := idea || jsonb_build_object('fingerprint', 'primary SQL contract ' || primary_id,
    'fingerprint_hash', md5(primary_id::text) || md5('contract:' || primary_id));
  report := report || jsonb_build_object('mode', 'primary', 'published', false, 'idea_ids', '[]'::jsonb,
    'ideas', jsonb_build_array(idea), 'usage', (report -> 'usage') || '{"chatgpt_cloud":{"provider":"chatgpt_cloud","model_verified":false}}'::jsonb);
  ideas := report -> 'ideas';
  sources := report -> 'sources';
  select jsonb_agg(jsonb_build_object('fingerprint_hash', i ->> 'fingerprint_hash',
    'post_id', i #>> '{source_post_ids,0}', 'signal_type', null, 'evidence_summary', i ->> 'problem'))
  into x_sources from jsonb_array_elements(ideas) i;
  select jsonb_agg(jsonb_build_object('fingerprint_hash', mapped.fingerprint_hash, 'source_id', mapped.source_id,
    'supported_claims', mapped.claims)) into links
  from (
    select i ->> 'fingerprint_hash' as fingerprint_hash, source_id,
      jsonb_agg(distinct claim_mapping ->> 'claim') as claims
    from jsonb_array_elements(ideas) i,
      jsonb_array_elements(i -> 'claim_source_map') claim_mapping,
      jsonb_array_elements_text(claim_mapping -> 'research_source_ids') source_id
    group by i ->> 'fingerprint_hash', source_id
  ) mapped;
  payload_hash := encode(extensions.digest(convert_to(pg_temp.cloud_test_canonical(raw_payload), 'UTF8'), 'sha256'), 'hex');
  result_hash := encode(extensions.digest(convert_to(pg_temp.cloud_test_canonical(raw_result), 'UTF8'), 'sha256'), 'hex');
  assert jsonb_typeof(ideas)='array' and jsonb_typeof(x_sources)='array'
    and jsonb_typeof(sources)='array' and jsonb_typeof(links)='array',
    'The read-only shadow fixture must produce all publication mapping arrays.';
  assert payload_hash ~ '^[0-9a-f]{64}$' and result_hash ~ '^[0-9a-f]{64}$';
  update public.cloud_ideation_runs c set result = report - 'ideas', phase = 'researching'
  where c.id = primary_id;
  insert into public.cloud_model_jobs(id, cloud_run_id, owner_id, job_key, kind, payload)
  values(research_id, primary_id, owner_id, 'research', 'research',
    jsonb_set(old_research.payload, '{input}', raw_payload));

  -- Exercise the same RPC pair used by scheduled Work; no API research queue
  -- row exists until the atomic publisher runs.
  assert public.claim_cloud_model_job(gen_random_uuid(), research_id) ->> 'status' = 'empty';
  claim := public.claim_cloud_model_job(owner_id, research_id);
  assert claim ->> 'status' = 'claimed';
  assert public.claim_cloud_model_job(owner_id, research_id) ->> 'status' = 'empty';
  submission := public.submit_cloud_model_job(owner_id, research_id, (claim ->> 'claim_id')::uuid,
    raw_result, '{"reported_model":"SQL contract fixture","model_verified":true}');
  assert submission ->> 'status' = 'submitted';
  assert (select j.runtime_metadata ->> 'model_verified' from public.cloud_model_jobs j where j.id = research_id) = 'false';
  update public.cloud_model_jobs j set status = 'completed', completed_at = now() where j.id = research_id;
  update public.cloud_ideation_runs c set phase = 'validating' where c.id = primary_id;
  assert (select r.stage from public.runs r where r.id = primary_id) = 'validating';
  assert not exists(select 1 from public.research_jobs j where j.run_id = primary_id);

  -- Incorrect source binding and failed product checks roll back the entire
  -- bridge/publication transaction, including any nested evidence inserts.
  begin
    perform public.publish_primary_cloud_ideas(owner_id, primary_id, research_id, payload_hash, result_hash,
      ideas, jsonb_set(x_sources, '{0,post_id}', '"99999999999999999999999999999999"'), sources, links,
      report -> 'counts', report -> 'usage', report);
    raise exception 'Unbound X evidence was accepted';
  exception when sqlstate '23514' then null; end;
  begin
    perform public.publish_primary_cloud_ideas(owner_id, primary_id, research_id, payload_hash, result_hash,
      jsonb_set(ideas, '{0,evidence_score}', '0'), x_sources, sources, links,
      report -> 'counts', report -> 'usage', report);
    raise exception 'Weak evidence was published';
  exception when sqlstate '23514' then null; end;
  assert not exists(select 1 from public.research_jobs j where j.run_id = primary_id);
  assert not exists(select 1 from public.ideas i where i.run_id = primary_id);

  select * into saved from public.publish_primary_cloud_ideas(owner_id, primary_id, research_id, payload_hash, result_hash,
    ideas, x_sources, sources, links, report -> 'counts', report -> 'usage', report);
  assert saved.status = 'completed' and saved.phase = 'done' and saved.result ->> 'published' = 'true';
  assert jsonb_array_length(saved.result -> 'idea_ids') = 1;
  first_idea_id := (saved.result #>> '{idea_ids,0}')::uuid;
  assert (select r.status from public.runs r where r.id = primary_id) = 'completed';
  assert (select j.status from public.research_jobs j where j.id = research_id) = 'completed';
  assert not exists(select 1 from public.research_jobs j where j.run_id = primary_id and j.status in ('pending', 'claimed'));
  assert (select count(*) from public.idea_sources s where s.idea_id = first_idea_id) = 1;
  assert (select count(*) from public.idea_research_sources s where s.idea_id = first_idea_id) = jsonb_array_length(links);
  assert (select count(*) from public.research_sources s where s.job_id = research_id) = jsonb_array_length(sources);
  cloud_tokens := (report #>> '{usage,embeddings,input_tokens}')::bigint;
  assert (select (r.usage #>> '{embeddings,input_tokens}')::bigint from public.runs r where r.id = primary_id) = 7 + cloud_tokens;
  assert (select r.usage #>> '{luna,input_tokens}' from public.runs r where r.id = primary_id) = '123';
  select * into replay from public.publish_primary_cloud_ideas(owner_id, primary_id, research_id, payload_hash, result_hash,
    ideas, x_sources, sources, links, report -> 'counts', report -> 'usage', report);
  assert replay.result -> 'idea_ids' = saved.result -> 'idea_ids';
  assert (select count(*) from public.ideas i where i.run_id = primary_id) = 1;
  assert (select (r.usage #>> '{embeddings,input_tokens}')::bigint from public.runs r where r.id = primary_id) = 7 + cloud_tokens;

  begin
    perform public.publish_primary_cloud_ideas(owner_id, shadow_id, old_research.id, payload_hash, result_hash,
      ideas, x_sources, sources, links, report -> 'counts', report -> 'usage', report);
    raise exception 'Historical shadow comparison published';
  exception when sqlstate '55000' then null; end;
  begin
    update public.cloud_ideation_runs c set mode = 'primary' where c.id = shadow_id;
    raise exception 'Historical shadow mode changed';
  exception when sqlstate '55000' then null; end;

  -- A primary source with no surviving ideas closes without a research bridge.
  insert into public.runs(id,owner_id,run_key,trigger,status,window_start,window_end,settings_snapshot,usage)
  values(empty_id,owner_id,'manual:primary-empty:'||empty_id,'manual','running',now(),now(),
    '{"ideation_provider":"chatgpt_cloud"}','{"luna":{"input_tokens":123},"embeddings":{"input_tokens":7}}');
  insert into public.cloud_ideation_runs(id,owner_id,mode,status,phase,input)
  values(empty_id,owner_id,'primary','pending','generating','{"posts":[]}');
  select * into saved from public.finish_primary_cloud_ideation(owner_id,empty_id,
    '{"ideas":[],"counts":{},"usage":{"embeddings":{"input_tokens":11}}}',null);
  assert saved.status = 'no_ideas' and (select r.status from public.runs r where r.id=empty_id)='no_ideas';
  assert not exists(select 1 from public.research_jobs j where j.run_id=empty_id);
  perform public.finish_primary_cloud_ideation(owner_id,empty_id,'{"ideas":[],"usage":{"embeddings":{"input_tokens":11}}}',null);
  assert (select r.usage #>> '{embeddings,input_tokens}' from public.runs r where r.id=empty_id)='18';

  -- A deadline failure accepts a null report and closes pending/submitted jobs
  -- while preserving accepted results and both original and cloud history.
  insert into public.runs(id,owner_id,run_key,trigger,status,window_start,window_end,settings_snapshot)
  values(failure_id,owner_id,'manual:primary-failure:'||failure_id,'manual','running',now(),now(),'{"ideation_provider":"chatgpt_cloud"}');
  insert into public.cloud_ideation_runs(id,owner_id,mode,status,phase,input,created_at,deadline_at)
  values(failure_id,owner_id,'primary','running','generating','{"posts":[]}',now()-interval '26 hours',now()-interval '2 hours');
  insert into public.cloud_model_jobs(id,cloud_run_id,owner_id,job_key,kind,source_post_id,payload)
  values(pending_id,failure_id,owner_id,'candidate:1','candidate','1','{}');
  insert into public.cloud_model_jobs(id,cloud_run_id,owner_id,job_key,kind,source_post_id,payload,result,status,claim_id,submitted_at)
  values(submitted_id,failure_id,owner_id,'candidate:2','candidate','2','{}','{"preserved":true}','submitted',gen_random_uuid(),now());
  assert public.claim_cloud_model_job(owner_id,pending_id)->>'status'='empty';
  select * into saved from public.finish_primary_cloud_ideation(owner_id,failure_id,null,'Cloud research exceeded its 24-hour deadline.');
  assert saved.status='failed' and saved.error_message='Cloud research exceeded its 24-hour deadline.';
  assert (select r.status from public.runs r where r.id=failure_id)='failed';
  assert (select count(*) from public.cloud_model_jobs j where j.cloud_run_id=failure_id and j.status='failed')=2;
  assert (select j.result from public.cloud_model_jobs j where j.id=submitted_id)='{"preserved":true}'::jsonb;

  assert (select md5(row_to_json(c)::text) from public.cloud_ideation_runs c where c.id=shadow_id)=original_cloud_hash;
  assert (select md5(row_to_json(r)::text) from public.runs r where r.id=shadow_id)=original_run_hash;
  assert (select count(*) from public.ideas i where i.owner_id=owner_id)=baseline_ideas+1;
end;
$test$;
rollback;
select 'Primary claim/submission, atomic evidence publication, replay, shadow isolation, zero ideas, deadline failure and usage checks passed; all fixtures rolled back.' as result;
