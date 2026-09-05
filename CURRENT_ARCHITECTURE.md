# Signal Foundry: Current Architecture

This document records the system implemented in this repository.

It is a factual baseline, not a product roadmap.

The application is a private, single-owner research desk. Its primary
production input is the first 30 new, verified original posts from the owner's
X `For you` feed. It filters those posts for concrete commercial inspiration,
hydrates only ambiguous linked context, shortlists at most eight posts, creates
one independently generated candidate per shortlisted post, and researches at
most three deduplicated candidates before publishing zero to three ideas.

New production runs use ChatGPT cloud for Sol shortlisting, isolated candidate
generation and final web research. Luna filtering/context and embeddings remain
OpenAI Platform calls made with server-only credentials. After the shared Luna
stages, the daily Vercel Workflow dispatches a primary cloud run and returns;
the cloud coordinator validates results and publishes through trusted database
functions. The hourly Work parent delegates exactly one job to a new Sol High
child with no forked conversation history.

`PIPELINE.ideationProvider = "chatgpt_cloud"` is saved as
`runs.settings_snapshot.ideation_provider` when a run is created. The retained
Sol Responses API implementation can be selected explicitly with `"api"` for
rollback; cloud errors do not fall back to API calls. Historical shadow
comparisons keep their immutable mode and cannot publish (sections 22 and 30).
The repository also retains the separate narrow Signal Foundry MCP interface
and Codex skill as an optional manual or future research worker path.

The Playwright collector contributes only ordered X post IDs and feed
positions. The daily Vercel Workflow invokes one stopped EC2 worker only when
the exact feature flag and approved-account gate is enabled. Official X lookup
verifies and hydrates those IDs, including bounded URL, long-post, article, and
media-alt context. Official followed-account and topic recent search remains a
configurable fallback path.

## 1. System at a glance

```text
13:00 UTC Vercel cron or owner clicks Run now
                    |
                    v
        Create one owner-scoped run
                    |
                    v
      For You lane                     Optional official search fallback
 webhook -> EC2/SSM -> <=100 IDs       preferred accounts + topic query
          |                                         |
 official X verification                           ranking
          |                                         |
 first 30 new originals ----------------------------+
          |
          v
 Luna commercial filter: keep / reject / needs_context
          |
          v
 Luna hydrates only needs_context posts with bounded official
 context and low-context hosted web search
          |
          v
 Cloud shortlist when more than 8 survive; maximum 8 posts
          |
          v
 New cloud Sol High child per post: 3 concepts -> 0 or 1 candidate
          |
          v
 Persist generation result -> exact/semantic dedup -> top 3
          |
          v
 Build bounded, immutable candidate research payload
                    |
                    v
       Supabase cloud_model_jobs: pending research
                    |
                    v
 Hourly cloud parent spawns one child with fork_turns: none
                    |
                    v
  Child claims one job, researches on the public web,
  and submits its bounded structured response
                    |
                    v
 Cloud coordinator checks durably for up to 24 hours
                    |
                    v
      Durable result saved in Supabase
                    |
                    v
 Trusted coordinator validates -> embeds -> deduplicates
 Database transaction publishes ideas and completes both runs
                    |
                    v
  0 ideas: no_ideas     1-3 ideas: completed
```

The split is deliberate:

- Supabase owns durable state.
- Vercel owns trusted collection, validation, deduplication, and publication.
- A scheduled ChatGPT cloud worker produces the bounded research result.
- Model output never writes directly to `ideas`.
- The browser never receives service credentials or provider tokens.

An authorized MCP client can optionally claim legacy `research_jobs`. That
retained boundary shares result schemas and publication validation, but is not
the cloud worker's queue or the default daily production flow.

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
| Commercial post filtering | `gpt-5.6-luna`, low reasoning |
| Ambiguous linked-context hydration | `gpt-5.6-luna`, low reasoning, hosted web search |
| Post shortlisting | ChatGPT cloud, requested `gpt-5.6-sol` High |
| Isolated candidate generation | New cloud child per post, requested `gpt-5.6-sol` High |
| Fingerprint embeddings | `text-embedding-3-small` |
| Candidate research and refinement | New cloud child, requested `gpt-5.6-sol` High |
| External research | Cloud worker public-web research; source access worker-reported |

### Production research integration

| Area | Implemented technology |
| --- | --- |
| Model work | Hourly ChatGPT Work parent and one isolated child per execution |
| Execution | Immutable owner-scoped jobs, 30-minute claims, at most three attempts |
| Search | Public-web research in the child |
| Output | Saved structured JSON, independently validated against the schema |
| Waiting and retry | Durable Vercel coordinator, one-minute sleeps, 24-hour run deadline |

Runtime model identity is unverified despite explicit Sol High requests. The
Responses API implementation is retained for rollback, not called for Sol work
by new cloud-provider runs.

### Optional MCP integration

| Area | Implemented technology |
| --- | --- |
| Remote tool protocol | Model Context Protocol over HTTP |
| MCP route | `mcp-handler` and MCP server v2 |
| Tool input/output validation | Zod 4 |
| OAuth authorization server | Supabase Auth OAuth 2.1 |
| JWT verification | `jose` with Supabase JWKS |
| Worker instructions | Versioned Codex skill in a local plugin package |

### Optional X web collection

| Area | Implemented technology |
| --- | --- |
| Browser automation | Playwright Core with installed Chrome Stable and Chromium sandbox enabled |
| Cloud execution support | Pinned `us-east-2` EC2 instance `i-064c47109859601d1`, started/stopped by Vercel and invoked through SSM Run Command |
| Vercel AWS authentication | Short-lived OIDC credentials from `@vercel/oidc-aws-credentials-provider` assuming pinned role `signal-foundry-vercel-x-for-you` |
| Browser display | Headed Chrome in an isolated Xvfb virtual display; unattended challenges abort |
| Development execution | Manual Node.js process on an interactive Windows desktop |
| Session | Dedicated persistent Chrome profile on encrypted EBS, or under the local Windows per-user data directory |
| Authorization | `X_WEB_AUTOMATION_ENABLED=true` plus `X_WEB_AUTOMATION_APPROVED_ACCOUNT` matching secret `X_LOGIN_USERNAME` |
| Concurrency | Exclusive persistent-profile lock; one Workflow invocation at a time per worker |
| Cloud secrets | One credentials-only Secrets Manager value read through a narrowly scoped EC2 instance role |
| Production result | One one-use Workflow webhook carrying at most 100 canonical post IDs and feed positions |
| Deployment storage | Private, versioned S3 `deployment/` prefix; no S3 result plane |

### Important absences

The retained API rollback path does not use:

- TypeScript;
- an ORM;
- a generic job-queue service;
- a general-purpose database MCP server;
- arbitrary SQL tools;
- a second production scheduler or queue-polling cron;
- a For You queue, Lambda, Step Functions state machine, custom callback route,
  or result table;
- a production dependency on a ChatGPT/Codex scheduled task;
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
- optionally starting and stopping the For You EC2 worker, invoking it through
  SSM, accepting its one-use webhook result, and hydrating its post IDs through
  the official X lookup API;
- calling Luna, its bounded context search, and embeddings;
- dispatching primary cloud jobs and advancing their validated state;
- constructing and hashing the research payload;
- retaining Sol response creation/polling/cancellation for explicit API rollback;
- validating and persisting the research result;
- running final validation in the cloud coordinator;
- validating and atomically publishing ideas.

The application also exposes the authenticated MCP endpoint for the optional
worker path. An MCP submission persists first and then dispatches the separate,
idempotent finalizer workflow.

### Optional X web collector boundary

The collector is not a Next.js route, cron, MCP tool, or database writer. Its
executable statically imports only gate-safe modules. It validates that
`X_WEB_AUTOMATION_ENABLED` is exactly `true`, that
`X_WEB_AUTOMATION_APPROVED_ACCOUNT` matches the configured
`X_LOGIN_USERNAME` case-insensitively, and that the post limit and external
runtime paths are safe before dynamically importing the browser runner. There
are no signatures, public keys, approval documents, approval IDs, approval
expiry, or daily approval ledger.

When the gate is disabled, the daily Workflow skips webhook creation and every
AWS operation for this lane. The worker cannot read its X secret, import
Playwright, launch Chrome, or contact the X website. Runtime AWS configuration
and X credentials do not grant authorization by themselves.

The browser launcher validates the opaque in-process capability again before
dynamically importing Playwright Core, atomically consumes its single browser
launch claim, rejects ambient Playwright/debug instrumentation against the
actual process environment, and launches installed Chrome with the Chromium
sandbox enabled and explicit launch/action/navigation deadlines.

The collector can:

- open X Home in a dedicated persistent profile;
- reuse an existing authenticated session;
- make one email/optional-username/password login attempt when required;
- verify the authenticated session through the exact allowed-host profile-link
  handle against the approved account;
- wait for an operator to finish a challenge only in explicitly enabled
  interactive mode;
- select and verify the English `For you` tab;
- read top-level, rendered timeline articles only while they intersect the
  viewport and scroll by a fixed viewport fraction;
- append first-observed posts to local diagnostic JSONL; and
- return at most 100 canonical numeric status IDs and first feed positions to
  the one-use Workflow webhook after browser and output handles are closed.
  Its path is sent through the public production alias because Vercel protects
  the deployment-specific hostname; this adds no callback secret or endpoint.

