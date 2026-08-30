# Signal Foundry: Current Architecture

This document records the system implemented in this repository.

It is a factual baseline, not a product roadmap.

The application is a private, single-owner research desk. It finds unusually
visible AI discussions on X, extracts commercial problems, groups related
signals, hands a bounded research job to a scheduled ChatGPT/Codex worker, and
publishes zero to three evidence-backed website ideas after independent server
validation.

The final research worker does not call an OpenAI Platform ideation model from
the application. Luna, Terra, and embeddings remain API-backed. Final web
research and candidate generation are performed by the account's scheduled
ChatGPT/Codex task through a narrow MCP connection.

There is one production path. No other final-ideation path is present.

## 1. System at a glance

```text
13:00 UTC Vercel cron or owner clicks Run now
                    |
                    v
        Create one owner-scoped run
                    |
                    v
       Official X recent-search API
      preferred accounts + topic query
                    |
                    v
       50,000-view gate and ranking
   views > comments > likes > bookmarks
                    |
                    v
       Luna commercial-signal extraction
                    |
                    v
          Terra problem clustering
                    |
                    v
 Build bounded, immutable research payload
                    |
                    v
       Supabase research_jobs: pending
                    |
            first workflow ends
                    |
                    v
 Hourly cloud ChatGPT/Codex scheduled task
                    |
                    v
       Signal Foundry plugin and MCP
 claim one job -> public web research -> submit
                    |
                    v
      Durable result saved in Supabase
                    |
                    v
       Separate Vercel finalizer workflow
 validate -> embed -> deduplicate -> publish
                    |
                    v
  0 ideas: no_ideas     1-3 ideas: completed
```

The split is deliberate:

- Supabase owns durable state.
- Vercel owns trusted collection, validation, deduplication, and publication.
- The scheduled worker owns public-web research and candidate drafting.
- The worker never writes directly to `ideas`.
- The browser never receives service credentials or provider tokens.

## 2. Technology stack

### Application

| Area | Implemented technology |
| --- | --- |
| Web framework | Next.js 16 App Router |
| Language | JavaScript and JSX |
| UI | React 19 |
| Styling | Tailwind CSS 4 |
| Hosting | Vercel |
| Durable orchestration | Vercel Workflow |
| Database | Supabase Postgres |
| Vector search | `pgvector`, 1,536 dimensions |
| Browser authentication | Supabase Auth |

### Data and models

| Responsibility | Provider or model |
| --- | --- |
| Recent social evidence | Official X API v2 |
| Per-post signal extraction | `gpt-5.6-luna` |
| Problem clustering | `gpt-5.6-terra` |
| Fingerprint embeddings | `text-embedding-3-small` |
| Final research and ideation | Scheduled ChatGPT/Codex task |

### Worker integration

| Area | Implemented technology |
| --- | --- |
| Remote tool protocol | Model Context Protocol over HTTP |
| MCP route | `mcp-handler` and MCP server v2 |
| Tool input/output validation | Zod 4 |
| OAuth authorization server | Supabase Auth OAuth 2.1 |
| JWT verification | `jose` with Supabase JWKS |
| Worker instructions | Versioned Codex skill in a local plugin package |

### Important absences

The current system does not use:

- TypeScript;
- an ORM;
- a generic job-queue service;
- a general-purpose database MCP server;
- arbitrary SQL tools;
- a second final-ideation API call;
- browser-side OpenAI, X, Supabase secret, or cron credentials;
- complete scraped web pages in Postgres.

## 3. Runtime boundaries

### Browser boundary

The browser can:

- sign the configured owner into Supabase;
- view runs, posts, ideas, and evidence permitted by RLS;
- start a manual run through an owner-authenticated API route;
- update settings;
- save or reject ideas and record feedback;
- approve or deny an OAuth connection on the owner-only consent page.

The browser cannot:

- use the Supabase secret key;
- call X with the bearer token;
- call OpenAI with the API key;
- invoke service-role research RPCs;
- submit a research result directly;
- bypass the owner identity check.

### Vercel application boundary

Next.js server routes and Vercel Workflow can use server-only credentials.

They are responsible for:

- authenticating cron and owner requests;
- reading the configured owner ID;
- creating and recovering runs;
- retrieving X posts;
- calling Luna, Terra, and embeddings;
- constructing and hashing the research payload;
- exposing the authenticated MCP endpoint;
- persisting a submitted research result;
- dispatching the separate finalizer workflow;
- validating and atomically publishing ideas.

### Scheduled worker boundary

The scheduled worker is external to the Vercel process and database.

It receives no database credential and no provider secret. It connects through
OAuth and can see only the bounded job returned by `claim_research_job`.

It may:

- claim one pending job;
- read that job's compressed X evidence and product contract;
- research public web sources;
- submit one schema-valid result;
- report one safe failure category.

It may not:

- list owner data;
- retrieve arbitrary runs or jobs;
- renew a lease;
- edit settings;
- write ideas;
- execute SQL;
- fetch a second job in the same invocation.

### Database boundary

Supabase Postgres is the source of truth for:

- run state;
- X post snapshots and analyses;
- Terra clusters;
- immutable research-job payloads;
- accepted worker results;
- published ideas and their evidence;
- owner feedback.

