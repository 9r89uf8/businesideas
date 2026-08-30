import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("the remote worker exposes exactly three authenticated tools", async () => {
  const [route, tools] = await Promise.all([
    readFile(new URL("../src/app/mcp/route.js", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/mcp/tools.js", import.meta.url), "utf8"),
  ]);

  assert.equal(tools.match(/server\.registerTool\(/g)?.length, 3);
  for (const name of [
    "claim_research_job",
    "submit_research_result",
    "report_research_failure",
  ]) {
    assert.match(tools, new RegExp(`"${name}"`));
  }
  assert.match(route, /withMcpAuth/);
  assert.match(route, /required: true/);
  assert.match(route, /maxSubscriptions: 0/);
  assert.match(route, /authenticatedHandler as GET/);
  assert.match(route, /authenticatedHandler as POST/);
  assert.match(route, /authenticatedHandler as DELETE/);
  assert.doesNotMatch(`${route}\n${tools}`, /console\.(?:log|error|warn)/);
});

test("submissions validate, hash, commit, and only then dispatch finalization", async () => {
  const tools = await readFile(
    new URL("../src/lib/mcp/tools.js", import.meta.url),
    "utf8",
  );
  const submitRpc = tools.indexOf('.rpc("submit_research_result"');
  const dispatch = tools.indexOf("await start(finalizeResearch", submitRpc);

  assert.match(tools, /validateResearchResultShape\(result\)/);
  assert.match(tools, /hashResearchJson\(normalized\)/);
  assert.ok(submitRpc >= 0);
  assert.ok(dispatch > submitRpc);
  assert.match(tools, /data\.newly_submitted \? "accepted" : "already_accepted"/);
  assert.match(tools, /p_error_code: errorCode/);
  assert.match(
    tools,
    /"research_unavailable"[\s\S]*"source_access_failed"[\s\S]*"submission_invalid"[\s\S]*"tool_error"/,
  );
});

test("the next queue check redrives a stranded durable submission", async () => {
  const tools = await readFile(
    new URL("../src/lib/mcp/tools.js", import.meta.url),
    "utf8",
  );
  const recoveryQuery = tools.indexOf('.from("research_jobs")');
  const claimRpc = tools.indexOf('.rpc("claim_pending_research_job"');

  assert.ok(recoveryQuery >= 0);
  assert.ok(claimRpc > recoveryQuery);
  assert.match(tools, /validationRedriveSeconds/);
  assert.match(
    tools,
    /status\.eq\.submitted,and\(status\.eq\.validating,validation_started_at\.lt\./,
  );
  assert.match(
    tools,
    /await start\(finalizeResearch, \[\{ jobId: stranded\.id, ownerId \}\]\)/,
  );
  assert.match(tools, /Pending research finalization was restarted/);
  assert.match(
    tools,
    /data\.newly_submitted \|\| data\.research_status === "submitted"/,
  );
});

test("OAuth metadata and owner consent use the supported Supabase flow", async () => {
  const [metadata, actions, page] = await Promise.all([
    readFile(
      new URL(
        "../src/app/.well-known/oauth-protected-resource/route.js",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL("../src/app/oauth/consent/actions.js", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../src/app/oauth/consent/page.js", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(metadata, /generateProtectedResourceMetadata/);
  assert.match(
    metadata,
    /scopes_supported: \["openid", "email", "offline_access"\]/,
  );
  assert.match(metadata, /getSupabaseAuthIssuer\(\)/);
  assert.match(actions, /getAuthorizationDetails/);
  assert.match(actions, /approveAuthorization/);
  assert.match(actions, /denyAuthorization/);
  assert.match(actions, /skipBrowserRedirect: true/);
  assert.match(actions, /details\.user\?\.id !== identity\.ownerId/);
  assert.match(page, /buildLoginRedirectPath\(returnPath\)/);
});

test("OAuth worker tokens cannot reuse owner RLS access outside MCP", async () => {
  const migration = await readFile(
    new URL(
      "../supabase/migrations/003_scheduled_research_worker.sql",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(migration, /drop policy if exists owner_only on public\.%I/i);
  assert.match(migration, /create policy owner_browser_only on public\.%I/i);
  assert.ok(
    (
      migration.match(
        /coalesce\(auth\.jwt\(\) ->> 'client_id', ''\) = ''/g,
      ) || []
    ).length >= 3,
  );
  assert.match(
    migration,
    /revoke all on function public\.claim_pending_research_job[\s\S]*from public, anon, authenticated/i,
  );
  assert.match(
    migration,
    /return jsonb_build_object\('claims', claims\)/i,
  );
  assert.match(
    migration,
    /p_error_code is null or p_error_code not in/i,
  );
  assert.doesNotMatch(
    migration,
    /return jsonb_set\(event, '\{claims\}'/i,
  );
});