Its action-policy module contains the complete mutable UI surface: fill the
login identifier, optional username, and password; click Next, Log in, and
`For you`; and scroll. It has no action for timeline clicks, likes, reposts,
replies, follows, bookmarks, direct messages, composing posts, external links,
or settings. Context-wide top-level navigation is restricted to the exact
Home, login, and challenge routes on approved HTTPS X hosts, including a
popup's first request; collection rechecks the Home route and selected `For
you` tab each cycle. New pages are fatal and closed, downloads are disabled,
CAPTCHA is never automated, and all loops have explicit count and time bounds.

Credentials use local environment injection and never appear in structured
logs, output allowlists, failure metadata, traces, or source. Screenshots are
disabled for authentication, challenge, account, session, and authorization
failures; eligible Home-feed screenshots additionally mask inputs, account UI,
dialogs, and the DM drawer. Chrome receives a fixed
operating-system-variable allowlist rather than inheriting `.env`, so X login
credentials and unrelated application secrets are absent from its process
environment. The profile, lock, output, and diagnostics
must resolve under the current account's local per-user data directory and
outside the repository; UNC/device paths are rejected. A stale lock is not
automatically removed, so a crash or unconfirmed shutdown fails closed until
the operator confirms Chrome is stopped and removes that one lock file.
Failure JSON records only an allowlisted page-title label and a bounded,
text-free structural HTML fragment. No title, DOM, or screenshot read occurs
after the page is observed outside the exact approved Home route.

### Retained OpenAI API research boundary

OpenAI is external to the Vercel process and database. Vercel keeps the API key
and passes only the bounded immutable job envelope to the Responses API.

The model receives no database credential, owner ID, claim capability, X bearer
token, or Supabase credential. It can use only the configured hosted web-search
tool and returns one strict research-result object.

It may:

- read at most three supplied candidates, each with one verified source post;
- research public web sources;
- refine or reject each supplied candidate.

It may not:

- list owner data;
- retrieve arbitrary runs or jobs;
- edit settings;
- write ideas;
- execute SQL;
- override the server-selected model, reasoning, search, or output limits.

### Optional MCP worker boundary

An authorized MCP client is also external to Vercel and Postgres. It receives
no database or provider credentials and can see only one bounded job returned
by `claim_research_job`. The three-tool interface allows one claim, one result
submission, or one safe failure report. It cannot list owner data, execute SQL,
renew a lease, edit settings, or write ideas directly.

### Database boundary

Supabase Postgres is the source of truth for:

- run state;
- X post snapshots and analyses;
- per-post filter, context, shortlist, and candidate-generation checkpoints;
- immutable research-job payloads;
- accepted research results;
- published ideas and their evidence;
- owner feedback.

Cloud tables retain immutable model inputs, submitted responses, validation
state and final reports. Primary reports link actual published ideas; historical
shadow reports remain comparison-only (section 30).

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

### Cloud comparison for an existing run

`POST /api/runs/[id]/cloud-comparison` requires the signed-in owner and verifies
the source run belongs to that owner. It starts or recovers only that run's
cloud comparison from retained, selected posts that Luna kept or resolved.
It returns `202` with comparison state, or `409` when no posts survived or the
run's saved provider is `chatgpt_cloud`. The primary guard runs before post
loading or dispatch, preventing a shadow row from occupying a primary run ID. It does
not restart X collection, Luna or the API run. The Source feed exposes this
action when eligible retained posts exist and no comparison has been recorded.

### API research continuation

This continuation is retained for runs whose saved provider is `api`. The
default cloud provider hands off after Luna and never enters this Sol API path.

There is no second cron and no hourly queue poll. After the daily or manual run
persists its research job, that same Vercel Workflow:

1. reloads and claims the prepared job;
2. makes one OpenAI background-response creation attempt for the claim;
3. waits with durable Workflow sleeps while polling the response;
4. persists a completed result or records a bounded retryable failure;
5. invokes final validation and publication after durable acceptance.

Only one research job exists per run. The optional MCP tools remain available
for a deliberate manual run or a future authorized scheduler, but normal
production execution does not wait for them.

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
- the legacy official-search ranking policy;
- fixed ranking policy version.

The search interval is a rolling 72 hours. Its bounds are stored before the X
request, so a workflow retry repeats the same window.

## 6. X collection

### Account-first discovery

The preferred-account lane searches AI-related posts from up to 50 configured
usernames. The application packs the complete list into query-length-safe
batches because a single 50-account query can exceed X's 512-character limit.

The topic lane uses the editable X query from settings.

Both generated queries exclude retweets and quote posts with X search
operators. The client also requests `referenced_tweets`; deterministic ranking
rejects `retweeted` and `quoted` references as a defense-in-depth check.

Preferred accounts are the primary discovery source, not a quality exception.
They may fill the complete 100-post collection budget, and their qualifying
posts are selected for Luna before topic posts. Every preferred-account post
must still meet the normal quality gates.

Topic discovery is a bounded fallback. When preferred accounts are configured,
it can use only raw-result capacity those account batches did not consume and
never more than 20 percent of the run limit. When no preferred accounts are
configured, the topic query may use the complete budget.

### X request behavior

The X client uses:

- `/2/tweets/search/recent`;
- relevancy ordering;
- a global maximum of 100 raw discovery records per run;
- query-length-safe preferred-account batches, each with at most two pages;
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
histories, or full quoted-post bodies. Official lookup/search normalization does
retain a bounded `source_context` object for URL entities, long-post metadata,
article metadata, and attached-media alt text when X returns those fields.

### Partial results

If page one has at least 50 usable posts and page two fails, the X helper may
return a marked partial result. A first-page failure or an undersized partial
result fails the step and uses workflow retry behavior.

Rate-limit metadata is reduced to safe status and timing information. Request
headers, bearer values, query strings, and arbitrary upstream response bodies
are not exposed in application errors.

### Optional For You discovery

The daily Workflow first reads the optional lane's activation values. Unless
`X_WEB_AUTOMATION_ENABLED` is exactly `true` and
`X_WEB_AUTOMATION_APPROVED_ACCOUNT` is a valid handle, it creates no webhook and
makes no AWS call. When enabled, it creates one one-use Workflow webhook,
starts pinned stopped instance `i-064c47109859601d1` in `us-east-2` with the AWS
SDK, and durably waits until EC2 is `running` and SSM reports the instance
`Online`.

The Workflow then sends one `AWS-RunShellScript` command. Its environment
carries the enable flag, approved account, and one-use HTTPS callback URL; the
callback URL is not placed in process arguments, returned from Workflow steps,
or logged. The worker reads the credentials-only X secret through its instance
role, runs the bounded collector, closes the browser and local output handles,
and POSTs this strict result shape:

```json
{
  "collectorRunId": "bounded-run-id",
  "candidates": [
    { "postId": "1234567890123456789", "feedPosition": 1 }
  ]
}
```

The payload is at most 16 KiB and contains at most 100 unique canonical status
IDs and unique positive feed positions. It contains no post text, media,
credential, profile state, or raw browser data. The one-use Workflow webhook
token authorizes this callback; there is no custom result API or second token.
On a bounded collector failure, the same webhook instead receives exactly
`{"status":"failed","errorCode":"SAFE_CODE","candidates":[]}`. The sender
maps unknown errors to `COLLECTOR_FAILED`, and the receiver accepts only the
collector's fixed safe-code allowlist.
Workflow polling treats EC2/SSM eventual consistency as pending and bounds the
SSM command to 20 minutes. The command schedules a 20-minute shutdown before
collection and shuts down immediately on command exit; the Workflow also
requests `StopInstances` in its `finally` path. A systemd timer independently
stops the machine 25 minutes after each boot if both application paths fail.

The command watchdog performs at most 119 status checks, with a 10-second
durable sleep before each check and a 30-second callback grace period after a
terminal command or exhausted polling. Callback arrival, or entry to cleanup,
sets its stop flag. Cleanup awaits the already-running watchdog sleep or status
step before requesting EC2 shutdown and disposing the webhook. It does not
cancel a durable sleep instantly: completion can wait for the remainder of the
current 10- or 30-second sleep, or for the in-flight status step. Once stopped,
the watchdog starts no more polls or grace sleeps, including when the 119th
status check rejects as a callback arrives. Cleanup errors do not discard an
already accepted callback; the existing SSM/systemd shutdown backstops remain.

The callback records are only discovery candidates. Before lookup,
`fetchAndRank` queries the owner's canonical `posts` rows and removes every ID
already stored through any source lane. It then hydrates only unseen IDs through
the existing official X lookup endpoint, requires the current run's exact
72-hour window, and rejects unavailable posts, replies, reposts, and quote
posts. The first 30 new originals in feed order are merged with
`source_channel = 'for_you'`. They are selected directly in feed order for the
commercial filter; reach and text length do not gate this primary path.
Existing followed/topic records win same-run cross-channel ID duplicates. The
preserved feed position becomes `run_posts.search_position`. When no verified
For You post is available and official API discovery is enabled, the existing
quality-ranked hybrid selector remains the fallback.

Official followed-account and topic recent search remains available as a
fallback. Exact `X_API_DISCOVERY_ENABLED=false`, used by the current For
You-only production configuration, replaces those discovery calls with an
empty baseline while retaining official lookup hydration for the browser IDs.
In this mode lookup, validation, or history-query failure fails the run; when
API discovery is enabled the For You lane remains fail-open. The owner
dashboard's existing authenticated run control is labeled **Collect For You &
run research** and invokes this same workflow, so there is no second queue,
route, or collection status model.

For supervised Windows development, `npm run x:for-you:check` validates the
same flag/account gate and safe configuration without acquiring the profile
lock, importing Playwright, or launching Chrome. `npm run x:for-you:collect`
runs only after the same gate and writes local diagnostic/discovery files; S3
is not a result transport in either environment.

Each enabled cloud attempt also stores a bounded connection observation in the
existing `runs.counts` JSONB object: `x_for_you_auth_state`,
`x_for_you_checked_at`, `x_for_you_success_at`, and
`x_for_you_error_code`. The dashboard derives its connection card from the
latest checked and latest healthy run. It deliberately shows last-observed
health rather than a predicted expiration date because X provides no reliable
future session-expiry value. Authentication, account-mismatch, verification,
and session-expiry codes map to `manual_login_required`; other failures remain
`unknown`. This optional status write cannot fail the research run.

## 7. Primary selection and fallback ranking

The primary path selects the first 30 verified For You originals in feed order.
The commercial model, not reach or post length, decides whether they continue.
Replies, reposts, quote posts, out-of-window posts, unavailable IDs, and posts
already present in the owner's canonical history are removed before selection.

If that set is empty and official recent search is enabled, the legacy
deterministic selector remains available. It requires 19,000 views, performs
text and author cleanup, and ranks age-adjusted view, comment, like, and save
percentiles at 65/20/10/5. This fallback does not override the For You feed.

The `/posts` page exposes collected records, source lanes, metrics, selection,
and analysis for owner inspection.

## 8. Luna filtering and context hydration

Luna first receives every selected post, up to 30, in one bounded structured
request. It must return each post exactly once as `keep`, `reject`, or
`needs_context`, with a reason and one commercial element: capability, problem,
request, result, spending, change, or none. Decisions and usage are persisted
on `run_posts` so a retry can recover the checkpoint.

Only `needs_context` posts enter a second Luna request. The request includes at
most five bounded sources derived from official X URL entities, long-post or
article metadata, and media alt text, and it may use low-context hosted web
search. A post continues only when context resolves to a supported commercial
element. Unavailable context removes that post without blocking kept siblings.

## 9. Sol shortlist and isolated candidate generation

The primary cloud coordinator applies the selection below using one shortlist
job and one independently claimed candidate job per selected post. Responses
are retained in `cloud_model_jobs`, with assessments in
`cloud_ideation_runs.shortlist_result`. The remaining paragraph describes the
retained API rollback implementation of the same model task.

If eight or fewer posts survive, all advance directly. If more than eight
survive, one Sol request assesses every survivor and selects at most eight.
Assessments and the chosen post-first units are stored before generation.

In the API rollback path, each shortlisted post receives its own Sol Responses request with only
that post, its resolved context summary, and the run's product preferences.
The model considers exactly three concepts and returns either one selected
candidate or `no_viable_idea`. Calls run independently; each result and its
usage are checkpointed before the workflow continues, so one failed call does
not contaminate or erase successful siblings.

The API rollback path uses `clusters` as the persistence envelope for these
single-post shortlist units. Its legacy Terra columns remain for compatibility;
Terra clustering is not called by the production daily workflow.

## 10. Candidate deduplication and research-job preparation

Primary cloud research uses the coordinator's saved candidate results and the
same exact/semantic duplicate rules to select at most three ideas. It creates
one immutable `cloud_model_jobs` research payload. The function and durable
handoff described below are retained for API rollback.

`prepareCandidateResearchJob()` reloads all generation checkpoints, orders
valid candidates by their generation score, and fingerprints each candidate's
payer, problem or opportunity, product, and pricing hypothesis. It removes:

- exact matches against prior published ideas;
- semantic matches against prior ideas;
- exact or semantic duplicates within the current candidate batch.

Trusted backend embeddings and the existing `0.90` semantic threshold remain
authoritative. The first three accepted candidates are placed in the immutable
research job; if none remain, the run completes as `no_ideas`.

### Bounded payload

The payload contains:

```text
schema_version
prompt_version
run_id
research_as_of
preferences
product_contract
candidates
```

Each candidate contains its candidate ID, one verified source post, the
available bounded context, captured metrics, and the independently selected
idea. The payload does not ask the research stage to invent unrelated concepts.

The payload omits:

- the complete candidate pool;
- unrelated owner data;
- complete historical reports;
- credentials;
- database internals;
- arbitrary SQL access.

Payload size is capped at one MiB.

### Durable handoff

`persist_research_job` creates at most one research job per run and changes the
run to:

```text
status = running
stage  = research_queued
```

The daily workflow keeps the job ID, reloads the durable row, and continues
through claim, API research, result persistence, and finalization. Durable
Workflow sleeps suspend execution while waiting; there is no polling cron.

## 11. Retained OpenAI API research worker

The explicit API rollback research stage is implemented by:

```text
src/workflows/openai-research-steps.js
src/lib/openai/research-response.js
```

The server constructs the request. A caller cannot override its fixed limits:

| Request property | Value |
| --- | --- |
| Model | `gpt-5.6-sol` |
| Reasoning effort | `high` |
| Execution | Responses API background mode with `store: true` |
| Tool | Hosted `web_search` with external web access |
| Search context | `medium` |
| Tool-call maximum | 20 |
| Structured output | Strict `research_result` JSON Schema |
| Output-token maximum | 32,000 |

The prompt contains the versioned research instructions and one immutable
envelope:

```text
job_id
prompt_version
accessed_at
payload
```

`accessed_at` is generated by the server and must be copied exactly to every
source. That timestamp is carried through every poll, and the response parser
rejects a source that changes it. The prompt builder rejects private key names
such as owner IDs, claim capabilities, API keys, authorization values, and
refresh tokens before a request is sent.

The model must use web search before returning any ideas and must open or cite
every source it submits. The response parser reads completed web-search calls,
opened pages, and URL citations from the response. It rejects ideas with no
completed web search and rejects a source URL that was neither opened nor
cited. Local result validation and finalizer checks remain authoritative.

### Response lifecycle

The Workflow claims the exact job it just prepared and verifies payload identity
and the canonical hash. If the claim call has an ambiguous transport outcome,
the Workflow reloads durable state instead of abandoning the run.

Responses creation has no documented idempotency guarantee. The creation step
therefore has both Workflow and OpenAI SDK retries set to zero and a 30-second
request timeout. `X-Client-Request-Id` identifies the job and attempt for
tracing; it is not treated as an idempotency key.

While the response is `queued` or `in_progress`, the Workflow sleeps for 10
seconds initially, increases the interval by about 1.5 times, and caps it at 30
seconds. Retrieval calls have bounded SDK and Workflow retries. After 30
minutes the Workflow attempts cancellation. The cancel response, or a fallback
retrieve after an ambiguous cancel, can still recover a response that completed
at the deadline instead of discarding it.

A retryable failure returns the job to `pending` for 15 minutes. The same daily
Workflow waits and may claim it again, up to the database maximum of three
attempts. Because response creation itself is not idempotent, those attempts may
produce up to three billable research responses. Completed structured output is
retained across an ambiguous submit or failure-report outcome so the state can
be reconciled without unnecessarily generating another result.

After durable acceptance, the server records research usage, attempts to delete
the stored OpenAI response, and invokes the unchanged finalizer as a later step
in the same daily Workflow. Stored responses for terminal failed attempts are
also deleted best-effort when their IDs are known; cleanup failure does not undo
durable application state.

### Research responsibilities

For each supplied candidate, the research stage may investigate:

- existing products and substitutes;
- public pricing;
- customer evidence;
- implementation feasibility;
- distribution channels;
- a concrete differentiation wedge;
- material risks;
- LATAM fit when relevant.

The result must distinguish:

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

The research stage may return zero to three refined candidates, at most one for
each supplied `candidate_id`, strongest first. Zero is a valid result and is
preferable to filler.

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

## 12. Optional MCP interface

The MCP path is not used by the production daily Workflow. It remains a narrow
manual or future-worker alternative over the same queue and result contract.

The repository contains its plugin source at:

```text
integrations/signal-foundry-research/
```

The package includes its manifest, production MCP connection, versioned worker
skill, and strict result-contract reference. A compatible authorized client can
claim one pending job, conduct public research, submit one result, or report one
bounded failure.

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

First checks for a durable result left in `submitted` or `validating` for at
least 30 minutes. The grace period avoids racing the production Workflow or a
healthy finalizer. If one exists, it restarts the idempotent finalizer and
returns `empty` so the worker does not claim a second unit of work. Otherwise it
atomically claims the oldest available job for the configured owner.

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
workflow. This separate dispatch is specific to the optional MCP path; the
retained API rollback path invokes finalization inside its daily Workflow.

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

## 13. Optional MCP OAuth and authorization

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

The research result root object has exactly:

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

The server never makes its own HTTP request to a model-submitted URL. In the
production path, the response adapter additionally requires each submitted URL
to appear as an opened page or output citation in the completed OpenAI response.
It then validates, stores, and later renders the link. This avoids turning URL
submission into a server-side request-forgery path while still requiring
evidence that the hosted research tool observed the source.

### Candidate grounding

Each refined candidate includes the supplied `candidate_id`, the full product
contract, risks, assumptions, an X-only evidence score, the exact source post,
external research source IDs, and a claim map.

The server requires:

- one supplied candidate ID, used at most once;
- exactly the one X post ID attached to that candidate;
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

## 15. Final validation and publication

The primary cloud coordinator validates its saved research response, candidate
membership, evidence/product rules and duplicates. It prepares publication rows
and calls `publish_primary_cloud_ideas`. This service-only transaction bridges
the validated cloud research into the existing publication boundary, saves the
normal idea/evidence tables, completes the cloud and source runs, and records
actual `idea_ids` with `published: true` only when ideas were saved.
`finish_primary_cloud_ideation` atomically closes empty or failed primary runs.
The worker itself can only claim, submit or report failure; it cannot publish.
The publication bridge inserts the accepted cloud research into `research_jobs`
directly as `validating` within its transaction and calls the existing
`publish_run_researched_ideas` function. It never exposes that row as a pending
API-claimable job or makes a Sol API request. A database trigger synchronizes
primary cloud progress into the source run; terminal functions close both.

The retained API and optional MCP paths use `finalizeResearchResult` after
the result has been stored through `submit_research_result`:

- the API rollback path persists the result and calls the finalizer as a
  later step in the same daily Workflow;
- the optional MCP path persists the result and then starts `finalizeResearch`
  as a separate Vercel Workflow.

Durable acceptance always precedes finalization. Replaying the identical result
is idempotent; a different result cannot replace an accepted result.

That retained finalizer:

1. Atomically moves the job from `submitted` to `validating`.
2. Reloads the parent run, immutable payload, and submitted result.
3. Recomputes both canonical SHA-256 hashes.
4. Checks schema and prompt versions.
5. Reloads only the X posts named by the payload.
6. Validates candidate ID and exact source-post membership.
7. Rechecks scores, product rules, and claim maps.
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

Historical matches in the job help the research model avoid repetition, but trusted
server-side fingerprinting and vector search remain authoritative.

### Zero-idea completion

A research result may contain no candidates, or all candidates may fail grounding or
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
- up to 50 preferred X usernames;
- candidate and model-input limits;
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
shortlisting
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
time, availability, refresh timestamps, and bounded official `source_context`
for URLs, long posts, articles, and media alt text.

### `run_posts`

Per-run snapshots containing captured public metrics, discovery lane,
selection, Luna filter decision/reason/commercial element, hydrated context,
and Sol shortlist assessment.

### `clusters`

Run-scoped persistence envelopes. New production rows represent one shortlisted
source post and store its independent `candidate_result` and `candidate_usage`.
Legacy Terra fields and functions remain for historical compatibility.

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

### `cloud_ideation_runs` and `cloud_model_jobs`

`cloud_ideation_runs.id` is the source run ID, linked through an owner-aware
foreign key. Each row has immutable `mode` (`primary` or `shadow`), input and deadline,
its own status/phase, shortlist result, trusted selection/report checkpoint,
coordinator Workflow ID and lifecycle timestamps.
Primary completion records `published` and actual `idea_ids`; shadow results
cannot publish. New source runs snapshot `ideation_provider = 'chatgpt_cloud'`;
existing runs retain their provider and modes.

`cloud_model_jobs` holds independently claimed `shortlist`, `candidate` and
`research` work, with a unique `(cloud_run_id, job_key)`. It retains the source
post ID for candidate work, immutable payload/requested model settings, claim
capability and lease, attempt count, submitted model result, worker-reported
runtime metadata, errors and timestamps. The model result becomes immutable
once submitted; `submitted` is awaiting application validation and `completed`
means the response passed its contract. The coordinator alone advances phases
and applies the later research/evidence gates. Inputs are at most one MiB;
individual model results are at most 256 KiB. These tables have owner browser
SELECT policies and service-role mutations; ordinary authenticated sessions
cannot call the queue's mutation RPCs. See section 30 for the administrative
Supabase plugin boundary.

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
  -> running / shortlisting
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

The state machine below describes the retained API/MCP queue. Primary cloud
model jobs use `pending -> claimed -> submitted -> completed`, or `failed`;
validation is trusted coordinator work. Only accepted primary research enters
the existing publication boundary through the atomic bridge.

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

Primary cloud claims last at most 30 minutes, within the immutable 24-hour run
deadline, with at most three claims and no renewal. The remaining lease rules
describe the retained API/MCP queue.

API/MCP claims last at most two hours. An expired claim can be reclaimed with a new
claim ID while fewer than three attempts have been used.

No lease-renewal operation is exposed. The API response deadline is 30
minutes, leaving room inside the two-hour lease for result persistence and
state recovery. An optional MCP client must also finish within the lease.

### Workflow retries

Cloud-primary runs persist each model response and coordinator checkpoint.
The daily Workflow dispatches once recoverably after Luna and returns; the
cloud coordinator advances primary run progress and waits durably for jobs.
Its failure path closes both cloud and source runs instead of invoking Sol API
fallback. The following response-specific retries apply to API rollback.

Fetch, Luna filtering/context, Sol shortlisting/generation, research-job
preparation, response retrieval, result persistence, final validation, and
failure recording use bounded Workflow step retries. The OpenAI response-start
step deliberately has no Workflow retry; it
also has no SDK retry. Its `X-Client-Request-Id` value is for tracing, not
idempotency.

API research failures use the existing database attempt counter. A retryable
failure is available again after 15 minutes, and the job becomes terminal after
the third failed or expired claim. The state-reconciliation loop is capped at
12 cycles, four times the maximum claim count.

Committed checkpoints make retries idempotent:

- selected posts are recovered from `run_posts`;
- Luna filter/context and Sol shortlist assessments are recovered from
  `run_posts`;
- shortlist units and independently saved candidate results are recovered from
  `clusters`;
- the existing research job is recovered from `research_jobs`;
- an active claim is revisited after its lease expires;
- a completed generated result is retained across ambiguous persistence state;
- an already completed finalizer returns existing idea IDs;
- an identical result submission is accepted as already persisted;
- the API Workflow directly resumes a submitted, validating, or completed job;
- an optional MCP claim call redrives a submitted or validating finalizer only
  after a 30-minute grace period, before claiming new work.

A failed job with no accepted result may be reset by same-day run recovery. An
immutable result that already failed final validation is not reopened; recovery
fails safely instead of creating an unowned `submitted` state.

### Stale runs

Starting a new run checks existing owner runs.

An active primary cloud run remains active until its saved cloud deadline;
the shorter legacy thresholds below do not terminate a healthy hourly queue.
Expiry is closed through `finish_primary_cloud_ideation` so both runs agree.

Local pipeline stages are stale after six hours. External-research stages are
stale after 12 hours. A stale research run is closed through
`fail_research_job` so the job and run do not disagree.

There is no independent queue-monitoring cron. Stale-run cleanup happens when a
new run is requested, while expired research claims are handled by the next
claim operation. Cloud claims are handled by the hourly child; legacy API
claims occur inside the daily Workflow, and optional MCP invocations retain
the same legacy queue semantics.

## 18. Evidence retention

Raw X post text, official `source_context`, and legacy exact Luna excerpts are
retained for 30 days.
Primary publication also retains an immutable `research_jobs` payload/result
copy under the existing research-job policy. The opportunistic 48-hour purge of
cloud run inputs and cloud job payloads does not erase that bridge copy.

At the start of a fetch step, the application:

- removes expired raw text;
- clears expired source context and exact excerpts;
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
includes waiting research, active research and final validation, driven by the
source run state maintained by the trusted coordinator. The generated-ideas
counter uses cloud generation counts with legacy cluster-count fallback.

### `/posts`

Collected-post inspection, including X link, text while retained, source lane,
captured engagement, ranking, and analysis state.

Historical API-shortlisted posts have an expandable Model decisions panel containing the
saved Sol candidate or no-viable-idea result, decision reason, three concepts
and critiques, and selected idea details. It also shows the shortlist
assessment and available Luna context/filter decisions. Automatic shortlist
advancement is labeled explicitly without presenting its placeholder score
as a model assessment. An API shortlisted posts filter limits the feed to these
posts. Candidate results are read by owner, run, and source post through the
owner's RLS-protected Supabase client; a candidate-query failure leaves the
source feed available and marks the panel unavailable. Missing results are
shown as pending only while the run can still generate them, otherwise as no
saved response. The panel does not infer research or publication decisions.

The cloud panel loads both primary and historical shadow modes and shows run
and job progress, requested model
and reasoning, and an explicitly unverified actual model. Cloud shortlist
assessments and independent generation appear beside historical API panels, including
posts selected only by cloud and posts cloud held or rejected. The Cloud
shortlisted posts filter uses that independent selection. Submitted responses
are labeled as awaiting validation; final comparison reports expose the
research summary, ideas that passed checks and worker-reported source links.
Primary results show cloud research and links to actual published idea IDs;
historical shadow results remain explicitly comparison-only. Primary run
snapshots hide the separate comparison-start action and API-only decision
panels, while keeping shared Luna context visible. Owner/run-scoped queries
select explicit display fields and do not load model payloads or runtime
metadata into the page. Eligible older runs offer Run cloud comparison.

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
| X recent-search maximum | 100 raw candidate records |
| Preferred X usernames | 50 maximum |
| Topic fallback with preferred accounts | At most 20% of unused capacity |
| Verified For You input | First 30 new originals in feed order |
| Commercial filter | Luna, up to 30 posts |
| Context hydration | Luna, only `needs_context` posts; at most 5 context sources each |
| Maximum shortlisted posts | 8 |
| Candidate generation | One isolated cloud child per shortlisted post; exactly 3 concepts considered |
| Candidate result per post | 0 or 1 |
| Candidates sent to research | At most 3 after exact and semantic deduplication |
| Official-search fallback minimum views | 19,000 |
| Official-search fallback posts per author | 3 maximum |
| Official-search fallback ranking weights | views 65%, comments 20%, likes 10%, saves 5% |
| Research schema version | 2 |
| Research prompt version | `candidate_research_v2` |
| Requested cloud model and reasoning | `gpt-5.6-sol`, `high`; actual runtime unverified |
| Cloud worker cadence | Hourly; one new isolated child and one job per execution |
| Cloud run deadline / coordinator poll | 24 hours / one-minute durable sleeps, up to 1,440 checks |
| Cloud claim lease | 30 minutes, capped by the run deadline |
| Cloud input / result JSON | At most 1 MiB / 256 KiB |
| API rollback hosted web-search context | `medium` |
| API rollback maximum research tool calls | 20 |
| API rollback maximum research output | 32,000 tokens |
| API rollback background-response deadline | 30 minutes |
| API rollback response polling interval | 10 seconds, increasing to 30 seconds |
| API/MCP job or result JSON | At most 1 MiB each |
| MCP POST limit | 1.25 MB |
| API/MCP research claim lease | 2 hours |
| Maximum claim attempts | 3 |
| API/MCP failure retry delay | 15 minutes |
| Maximum external sources | 40 |
| External sources per idea | 1 to 10 |
| Maximum researched candidates | 3 |
| Minimum publishable evidence | 65/100 |
| Published ideas | 0 to 3 |
| MVP build window | 2 to 6 weeks |
| Semantic duplicate threshold | 0.90 |
| Raw X text retention | 30 days |
| Optional For You callback payload | 16 KiB maximum; at most 100 unique IDs and feed positions |
| Optional For You post limit | Configured value, hard-capped at 100 |
| Optional For You new original posts retained | 30 per run, after historical deduplication and post-type filtering |
| Optional For You maximum scrolls | 60 by default, hard-capped at 200 |
| Optional For You no-growth stop | 5 cycles by default |
| Optional For You runtime stop | 5 minutes by default, hard-capped at 15 minutes |
| Optional For You load wait | 2.5 seconds by default |
| Optional For You article candidates | 40 per collection cycle |
| Optional For You timeline DOM watchdog | 5 seconds per bounded call |
| Optional For You safe partial floor | 50 unique posts before later selector drift can stop successfully |
| Optional For You browser operation deadline | 30 seconds for launch, actions, and navigation |
| Optional For You browser-close confirmation | 15-second hard timeout; failure retains the profile lock |
| Optional For You AWS secret envelope | 64 KiB maximum, retrieved through instance-role AWS CLI credentials |
| Optional For You AWS secret-read deadline | 30 seconds |
| Optional For You SSM command timeout | 20 minutes |
| Optional For You command shutdown | Scheduled at 20 minutes and immediate on command exit |
| Optional For You per-boot failsafe | systemd stops the instance after 25 minutes |
| Optional For You deployment storage | Private, versioned S3 `deployment/` prefix only |
| Optional For You manual desktop | 15 minutes; localhost-only noVNC through SSM |

## 22. Required operator setup

Cloud-primary production needs the application deployment, server-only provider
credentials, database schema, one daily Vercel cron, and the active hourly
ChatGPT Work schedule with its Supabase connection and saved isolated-child
prompt. The private Signal Foundry MCP connector is not required.

The repository implements this path. A deployment is operational only after it
has been rebuilt from this revision and the end-to-end check below succeeds.

### 1. Apply database migrations

Apply every file in `supabase/migrations` in filename order, including:

```text
003_scheduled_research_worker.sql
004_account_first_x_collection.sql
005_for_you_source_channel.sql
006_post_first_ideation.sql
20260904235628_cloud_ideation_shadow_queue.sql
20260905001502_cloud_ideation_hourly_deadline.sql
20260905014539_cloud_ideation_primary_publication.sql
```

Together these create the queue, external evidence tables, research RPCs, stage
updates, RLS policies, and access-token hook function; clamp X collection to 100
candidates; allow 50 preferred usernames; and permit the additive `for_you`
source channel. Migration 006 adds official source context, post-first filter,
context and shortlist checkpoints, isolated candidate results, and the v2
candidate research envelope while preserving legacy rows.
The timestamped cloud migration adds the isolated comparison tables, leased
worker RPCs, immutable input/result triggers, owner browser read policies and
terminal-input retention function.
The hourly-deadline migration gives new comparisons a 24-hour window without
changing deadlines already saved on existing comparisons.
The primary-publication migration allows immutable primary mode, synchronizes
source-run progress, and adds service-only atomic finish/publication functions.

### 2. Configure server-only production values

Set every required value in section 23 in the Vercel project. In particular,
the OpenAI key must remain available for shared Luna filtering/context and
embeddings. Retained API rollback can also create/retrieve/cancel Sol responses;
new cloud-provider runs do not call those Sol adapters. The X bearer token,
Supabase secret, and cron secret remain server-only.

### 3. Deploy and confirm the single cron

Deploy the application and confirm `vercel.json` contains only:

```text
GET /api/cron/daily at 13:00 UTC
```

No research polling cron is added. Cloud-primary model work requires the hourly
ChatGPT Work worker below; it does not alter this daily Vercel cron.

### 4. Perform one production end-to-end check

1. Start a manual run.
2. Confirm `settings_snapshot.ideation_provider = chatgpt_cloud`, shared Luna
   completes, and the daily Workflow dispatches `mode = primary` without any
   Sol Responses API call or automatic fallback.
3. Confirm separate cloud shortlist/candidate/research jobs move through claims,
   submission and trusted validation under the cloud coordinator.
4. Confirm the cloud and source run agree on `completed`, `no_ideas` or failure,
   and saved idea IDs match the actual published idea rows.
5. Confirm usage separates server-side Luna/embeddings from cloud jobs whose
   runtime model and token usage are unverified/unavailable.
6. If ideas publish, verify both X and external evidence on an idea page.

### Cloud worker setup and verification status

Apply the cloud migration and deploy the coordinator, queue integration and
owner route. Configure a standalone **ChatGPT Work cloud schedule** with the
complete [`worker-prompt.md`](./integrations/chatgpt-cloud-ideation/worker-prompt.md),
the installed Supabase plugin, GPT-5.6 Sol High requested, and an hourly
interval. Each scheduled parent must spawn one new worker child using
`fork_turns: "none"`, the explicit Sol model and High reasoning. Only that child
claims and processes one job. The saved prompt returns job ID/status plus a
controlled diagnostic on failure. This revision passed all 15 non-operational
fixture scenarios and was saved and verified after a fresh browser reload on
September 5, 2026. The parent never reads payloads or uses SQL; it uses no local
project or local files.
Eligible paid ChatGPT schedules support recurrence up to once per hour; the
five-minute configuration was not created. See the
[official task frequency limits](https://help.openai.com/en/articles/10291617-tasks-in-chatgpt).
A complete batch can require ten separate hourly executions: one shortlist,
up to eight candidate jobs and one research job. The coordinator's 24-hour
deadline allows for scheduling delay and some retries.

The hourly [Signal Foundry cloud worker](https://chatgpt.com/scheduled/6a9b6225d5048191903c994bc0b91d55)
is active, and its first automatic execution claimed and submitted a real
shortlist that the server validated. All eight candidate jobs have completed
server validation, and the coordinator selected three for research. The exact
parent/child prompt is saved and persisted after reloading the schedule UI.
Research launched through Run now completed in the isolated child; the server
validated one shadow idea and eight sources. All ten queue jobs completed,
and the Source feed displayed the final comparison correctly. This verifies
the automatic shortlist, manually accelerated candidates and saved-schedule
research path, not a batch of ten elapsed hourly executions. Section 30 records
the deployment and test evidence. The child boundary uses explicit
`fork_turns: "none"` rather than relying on the scheduled parent having fresh
context: Open chat still points to its setup conversation, and the UI does not
expose complete background context. Model runtime identity remains unverified,
and research source access remains worker-reported. Comparison-only storage
and unchanged API publication were verified. The instructions and connection
requirements are in the
[`cloud integration README`](./integrations/chatgpt-cloud-ideation/README.md).
That completed test was a shadow comparison before the primary cutover. The
cloud-primary cutover is now deployed for new production runs, and the exact
updated worker prompt was saved and verified after reloading the active hourly
schedule. The primary migration is applied and its rolled-back database
contract test passed. A newly created manual run has the verified cloud
provider snapshot; the first complete primary batch and live publication
remain pending under the hourly schedule, separate from the historical shadow test.

For explicit rollback, change `PIPELINE.ideationProvider` in
`src/lib/config.js` to `api` and deploy. It affects newly created runs only;
existing cloud runs retain their saved provider/mode and should finish or fail
through their coordinator. No failure path silently enables Sol API calls.

### Optional MCP setup and current status

The OAuth-protected MCP surface remains deployed for manual use or a future
eligible scheduler. It is separate from the production cloud worker.

Its required operator configuration is:

1. Use Supabase asymmetric `RS256` or `ES256` signing; the verifier rejects
   shared `HS256` secrets.
2. Enable the Supabase OAuth 2.1 server, dynamic registration when required,
   explicit owner consent, and the `/oauth/consent` authorization path.
3. Select `public.signal_foundry_access_token_hook` as the Custom Access Token
   Hook so OAuth JWTs use the exact production `/mcp` URL as audience.
4. Install `integrations/signal-foundry-research`, connect its
   `signal-foundry` MCP server, and approve only `openid email offline_access`.
5. Verify the discovery route is public, the MCP route rejects unauthenticated
   requests, and all three tools work without copying a secret into a prompt.

The optional path has already been transport-tested: Codex CLI OAuth succeeded,
and a controlled local Codex run claimed a job, submitted a result, and reached
`research_jobs.status = completed` and `runs.status = no_ideas`. That check used
retained legacy evidence only, and its synthetic rows were removed afterward.

An earlier unattended task on the personal Pro account did not expose the
private skill or MCP tools. Its nonfunctional hourly heartbeat was deleted.
That observation concerns the private Signal Foundry MCP path; production
remained on the API-backed daily Workflow at that historical checkpoint.

On September 4, 2026, a one-time cloud ChatGPT Work schedule using the installed
Supabase plugin completed without an approval prompt. An independent database
read confirmed a saved `candidate` decision and three-sentence rationale at
`2026-09-04T23:31:10.729213Z`, with the correct nonce read from the fixture and
absent from the scheduled prompt. The fixture was a terminal `runs` row that
never entered the research queue; the test created zero research jobs and zero
ideas. This verifies scheduled database reading, model evaluation, and writing
through the installed Supabase plugin. The custom Signal Foundry MCP tools were
absent and remain unverified in this cloud scheduling path.
The disposable fixture was deleted afterward, and a separate query confirmed
zero remaining test runs, jobs, or ideas. The one-time schedule is completed
with no recurrence; its history remains available for review.

The evidence is in [the Work test chat](https://chatgpt.com/c/6a9b52db-7c70-83e8-8bf0-b5aa32a51964),
schedule ID `6a9b53a3e2ec819195b642f0f3c8d347`. The initiating Work UI selected
GPT-5.6 Sol Medium and the saved prompt requested it, but the scheduled runtime
returned no independent model metadata, so its exact model was not verified.

### Optional For You setup

This lane is not required for the followed-account/topic production path. X's
published automation rules prohibit non-API website scripting and warn of
account suspension. Before enabling it, the operator must obtain explicit
written permission covering the exact X account and read-only collection.

After permission exists, authorization is exactly these two values:

```text
X_WEB_AUTOMATION_ENABLED=true
X_WEB_AUTOMATION_APPROVED_ACCOUNT=@approved_handle
```

For the current For You-only production mode, also set:

```text
X_API_DISCOVERY_ENABLED=false
```

This is a reversible discovery switch, not part of the browser authorization
gate. It skips followed-account and topic recent search but retains the
server-only X bearer token and official lookup used to validate For You IDs.

The approved handle must match the credentials-only secret's
`X_LOGIN_USERNAME` case-insensitively. There are no signatures, public keys,
approval files, approval IDs, expiry payloads, or daily approval ledger. The
AWS target, OIDC role, instance role, secret resource, and worker machine are
pinned infrastructure provisioned separately; none adds an operator
authorization value. The gate is an invocation safety interlock, not a sandbox
against hostile code already executing as a trusted application or
operating-system principal.

The intended runtime is one x86-64 Linux EC2 instance with an encrypted EBS
volume, installed Chrome Stable, Node.js 20.12 or newer, Xvfb, AWS CLI v2, and
the SSM agent. It has no inbound listener. Systems Manager Run Command invokes
`/usr/local/bin/signal-foundry-x-for-you`; the wrapper switches to the dedicated
unprivileged `signal-foundry-x` user and runs headed Chrome in a private virtual
display. The Vercel Workflow starts the instance only for an enabled collection
and always attempts a pinned-target stop afterward. The SSM command schedules a
20-minute instance shutdown and shuts down immediately when the command exits.
An enabled systemd timer independently shuts down the machine 25 minutes after
every boot, so cleanup does not depend on either application path alone. Normal
EC2 stop/start preserves the EBS-backed Chrome profile and profile lock. No
laptop or interactive desktop is involved.

The EC2 instance role can read exactly one Secrets Manager value and read the
collector's immutable `deployment/` objects from the private bucket. When
configured, the accepted secret envelope contains only `X_LOGIN_EMAIL`,
`X_LOGIN_USERNAME`, and `X_LOGIN_PASSWORD`. S3 is deployment-artifact storage
only: the role has no result-prefix write permission and the collector sends
results directly to the one-use Workflow webhook. The AWS entry point holds
credentials in process memory and deliberately forces unattended challenge
mode, so verification and CAPTCHA states abort rather than wait or bypass.

CloudFormation owns the secret resource and IAM reference but omits
`SecretString`; credential values are managed out of band and cannot be reset by
an unrelated stack update.

[`deploy/aws/x-for-you/vercel-oidc-role.yaml`](./deploy/aws/x-for-you/vercel-oidc-role.yaml)
creates the Vercel OIDC provider and pinned caller role
`signal-foundry-vercel-x-for-you`. Its trust policy accepts only issuer
`https://oidc.vercel.com/admins-projects-d500137d`, audience
`https://vercel.com/admins-projects-d500137d`, and subject
`owner:admins-projects-d500137d:project:admins-projects-d500137d:environment:production`.
Preview, development, and other projects cannot assume it.

