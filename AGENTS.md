# Project instructions

- [`CURRENT_ARCHITECTURE.md`](./CURRENT_ARCHITECTURE.md) records the implemented system as a factual baseline, not a roadmap. Verify behavior against the application code and migrations, and update the document when an architectural change makes it stale.
- The production research path uses the OpenAI Responses API inside the daily Vercel Workflow. The MCP worker contract in [`integrations/signal-foundry-research/skills/signal-foundry-research/SKILL.md`](./integrations/signal-foundry-research/skills/signal-foundry-research/SKILL.md) and its [`result-contract.md`](./integrations/signal-foundry-research/skills/signal-foundry-research/references/result-contract.md) remains an optional manual or future integration. Keep it aligned with the shared queue, schemas, validation code, and migration whenever that boundary changes.
- Required production configuration that cannot be expressed in repository code is recorded in [`CURRENT_ARCHITECTURE.md`](./CURRENT_ARCHITECTURE.md#22-required-operator-setup). Production does not depend on a ChatGPT/Codex cloud schedule.
- Keep application changes in the existing JavaScript/JSX stack unless the user explicitly requests a technology change.
- Keep changes within the user's requested scope. A setup- or dependency-only request does not authorize building product features.
- Never print, commit, or expose environment secrets. Only `NEXT_PUBLIC_*` values may be used in browser code; Supabase secret, OpenAI, X bearer, and cron credentials must remain server-only.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
