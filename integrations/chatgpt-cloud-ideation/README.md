# ChatGPT cloud ideation

New production runs use ChatGPT cloud for Sol shortlisting, one-post generation
and web research. After shared Luna filtering and linked-context hydration, the
daily Vercel Workflow hands off to the cloud coordinator. Trusted server code
selects candidates, validates research, and publishes qualifying ideas into the
normal reports. Luna and embeddings remain API-backed.

`PIPELINE.ideationProvider = "chatgpt_cloud"` is snapshotted onto each new run.
The Sol Responses API implementation remains available for explicit rollback by
setting this value to `"api"` and deploying. Cloud failure never triggers Sol API
calls automatically. Existing runs keep their saved provider, and historical
`mode: "shadow"` comparisons remain unpublished.

The isolated worker child uses the installed Supabase plugin. This integration does
not depend on the optional private Signal Foundry MCP connector, which was not
available in the tested cloud Work account. The plugin has database-management
capabilities; the saved worker prompt restricts its work to the three queue RPCs.
Those RPCs enforce owner relationships, claim leases and submission idempotency.
They are not a restriction on the Supabase plugin's other administrative tools.

Save the full contents of [worker-prompt.md](./worker-prompt.md) in the hourly
ChatGPT Work cloud schedule. The scheduled parent only orchestrates: each
execution calls `collaboration.spawn_agent` once with a unique task name,
`fork_turns: "none"`, `model: "gpt-5.6-sol"` and `reasoning_effort: "high"`.
Its message contains the complete self-contained child task from the prompt,
without parent history or prior jobs. The child claims and processes one job,
then returns its sanitized job ID/status and, in this repository revision, a
controlled diagnostic on failure. The active schedule still has the previous
two-field-only prompt; the diagnostic revision awaits approval before testing
and saving.
The parent waits for completion
or attention, never reads payloads or uses SQL, and never reuses or follows up
with a child. If isolated spawning is unavailable or denied, the task stops;
there is no direct-SQL or inherited-context fallback.

The prompt's canonical failure report adds `diagnostic` with a controlled
stage, reason code, exact prewritten explanation, evidence category and known
retryability (otherwise `null`). Only an actually observed HTTP status or tool
identifier may be added. The report is capped at 1,000 characters and contains
no raw errors, SQL, source/model payloads, claim IDs, credentials or child
reasoning. Specific denial/unavailability codes require an observed tool or
runtime result; model inference uses `unknown`. These are worker-reported
diagnostics, not independent runtime attestations.

The parent preserves every safe failure in its scheduled ChatGPT response,
including child-spawn/wait errors and invalid or missing child reports. This
does not depend on Supabase being reachable or on an extra database write.
Successful and empty executions remain quiet. A lost claim reply never causes
a second claim; an unconfirmed submission after the one permitted identical
retry never causes a failure RPC. `failed` means the failure RPC acknowledged
a report, not necessarily that the queue job became terminal.
For the primary cutover, apply the primary publication migration and validate
the application deployment, then save this exact updated prompt in the existing
hourly schedule before its first primary claim. Its parent and isolated child
both carry the owner's primary/shadow authorization; the three queue RPCs and
the prohibition on direct publication remain unchanged.