The role needs only:

- `ec2:StartInstances` and `ec2:StopInstances` on the exact worker instance;
- region-bounded `ec2:DescribeInstances`;
- `ssm:SendCommand` on the exact instance and the AWS-managed
  `AWS-RunShellScript` document; and
- region-bounded `ssm:GetCommandInvocation` and
  `ssm:DescribeInstanceInformation`.

It grants no Secrets Manager, S3, or X access. Server code pins `us-east-2`,
instance `i-064c47109859601d1`, and the role ARN, then uses
`@vercel/oidc-aws-credentials-provider` to obtain short-lived credentials for
the AWS SDK. Vercel needs no AWS target variables or static AWS access-key
environment values. The SSM command supplies the flag, approved handle, and
one-use callback URL for that invocation; none is persisted as an enabled
authorization value on EC2.

`deploy/aws/x-for-you/cloudformation.yaml` is the repeatable resource template.
`deploy/aws/x-for-you/bootstrap-disabled-worker.sh` configures an extracted
bundle as the unprivileged worker without an enabled flag or approved handle.
This disabled bootstrap is safe before approval: the Vercel lane makes no AWS
call while disabled, and direct worker verification fails at the feature flag
before a secret read, Playwright import, browser launch, or X request.

As of 2026-09-01, CloudFormation stack `signal-foundry-x-for-you` is
`UPDATE_COMPLETE` in `us-east-2`. It owns stopped instance
`i-064c47109859601d1`, private versioned bucket
`signal-foundry-x-for-you-563561751769-us-east-2`, credentials-secret resource
`signal-foundry/x-for-you`, and no-ingress security group
`sg-056fcfcb84a8247e8` with TCP 443-only egress. The encrypted 20 GiB gp3 root
volume is retained for the worker runtime. Secret-free source bundles are
retained as encrypted, versioned objects under the bucket's `deployment/`
prefix. SSM installation and disabled-configuration verification succeeded for
bundle SHA-256
`bf4fc358b49adff368cc32467aebd82d8e019b5485674ef061e4442ad279f7e6`
(S3 version `6FBPkFWWyjfX4mgXQfOp.N_TaV0I6SN5`). The instance was then confirmed
`stopped`. Its persistent configuration contains no enabled authorization
values, the systemd boot lease is active, the disabled check returned
`FEATURE_DISABLED`, and no Chrome process or X request was part of
provisioning. The dedicated secret now contains exactly `X_LOGIN_EMAIL`,
`X_LOGIN_USERNAME`, and `X_LOGIN_PASSWORD`; the valid bare username from the
local environment was stored in canonical `@handle` form, and no value was
printed. The approved no-replacement stack update removed the obsolete result
prefix `s3:PutObject` permission and removed CloudFormation management of
`SecretString`. The live instance role is deployment-read-only in S3.