Machine-checkable state changes are implemented as narrow Postgres functions.
Mutating research functions are executable only by the service role. The owner
has RLS-protected read access to research tables.

## 4. Entry points

### Daily run

[`vercel.json`](./vercel.json) schedules:

```text
GET /api/cron/daily
13:00 UTC every day
```

The route requires the Vercel cron bearer value to match `CRON_SECRET` using a
timing-safe comparison.

A scheduled run key is date-based:

```text
scheduled:YYYY-MM-DD
```

That unique key makes a repeated daily delivery idempotent.

### Manual run

The signed-in owner can call:

```text
POST /api/runs
```

Manual runs use a random run key. The database still permits only one queued or
running run for the owner at a time.

### Scheduled research task

The research worker is an hourly cloud task configured in ChatGPT/Codex, not a
second Vercel cron.

Each invocation uses the packaged `signal-foundry-research` skill:

1. Call `claim_research_job` once.
2. Stop quietly if the queue is empty.
3. If claimed, read the result contract.
4. Research only the supplied problems and audiences.
5. Submit one result, or report one bounded failure.
6. Stop without claiming another job.

The task runs against the deployed HTTPS MCP endpoint. It does not require the
owner's laptop or a local project directory only when the connected account
allows private, write-capable MCP tools to run unattended. This must be proved
with the live checks in section 22; `offline_access` alone does not remove a
tool approval requirement.

## 5. Run creation and snapshots

Every run stores:

- `owner_id`;
- trigger type;
- idempotency key;
- status and stage;
- fixed `window_start` and `window_end` values;
- a settings snapshot;
- counters;
- model usage;
- generic error information;
- created, started, and completed timestamps.

The settings snapshot prevents mid-run edits from changing an active run.

It contains the effective:

- X topic query;
- candidate limit;
- AI input limit;
- preferred X usernames;
- product preferences;
- fixed 50,000 minimum-view policy;
- fixed ranking policy version.

The search interval is a rolling 72 hours. Its bounds are stored before the X
request, so a workflow retry repeats the same window.

## 6. X collection

### Two discovery lanes

The application uses two X recent-search queries.

The preferred-account lane searches AI-related posts from up to 12 configured
usernames.

The topic lane uses the editable X query from settings.

Both generated queries exclude retweets and quote posts with X search
operators. The client also requests `referenced_tweets`; deterministic ranking
rejects `retweeted` and `quoted` references as a defense-in-depth check.

Preferred accounts are a discovery preference, not a quality exception.
Preferred-account posts must meet every normal quality gate.

The preferred request is bounded by half of the AI input capacity. After
ranking, preferred posts can occupy at most half of the Luna input. Topic posts
fill the remaining positions.

This is a soft blend rather than a quota. If preferred accounts have no strong
posts, topic discovery supplies the useful input. A weak preferred post is not
selected merely to reach 50 percent.

### X request behavior

The X client uses:

- `/2/tweets/search/recent`;
- relevancy ordering;
- at most two pages;
- at most 100 results per page;
- fixed run window timestamps;
- author expansion for usernames;
- server-only bearer authentication.

The persisted public metrics are:

- impressions, treated as views;
- replies, treated as comments;
- likes;
- bookmarks, treated as saves.

Repost and quote counts do not contribute to quality.

The client does not retrieve threads, media bodies, biographies, follower
histories, or full quoted-post bodies.

### Partial results

If page one has at least 50 usable posts and page two fails, the X helper may
return a marked partial result. A first-page failure or an undersized partial
result fails the step and uses workflow retry behavior.

Rate-limit metadata is reduced to safe status and timing information. Request
headers, bearer values, query strings, and arbitrary upstream response bodies
are not exposed in application errors.

## 7. X quality gate and ranking

### Absolute reach requirement

Every rankable post must have at least:

```text
50,000 views
```

Comments, likes, bookmarks, preferred-account status, and model judgment cannot
waive this floor.

### Deterministic cleanup

Before a post can reach Luna, deterministic code rejects:

- text shorter than 40 characters;
- empty normalized text;
- reposts and quote posts recognized by query or reference indicators;
- obvious repeated promotional text;
- duplicate normalized text;
- posts exceeding the per-author cap of three.

Candidate snapshots that miss the 50,000-view floor can still be retained in
`run_posts` for owner inspection, but they are not rankable or sent to Luna.

### Age-adjusted metrics

Each quality metric is age-adjusted with a log signal. Post age is clamped
between two and 168 hours and uses an age exponent of `0.55`.

The signals are converted to within-pool percentile ranks. The deterministic
score is:

```text
0.65 * view percentile
+ 0.20 * comment percentile
+ 0.10 * like percentile
+ 0.05 * save percentile
```

Views are therefore the main quality signal, followed by comments, likes, and
bookmarks.

Ties are resolved deterministically using the individual metric signals and
post ID.

### Inspection

The `/posts` page lets the owner inspect collected posts, their source lane,
metrics, selection status, and analysis. This is an audit surface for checking
what the system is actually using.

## 8. Luna signal extraction

If fewer than five posts survive ranking and hybrid selection, the run ends as
`no_ideas` without a model call.

Otherwise Luna receives one bounded batch of selected posts and extracts:

- relevance;
- signal type;
- target customer;
- problem;
- exact evidence excerpt;
- concise summary;
- commercial score;
- hype score.

Server validation requires returned post IDs to belong to the input and exact
excerpts to occur in the original text.

The combined opportunity score is:

```text
0.4 * deterministic quality
+ 0.6 * commercial score
- 0.3 * hype score
```

A signal is eligible for Terra only when:

- Luna marks it relevant;
- commercial score is at least 50;
- hype score is at most 75.

At most 70 signals continue.

The `persist_luna_checkpoint` database function commits analysis, counters,
usage, and the next stage together. A retry recovers the saved checkpoint
instead of paying for the same extraction again.

If fewer than five signals qualify, the run ends as `no_ideas`.

## 9. Terra clustering

Terra receives only validated commercial signals. It groups related posts into
independently evidenced problem clusters.

Each cluster records:

- title;
- target customer;
- recurring problem;
- why-now context;
- summary;
- supporting post IDs;
- evidence strength;
- payment signal;
- eligibility.

At most eight clusters are stored for a run.

A cluster is useful to the final handoff only when its validated evidence can
provide at least three exact excerpts from at least three independent authors.

The `persist_terra_checkpoint` function atomically stores clusters, counts,
usage, and the next stage. Later retries recover the saved eligible cluster IDs.

If no eligible cluster remains, the run ends as `no_ideas`.

## 10. Research-job preparation

`prepareResearchJob()` is the final step of the daily workflow.

It performs trusted backend work before any external worker is involved:

1. Reload eligible Terra clusters.
2. Reload current-run evidence records.
3. Recheck the three-post and three-author minimum.
4. Keep at most five evidence excerpts per cluster.
5. Ensure the selected excerpts retain independent authors.
6. Build normalized cluster fingerprints.
7. Embed those fingerprints.
8. Retrieve compact related historical ideas.
9. Normalize owner preferences against the hard exclusions.
10. Snapshot the complete product contract.
11. Build the versioned JSON job payload.
12. Canonically hash the payload with SHA-256.
13. Persist the job and advance the run atomically.

### Bounded payload

The payload contains:

```text
schema_version
prompt_version
run_id
research_as_of
preferences
product_contract
clusters
historical_ideas
```

Each cluster contains only the selected evidence needed for research:

- cluster ID and compressed problem fields;
- evidence and payment scores;
- three to five X post IDs;
- author IDs and optional usernames;
- X URLs and timestamps;
- exact Luna evidence excerpts;
- signal types;
- views, comments, likes, and saves;
- opportunity scores.

The payload omits:

- the complete candidate pool;
- unrelated owner data;
- complete historical reports;
- credentials;
- database internals;
- arbitrary SQL access.

Historical ideas are limited to 20 compact records containing title,
fingerprint, status, and feedback reason. They are deduplication context, not
evidence.

Payload size is capped at one MiB.

### Durable handoff

`persist_research_job` creates at most one research job per run and changes the
run to:

```text
status = running
stage  = research_queued
```

The daily workflow then ends successfully with the job ID. It does not remain
open while waiting for the hourly worker.

## 11. Scheduled ChatGPT/Codex worker

The repository contains the worker plugin source at:

```text
integrations/signal-foundry-research/
```

The package includes:

- `.codex-plugin/plugin.json` for plugin metadata;
- `.mcp.json` for the production MCP connection;
- `skills/signal-foundry-research/SKILL.md` for the worker procedure;
- `references/result-contract.md` for the strict submission shape.

The schedule prompt should remain small:

```text
Use $signal-foundry-research. Claim at most one pending research job.
If none exists, stop quietly. If claimed, follow the skill and submit once.
```

The evidence and product instructions are retrieved from the durable job and
versioned skill. They are not copied into the schedule prompt.

### Research responsibilities

For the supplied clusters, the worker may investigate:

- existing products and substitutes;
- public pricing;
- customer evidence;
- implementation feasibility;
- distribution channels;
- a concrete differentiation wedge;
- material risks;
- LATAM fit when relevant.

The worker must distinguish:

```text
X evidence
  What people in this run said and how strong the observed signal is.

External research
  Public facts about competition, prices, feasibility, distribution, or risk.

Inference
  A reasoned conclusion that still needs validation.
```

Engagement is not treated as proof of willingness to pay. External research
does not inflate the X-only evidence score.

### Product boundary

The worker may return zero to five candidates, strongest first. Zero is a valid
result and is preferable to filler.

Every candidate must be a specific, self-serve website that:

- delivers useful value without a call or manual onboarding;
- can plausibly be built by one developer in two to six weeks;
- saves time, saves money, makes legitimate income, or provides an information
  or distribution advantage;
- has a concrete recurring-use trigger;
- uses AI to perform an action and produce an outcome.

Hard exclusions are:

- hardware;
- healthcare, therapy, or medical-adjacent products;
- consulting, agencies, audits, workshops, or custom implementation;
- long-cycle enterprise products;
- translation products;
- generic chat wrappers;
- synthetic companions.

The favored directions are soft targets, not quotas:

- AI cost collapse for work that was previously expensive or impractical;
- legitimate remote-income enablement;
- a real LATAM operating wedge;
- self-serve replacement of a complicated incumbent service;
- repeatable social-distribution leverage;
- one concrete automated action.

