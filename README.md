# Signal Foundry

Signal Foundry is a private, single-owner research desk that turns current AI
discussions on X into zero to three evidence-backed website opportunities.

The implemented system is documented in
[`CURRENT_ARCHITECTURE.md`](./CURRENT_ARCHITECTURE.md).

## Current flow

1. A daily Vercel cron or owner-triggered run searches a fixed 72-hour X window.
2. Preferred accounts and topic discovery feed the same 50,000-view quality
   gate. Retweets and quote posts are excluded.
3. Qualifying posts are ranked by views, comments, likes, then bookmarks.
4. Luna extracts per-post commercial signals.
5. Terra groups strong signals into independently evidenced problems.
6. Vercel writes one bounded, immutable job to `research_jobs` and ends the
   first workflow.
7. An hourly cloud ChatGPT/Codex task claims at most one job through the private
   Signal Foundry MCP plugin, researches public web evidence, and submits zero
   to five candidates.
8. A separate Vercel Workflow validates the result, recomputes fingerprints and
   embeddings, removes duplicates, and atomically publishes zero to three ideas.

Luna, Terra, and embeddings use the OpenAI Platform API. Final research and
candidate generation use the connected ChatGPT/Codex scheduled task. The
worker cannot write directly to ideas.

## Stack

- Next.js 16 App Router with JavaScript and JSX
- React 19 and Tailwind CSS 4
- Supabase Postgres, Auth, RLS, and `pgvector`
- Vercel hosting, cron, and Workflow
- Official X API v2
- OpenAI Luna, Terra, and embeddings
- MCP over HTTP with Supabase OAuth 2.1
- Versioned `signal-foundry-research` Codex skill

## Local setup

Use Node.js 20 or newer. Create `.env` with:

```text
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SECRET_KEY=
OWNER_USER_ID=
OWNER_EMAIL=
OPENAI_API_KEY=
X_BEARER_TOKEN=
CRON_SECRET=
```

Optional MCP URL overrides are:

```text
MCP_RESOURCE_URL=
MCP_TOKEN_AUDIENCE=
SUPABASE_JWKS_URL=
```

The default production MCP resource is:

```text
https://admins-projects-d500137d.vercel.app/mcp
```

Never expose `SUPABASE_SECRET_KEY`, `OPENAI_API_KEY`, `X_BEARER_TOKEN`, or
`CRON_SECRET` in browser code, prompts, logs, or source control.

Apply every file in [`supabase/migrations`](./supabase/migrations) to the target
Supabase project in filename order, then run:

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and sign in as the
configured owner.

## Verification

```bash
npm test -- --test-isolation=none
npm run build
```

## Deployment and worker setup

[`vercel.json`](./vercel.json) invokes `/api/cron/daily` at 13:00 UTC. Add the
required environment variables to Vercel and deploy the version containing
migration `003_scheduled_research_worker.sql` and the MCP routes.

Complete these external setup steps once:

1. Use an asymmetric Supabase JWT signing key (`RS256` or `ES256`).
2. Enable the Supabase OAuth 2.1 server.
3. Set its Site URL to the production website and authorization path to
   `/oauth/consent`.
4. Enable dynamic client registration when required by the MCP client.
5. Select `public.signal_foundry_access_token_hook` as the Supabase Custom
   Access Token Hook.
6. Install and connect the plugin in
   [`integrations/signal-foundry-research`](./integrations/signal-foundry-research).
7. Approve its `openid email offline_access` request while signed in as the
   configured owner so a compatible cloud schedule can refresh authorization
   without another interactive login.
8. In a normal cloud chat, confirm the private MCP write tools run without an
   interactive approval. Personal Pro support for unattended private write
   actions is not guaranteed by the public documentation.
9. Only if that test passes, create an hourly cloud scheduled task that uses
   `$signal-foundry-research`, claims at most one job, and stops quietly when
   the queue is empty.

The schedule is cloud configuration; it is not created by `vercel.json` or a
database migration. Until the plugin is connected, its unattended write test
passes, and the schedule is active, daily runs can correctly stop at
`research_queued` with pending work.

For the complete state machine, security checks, data model, and end-to-end
operator check, see
[`CURRENT_ARCHITECTURE.md`](./CURRENT_ARCHITECTURE.md#22-required-operator-setup).