CloudFormation stack `signal-foundry-vercel-x-for-you-oidc` is
`CREATE_COMPLETE` in `us-east-2`. It owns the exact Vercel OIDC provider and
caller role described above. The role is used only through short-lived Vercel
OIDC sessions.

`scripts/setup-x-for-you-aws.sh` provisions the worker account, runtime,
root-owned configuration, and fixed launcher. It does not activate collection.
After approval, the only authorization change is setting the Vercel flag to
exactly `true` and its approved-account value to the approved handle. The
existing daily/manual Workflow then performs the start, readiness wait, single
SSM command, one-use callback, official lookup hydration, merge, and layered
command/Workflow/systemd stop sequence; it does not require a second schedule
or operator session.

If the dashboard reports `Manual login required`, the operator waits until no
research run is active and runs `npm run x:for-you:login` from the configured
Windows laptop. The parameterless helper targets only the pinned region and
instance. It downloads and verifies the official Session Manager plugin in a
restricted temporary directory, starts the stopped worker, temporarily installs
only missing `x11vnc`, `novnc`, and `websockify` packages, and opens the
persistent EC2 Chrome profile through a localhost-only SSM tunnel. Xvfb disables
TCP, both VNC listeners bind to `127.0.0.1`, and no ingress rule is added. The
operator completes X sign-in and clicks OK after Home is visible. Cleanup stops
the transient units, releases the shared profile lock, purges only the VNC
package names installed by that session without `autoremove`, removes local
temporary files, and stops EC2. The browser session is capped at 15 minutes;
the guest shutdown lease and per-boot systemd timer remain backstops. The helper
never reads the X secret or automates the login form. The next enabled cloud run
records the healthy observation shown by the dashboard.