## 12. MCP interface

The deployed MCP resource is:

```text
https://admins-projects-d500137d.vercel.app/mcp
```

The route is Node.js, dynamically rendered, stateless, and accepts MCP `GET`,
`POST`, and `DELETE` requests.

POST bodies are limited to 1.25 MB before MCP parsing. Research result JSON is
limited to one MiB.

Verbose MCP logging is disabled.

### Tool surface

Only three tools are registered.

#### `claim_research_job`

First checks for a durable result left in `submitted` because a prior finalizer
dispatch was interrupted, or in `validating` for at least 30 minutes. The stale
threshold avoids racing a healthy finalizer. If one exists, it restarts the
idempotent finalizer and returns `empty` so the worker does not claim a second
unit of work. Otherwise it atomically claims the oldest available job for the
configured owner.

It returns either:

```text
status = empty
```

or one bounded payload with:

- job and run IDs;
- schema and prompt versions;
- payload and payload hash;
- claim ID;
- lease expiration;
- attempt count.

The claim uses `FOR UPDATE SKIP LOCKED`. A claim ID is a capability for one job
and one lease, not a general credential.

#### `submit_research_result`

Performs strict shape validation, canonical hashing, and an atomic database
submission against the active claim.

The result is durable before the MCP route dispatches the separate finalizer
workflow.

Submitting the identical accepted result again is idempotent and can restart an
idempotent finalizer if dispatch failed. A different result cannot replace an
accepted result.

#### `report_research_failure`

Releases the active claim with one of four safe categories:

```text
research_unavailable
source_access_failed
submission_invalid
tool_error
```

No source content, prompt content, token, or arbitrary error body is accepted.

The normal retry delay is 15 minutes.

## 13. MCP OAuth and authorization

### Discovery

The application exposes protected-resource metadata at:

```text
/.well-known/oauth-protected-resource
```

It points MCP clients to the Supabase Auth issuer and advertises `openid`,
`email`, and `offline_access`.

### Consent

Supabase redirects OAuth authorization requests to:

```text
/oauth/consent?authorization_id=...
```

The page preserves the authorization request through login, loads the client
details from Supabase, shows the requested scopes and redirect host, and lets
only the configured owner approve or deny the request.

Redirects must use HTTPS except for native-client callbacks to the exact numeric
loopback hosts `127.0.0.1` or `::1` with an explicit port. They may not contain
credentials or a fragment, and must match the registered origin and path when
the decision is completed.

### Bearer verification

Every MCP request requires a Supabase-issued OAuth JWT.

The server verifies:

- the token signature through the remote Supabase JWKS;
- `RS256` or `ES256`;
- exact Supabase Auth issuer;
- exact MCP audience;
- unexpired `exp`;
- `sub` equals `OWNER_USER_ID`;
- `role` equals `authenticated`;
- a non-empty OAuth `client_id` exists.

Supabase returns granted OAuth scopes beside the access token, not inside the
access-token JWT. The server therefore does not pretend to enforce a JWT
`scope` claim that Supabase does not issue. The OAuth consent flow still limits
requests to Supabase's supported identity scopes; authorization for this MCP
resource comes from the owner subject, OAuth client ID, signature, issuer, and
exact resource audience.

The protected-resource metadata and consent allowlist require exactly
`openid`, `email`, and `offline_access`. The refresh scope lets a compatible
connected cloud worker refresh authorization without a new owner login on each
run, while rejecting unneeded profile or phone access. It does not guarantee
that a personal account will permit unattended write actions.

Migration 003 also replaces the original owner table policies with
browser-only owner policies. A JWT containing an OAuth `client_id` is denied
direct PostgREST access to application, queue, and research tables. The MCP
route performs its three narrow operations through the server-only service
role after independently verifying the token.

The OAuth client also receives the standard Supabase identity access covered
by the scopes shown on the consent screen. That residual trust is acceptable
for this private, owner-approved connection, but it is distinct from the MCP
application-data boundary. Revoke any unrecognized OAuth grant in Supabase;
the application never describes the token as incapable of standard identity
access.

Authentication failures are intentionally generic and do not log bearer tokens
or provider details.

### Audience hook

Migration `003_scheduled_research_worker.sql` creates:

```text
public.signal_foundry_access_token_hook(event jsonb)
```

For OAuth token issuance with a `client_id`, it changes `aud` to the exact
production MCP resource URL. Ordinary owner browser sessions, which have no
OAuth client ID, retain their existing audience.

Creating this SQL function is not enough. The operator must select it as the
Supabase Custom Access Token Hook in the Dashboard.

## 14. Research result contract

The submitted root object has exactly:

```text
schema_version
assessment
sources
ideas
```

Unknown fields are rejected.

### Assessment

`assessment.overall_evidence` is one of:

```text
insufficient
weak
moderate
strong
```

Only moderate or strong overall evidence can produce a publishable candidate.

### External sources

A result may contain up to 40 source records.

Each source contains:

- a result-local source ID;
- public HTTP or HTTPS URL;
- title;
- optional publisher;
- optional publication time;
- access time;
- source type;
- one to 20 concise supported claims.

Allowed types are:

```text
competitor
competitor_pricing
customer_evidence
feasibility
distribution
latam_fit
risk
other
```

