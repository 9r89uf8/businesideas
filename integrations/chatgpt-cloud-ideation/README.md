# ChatGPT cloud ideation comparison

The production API workflow remains authoritative. After shared Luna filtering
and linked-context hydration, a separate Vercel Workflow coordinates cloud
shortlisting, one-post generation, trusted candidate selection, and cloud web
research. It validates and stores comparison results without publishing them or
overwriting the API's decisions.

The scheduled model uses the installed Supabase plugin. This integration does
not depend on the optional private Signal Foundry MCP connector, which was not
available in the tested cloud Work account. The plugin has database-management
capabilities; the saved worker prompt restricts its work to the three queue RPCs.
Those RPCs enforce owner relationships, claim leases and submission idempotency.
They are not a restriction on the Supabase plugin's other administrative tools.

Save the full contents of [worker-prompt.md](./worker-prompt.md) in a standalone
ChatGPT Work schedule. Each execution must start a fresh chat and process only
one job. Select GPT-5.6 Sol High, connect Supabase, and run once per hour.
The schedule must run in cloud Work, with no local project or files required.
Eligible paid ChatGPT schedules support recurring tasks up to once per hour;
the five-minute schedule was not created. See the
[official task frequency limits](https://help.openai.com/en/articles/10291617-tasks-in-chatgpt).
The coordinator waits durably with one-minute sleeps, up to 1,440 checks and a
24-hour deadline for new comparisons; previously saved deadlines remain unchanged.
A full batch can require ten hourly executions: a shortlist,
eight separate candidate jobs and research, before retries or queue delays.
Recurring worker activation and the complete cloud comparison remain pending
live verification.

The cloud payload reuses the application's versioned prompts and schemas.
Requested model/effort settings and any worker-reported runtime metadata remain
distinct; the application does not infer a verified model identity from them.
Luna filtering/context and embedding calls remain API-backed.

Existing eligible runs can start an additive comparison from the Source feed.
New runs enqueue it automatically. Review the API and cloud decisions together
there. A successful comparison does not switch the production provider: API
cutover is a separate change after the cloud results have been reviewed.
