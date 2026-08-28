create extension if not exists pgcrypto;
create extension if not exists vector with schema extensions;

-- ---------------------------------------------------------
-- SETTINGS
-- One row per owner.
-- ---------------------------------------------------------

create table public.settings (
  owner_id uuid primary key references auth.users(id) on delete cascade,

  x_query text not null,

  candidate_limit integer not null default 200
    check (candidate_limit between 50 and 500),

  ai_input_limit integer not null default 100
    check (ai_input_limit between 25 and 200),

  preferences jsonb not null default
    '{
      "offer_bias": "services_first",
      "preferred_customers": [],
      "preferred_business_models": [],
      "avoid": [],
      "personal_advantages": []
    }'::jsonb,

  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------
-- RUNS
-- One record for each scheduled or manual execution.
-- ---------------------------------------------------------

create table public.runs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,

  run_key text not null,
  trigger text not null
    check (trigger in ('scheduled', 'manual')),

  status text not null default 'queued'
    check (
      status in (
        'queued',
        'running',
        'completed',
        'no_ideas',
        'failed'
      )
    ),

  stage text
    check (
      stage is null or stage in (
        'fetching',
        'extracting',
        'clustering',
        'generating',
        'saving'
      )
    ),

  window_start timestamptz not null,
  window_end timestamptz not null,

  settings_snapshot jsonb not null default '{}'::jsonb,
  counts jsonb not null default '{}'::jsonb,
  usage jsonb not null default '{}'::jsonb,

  error_message text,

  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,

  unique (owner_id, run_key),
  unique (id, owner_id)
);

create unique index runs_one_active_per_owner
  on public.runs (owner_id)
  where status in ('queued', 'running');

create index runs_owner_created_idx
  on public.runs (owner_id, created_at desc);

-- ---------------------------------------------------------
-- POSTS
-- Canonical representation of an X post. X IDs stay text.
-- ---------------------------------------------------------

create table public.posts (
  x_post_id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,

  author_id text not null,
  author_username text,

  text text,
  url text not null,
  conversation_id text,
  language text,

  x_created_at timestamptz not null,

  availability text not null default 'available'
    check (availability in ('available', 'unavailable', 'unknown')),

  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_checked_at timestamptz,

  unique (x_post_id, owner_id)
);

create index posts_owner_created_idx
  on public.posts (owner_id, x_created_at desc);

create index posts_owner_author_idx
  on public.posts (owner_id, author_id);

-- ---------------------------------------------------------
-- RUN POSTS
-- Snapshot and analysis of a post within a particular run.
-- ---------------------------------------------------------

create table public.run_posts (
  run_id uuid not null,
  post_id text not null,
  owner_id uuid not null references auth.users(id) on delete cascade,

  search_position integer,
  metrics jsonb not null default '{}'::jsonb,

  deterministic_score real,
  selected_for_ai boolean not null default false,

  relevant boolean,
  signal_type text
    check (
      signal_type is null or signal_type in (
        'pain',
        'request',
        'workaround',
        'spending',
        'new_capability',
        'hype',
        'none'
      )
    ),

  target_customer text,
  problem text,
  evidence_excerpt text,
  signal_summary text,

  commercial_score smallint
    check (
      commercial_score is null
      or commercial_score between 0 and 100
    ),

  hype_score smallint
    check (
      hype_score is null
      or hype_score between 0 and 100
    ),

  opportunity_score real,
  created_at timestamptz not null default now(),

  primary key (run_id, post_id),
  foreign key (run_id, owner_id)
    references public.runs(id, owner_id) on delete cascade,
  foreign key (post_id, owner_id)
    references public.posts(x_post_id, owner_id) on delete cascade
);

create index run_posts_run_score_idx
  on public.run_posts (run_id, opportunity_score desc);

create index run_posts_post_idx
  on public.run_posts (post_id);

-- ---------------------------------------------------------
-- CLUSTERS
-- Terra-generated opportunity themes for a run.
-- ---------------------------------------------------------

create table public.clusters (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  owner_id uuid not null references auth.users(id) on delete cascade,

  title text not null,
  target_customer text not null,
  problem text not null,
  why_now text,
  summary text not null,

  evidence_post_ids text[] not null default '{}',

  evidence_strength smallint not null
    check (evidence_strength between 0 and 100),

  payment_signal smallint not null
    check (payment_signal between 0 and 100),

  eligible boolean not null default false,
  created_at timestamptz not null default now(),

  foreign key (run_id, owner_id)
    references public.runs(id, owner_id) on delete cascade
);

create index clusters_run_idx
  on public.clusters (run_id, evidence_strength desc);

-- ---------------------------------------------------------
-- IDEAS
-- Final ideas shown to the owner. Feedback lives on the idea.
-- ---------------------------------------------------------