The optional Windows development path keeps the runtime and persistent profile
outside the checkout. Its runtime must be under `LOCALAPPDATA` and must first be provisioned with
`scripts/setup-x-for-you-runtime.ps1`, which replaces inherited access with
inheritable full-control entries for the current account, Local System, and
local administrators. Local commands remain `npm run x:for-you:check` and
`npm run x:for-you:collect`.

Non-empty `DEBUG`, `DEBUG_FILE`, Playwright `PW*` (except `PWD`),
`PLAYWRIGHT_*`, and npm `pwdebug` controls are rejected before the Playwright
module import because they can bypass default timeouts or log filled values.
After an unconfirmed shutdown, the operator must confirm no Chrome process uses
the dedicated user-data directory before deleting only
`locks/chrome-profile.lock`.

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
The OpenAI key remains required for Luna and embeddings after the Sol cutover.
The ideation provider is a repository configuration value snapshotted per run,
not a browser setting or a new environment secret.

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

### Optional For You values

The Vercel Workflow reads these optional-lane values. With the flag absent or
anything other than exact lowercase `true`, it creates no callback and makes no
AWS call for this lane:

```text
X_WEB_AUTOMATION_ENABLED
X_WEB_AUTOMATION_APPROVED_ACCOUNT
```

The independent server-only discovery switch defaults to enabled. Exact
lowercase `false` disables followed-account and topic recent search but not the
official lookup hydration used by the For You lane:

```text
X_API_DISCOVERY_ENABLED
```

There are no Vercel environment values for AWS region, instance ID, role ARN,
access-key ID, secret access key, or session token. The pinned server code and
production-only Vercel OIDC trust described in section 22 supply that boundary.
After infrastructure is provisioned, the two values above are the complete
operator authorization surface for this lane.

For local Windows development, `X_LOGIN_EMAIL` and `X_LOGIN_PASSWORD` may be
omitted when the compatibility aliases `x_email` and `x_password` are present.
`X_LOGIN_USERNAME` is mandatory and must match
`X_WEB_AUTOMATION_APPROVED_ACCOUNT` case-insensitively.

Existing process variables take precedence over `.env.local`, which takes
precedence over `.env`. Dotenv path values must already be fully expanded.