Source IDs and normalized URLs must be unique in the result.

The URL validator rejects credentials, fragments, localhost, single-label
hosts, internal suffixes, cloud-metadata names, private or reserved IPv4
ranges, and non-public IPv6 ranges.

The server never fetches a worker-submitted URL. It validates, stores, and later
renders the link. This keeps URL submission from becoming a server-side request
forgery path.

### Candidate grounding

Each candidate includes the full product contract, risks, assumptions, an
X-only evidence score, X post IDs, external research source IDs, and a claim map.

The server requires:

- one supplied cluster ID;
- three to five unique X post IDs from that cluster;
- at least three independent authors;
- one to ten external sources;
- every external source ID to exist in the same result;
- every cited source to appear in a claim-map entry;
- every mapped claim string to exactly match a supported claim on each mapped
  source;
- consecutive candidate ranks starting at one;
- all hard-filter booleans to be true;
- an X evidence score of at least 65;
- a two-to-six-week MVP;
- self-serve web delivery and an allowed self-serve sales motion.

A candidate that fails grounding is dropped independently. A valid sibling can
still continue. A structurally invalid root result is rejected as a whole.

## 15. Finalizer workflow

`submit_research_result` stores the accepted result first, then starts
`finalizeResearch` as a separate Vercel Workflow.

The finalizer:

1. Atomically moves the job from `submitted` to `validating`.
2. Reloads the parent run, immutable payload, and submitted result.
3. Recomputes both canonical SHA-256 hashes.
4. Checks schema and prompt versions.
5. Reloads only the X posts named by the payload.
6. Validates candidate cluster and source membership.
7. Rechecks author diversity, scores, product rules, and claim maps.
8. Drops individually unpublishable candidates.
9. Recomputes normalized idea fingerprints.
10. Embeds candidate fingerprints with `text-embedding-3-small`.
11. Removes exact duplicates against prior ideas.
12. Removes semantic duplicates against prior ideas.
13. Removes duplicates within the submitted batch.
14. Keeps at most three ideas.
15. Publishes the run, ideas, X links, and external evidence atomically.

### Duplicate policy

Exact deduplication uses a normalized structured fingerprint and SHA-256 hash.

Semantic deduplication uses 1,536-dimensional embeddings and a similarity
threshold of `0.90`, together with structured idea comparison.

Historical matches in the job help the worker avoid repetition, but trusted
server-side fingerprinting and vector search remain authoritative.

### Zero-idea completion

A worker may submit no candidates, or all candidates may fail grounding or
deduplication.

That is a successful research outcome:

```text
research_jobs.status = completed
runs.status          = no_ideas
runs.stage           = null
```

The system does not publish filler to reach a quota.

### One-to-three-idea completion

When candidates survive, the atomic publication function creates:

- one to three `ideas` rows;
- `idea_sources` links to direct X evidence;
- the used `research_sources` rows;
- `idea_research_sources` links and supported claims;
- final counters and embedding usage.

It then marks both the job and run complete.

## 16. Persistent data model

### `settings`

One row for the owner containing:

- topic query;
- up to 12 preferred X usernames;
- candidate and Luna input limits;
- product preferences.

### `runs`

One row per scheduled or manual execution.

Run statuses are:

```text
queued
running
completed
no_ideas
failed
```

Run stages are:

```text
fetching
extracting
clustering
generating
research_queued
researching
validating
saving
```

`stage` becomes null for terminal runs.

### `posts`

Canonical owner-scoped X records. X IDs remain strings.

The table stores current text while retained, author identity, URL, creation
time, availability, and refresh timestamps.

### `run_posts`

Per-run snapshots containing captured public metrics, discovery lane,
deterministic ranking, Luna selection, and validated signal analysis.

### `clusters`

Terra-generated problem groups with evidence post IDs, evidence strength,
payment signal, and eligibility.

### `research_jobs`

One durable handoff per run.

Important fields include:

- status;
- schema and prompt versions;
- immutable payload and hash;
- immutable accepted result and hash;
- claim capability and lease expiration;
- attempt count and next availability;
- safe error code and message;
- lifecycle timestamps.

Payloads and results are each limited to one MiB. Attempts are limited to three.

### `ideas`

Published hypotheses with rank, product explanation, product contract, hard
checks, risks, assumptions, evidence score, fingerprint, embedding, status, and
owner feedback.

### `idea_sources`

Links a published idea to direct X evidence. It retains signal type and a
concise evidence summary.

### `research_sources`

Stores only validated external-source metadata and concise supported claims.
It does not store full pages.

Source IDs and URLs are unique within a research job.

### `idea_research_sources`

Links a published idea to an external research source in the same run and owner
boundary. Each link stores the claims that source supports for that idea.

## 17. State transitions and recovery

### Run state

```text
queued / null
  -> running / fetching
  -> running / extracting
  -> running / clustering
  -> running / generating
  -> running / research_queued
  -> running / researching
  -> running / validating
  -> running / saving
  -> completed / null

Any evidence gate may instead end at:
  -> no_ideas / null

An exhausted or unrecoverable failure ends at:
  -> failed
```

### Research-job state

