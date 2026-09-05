import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const require = createRequire(import.meta.url);
const { transform, loadBindings } = require("next/dist/build/swc");
await loadBindings();

async function compileComponent(path, imports = {}) {
  const filename = new URL(path, import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const { code } = await transform(source, {
    filename,
    jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
    module: { type: "commonjs" },
  });
  const module = { exports: {} };
  new Function("module", "exports", "require", code)(module, module.exports, (id) => imports[id] || require(id));
  return module.exports;
}

const decisions = await compileComponent("../src/components/model-decisions.jsx");
const { CloudComparison } = await compileComponent("../src/components/cloud-model-decisions.jsx", {
  "@/components/model-decisions": decisions,
  "@/components/cloud-comparison-trigger": () => React.createElement("button", null, "Run cloud comparison"),
  "next/link": ({ children, ...props }) => React.createElement("a", props, children),
});
const ideaId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const report = { mode: "primary", published: true, idea_ids: [ideaId], ideas: [{ title: "A researched product" }], sources: [] };
const render = (props) => renderToStaticMarkup(React.createElement(CloudComparison, props));

test("primary completed research exposes real published idea links", () => {
  const html = render({ run: { mode: "primary", status: "completed", result: report } });
  assert.match(html, /ChatGPT cloud research/);
  assert.match(html, /Research complete/);
  assert.match(html, new RegExp(`href="/ideas/${ideaId}"`));
  assert.match(html, /A researched product/);
  assert.doesNotMatch(html, /uses API research for publication|passed comparison checks/);
});

test("historical shadow reports remain unpublished comparisons", () => {
  const html = render({ run: { mode: "shadow", status: "completed", result: { ...report, mode: "shadow", published: false } } });
  assert.match(html, /Comparison complete/);
  assert.match(html, /passed comparison checks/);
  assert.match(html, /uses API research for publication/);
  assert.doesNotMatch(html, /View published idea/);
});

test("primary runs awaiting dispatch cannot start a separate comparison", () => {
  const html = render({ primary: true, sourceRunStatus: "running", canStart: true });
  assert.match(html, /Cloud research will begin after the posts finish filtering/);
  assert.doesNotMatch(html, /Run cloud comparison/);
  const terminal = render({ primary: true, sourceRunStatus: "failed", canStart: true });
  assert.match(terminal, /No saved cloud research/);
  assert.doesNotMatch(terminal, /will begin/);
});

test("submitted results cannot advertise publication, and malformed IDs never become links", () => {
  const pending = render({ run: { mode: "primary", status: "running", phase: "validating" }, jobs: [{ kind: "research", status: "submitted", result: report }] });
  assert.match(pending, /not yet validated/);
  assert.doesNotMatch(pending, /View published idea/);
  const final = render({ run: { mode: "primary", status: "completed", result: { ...report, idea_ids: ["javascript:alert(1)"] } } });
  assert.doesNotMatch(final, /javascript:|View published idea/);
});

test("the owner comparison endpoint rejects primary runs before reading posts or dispatching", async () => {
  const filters = [];
  const db = {
    from(table) {
      assert.equal(table, "runs", "primary rejection must not read source payloads");
      return {
        select(columns) { assert.match(columns, /settings_snapshot/); return this; },
        eq(key, value) { filters.push([key, value]); return this; },
        async maybeSingle() { return { data: { id: ideaId, settings_snapshot: { ideation_provider: "chatgpt_cloud" } }, error: null }; },
      };
    },
  };
  const { POST } = await compileComponent("../src/app/api/runs/[id]/cloud-comparison/route.js", {
    "@/lib/auth": { requireOwnerForApi: async () => ({ ownerId: "owner" }) },
    "@/lib/supabase/admin": { createSupabaseAdminClient: () => db },
    "@/lib/cloud-ideation/dispatch": { startCloudComparison: () => assert.fail("primary run must not dispatch a shadow comparison") },
  });
  const response = await POST(null, { params: Promise.resolve({ id: ideaId }) });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /already uses cloud research/);
  assert.deepEqual(filters, [["id", ideaId], ["owner_id", "owner"]]);
});