create table public.ideas (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  owner_id uuid not null references auth.users(id) on delete cascade,

  rank integer not null check (rank between 1 and 3),

  title text not null,
  target_customer text not null,
  problem text not null,
  offer text not null,
  why_pay text not null,
  why_now text,
  initial_price text,
  differentiation text,
  speed_to_first_revenue text,
  validation_plan text not null,

  risks text[] not null default '{}',
  assumptions text[] not null default '{}',

  evidence_score smallint not null
    check (evidence_score between 0 and 100),

  fingerprint text not null,
  fingerprint_hash text not null,
  embedding extensions.vector(1536),

  status text not null default 'new'
    check (
      status in (
        'new',
        'saved',
        'rejected',
        'testing',
        'validated',
        'archived'
      )
    ),

  feedback_reason text
    check (
      feedback_reason is null or feedback_reason in (
        'strong_fit',
        'interesting_customer',
        'credible_problem',
        'weak_evidence',
        'market_too_crowded',
        'poor_personal_fit',
        'too_slow_to_revenue',
        'too_difficult',
        'pricing_unrealistic',
        'already_considered',
        'other'
      )
    ),
  feedback_note text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (owner_id, fingerprint_hash),
  unique (run_id, rank),
  unique (id, owner_id),
  foreign key (run_id, owner_id)
    references public.runs(id, owner_id) on delete cascade
);

create index ideas_owner_created_idx
  on public.ideas (owner_id, created_at desc);

create index ideas_owner_status_idx
  on public.ideas (owner_id, status);

-- A sequential vector comparison is sufficient for the first few
-- thousand single-user ideas, so no vector index is added yet.

-- ---------------------------------------------------------
-- IDEA SOURCES
-- Evidence relationships between ideas and X posts.
-- ---------------------------------------------------------

create table public.idea_sources (
  idea_id uuid not null,
  post_id text not null,
  owner_id uuid not null references auth.users(id) on delete cascade,

  signal_type text,
  evidence_summary text not null,

  created_at timestamptz not null default now(),

  primary key (idea_id, post_id),
  foreign key (idea_id, owner_id)
    references public.ideas(id, owner_id) on delete cascade,
  foreign key (post_id, owner_id)
    references public.posts(x_post_id, owner_id)
);

create index idea_sources_post_idx
  on public.idea_sources (post_id);

-- ---------------------------------------------------------
-- VECTOR MATCHING
-- Called only from trusted backend code.
-- ---------------------------------------------------------

create or replace function public.match_ideas(
  p_owner_id uuid,
  p_embedding extensions.vector(1536),
  p_exclude_run_id uuid,
  p_limit integer default 8
)
returns table (
  idea_id uuid,
  title text,
  target_customer text,
  problem text,
  fingerprint text,
  status text,
  feedback_reason text,
  similarity double precision
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    i.id as idea_id,
    i.title,
    i.target_customer,
    i.problem,
    i.fingerprint,
    i.status,
    i.feedback_reason,
    1 - (i.embedding operator(extensions.<=>) p_embedding) as similarity
  from public.ideas i
  where i.owner_id = p_owner_id
    and (p_exclude_run_id is null or i.run_id <> p_exclude_run_id)
    and i.embedding is not null
  order by i.embedding operator(extensions.<=>) p_embedding
  limit greatest(1, least(p_limit, 50));
$$;

revoke all on function public.match_ideas(uuid, extensions.vector, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.match_ideas(uuid, extensions.vector, uuid, integer)
  to service_role;

-- Luna analysis, run observability, and the next run state commit together.
-- A retried step that reaches this function after the run advanced receives
-- the existing signal checkpoint without adding usage a second time.
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
    or current_stage in ('clustering', 'generating', 'saving')
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
  uuid,
  uuid,
  jsonb,
  jsonb,
  jsonb,
  boolean
) from public, anon, authenticated;
grant execute on function public.persist_luna_checkpoint(
  uuid,
  uuid,
  jsonb,
  jsonb,
  jsonb,
  boolean
) to service_role;

-- Terra output, usage, counts, and the run transition commit together. The
-- delete/insert replacement is transactionally invisible to retries.
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
    or current_stage in ('generating', 'saving')
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
  uuid,
  uuid,
  jsonb,
  jsonb,
  jsonb,
  boolean
) from public, anon, authenticated;
grant execute on function public.persist_terra_checkpoint(
  uuid,
  uuid,
  jsonb,
  jsonb,
  jsonb,
  boolean
) to service_role;

-- Final publication is one transaction. This prevents a workflow retry from
-- leaving visible ideas without sources or a terminal run state.
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
        select count(*)
        from public.idea_sources source
        where source.owner_id = p_owner_id
          and source.idea_id = i.id
      ) < 3
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
      ) < 3
  ) then
    raise exception 'Published ideas require three posts and three authors.' using errcode = '23514';
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
  uuid,
  uuid,
  jsonb,
  jsonb,
  jsonb,
  jsonb
) from public, anon, authenticated;
grant execute on function public.publish_run_ideas(
  uuid,
  uuid,
  jsonb,
  jsonb,
  jsonb,
  jsonb
) to service_role;

-- ---------------------------------------------------------
-- ROW LEVEL SECURITY
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
      'alter table public.%I enable row level security',
      table_name
    );

    execute format(
      'create policy owner_only on public.%I
       for all
       to authenticated
       using (owner_id = auth.uid())
       with check (owner_id = auth.uid())',
      table_name
    );
  end loop;
end $$;