```text
pending
  -> claimed
  -> submitted
  -> validating
  -> completed

claimed
  -> pending after a reported retryable failure
  -> claimed again after an expired lease
  -> failed on the third failed or expired attempt

submitted or validating
  -> completed through the idempotent finalizer
  -> failed if final validation cannot finish after workflow retries
```

### Leases

Claims last at most two hours. An expired claim can be reclaimed with a new
claim ID while fewer than three attempts have been used.

No lease-renewal tool is exposed. One scheduled invocation is expected to
finish its bounded job within the lease.

### Workflow retries

Fetch, Luna, Terra, research-job preparation, final validation, and finalizer
failure recording each permit up to three workflow attempts.

Committed checkpoints make retries idempotent:

- ranked posts are recovered from `run_posts`;
- Luna analysis is recovered from `run_posts`;
- Terra clusters are recovered from `clusters`;
- the existing research job is recovered from `research_jobs`;
- an already completed finalizer returns existing idea IDs;
- an identical result submission is accepted as already persisted;
- the next hourly claim call redrives a stranded submitted finalizer or a
  validating finalizer stale for at least 30 minutes.

A failed job with no accepted result may be reset by the same-day scheduled
retry. An immutable result that already failed final validation is not reopened;
the retry fails safely instead of creating an unowned `submitted` state.

### Stale runs

Starting a new run checks existing owner runs.

Local pipeline stages are stale after six hours. External-research stages are
stale after 12 hours. A stale research run is closed through
`fail_research_job` so the job and run do not disagree.

There is no independent queue-monitoring cron. Stale-run cleanup happens when a
new run is requested, while expired research claims are handled by the next
claim operation.

## 18. Evidence retention

Raw X post text and exact Luna excerpts are retained for 30 days.

At the start of a fetch step, the application:

- removes expired raw text;
- clears expired exact excerpts;
- refreshes X posts still referenced by published ideas;
- marks source availability as available, unavailable, or unknown;
- invalidates an exact excerpt if the source text changed.

Idea and evidence relationships remain after raw text expires.

Opening an idea rechecks its X sources. The interface separates:

- direct X evidence;
- external market research;
- model assumptions.

External links open with `noopener noreferrer`.

## 19. Owner authentication and RLS

The application is intentionally single-user.

`OWNER_USER_ID` is enforced by:

- the Next.js proxy;
- page and API server checks;
- workflow arguments and database predicates;
- MCP JWT validation;
- owner-aware foreign keys;
- Supabase RLS.

An authenticated non-owner session is signed out locally and cannot use the
private dashboard.

The proxy leaves these paths to their own authentication mechanisms:

- `/mcp`;
- `/.well-known/oauth-protected-resource`;
- Vercel Workflow protocol paths;
- Vercel cron routes.

`/oauth/consent` is reachable so Supabase can redirect to it, but approval still
requires the configured owner session.

Research-table browser permissions are read-only. Mutations go through
service-role RPCs after application-level owner and contract checks.

## 20. User-facing pages

### `/login`

Owner password login, with an email-link path for initial password setup and
recovery. A safe internal `next` parameter returns an OAuth flow to consent
after login.

### `/`

Dashboard showing recent run state, counts, and latest ideas. The run-state UI
includes queued external research, active research, and final validation.

### `/posts`

Collected-post inspection, including X link, text while retained, source lane,
captured engagement, ranking, and analysis state.

### `/ideas`

Published idea archive with filters and evidence summaries.

### `/ideas/[id]`

Complete product hypothesis, validation plan, direct X evidence, external
research sources with supported claims, assumptions, risks, and feedback.

### `/settings`

Topic query, preferred X usernames, input limits, and product preferences.

### `/oauth/consent`

Private Supabase OAuth approval UI for the MCP client.

## 21. Current operating constants

| Constant | Value |
| --- | --- |
| Daily Vercel cron | 13:00 UTC |
| X research window | 72 hours |
| X recent-search maximum | 200 candidate records |
| Preferred X usernames | 12 maximum |
| Minimum post views | 50,000 |
| Maximum posts per author | 3 |
| Ranking weights | views 65%, comments 20%, likes 10%, saves 5% |
| Default Luna input | 100 posts |
| Minimum posts before Luna | 5 |
| Luna commercial minimum | 50/100 |
| Luna hype maximum | 75/100 |
| Maximum signals | 70 |
| Maximum clusters | 8 |
| Minimum X evidence | 3 posts from 3 authors |
| Evidence sent per cluster | 3 to 5 posts |
| Maximum historical ideas in job | 20 |
| Research schema version | 1 |
| Research prompt version | `scheduled_research_v1` |
| Maximum job or result JSON | 1 MiB each |
| MCP POST limit | 1.25 MB |
| Research claim lease | 2 hours |
| Maximum claim attempts | 3 |
| Failure retry delay | 15 minutes |
| Maximum external sources | 40 |
| External sources per idea | 1 to 10 |
| Maximum worker candidates | 5 |
| Minimum publishable evidence | 65/100 |
| Published ideas | 0 to 3 |
| MVP build window | 2 to 6 weeks |
| Semantic duplicate threshold | 0.90 |
| Raw X text retention | 30 days |

## 22. Required operator setup

Repository code alone cannot enable Supabase OAuth, connect a private plugin,
or create a cloud schedule. The production flow is active only after the steps
below are complete.

### 1. Apply database migrations

