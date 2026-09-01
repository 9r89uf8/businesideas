# Signal Foundry

Signal Foundry is a private, single-owner research desk that turns current AI
discussions on X into zero to three evidence-backed website opportunities.

The implemented system is documented in
[`CURRENT_ARCHITECTURE.md`](./CURRENT_ARCHITECTURE.md).

## Current flow

1. A daily Vercel cron or owner-triggered run searches a fixed 72-hour X window.
2. Up to 50 preferred accounts fill a 100-post collection budget first. Topic
   discovery can use at most 20% of unused capacity. Both sources feed the same
   19,000-view quality gate; retweets and quote posts are excluded.
3. Qualifying posts are ranked by views, comments, likes, then bookmarks.
4. Luna extracts per-post commercial signals.
5. Terra groups strong signals into independently evidenced problems.
6. Vercel writes one bounded, immutable job to `research_jobs` and claims it in
   the same durable workflow.
7. A bounded GPT-5.6 Sol Responses API call researches live public-web evidence
   and returns zero to five structured candidates. Every submitted source must
   match a page the web-search tool opened or cited.
8. The workflow saves the result before validation, recomputes fingerprints and
   embeddings, removes duplicates, and atomically publishes zero to three ideas.

Luna, Terra, Sol, web search, and embeddings use the OpenAI Platform API. The
final model never writes directly to ideas; it can only return a bounded result
that passes the queue, source-grounding, product, evidence, and duplicate gates.

## Stack

- Next.js 16 App Router with JavaScript and JSX
- React 19 and Tailwind CSS 4
- Supabase Postgres, Auth, RLS, and `pgvector`
- Vercel hosting, cron, and Workflow
- Official X API v2
- Optional isolated Playwright Core collector for the authenticated X `For
  you` feed; intended for on-demand AWS EC2 execution with local development
  support
- OpenAI Luna, Terra, Sol, web search, and embeddings
- Optional MCP over HTTP with Supabase OAuth 2.1 for manual or future workers

## Local setup

Use Node.js 20.12 or newer. Create `.env` with:

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

## Optional read-only For You collector

The repository also contains an optional discovery lane for the authenticated X
`For you` feed. It is additive: the existing followed-account and topic-search
lanes still use the official X API and remain unchanged. When the optional lane
is enabled, the same daily Vercel Workflow invokes one stopped, SSM-managed EC2
worker and receives at most 100 ordered post IDs. The official X lookup API then
hydrates those IDs before they can enter the existing quality gate, ranking,
Luna, Terra, and Sol stages.