Select GPT-5.6 Sol High, connect Supabase, and run once per hour. The schedule
must run in cloud Work, with no local project or files required. This explicit
child boundary avoids relying on the scheduled parent's chat being empty:
the scheduler UI still opens the setup conversation and does not expose its
complete background context. Requested child settings also do not independently
attest to the model that executed the work.
Eligible paid ChatGPT schedules support recurring tasks up to once per hour;
the five-minute schedule was not created. See the
[official task frequency limits](https://help.openai.com/en/articles/10291617-tasks-in-chatgpt).
The coordinator waits durably with one-minute sleeps, up to 1,440 checks and a
24-hour deadline for new comparisons; previously saved deadlines remain unchanged.
Primary publication retains an immutable research-job payload/result copy for
the existing publication boundary. Purging cloud inputs/payloads after 48 hours
does not remove that copy; its existing research-job retention policy applies.
A full batch can require ten hourly executions: a shortlist,
eight separate candidate jobs and research, before retries or queue delays.
The pre-cutover shadow verification established that the hourly worker is
active, and its first automatic execution submitted a real
shortlist that the server validated: 26 assessments advanced eight posts. That
historical job retains its immutable original Medium request. All eight
candidate jobs have since completed server validation, including the last
job processed by a child spawned with `fork_turns: "none"` and the requested Sol
High settings. The server selected the top three candidates for research.
The exact parent/child prompt is saved in the active schedule, and persistence
was checked after reloading the UI. Run now was triggered at approximately
01:11 UTC on September 5, 2026 for research. Its isolated child submitted at
01:15:00.697509 UTC, and the server completed the comparison with one validated
shadow idea, **DocTask CI — Outcome Tests for Agent-Readable Documentation**,
and eight sources. All ten queue jobs completed, and the Source feed rendered
the validated research, expanded idea and sources correctly. This test combined
an automatic shortlist, manually accelerated candidates and research launched
through the saved schedule's Run now control; it did not wait through ten
hourly executions. The result remains `published: false`, the original API run
was unchanged, and the owner's two published ideas were unchanged.
At this checkpoint, 324 automated tests and the production build passed.
The deployment and operational evidence are recorded in
[CURRENT_ARCHITECTURE.md](../../CURRENT_ARCHITECTURE.md#30-cloud-primary-research-and-historical-comparisons).

The cloud payload reuses the application's versioned prompts and schemas.
Current enqueue code requests Sol High for every new cloud job, including
shortlisting, matching the saved child's model and reasoning request.
Requested model/effort settings and any worker-reported runtime metadata remain
distinct; the application does not infer a verified model identity from them.
Research source access remains worker-reported rather than independently attested.
Luna filtering/context and embedding calls remain API-backed.

The Source feed shows cloud decisions and published idea links for primary runs.
Historical API runs retain their API panels and separate cloud comparisons;
eligible older API runs can still start a comparison there. Primary runs do not
offer that separate comparison action. The historical test above validates the
worker and shadow path; the primary deployment and live verification record is
tracked separately below.
The primary-cutover code passed all 339 automated tests and the production build.
Migration `20260905014539` is applied. Its live database contract test passed
claim/submission, nonempty publication and evidence links, idempotent replay,
shadow rejection, empty/failure completion and usage preservation. All fixtures
were rolled back, leaving the production idea count at two.

Primary cutover commit `389562e15394f3fb6fcfbe552fc420c2a56fa3ec` is deployed as
Vercel production deployment `HTJLPiZJhmG5BehCqw2o2qfBqubv` (`READY`, 19-second
build). The exact updated worker prompt is saved and verified after reload in
the active hourly schedule. New manual run `43a1c953-7eba-42ff-a15d-fff1c4bedd3a`,
created at `2026-09-05T01:53:22.64577Z`, has the verified `chatgpt_cloud` provider
snapshot. Luna filtered 30 posts into 25 survivors; the handoff created the
primary cloud run in `running / shortlist`, with one pending shortlist job and
deadline `2026-09-06T01:56:01.636468Z`. API shortlist assessments, generation
clusters, candidate results and research jobs were all zero; usage contained
only `luna_filter`. After the saved schedule's Run now control was triggered
around 01:58 UTC, the first primary shortlist was claimed, submitted and
server-validated as completed for all 25 supplied posts, with eight advanced.
Both cloud and source runs were `running / generating`, with exactly eight
candidate jobs pending. Browser verification showed the validated shortlist,
eight waiting generations and the saved decision rationale/score. All Sol API
checkpoints remained zero, usage remained only `luna_filter`, and published
ideas remained two. At that initial cutover checkpoint, the remaining hourly
candidate/research work and complete primary publication were pending;
deployment, schedule save, the shared-Luna
handoff and the first primary cloud model response are verified.

On September 5, 2026, the repository prompt was extended with these safe failure
diagnostics after two reported pre-claim failures exposed only job ID/status.
Their underlying causes were not established by those reports. The diagnostic
prompt upload to a manual offline fixture chat was blocked by automatic approval
review and awaits explicit user approval. The fixture has not run, and the
active schedule has not received this diagnostic revision. The existing
two-field report remains the saved production contract.