Apply every file in `supabase/migrations` in filename order, including:

```text
003_scheduled_research_worker.sql
```

This creates the queue, external evidence tables, research RPCs, stage updates,
RLS policies, and access-token hook function.

### 2. Use asymmetric Supabase JWT signing

Configure the Supabase project with an asymmetric signing key supported by the
application:

```text
RS256 or ES256
```

The MCP verifier intentionally does not accept a shared HS256 secret.

### 3. Enable the Supabase OAuth server

In the Supabase Dashboard:

1. Open Authentication > OAuth Server.
2. Enable OAuth 2.1 server capabilities.
3. Set the authorization path to `/oauth/consent`.
4. Confirm the Authentication Site URL is the production website origin.
5. Enable dynamic client registration if the ChatGPT/Codex MCP client uses it.
6. Require explicit owner consent.
7. Confirm the connection requests `openid email offline_access` so unattended
   runs can refresh their authorization.

### 4. Enable the custom access-token hook

In Authentication > Hooks, select:

```text
public.signal_foundry_access_token_hook
```

as the Custom Access Token Hook.

The issued OAuth token must have this exact audience:

```text
https://admins-projects-d500137d.vercel.app/mcp
```

### 5. Deploy the new application version

The public deployment must expose successful responses for:

```text
https://admins-projects-d500137d.vercel.app/.well-known/oauth-protected-resource
https://admins-projects-d500137d.vercel.app/mcp
https://admins-projects-d500137d.vercel.app/oauth/consent
```

An unauthenticated MCP request should be rejected. That rejection confirms the
route is not accidentally public.

### 6. Install and connect the plugin

Install the plugin package from:

```text
integrations/signal-foundry-research
```

Connect its `signal-foundry` MCP server. Complete the Supabase OAuth flow while
signed in as the configured owner, review the client and scopes, and approve
the connection.

The exact private-plugin installation interface depends on the ChatGPT/Codex
account and workspace capabilities. Do not replace OAuth with a secret pasted
into a task prompt.

Before creating the schedule, test the connection from a normal cloud chat:

1. Call `claim_research_job` when the queue is empty and confirm it returns
   without an approval prompt.
2. Queue a controlled job, claim it, and confirm a result can be submitted
   without an approval prompt.
3. If either mutating tool is unavailable or pauses for approval, do not create
   the cloud schedule. Personal Pro support for unattended private write tools
   is not guaranteed by the public documentation.

### 7. Create the hourly cloud schedule

Create a ChatGPT/Codex scheduled task that runs hourly and instructs the worker
to use `$signal-foundry-research`, claim at most one job, and stop quietly when
empty.

Use a cloud task with the connected plugin only after the unattended write test
passes. A local project task is a different execution mode and requires this
repository, the desktop app, and the computer to remain available.

### 8. Perform one end-to-end check

1. Start a manual run.
2. Confirm it reaches `research_queued` and creates one pending job.
3. Run the worker once.
4. Confirm the job reaches `submitted`, `validating`, then `completed`.
5. Confirm the run ends as `completed` or `no_ideas`.
6. If ideas publish, verify both X and external evidence on an idea page.
7. Confirm no secret or complete research payload appears in the task chat.

## 23. Environment variables

### Required application values

```text
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
SUPABASE_SECRET_KEY
OWNER_USER_ID
OWNER_EMAIL
OPENAI_API_KEY
X_BEARER_TOKEN
CRON_SECRET
```

Only the two `NEXT_PUBLIC_*` values may be used in browser code.

### MCP overrides

These are optional when the production Vercel hostname and standard Supabase
JWKS endpoint are correct:

```text
MCP_RESOURCE_URL
MCP_TOKEN_AUDIENCE
SUPABASE_JWKS_URL
```

`MCP_RESOURCE_URL` and `MCP_TOKEN_AUDIENCE` must be plain HTTPS URLs ending in
`/mcp`. If either is changed, the Supabase access-token hook and plugin
configuration must use the same exact resource URL.

Secrets must never be copied into browser code, source control, logs, X
queries, research payloads, schedule prompts, or plugin skill text.

## 24. Local development and verification

Use Node.js 20 or newer.

Install and start the application:

```bash
npm install
npm run dev
```

Run automated verification:

```bash
npm test -- --test-isolation=none
npm run build
```

Local development covers application logic, schemas, workflows, MCP request
handling, and UI. A cloud worker cannot connect to an unpublished localhost MCP
resource, so the final OAuth and schedule check must use a public HTTPS
deployment.

## 25. Operational interpretation

Useful run counters include:

- X returned and raw-returned records;
- preferred and topic lane totals;
- records clearing the 50K view gate;
- posts sent to Luna by lane;
- relevant Luna signals;
- clusters created and eligible;
- research jobs queued;
- grounded research candidates;
- duplicates removed;
- ideas saved;
- partial X retrieval.

Usage records cover Luna, Terra, and embedding calls. The account's scheduled
task usage is managed by ChatGPT/Codex and is not reported as OpenAI Platform
token usage in the run row.

An idea remains a researched hypothesis, not a validated business. Direct X
evidence demonstrates that a discussion or problem appeared in the sampled
window. External links support specific market facts. Assumptions and the
seven-day validation plan identify what still needs real-world testing.

