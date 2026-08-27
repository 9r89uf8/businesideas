# Project instructions

- Read [`mainplan.md`](./mainplan.md) in full before planning work, installing dependencies, or changing application code. Treat it as the source of truth for product scope, architecture, technology choices, file structure, database schema, API routes, security rules, build order, exclusions, and acceptance criteria.
- Follow the plan's JavaScript/JSX-only stack and its explicit version-one exclusions. Do not substitute technologies, add architectural layers, or advance to a later build phase unless the user explicitly requests it.
- Keep changes within the user's requested scope and reference the relevant `mainplan.md` section(s) in implementation plans and handoffs. A setup- or dependency-only request does not authorize building product features.
- Never print, commit, or expose environment secrets. Only `NEXT_PUBLIC_*` values may be used in browser code; Supabase secret, OpenAI, X bearer, and cron credentials must remain server-only.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