```text
X_WEB_AUTOMATION_ENABLED
X_WEB_AUTOMATION_APPROVED_ACCOUNT
X_LOGIN_EMAIL
X_LOGIN_USERNAME
X_LOGIN_PASSWORD
X_WEB_AUTOMATION_POST_LIMIT
X_WEB_AUTOMATION_RUNTIME_DIR
```

The AWS entry point does not load dotenv files. Its root-owned configuration
also supplies these non-secret values:

```text
AWS_REGION
X_FOR_YOU_REPOSITORY_DIR
X_FOR_YOU_AWS_SECRET_ID
```

The referenced Secrets Manager JSON supplies `X_LOGIN_EMAIL`,
`X_LOGIN_USERNAME`, and `X_LOGIN_PASSWORD` only. The one-use invocation also
supplies `X_FOR_YOU_RESULT_URL`; it is validated as a canonical public HTTPS
Workflow webhook URL, consumed by the AWS runner, and never placed in command
arguments or logs. The instance uses IAM role credentials; static AWS access
keys are neither required nor passed to the AWS CLI subprocess.

Optional bounded overrides are:

```text
X_WEB_AUTOMATION_MAX_SCROLLS
X_WEB_AUTOMATION_MAX_NO_GROWTH_CYCLES
X_WEB_AUTOMATION_MAX_RUNTIME_MS
X_WEB_AUTOMATION_LOAD_WAIT_MS
X_WEB_AUTOMATION_STATE_TIMEOUT_MS
X_WEB_AUTOMATION_INTERACTIVE_CHALLENGES
X_WEB_AUTOMATION_MANUAL_ACTION_TIMEOUT_MS
X_WEB_AUTOMATION_INCLUDE_RAW_TEXT
X_WEB_AUTOMATION_SAVE_FAILURE_SCREENSHOT
```

Secrets must never be copied into browser code, source control, logs, X
queries, research payloads, schedule prompts, or plugin skill text.

## 24. Local development and verification

On September 5, 2026, the watchdog fix passed all 352 automated tests and the
production build. Its 13 new timer regressions cover callback arrival before or
during a durable sleep/status check, terminal-command grace, bounded timeout,
the final rejected status check, parsing failures and cleanup failures. They
assert no watchdog sleep or status check survives into EC2 shutdown/webhook
disposal, while preserving accepted callback results. Timer-fix commit
`42fa8cf` was deployed as Vercel deployment `EQigoAfv8zd8xtwM4QsNGriPETFK`.
These code/build checks do not test the separate scheduled-worker diagnostic
prompt.

Use Node.js 20.12 or newer.

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

Local development covers application logic, schemas, workflows, OpenAI response
parsing, optional MCP request handling, and UI. Automated tests use controlled
responses for the API research boundary. A true hosted-web-search and background
response check requires a deployment with server-side OpenAI access. Optional
MCP OAuth checks likewise require a public HTTPS resource.

The For You suites use synthetic values, literal bounded HTML fixtures, and
deterministic fake browser, AWS SDK, webhook, and AWS subprocess objects.
Fixtures cover
logged-out, username, password, challenge, authenticated For You, real
system-error, misleading timeline-copy, and deceptive-account surfaces. The
normal test command does not contact EC2, SSM, Secrets Manager, S3, or X, import
Playwright, or launch Chrome. A live locator calibration or collection is an
operator action available only after the flag/account gate is deliberately
enabled following approval.

## 25. Operational interpretation

Useful run counters include:

- X returned and raw-returned records;
- followed, topic, and optional For You lane totals, including requested,
  hydrated, rejected, and merged For You candidates;
- the latest For You connection state, check time, successful verification
  time, and allowlisted error code in the existing run `counts` object;
- posts selected for Luna by lane;
- Luna keep, reject, and needs-context decisions;
- context requests, resolutions, and unavailable results;
- shortlist survivors and shortlisted posts;
- generation attempts, candidates, no-viable results, and failed calls;
- research jobs queued;
- candidates admitted to research and pre-research duplicates removed;
- ideas saved;
- partial X retrieval.

Primary run usage separates Luna filtering/context and embedding API calls from
`chatgpt_cloud` job metadata: provider, requested model/reasoning and saved job
status. Cloud token usage is unavailable and model verification remains false;
no API usage or response IDs are fabricated for cloud execution.

Retained API-run usage records cover Luna filtering/context, Sol shortlisting/generation and
accepted research, plus embedding calls. The
top-level `research` usage entry records model and response ID, input, cached,
output, reasoning, and total tokens, plus completed web-search calls for the
accepted result. Failed, invalid, cancelled, or abandoned response attempts may
incur provider usage that is not written to the run row. These are OpenAI
Platform operations billed to the configured API account; they do not consume a
ChatGPT/Codex subscription allowance.

An idea remains a researched hypothesis, not a validated business. Direct X
evidence demonstrates that a discussion or problem appeared in the sampled
window. External links support specific market facts. Assumptions and the
seven-day validation plan identify what still needs real-world testing.

## 26. Known boundaries

- The daily/manual Workflow performs collection and shared Luna work, then
  hands primary research to a separate durable coordinator and hourly cloud
  worker. There is no extra Vercel polling cron. The retained API rollback
  path completes inside the daily Workflow (section 30).
- In API rollback, each database claim makes one non-retried response-creation POST. OpenAI does
  not document creation idempotency, and a job can consume up to three
  potentially billable claim attempts after bounded failures.
- API rollback research is capped at 20 tool calls, 32,000 output tokens, and a
  30-minute response deadline per attempt.
- Source claims are structurally linked. Cloud source access is worker-reported;
  the retained API adapter proves only that a
  returned page was opened or cited in the response. No independent crawler
  fact-checks the claim or fetches a model-submitted URL.
- The retained API adapter uses `store: true` so it can poll background Responses
  durably. The accepted response ID is retained in `runs.usage.research`, while
  stored responses are deleted best-effort after a handled success or failure.
- If a create request has an ambiguous transport outcome and returns no response
  ID, the application cannot retrieve, cancel, or delete that provider-side
  response.
- Failed or abandoned response usage is not guaranteed to appear in the run
  usage record, so provider billing is authoritative for total research spend.
- There is no market-size model and no claim that engagement equals demand.
- Stale cleanup is opportunistic when another run or claim occurs. Recovery is
  bounded by Workflow state reads, leases, and the database attempt counter.
- Optional MCP use still depends on OAuth authorization and the connected
  account's support for private write-capable tools. That limitation does not
  affect the production cloud path or retained API rollback.
- The For You collector contributes only ordered discovery IDs and feed
  positions. AWS deployment and on-demand invocation support are implemented.
  The Workflow hydrates candidates through the official X API before selecting
  the first 30 new originals; DOM text and browser metrics never enter model
  input. Followed/topic API discovery remains a configurable fallback.
- X can change its login and Home DOM without notice. Locator drift, session
  expiry, verification, CAPTCHA, feed errors, and external navigation all end
  the bounded collector rather than trigger evasive behavior. This optional
  lane can fail without replacing the official-API path.

These are current operating boundaries, not alternate execution paths.

## 27. Source-of-truth files

### Orchestration

- [`src/workflows/daily-research.js`](./src/workflows/daily-research.js)
- [`src/workflows/daily-research-steps.js`](./src/workflows/daily-research-steps.js)
- [`src/workflows/ideation-steps.js`](./src/workflows/ideation-steps.js)
- [`src/workflows/x-for-you-cloud-steps.js`](./src/workflows/x-for-you-cloud-steps.js)
- [`src/workflows/openai-research-steps.js`](./src/workflows/openai-research-steps.js)
- [`src/workflows/finalize-research.js`](./src/workflows/finalize-research.js)
- [`src/workflows/research-finalizer-steps.js`](./src/workflows/research-finalizer-steps.js)
- [`src/lib/research/job-service.js`](./src/lib/research/job-service.js)
- [`src/lib/runs/start-run.js`](./src/lib/runs/start-run.js)
- [`src/workflows/cloud-ideation.js`](./src/workflows/cloud-ideation.js)
- [`src/workflows/cloud-ideation-steps.js`](./src/workflows/cloud-ideation-steps.js)
- [`src/lib/cloud-ideation/dispatch.js`](./src/lib/cloud-ideation/dispatch.js)
- [`src/lib/cloud-ideation/engine.js`](./src/lib/cloud-ideation/engine.js)
- [`src/lib/cloud-ideation/contracts.js`](./src/lib/cloud-ideation/contracts.js)
- [`src/lib/cloud-ideation/publication.js`](./src/lib/cloud-ideation/publication.js)
- [`integrations/chatgpt-cloud-ideation/README.md`](./integrations/chatgpt-cloud-ideation/README.md)
- [`integrations/chatgpt-cloud-ideation/worker-prompt.md`](./integrations/chatgpt-cloud-ideation/worker-prompt.md)
- [`vercel.json`](./vercel.json)

### X and ranking

- [`src/lib/x/search-posts.js`](./src/lib/x/search-posts.js)
- [`src/lib/x/lookup-posts.js`](./src/lib/x/lookup-posts.js)
- [`src/lib/x/client.js`](./src/lib/x/client.js)
- [`src/lib/x/for-you-hydration.js`](./src/lib/x/for-you-hydration.js)
- [`src/lib/x/for-you-result.js`](./src/lib/x/for-you-result.js)
- [`src/lib/x/retention.js`](./src/lib/x/retention.js)
- [`src/lib/ranking.js`](./src/lib/ranking.js)

### Optional For You collector

- [`scripts/collect-x-for-you.js`](./scripts/collect-x-for-you.js)
- [`scripts/run-x-for-you-aws.js`](./scripts/run-x-for-you-aws.js)
- [`scripts/open-x-for-you-login.ps1`](./scripts/open-x-for-you-login.ps1)
- [`scripts/setup-x-for-you-aws.sh`](./scripts/setup-x-for-you-aws.sh)
- [`scripts/setup-x-for-you-runtime.ps1`](./scripts/setup-x-for-you-runtime.ps1)
- [`deploy/aws/x-for-you/bootstrap-disabled-worker.sh`](./deploy/aws/x-for-you/bootstrap-disabled-worker.sh)
- [`deploy/aws/x-for-you/run.sh`](./deploy/aws/x-for-you/run.sh)
- [`deploy/aws/x-for-you/cloudformation.yaml`](./deploy/aws/x-for-you/cloudformation.yaml)
- [`deploy/aws/x-for-you/vercel-oidc-role.yaml`](./deploy/aws/x-for-you/vercel-oidc-role.yaml)
- [`deploy/aws/x-for-you/signal-foundry-x-for-you-auto-stop.service`](./deploy/aws/x-for-you/signal-foundry-x-for-you-auto-stop.service)
- [`deploy/aws/x-for-you/signal-foundry-x-for-you-auto-stop.timer`](./deploy/aws/x-for-you/signal-foundry-x-for-you-auto-stop.timer)
- [`deploy/aws/x-for-you/x-for-you.env.example`](./deploy/aws/x-for-you/x-for-you.env.example)
- [`src/lib/x/for-you/aws-runner.js`](./src/lib/x/for-you/aws-runner.js)
- [`src/lib/x/for-you-connection.js`](./src/lib/x/for-you-connection.js)
- [`src/lib/x/for-you/preflight.js`](./src/lib/x/for-you/preflight.js)
- [`src/lib/x/for-you/action-policy.js`](./src/lib/x/for-you/action-policy.js)
- [`src/lib/x/for-you/browser.js`](./src/lib/x/for-you/browser.js)
- [`src/lib/x/for-you/login.js`](./src/lib/x/for-you/login.js)
- [`src/lib/x/for-you/navigation.js`](./src/lib/x/for-you/navigation.js)
- [`src/lib/x/for-you/feed.js`](./src/lib/x/for-you/feed.js)
- [`src/lib/x/for-you/extract-post.js`](./src/lib/x/for-you/extract-post.js)
- [`src/lib/x/for-you/collect.js`](./src/lib/x/for-you/collect.js)
- [`src/lib/x/for-you/output.js`](./src/lib/x/for-you/output.js)
- [`src/lib/x/for-you/diagnostics.js`](./src/lib/x/for-you/diagnostics.js)