## 26. Known boundaries

- The queue is polled hourly, so a valid job can wait until the next task run.
- One scheduled invocation processes at most one job.
- The system relies on the private plugin connection remaining authorized.
- Source claims are checked for structural linkage, not independently fact-
  checked by another crawler.
- The server validates submitted URLs but intentionally does not fetch them.
- There is no market-size model and no claim that engagement equals demand.
- External task usage and task-level approval behavior depend on the connected
  ChatGPT/Codex account.
- Public documentation does not guarantee unattended private write-capable MCP
  actions for a personal Pro account; the live connection and Run now checks
  are part of activation, not optional QA.
- Stale cleanup is opportunistic when another run or claim occurs; there is no
  separate watchdog cron.

These are current operating boundaries, not alternate execution paths.

## 27. Source-of-truth files

### Orchestration

- [`src/workflows/daily-research.js`](./src/workflows/daily-research.js)
- [`src/workflows/daily-research-steps.js`](./src/workflows/daily-research-steps.js)
- [`src/workflows/finalize-research.js`](./src/workflows/finalize-research.js)
- [`src/workflows/research-finalizer-steps.js`](./src/workflows/research-finalizer-steps.js)
- [`src/lib/runs/start-run.js`](./src/lib/runs/start-run.js)
- [`vercel.json`](./vercel.json)

### X and ranking

- [`src/lib/x/search-posts.js`](./src/lib/x/search-posts.js)
- [`src/lib/x/client.js`](./src/lib/x/client.js)
- [`src/lib/x/retention.js`](./src/lib/x/retention.js)
- [`src/lib/ranking.js`](./src/lib/ranking.js)

### Models, contracts, and validation

- [`src/lib/config.js`](./src/lib/config.js)
- [`src/lib/prompts/extract-signals.js`](./src/lib/prompts/extract-signals.js)
- [`src/lib/prompts/build-clusters.js`](./src/lib/prompts/build-clusters.js)
- [`src/lib/prompts/generate-ideas.js`](./src/lib/prompts/generate-ideas.js)
- [`src/lib/ai-schemas/idea-generation.js`](./src/lib/ai-schemas/idea-generation.js)
- [`src/lib/validation.js`](./src/lib/validation.js)
- [`src/lib/fingerprints.js`](./src/lib/fingerprints.js)
- [`src/lib/idea-deduplication.js`](./src/lib/idea-deduplication.js)
- [`src/lib/research/canonical-json.js`](./src/lib/research/canonical-json.js)
- [`src/lib/research/public-url.js`](./src/lib/research/public-url.js)

### MCP and OAuth

- [`src/app/mcp/route.js`](./src/app/mcp/route.js)
- [`src/app/.well-known/oauth-protected-resource/route.js`](./src/app/.well-known/oauth-protected-resource/route.js)
- [`src/app/oauth/consent/page.js`](./src/app/oauth/consent/page.js)
- [`src/app/oauth/consent/actions.js`](./src/app/oauth/consent/actions.js)
- [`src/lib/mcp/config.js`](./src/lib/mcp/config.js)
- [`src/lib/mcp/auth.js`](./src/lib/mcp/auth.js)
- [`src/lib/mcp/tools.js`](./src/lib/mcp/tools.js)

### Plugin

- [`integrations/signal-foundry-research/.codex-plugin/plugin.json`](./integrations/signal-foundry-research/.codex-plugin/plugin.json)
- [`integrations/signal-foundry-research/.mcp.json`](./integrations/signal-foundry-research/.mcp.json)
- [`integrations/signal-foundry-research/skills/signal-foundry-research/SKILL.md`](./integrations/signal-foundry-research/skills/signal-foundry-research/SKILL.md)
- [`integrations/signal-foundry-research/skills/signal-foundry-research/references/result-contract.md`](./integrations/signal-foundry-research/skills/signal-foundry-research/references/result-contract.md)

### Database and UI

- [`supabase/migrations/001_initial_schema.sql`](./supabase/migrations/001_initial_schema.sql)
- [`supabase/migrations/002_hybrid_sources_and_product_contract.sql`](./supabase/migrations/002_hybrid_sources_and_product_contract.sql)
- [`supabase/migrations/003_scheduled_research_worker.sql`](./supabase/migrations/003_scheduled_research_worker.sql)
- [`src/app/posts/page.js`](./src/app/posts/page.js)
- [`src/app/ideas/[id]/page.js`](./src/app/ideas/[id]/page.js)
- [`src/components/idea-detail.jsx`](./src/components/idea-detail.jsx)
- [`src/components/external-research-list.jsx`](./src/components/external-research-list.jsx)

## 28. External implementation references

- [OpenAI scheduled tasks](https://learn.chatgpt.com/docs/automations?surface=app)
- [OpenAI MCP server guidance](https://developers.openai.com/plugins/build/mcp-server)
- [OpenAI plugin authentication guidance](https://developers.openai.com/plugins/build/auth)
- [Supabase MCP authentication](https://supabase.com/docs/guides/auth/oauth-server/mcp-authentication)
- [Supabase OAuth server setup](https://supabase.com/docs/guides/auth/oauth-server/getting-started)
- [Supabase OAuth token security](https://supabase.com/docs/guides/auth/oauth-server/token-security)
