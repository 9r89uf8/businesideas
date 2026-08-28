# Signal Foundry

Signal Foundry is a private, single-owner research desk that turns current AI discussions on X into zero to three evidence-backed business or service hypotheses each day.

The implementation follows [`mainplan.md`](./mainplan.md): Next.js App Router with JavaScript/JSX, Supabase Postgres and Auth, Tailwind CSS, Vercel Workflow, the official X API, and staged OpenAI analysis.

## What it does

1. Retrieves up to 200 recent English-language X posts through the official API.
2. Filters, deduplicates, and deterministically ranks the candidate set.
3. Uses Luna once for per-post commercial-signal extraction.
4. Uses Terra once to group strong signals into independently evidenced problems.
5. Sends only compressed evidence to Sol for final ideation.
6. Rejects weak, ungrounded, repeated, and semantically duplicate ideas.
7. Stores reports, evidence, model usage, and owner feedback in Supabase.

Raw post text and exact excerpts are expired after 30 days. Retained evidence is rechecked against X so edits, deletions, and transient lookup failures are represented accurately.

## Local setup

Use Node.js 20 or newer. Create `.env` with these server and public values:

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

Never expose `SUPABASE_SECRET_KEY`, `OPENAI_API_KEY`, `X_BEARER_TOKEN`, or `CRON_SECRET` in browser code.

Apply [`supabase/migrations/001_initial_schema.sql`](./supabase/migrations/001_initial_schema.sql) to the target Supabase project, then run:

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and request a magic link for the configured owner account.

## Verification

```bash
npm test -- --test-isolation=none
npm run build
```

The suite covers ranking, strict AI schemas, model-output validation, exact excerpts, evidence boundaries, duplicate rejection, X lookup behavior, retention, settings, run creation, and feedback validation.

## Deployment

Deploy the repository to Vercel, add the same environment variables for Production, Preview, and Development as appropriate, and keep `CRON_SECRET` server-only. [`vercel.json`](./vercel.json) invokes `/api/cron/daily` once per day at 13:00 UTC. Vercel supplies the cron authorization header automatically.

The application is deliberately single-user. Supabase RLS, server routes, and the Next.js proxy all enforce `OWNER_USER_ID`.