### Models, contracts, and validation

- [`src/lib/config.js`](./src/lib/config.js)
- [`src/lib/prompts/post-filter.js`](./src/lib/prompts/post-filter.js)
- [`src/lib/prompts/context-hydration.js`](./src/lib/prompts/context-hydration.js)
- [`src/lib/prompts/post-shortlist.js`](./src/lib/prompts/post-shortlist.js)
- [`src/lib/prompts/candidate-generation.js`](./src/lib/prompts/candidate-generation.js)
- [`src/lib/prompts/generate-ideas.js`](./src/lib/prompts/generate-ideas.js)
- [`src/lib/ai-schemas/post-filter.js`](./src/lib/ai-schemas/post-filter.js)
- [`src/lib/ai-schemas/context-hydration.js`](./src/lib/ai-schemas/context-hydration.js)
- [`src/lib/ai-schemas/post-shortlist.js`](./src/lib/ai-schemas/post-shortlist.js)
- [`src/lib/ai-schemas/candidate-generation.js`](./src/lib/ai-schemas/candidate-generation.js)
- [`src/lib/openai/research-response.js`](./src/lib/openai/research-response.js)
- [`src/lib/ai-schemas/idea-generation.js`](./src/lib/ai-schemas/idea-generation.js)
- [`src/lib/validation.js`](./src/lib/validation.js)
- [`src/lib/fingerprints.js`](./src/lib/fingerprints.js)
- [`src/lib/idea-deduplication.js`](./src/lib/idea-deduplication.js)
- [`src/lib/research/canonical-json.js`](./src/lib/research/canonical-json.js)
- [`src/lib/research/public-url.js`](./src/lib/research/public-url.js)

### Optional MCP and OAuth

- [`src/app/mcp/route.js`](./src/app/mcp/route.js)
- [`src/app/.well-known/oauth-protected-resource/route.js`](./src/app/.well-known/oauth-protected-resource/route.js)
- [`src/app/oauth/consent/page.js`](./src/app/oauth/consent/page.js)
- [`src/app/oauth/consent/actions.js`](./src/app/oauth/consent/actions.js)
- [`src/lib/mcp/config.js`](./src/lib/mcp/config.js)
- [`src/lib/mcp/auth.js`](./src/lib/mcp/auth.js)
- [`src/lib/mcp/tools.js`](./src/lib/mcp/tools.js)

### Optional plugin

- [`integrations/signal-foundry-research/.codex-plugin/plugin.json`](./integrations/signal-foundry-research/.codex-plugin/plugin.json)
- [`integrations/signal-foundry-research/.mcp.json`](./integrations/signal-foundry-research/.mcp.json)
- [`integrations/signal-foundry-research/skills/signal-foundry-research/SKILL.md`](./integrations/signal-foundry-research/skills/signal-foundry-research/SKILL.md)
- [`integrations/signal-foundry-research/skills/signal-foundry-research/references/result-contract.md`](./integrations/signal-foundry-research/skills/signal-foundry-research/references/result-contract.md)

### Database and UI

- [`supabase/migrations/001_initial_schema.sql`](./supabase/migrations/001_initial_schema.sql)
- [`supabase/migrations/002_hybrid_sources_and_product_contract.sql`](./supabase/migrations/002_hybrid_sources_and_product_contract.sql)
- [`supabase/migrations/003_scheduled_research_worker.sql`](./supabase/migrations/003_scheduled_research_worker.sql)
- [`supabase/migrations/004_account_first_x_collection.sql`](./supabase/migrations/004_account_first_x_collection.sql)
- [`supabase/migrations/005_for_you_source_channel.sql`](./supabase/migrations/005_for_you_source_channel.sql)
- [`supabase/migrations/006_post_first_ideation.sql`](./supabase/migrations/006_post_first_ideation.sql)
- [`supabase/migrations/20260904235628_cloud_ideation_shadow_queue.sql`](./supabase/migrations/20260904235628_cloud_ideation_shadow_queue.sql)
- [`supabase/migrations/20260905001502_cloud_ideation_hourly_deadline.sql`](./supabase/migrations/20260905001502_cloud_ideation_hourly_deadline.sql)
- [`supabase/migrations/20260905014539_cloud_ideation_primary_publication.sql`](./supabase/migrations/20260905014539_cloud_ideation_primary_publication.sql)
- [`src/app/posts/page.js`](./src/app/posts/page.js)
- [`src/app/api/runs/[id]/cloud-comparison/route.js`](./src/app/api/runs/[id]/cloud-comparison/route.js)
- [`src/components/cloud-model-decisions.jsx`](./src/components/cloud-model-decisions.jsx)
- [`src/app/ideas/[id]/page.js`](./src/app/ideas/[id]/page.js)
- [`src/components/idea-detail.jsx`](./src/components/idea-detail.jsx)
- [`src/components/external-research-list.jsx`](./src/components/external-research-list.jsx)

## 28. External implementation references