[X's current automation rules](https://help.x.com/en/rules-and-policies/x-automation)
prohibit scripting the X website and warn that it may result in account
suspension. Credentials are not authorization. The collector therefore cannot
import Playwright or launch Chrome until both of these checks pass:

1. `X_WEB_AUTOMATION_ENABLED` is exactly `true`.
2. `X_WEB_AUTOMATION_APPROVED_ACCOUNT` is a valid X handle and matches the
   `X_LOGIN_USERNAME` stored in the collector secret, case-insensitively.

There are no approval signatures, public keys, approval files, approval IDs,
expiry documents, or daily approval ledger. The flag and approved-account value
must be supplied for each cloud invocation; neither is stored as an enabled
authorization value on the instance. Before the flag is enabled, the optional
lane skips webhook creation and all AWS work. The worker cannot read its X
secret, import Playwright, launch Chrome, or contact the X website. The normal
official-API lanes continue independently.

### AWS on-demand worker

Use one x86-64 Linux EC2 instance with an encrypted EBS root volume, Google
Chrome Stable, Node.js 20.12 or newer, Xvfb, AWS CLI v2, and the SSM agent. The
instance needs no inbound port: Systems Manager Run Command is the invocation
surface. Chrome remains headed but renders into an isolated virtual display.
The Vercel Workflow starts pinned `us-east-2` instance
`i-064c47109859601d1` for a collection and requests `StopInstances` in its
`finally` path. The SSM command also schedules a 20-minute shutdown and shuts
down immediately when the command exits. An independent systemd timer stops the
machine 25 minutes after every boot if both application stop paths fail. The
EBS-backed Chrome profile survives normal stop/start cycles, so normal
collection needs no laptop or interactive desktop. A laptop is needed only
when X invalidates the saved session and requires a human sign-in or challenge.

The cloud handoff is deliberately small:

1. The Workflow checks the exact flag and approved-account configuration.
2. When enabled, it creates one one-use Vercel Workflow webhook.
3. It starts the pinned EC2 instance through the AWS SDK and waits for both
   EC2 `running` and SSM `Online`.
4. It sends one 20-minute SSM Run Command carrying the flag, approved account,
   and one-use callback URL in the command environment. The callback URL is not
   placed in process arguments or logs.
5. After the browser and output handles are closed, the collector POSTs exactly
   one bounded terminal payload: either a collector run ID with up to 100
   `{ postId, feedPosition }` candidates, or an empty candidate list with one
   allowlisted failure code.
6. The Workflow validates the payload, stops the instance in a `finally` path,
   hydrates the IDs through the official X lookup API, and merges eligible
   records as `source_channel = 'for_you'`.

The one-use webhook is the callback authorization. There is no custom callback
API route, queue, Lambda, Step Functions state machine, result table, or S3
result exchange. The private S3 bucket stores versioned, secret-free deployment
artifacts only.

Attach the SSM managed-instance permissions and a collector policy with only:

- `secretsmanager:GetSecretValue` for the one collector secret;
- `s3:GetBucketLocation` and deployment-prefix-only `s3:ListBucket`; and
- `s3:GetObject` for the immutable deployment-bundle prefix.

If the secret uses a customer-managed KMS key, its narrowly scoped
`kms:Decrypt` permission is also required.

When configured, the Secrets Manager value is a credentials-only object with
this shape:

```json
{
  "X_LOGIN_EMAIL": "account@example.com",
  "X_LOGIN_USERNAME": "@your_account",
  "X_LOGIN_PASSWORD": "secret"
}
```

`deploy/aws/x-for-you/cloudformation.yaml` creates the private bucket,
credentials-secret resource, least-privilege instance role, no-ingress security
group, encrypted EBS volume, and SSM-managed instance. The deployment first runs
`deploy/aws/x-for-you/bootstrap-disabled-worker.sh`; that installs the fixed
launcher and root-owned runtime configuration without an enabled flag or
approved account. The worker reads AWS credentials from its instance role, not
static keys, and passes neither X credentials nor unrelated application secrets
to Chrome. Browser collection is serialized by the exclusive profile lock. An
X verification or CAPTCHA challenge aborts the unattended run safely; it is
never bypassed.

CloudFormation owns the secret container and its IAM reference, but deliberately
does not manage `SecretString`; stack updates therefore cannot overwrite X
credentials that are supplied out of band after approval.

The AWS target and caller role are pinned in server code: region `us-east-2`,
instance `i-064c47109859601d1`, and role
`signal-foundry-vercel-x-for-you`. Vercel obtains short-lived credentials with
`@vercel/oidc-aws-credentials-provider`; it needs no static AWS keys or AWS
target environment variables. The role trust accepts only the exact Signal
Foundry Vercel OIDC issuer, audience, project subject, and
`environment:production` deployment identity.

[`deploy/aws/x-for-you/vercel-oidc-role.yaml`](./deploy/aws/x-for-you/vercel-oidc-role.yaml)
defines that trust and the pinned EC2/SSM permissions. Its deployed
CloudFormation stack `signal-foundry-vercel-x-for-you-oidc` is
`CREATE_COMPLETE` in `us-east-2`.

After infrastructure provisioning, the only operator authorization values are:

```text
X_WEB_AUTOMATION_ENABLED=false
X_WEB_AUTOMATION_APPROVED_ACCOUNT=
```

The OIDC role permits `ec2:StartInstances` and `ec2:StopInstances` on the exact
worker, region-bounded `ec2:DescribeInstances`, `ssm:SendCommand` on the worker
and AWS-managed `AWS-RunShellScript` document, plus region-bounded
`ssm:GetCommandInvocation` and `ssm:DescribeInstanceInformation`. It grants no
Secrets Manager, S3, or X access. After written approval is granted, activation
consists only of setting the flag to exactly `true` and setting the approved
account to the approved handle.

### Connection status and manual sign-in

The dashboard shows the latest cloud connection check and the latest successful
account verification. X does not expose a dependable future session-expiration
time, so the dashboard reports what the collector actually observed instead of
guessing an expiry date. A healthy check is green; an authentication or
verification failure is red and says **Manual login required**; infrastructure
or other inconclusive failures are yellow.

The check is recorded in the existing run metadata. It adds no table, queue,
service, public browser endpoint, or secret. A failed optional check never
blocks the followed-account/topic research lanes.

When the card says **Manual login required**, wait until no research run is
active and, from the configured Windows operator laptop, run:

```powershell
npm run x:for-you:login
```

That one command starts the pinned worker, downloads a signed temporary AWS
Session Manager plugin, creates a localhost-only SSM tunnel, and opens the
worker's persistent Chrome profile in a temporary noVNC window. Complete X's
sign-in yourself; if X first asks for a phone code, choose **Use password**.
Click **OK** only after the X Home timeline is visible. The helper then closes
the tunnel and browser session, removes its temporary local files and any VNC
packages it installed, and stops the EC2 instance. It never reads the X secret
or fills the login form. The next enabled collection records the new healthy
check and turns the dashboard card green.

The operator laptop needs AWS CLI v2 with credentials allowed to start/stop the
pinned instance and use SSM. The helper opens no security-group ingress and is
hard-capped at 15 minutes, with independent cloud shutdown backstops.

### Local Windows development path

This local worker requires Node.js 20.12 or newer, installed Google Chrome
Stable, and an interactive signed-in Windows desktop. `playwright-core` does
not download a browser, and the worker is not intended for a headless Windows
service session. Before the first run, provision a private runtime ACL for the
current account, Local System, and local administrators:

```powershell
pwsh -File .\scripts\setup-x-for-you-runtime.ps1 `
  -RuntimeDirectory "$env:LOCALAPPDATA\SignalFoundry\x-for-you"
```

Configure these local-only values (the existing lowercase email/password names
remain supported as compatibility aliases):

```text
X_WEB_AUTOMATION_ENABLED=false
X_WEB_AUTOMATION_APPROVED_ACCOUNT=@your_account
X_LOGIN_EMAIL=
X_LOGIN_USERNAME=@your_account
X_LOGIN_PASSWORD=
X_WEB_AUTOMATION_POST_LIMIT=100
X_WEB_AUTOMATION_RUNTIME_DIR=C:\Users\YOUR_USER\AppData\Local\SignalFoundry\x-for-you
```

Process environment values take precedence, followed by `.env.local`, then
`.env`. The dotenv files do not expand `%LOCALAPPDATA%`; store a resolved
absolute path. Only `x_email` and `x_password` are accepted as lowercase
compatibility aliases; `X_LOGIN_USERNAME` remains mandatory.

The collector rejects non-empty `DEBUG`, `DEBUG_FILE`, Playwright `PW*`
variables (other than the ordinary shell `PWD`), `PLAYWRIGHT_*`, and npm
`pwdebug` controls. Those ambient controls can remove browser-operation
timeouts or send filled credential values to logging outside the collector's
allowlist; unset them before either command. Chrome is spawned with a fixed
operating-system-variable allowlist, so the `.env` credentials and unrelated
application secrets are not inherited by the browser process.

Optional bounded controls are:

```text
X_WEB_AUTOMATION_MAX_SCROLLS=60
X_WEB_AUTOMATION_MAX_NO_GROWTH_CYCLES=5
X_WEB_AUTOMATION_MAX_RUNTIME_MS=300000
X_WEB_AUTOMATION_LOAD_WAIT_MS=2500
X_WEB_AUTOMATION_STATE_TIMEOUT_MS=20000
X_WEB_AUTOMATION_INTERACTIVE_CHALLENGES=false
X_WEB_AUTOMATION_MANUAL_ACTION_TIMEOUT_MS=300000
X_WEB_AUTOMATION_INCLUDE_RAW_TEXT=false
X_WEB_AUTOMATION_SAVE_FAILURE_SCREENSHOT=true
```

Validate the exact feature flag, approved-account match, post limit, and safe
runtime paths without acquiring the profile lock, importing Playwright, or
launching Chrome locally:

```bash
npm run x:for-you:check
```

Only after written approval exists and that check succeeds, run:

```bash
npm run x:for-you:collect
```

The worker always uses headed installed Chrome with the dedicated persistent
profile. It reuses an authenticated session, uses the configured email and
password only when login is required, makes a single login attempt, confirms
the live session through the exact allowed-host profile-link handle, requires
the exact X Home route and selected English `For you` tab throughout
collection, reads only rendered articles intersecting the viewport, never
clicks timeline content, and stops safely on verification, CAPTCHA, selector
drift, external navigation, feed errors, session expiry, bounded runtime, or
lack of feed growth. Each cycle inspects at most 40 article candidates, and an
individual timeline DOM call has a two-second watchdog within the overall run
deadline. Context-wide routing blocks top-level navigation from the primary
page or any popup before it can leave the approved workflow. Chrome runs
headed with its Chromium sandbox enabled and explicit 30-second launch,
action, and navigation deadlines. Interactive challenge mode only waits for
the operator to finish the challenge manually; it never solves or bypasses
one. Eligible Home failure diagnostics contain an allowlisted page-title label,
a text-free bounded structural HTML fragment, and a masked screenshot; they do
not inspect an external page after a navigation failure.

If a crash or unconfirmed Chrome shutdown leaves the profile lock behind, first
confirm that no `chrome.exe` process uses this runtime's dedicated
`--user-data-dir`. Then remove only
`<X_WEB_AUTOMATION_RUNTIME_DIR>\locks\chrome-profile.lock`; the collector never
removes a stale lock automatically.

Local JSONL rows remain diagnostics/discovery records. Production uses only the
bounded post IDs and feed positions returned to the one-use Workflow webhook.
Official X lookup supplies authoritative author IDs, timestamps,
repost/quote references, and public metrics before a For You candidate can be
ranked.

## Verification

```bash
npm test -- --test-isolation=none
npm run build
```

## Deployment

[`vercel.json`](./vercel.json) invokes `/api/cron/daily` at 13:00 UTC. Add the
required environment variables to Vercel and deploy the version containing
migrations through `005_for_you_source_channel.sql` and the MCP routes.

The daily Vercel Workflow now performs final API research itself. It makes one
non-retried background Responses API creation attempt per database claim, polls
with durable sleeps, and can open a new claim through the existing three-attempt
queue contract. After the result is durable, it invokes the finalizer inline.
No hourly cron or ChatGPT schedule is required.

The MCP endpoint and local plugin remain available as an optional manual/future
worker path. To use that path, complete these one-time OAuth steps:

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
8. Use the plugin only when the API worker is not already processing the job;
   the database claim lease prevents both paths from owning it simultaneously.

For the complete state machine, security checks, data model, and end-to-end
operator check, see
[`CURRENT_ARCHITECTURE.md`](./CURRENT_ARCHITECTURE.md#22-required-operator-setup).
