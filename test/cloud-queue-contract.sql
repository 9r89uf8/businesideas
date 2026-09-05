-- Run as the database administrator. Every fixture is rolled back.
begin;
do $test$
declare
  owner uuid := 'f8682895-57c5-4a3f-ad65-238386718274';
  fixture_run_id uuid := gen_random_uuid();
  job_id uuid := gen_random_uuid();
  retry_job uuid := gen_random_uuid();
  claimed jsonb;
  prior_claim uuid;
  response jsonb;
begin
  assert not has_function_privilege('authenticated', 'public.claim_cloud_model_job(uuid,uuid)', 'execute');
  assert not has_function_privilege('anon', 'public.submit_cloud_model_job(uuid,uuid,uuid,jsonb,jsonb)', 'execute');
  assert not has_table_privilege('authenticated', 'public.cloud_model_jobs', 'insert');
  assert not has_table_privilege('anon', 'public.cloud_model_jobs', 'select');
  assert has_table_privilege('authenticated', 'public.cloud_model_jobs', 'select');

  insert into public.runs(id,owner_id,run_key,trigger,status,window_start,window_end,completed_at)
  values(fixture_run_id,owner,'manual:cloud-queue-contract:'||fixture_run_id,'manual','no_ideas',now(),now(),now());
  insert into public.cloud_ideation_runs(id,owner_id,status,phase,input)
  values(fixture_run_id,owner,'running','generating','{"test":"queue contract"}');
  insert into public.cloud_model_jobs(id,cloud_run_id,owner_id,job_key,kind,source_post_id,payload)
  values(job_id,fixture_run_id,owner,'candidate:1','candidate','1','{"test":"one isolated post"}');

  claimed := public.claim_cloud_model_job(owner,job_id);
  assert claimed->>'status'='claimed';
  assert (claimed->>'job_id')::uuid=job_id;
  prior_claim := (claimed->>'claim_id')::uuid;
  assert public.claim_cloud_model_job(owner,job_id)->>'status'='empty';
  assert public.claim_cloud_model_job(gen_random_uuid(),job_id)->>'status'='empty';
  begin
    perform public.submit_cloud_model_job(owner,job_id,gen_random_uuid(),'{"decision":"test"}');
    raise exception 'Wrong claim was accepted';
  exception when sqlstate '55000' then null;
  end;
  begin
    update public.cloud_model_jobs set payload='{"changed":true}' where id=job_id;
    raise exception 'Immutable payload changed';
  exception when sqlstate '55000' then null;
  end;

  response := public.submit_cloud_model_job(owner,job_id,prior_claim,'{"decision":"test"}','{"model_verified":true,"reported_model":"self-report"}');
  assert response->>'status'='submitted';
  assert (select runtime_metadata->>'model_verified' from public.cloud_model_jobs where id=job_id)='false';
  update public.cloud_model_jobs set status='completed',completed_at=now() where id=job_id;
  response := public.submit_cloud_model_job(owner,job_id,prior_claim,'{"decision":"test"}');
  assert response->>'idempotent'='true' and response->>'status'='completed';
  begin
    perform public.submit_cloud_model_job(owner,job_id,prior_claim,'{"decision":"different"}');
    raise exception 'Conflicting result was accepted';
  exception when sqlstate '55000' then null;
  end;

  insert into public.cloud_model_jobs(id,cloud_run_id,owner_id,job_key,kind,source_post_id,payload,status,claim_id,lease_expires_at,attempts)
  values(retry_job,fixture_run_id,owner,'candidate:2','candidate','2','{}','claimed',gen_random_uuid(),now()-interval '1 minute',1);
  select claim_id into prior_claim from public.cloud_model_jobs where id=retry_job;
  claimed := public.claim_cloud_model_job(owner,retry_job);
  assert claimed->>'status'='claimed' and (claimed->>'claim_id')::uuid<>prior_claim;
  assert (select attempts from public.cloud_model_jobs where id=retry_job)=2;
  begin
    perform public.submit_cloud_model_job(owner,retry_job,prior_claim,'{}');
    raise exception 'Expired replaced claim was accepted';
  exception when sqlstate '55000' then null;
  end;
  response := public.report_cloud_model_failure(owner,retry_job,(claimed->>'claim_id')::uuid,'Temporary connection failure');
  assert response->>'status'='pending';
  assert public.claim_cloud_model_job(owner,retry_job)->>'status'='empty';
  update public.cloud_model_jobs set available_at=now() where id=retry_job;
  claimed := public.claim_cloud_model_job(owner,retry_job);
  response := public.report_cloud_model_failure(owner,retry_job,(claimed->>'claim_id')::uuid,'Final failure');
  assert response->>'status'='failed';
  assert public.claim_cloud_model_job(owner,retry_job)->>'status'='empty';

  update public.cloud_ideation_runs set status='completed',phase='done',completed_at=now() where id=fixture_run_id;
  assert public.claim_cloud_model_job(owner,retry_job)->>'status'='empty';
  assert (select status from public.runs where id=fixture_run_id)='no_ideas';
  assert not exists(select 1 from public.research_jobs where research_jobs.run_id=fixture_run_id);
  assert not exists(select 1 from public.ideas where ideas.run_id=fixture_run_id);
end;
$test$;
rollback;
select 'Cloud queue claims, retries, idempotency, immutability and grants passed; fixtures rolled back.' as result;