- [X automation rules](https://help.x.com/en/rules-and-policies/x-automation)
- [Playwright persistent browser contexts](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context)
- [Playwright authentication-state security](https://playwright.dev/docs/auth)
- [Playwright locator guidance](https://playwright.dev/docs/locators)
- [OpenAI GPT-5.6 Sol model](https://developers.openai.com/api/docs/models/gpt-5.6-sol)
- [OpenAI Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [OpenAI scheduled tasks](https://learn.chatgpt.com/docs/automations?surface=app)
- [OpenAI MCP server guidance](https://developers.openai.com/plugins/build/mcp-server)
- [OpenAI plugin authentication guidance](https://developers.openai.com/plugins/build/auth)
- [OpenAI developer mode and full MCP apps in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt)
- [Supabase MCP authentication](https://supabase.com/docs/guides/auth/oauth-server/mcp-authentication)
- [Supabase OAuth server setup](https://supabase.com/docs/guides/auth/oauth-server/getting-started)
- [Supabase OAuth token security](https://supabase.com/docs/guides/auth/oauth-server/token-security)

## 29. Optional X For You cloud collector

This is additive by default. Exact `X_API_DISCOVERY_ENABLED=false` turns off the
official followed-account and topic recent-search requests while preserving the
official lookup endpoint used to validate browser-discovered posts.

At the beginning of the daily Vercel Workflow,
`src/workflows/x-for-you-cloud-steps.js` requires both
`X_WEB_AUTOMATION_ENABLED=true` and a syntactically valid
`X_WEB_AUTOMATION_APPROVED_ACCOUNT`. If either value is absent or invalid, no
AWS call is made. When enabled, the Workflow creates one one-use Workflow
webhook, assumes the production-pinned Vercel OIDC role, starts EC2
`i-064c47109859601d1` in `us-east-2`, and invokes the installed collector with
SSM Run Command. The instance is stopped in the Workflow cleanup path; SSM and
systemd also enforce 20- and 25-minute shutdown bounds.

The EC2 collector retrieves exactly `X_LOGIN_EMAIL`, `X_LOGIN_USERNAME`, and
`X_LOGIN_PASSWORD` from AWS Secrets Manager `signal-foundry/x-for-you` through
its instance role. It verifies that the live X account matches the approved
handle, uses only the allowlisted read-only browser actions, and returns at most
100 unique post IDs with feed positions. Passwords, cookies, post text, and
browser state never cross the callback boundary. Challenge or account drift
fails closed without interaction. On X's combined login surface, the only
approved passwordless-method escape is the exact accessible `Use password`
button on the exact login URL: the collector enters the email, clicks the exact
`Continue` control once, switches to password once, and then submits the
password once. It never reads, fills, or submits a six-digit verification code.

The Vercel Workflow first excludes IDs already present in the owner's canonical
posts. It hydrates unseen IDs through the official X lookup client, applies the
date and reply/repost/quote rules, and writes at most the first 30 new original
feed posts as `source_channel = 'for_you'`. These verified posts are passed to
the Luna commercial filter in feed order without a view or text-length gate.
Official URL, long-post, article, and media-alt metadata is retained in bounded
`source_context` for conditional hydration.
When API discovery is enabled, browser, AWS, or For You hydration failure leaves
the official search path running. In For You-only mode, browser/AWS failure or
lookup/history-validation failure fails the run.

AWS infrastructure is owned by the `signal-foundry-x-for-you` and
`signal-foundry-vercel-x-for-you-oidc` CloudFormation stacks. Deployment source
is stored only under the private, versioned S3 `deployment/` prefix; results do
not use S3. Human approval expiry is an operator/renewal concern and does not
add another runtime flag or service.

## 30. Cloud primary research and historical comparisons

New cloud-provider runs use immutable `mode = primary`; their trusted final
validation publishes qualifying ideas to the normal reports. Existing
`mode = shadow` comparisons remain immutable and unpublished. Both modes share
retained X posts, Luna commercial filtering and resolved linked context, then
make an independent commercial selection:

```text
Shared Luna survivors and resolved context
  -> independent cloud shortlist (at most 8; automatic when 8 or fewer survive)
  -> one cloud candidate job per post, assigned to a new child with fork_turns: none
  -> trusted schema/source validation, score ordering and duplicate checks
  -> immutable top-3 research payload
  -> one cloud research job with public-web sources
  -> trusted evidence/product validation and final duplicate checks
  -> primary: atomically publish zero to three ideas and complete the source run
     shadow: comparison report only, published = false
```

The payloads reuse the existing shortlist, candidate-generation and research
prompts and schemas. A candidate job receives exactly one source post, its
resolved context and saved product preferences; the worker must consider three
concepts and return a candidate or `no_viable_idea`. The current enqueue code
requests Sol High for all new cloud jobs: shortlist, candidate and research.
The saved worker prompt also requests Sol High for every child. Cloud Work
schedule/model requests and worker-reported metadata do not establish the
actual model or reasoning used; runtime identity remains unverified. Source
access is worker-reported rather than attested by an API response trace. Luna
and embedding calls remain OpenAI Platform calls.

After validating generation results, the Vercel coordinator sorts by selected
idea score and applies the existing exact/semantic duplicate rules before
admitting at most three candidates. Primary runs check all current owner ideas
outside their own run, including ideas published while cloud work was waiting.
Historical shadow comparisons use only the
owner's ideas created before the source API run's saved `started_at` (or
`created_at` fallback), and explicitly exclude ideas from that API run. This
prevents the concurrent API result from being treated as prior historical
evidence against its cloud comparison. Trusted selection is saved before
research is queued. The final research stage checks candidate/source membership,
evidence grounding and the product contract, then deduplicates again against
the same historical cutoff and within the final batch. The report retains
assessments, ideas, source records, rejected candidate reason codes, counts,
embedding usage and the unverified-runtime/worker-reported-source qualifiers.
Primary mode publishes through `publish_primary_cloud_ideas`, which bridges to
the existing trusted research publication transaction and writes the normal
idea/evidence rows plus actual result `idea_ids`. Its `published` flag is true
only for an actual nonempty publication. Shadow mode never invokes that bridge
or writes published ideas, source links or API decision checkpoints.

### Coordination, claims and access

The daily Workflow reads the run's saved provider after Luna survivors are
resolved. For `chatgpt_cloud`, it dispatches primary mode and returns without
calling Sol APIs; dispatch failure closes the attempt rather than enabling
an API fallback. Explicit `api` rollback retains its independent shadow dispatch
and proceeds through the retained API stages. The separate `cloudIdeation`
Workflow advances saved state, sleeps durably for one minute between checks
and enforces the run's saved deadline, with at most 1,440 polling iterations.
New comparisons receive a 24-hour deadline; earlier immutable deadlines remain
unchanged.
Unique job keys, immutable inputs and conditional checkpoint updates make
dispatch/processing retries recoverable without replacing accepted model output.

The saved hourly parent prompt creates exactly one child with
`collaboration.spawn_agent`, a unique task name, `fork_turns: "none"`,
`model: "gpt-5.6-sol"` and `reasoning_effort: "high"`. It passes the complete
self-contained worker contract without parent chat history, waits for completion
or attention. The saved prompt adds a controlled diagnostic for `failed` or
`attention_required`; all 15 non-operational fixture scenarios passed, and
the exact tested prompt was saved and reload-verified with the user's approval.
The parent does not read payloads, evaluate posts or call SQL. It cannot reuse or follow up with
a child; unavailable or denied isolated spawning stops the execution rather
than falling back to direct SQL or inherited context.

The repository prompt defines diagnostics with a controlled stage/reason code,
exact prewritten explanation, evidence category and explicit retryability when
known (otherwise `null`). An observed HTTP status and tool identifier are the
only optional additions; the complete report is capped at 1,000 characters.
Raw errors, SQL, model/source payloads, claim capabilities, credentials and
child reasoning cannot be forwarded. A specific denial or tool-unavailability
claim requires an actual tool/runtime observation; model inference remains
`unknown`. These diagnostic labels are worker-reported, not independently
attested runtime evidence.

The parent retains failed/attention reports in the scheduled ChatGPT response,
even if Supabase is unavailable. Its own spawn/wait failures use the same
contract; an invalid or missing child report becomes `child_response_invalid`
instead of exposing the unsafe output. No extra logging RPC, permission or
fallback is added. Empty/successful runs stay quiet. An unconfirmed claim cannot
be retried, and a submission still unconfirmed after its one identical retry
must not be followed by a failure RPC. `failed` denotes an acknowledged failure
report, which may release the queue job for a later attempt rather than mark
it terminal.

The isolated child uses the installed administrative Supabase plugin's
`execute_sql` tool. Its saved prompt permits only these three invoker RPCs:

- `claim_cloud_model_job`: atomically claim one available owner-scoped job;
- `submit_cloud_model_job`: save the result under its exact job/claim capability;
- `report_cloud_model_failure`: release or fail the current claim.

Claims last at most 30 minutes, are capped by the run deadline, and allow at
most three attempts. The queue rejects mismatched owner/job pairs, stale/replaced claims and
changed resubmissions; an identical accepted submission is idempotent.
Submitted JSON remains immutable while the coordinator marks valid contracts
completed or invalid contracts failed. The worker cannot mark a response as
validated through these RPCs.

Authenticated owner browser sessions have RLS-protected SELECT access only;
mutation RPC execution is revoked from public/anonymous/authenticated roles
and granted to `service_role`. The installed plugin executes administratively
as Postgres, which can also call these functions. Its other administrative
tools are broad capabilities: the three-RPC worker limit is a prompt boundary,
not a database restriction on that plugin. This connection is separate from
the optional private Signal Foundry MCP connector, which was unavailable in
the tested cloud Work account.

At the next comparison launch, the server calls `purge_cloud_model_payloads`
to erase run inputs and job payloads for terminal comparisons created at least
48 hours earlier. Responses, assessments and reports remain available for
comparison. This cleanup is opportunistic, not a separate timer. Operator
schedule setup and the current verification status are recorded in section 22.
The primary publisher's immutable copy in `research_jobs` remains under the
existing research-job retention policy; this cloud purge does not remove it.

### Historical shadow verification before cutover: September 5, 2026 UTC

Commit `255653aea30f455fead054afd743d9062bded0cb` was deployed as Vercel
deployment `9KtfVACrVjqskwfWG4Jps53ttnaS`, which reached `READY`. Both cloud
migrations were applied, with database versions `20260904235628` and
`20260905001502`.

The retained-run comparison `69245cd0-67be-48f6-8c50-9ec615abbd3c` started
Workflow `wrun_01M1QEZP3BNF9TDT2B6MX2YWKY` with the exact 24-hour deadline
`2026-09-06T00:20:06.832363Z`. The active hourly **Signal Foundry cloud worker**
was created through the Scheduled Work UI. Its first automatic execution
claimed the real shortlist at `00:34:22 UTC` and submitted it at
`00:36:00.371477 UTC`; the server validated all 26 assessments and eight
advanced post IDs, then queued eight individual candidate jobs. This verifies
automatic scheduling, plugin access, a real queue claim/submission and trusted
shortlist validation.
This historical shortlist job retained its original requested Medium reasoning;
it was created before enqueue code changed all new cloud jobs to High.
Its immutable request metadata is preserved.

The schedule's setup conversation is `6a9b61f0-bb9c-83e8-a1c5-38fa9d6cffc0`.
Its Open chat action still opens that conversation, and the UI does not reveal
the complete context supplied to a background parent execution. The updated
prompt therefore creates an explicit child with `fork_turns: "none"` for each
job instead of depending on scheduler-level context isolation. Selecting Sol
High and saving per-job model requests provides no runtime model attestation.

The earlier in-chat **Signal Foundry cloud ideation** schedule is paused. Its
Run now attempt reported inherited setup context; automatic approval review
blocked the claim, and that attempt made no database mutation. It is separate
from the active worker above.

All eight candidate jobs completed server validation during the manual cloud
Work checks. The final candidate was claimed and submitted by a new child with
`fork_turns: "none"` and the requested Sol High settings. The coordinator ranked
the accepted candidates and selected the top three for research. These manual
candidate executions do not establish that an entire batch has completed
through the hourly schedule.

The exact parent/child worker prompt was saved in the active schedule, then
verified to persist after reloading the UI. At approximately `01:11 UTC`, Run
now was triggered to process research job
`d1f056f1-4fe1-4e46-9652-c8f3c0a0cdac` through the isolated child. The job was
claimed by `01:13 UTC` and submitted at `2026-09-05T01:15:00.697509Z`. The
scheduled parent UI reported 3 minutes 52 seconds of work and child completion.
The server then completed trusted research validation and the comparison.

Independent read-only database verification confirmed `status = completed`,
`phase = done`, and all ten jobs completed: one shortlist, eight candidate jobs
and one research job. The final flow was 26 source posts, eight generated
candidates, three research candidates and one validated shadow idea with eight
research sources. Seven recorded exclusions comprised five
`pre_research / outside_top_three` and two `research / research_omitted` results;
there were zero generation failures and zero `no_viable_idea` outcomes. The
final report retained `published = false`.

The Source feed showed Comparison complete, Research Validated and eight of
eight generations validated. Its final idea, **DocTask CI — Outcome Tests for
Agent-Readable Documentation**, and all eight sources rendered correctly when
expanded. The verified test combined an automatic shortlist, manually
accelerated candidate jobs and research launched through the updated schedule's
Run now control. It does not claim ten fully hourly executions. All 324
automated tests and the production build also passed.

The original API run's verification hash remained
`b993eb92e7f66c19ad9daab326f70114`, and the owner's published idea count remained
two, both exactly matching the pre-comparison baseline. The production API
path remained enabled and authoritative. The completed comparison did not
publish its idea or alter the API run. Runtime model identity remains
unverified, and source access remains worker-reported.

### Primary cutover verification: September 5, 2026 UTC

The cloud-primary code passed all 339 automated tests and the production build.
Coverage includes the provider branch, primary publication preparation,
historical shadow behavior, published-idea links, and the owner route's
rejection of a separate comparison for a primary run.

Primary publication migration `20260905014539` was applied. A live database
contract test passed using the real claim/submission RPCs and existing atomic
publisher inside a rolled-back transaction. It verified nonempty publication
with X and external evidence links, replay idempotency, rejection of shadow
publication, empty/failure completion, and preservation of Luna usage with
correct embedding accumulation. All fixture changes were rolled back; the
production published idea count remained two.

Commit `389562e15394f3fb6fcfbe552fc420c2a56fa3ec` reached production as Vercel
deployment `HTJLPiZJhmG5BehCqw2o2qfBqubv`, with `READY` status and a 19-second
build. The exact updated primary/shadow worker prompt was saved to the existing
hourly schedule and verified after reloading the UI. The schedule remains
active, and new production runs now use the cloud provider for Sol stages;
shared Luna and embedding APIs remain enabled.

Normal manual verification run `43a1c953-7eba-42ff-a15d-fff1c4bedd3a` was created
at `2026-09-05T01:53:22.64577Z`. Its saved
`settings_snapshot.ideation_provider` was verified as `chatgpt_cloud`. The normal
collection/Luna flow filtered 30 posts and produced 25 survivors. The verified
handoff created a `primary` cloud run in `running / shortlist`, with 25 input
posts, Workflow `wrun_01M1QMFA86TW1R8P8FX3BWHQ5W`, and deadline
`2026-09-06T01:56:01.636468Z`. Exactly one cloud shortlist job,
`fa87220a-3593-4581-8a31-96a4ce998bd6`, was pending.

At that handoff, the source run had zero API shortlist assessments, generation
clusters, candidate results and `research_jobs`; its usage contained only
`luna_filter`. Shared Luna had run, and no Sol API stages had executed. At
approximately `01:58 UTC`, Run now was triggered on the saved schedule to
exercise the first primary cloud claim/submission. The shortlist job was then
claimed and submitted through the saved cloud Work schedule, and the server
validated its response for all 25 supplied posts and marked the job completed,
with eight posts advanced. Both the primary cloud run and its original source
run were `running / generating`, and exactly eight candidate jobs were pending.
API shortlist, generation and research-job checkpoints remained zero, with
usage still only `luna_filter`; the published idea count remained two.
Browser verification showed a Validated shortlist, zero of eight generation
responses validated, eight waiting to start, and the stored shortlist rationale
and score visible for `@bot`.

At that initial cutover checkpoint, the remaining candidate/research work and
complete primary batch publication were pending under the hourly schedule. The shadow execution above remains
historical evidence and is not relabeled as a primary run.

### Scheduled-worker diagnostic revision: September 5, 2026 UTC

Two reported pre-claim failures retained only job ID/status, leaving their
underlying causes unestablished. The repository worker prompt now includes the
bounded failure contract above so failures before database access can remain
reviewable in ChatGPT. Automatic approval review blocked uploading the revised
prompt into the manual offline fixture chat. The user then explicitly approved
sending the revised instructions to ChatGPT, testing them, and updating the
existing hourly schedule.

The [non-operational ChatGPT Work fixture test](https://chatgpt.com/c/6a9c9acf-9554-83e8-bbe3-b8df5aa232ed)
then passed all 15 scenarios for classification, canonical status shape, the
1,000-character report limit and non-leakage of synthetic canary content. Its
input matched the exact committed worker prompt after normalization: 15,461
characters, FNV-1a `443cc5f1`. This checks simulated diagnostic behavior; it does
not establish the causes of the earlier failures or exercise production jobs.

The revised prompt was saved to the existing **Signal Foundry cloud worker**
task `6a9b6225d5048191903c994bc0b91d55` on September 5, 2026. A fresh browser tab
of its setup chat was opened, the task's Instructions were reopened, and exact
string equality to the tested committed prompt was confirmed (the same
normalized length and FNV-1a fingerprint above). The existing task remains
active, hourly, every one hour, with no end date; no replacement schedule was
created. Its production failure-output contract now includes the controlled
diagnostic. The earlier saved-prompt and live pipeline records describe the
previous two-field contract. This synthetic test and persistence check did not
reproduce an operational failure or recover its historical cause. No new
database logging, permissions or tool access was added by this prompt revision.
