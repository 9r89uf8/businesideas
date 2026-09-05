# ChatGPT cloud ideation comparison

The production API workflow remains authoritative. After shared Luna filtering
and linked-context hydration, a separate Vercel Workflow coordinates cloud
shortlisting, one-post generation, trusted candidate selection, and cloud web
research. It validates and stores comparison results without publishing them or
overwriting the API's decisions.

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
then returns only its sanitized job ID and status. The parent waits for completion
or attention, never reads payloads or uses SQL, and never reuses or follows up
with a child. If isolated spawning is unavailable or denied, the task stops;
there is no direct-SQL or inherited-context fallback.

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
A full batch can require ten hourly executions: a shortlist,
eight separate candidate jobs and research, before retries or queue delays.
The hourly worker is active, and its first automatic execution submitted a real
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
[CURRENT_ARCHITECTURE.md](../../CURRENT_ARCHITECTURE.md#30-chatgpt-cloud-ideation-comparison).

The cloud payload reuses the application's versioned prompts and schemas.
Current enqueue code requests Sol High for every new cloud job, including
shortlisting, matching the saved child's model and reasoning request.
Requested model/effort settings and any worker-reported runtime metadata remain
distinct; the application does not infer a verified model identity from them.
Research source access remains worker-reported rather than independently attested.
Luna filtering/context and embedding calls remain API-backed.

Existing eligible runs can start an additive comparison from the Source feed.
New runs enqueue it automatically. Review the API and cloud decisions together
there. A successful comparison does not switch the production provider: API
cutover is a separate change after the cloud results have been reviewed.
