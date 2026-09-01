import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the account-first X migration clamps and enforces production limits", async () => {
  const migration = await readFile(
    new URL(
      "../supabase/migrations/004_account_first_x_collection.sql",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(migration, /candidate_limit = least\(candidate_limit, 100\)/i);
  assert.match(migration, /ai_input_limit = least\(ai_input_limit, 100\)/i);
  assert.match(
    migration,
    /alter column candidate_limit set default 100/i,
  );
  assert.match(migration, /candidate_limit between 50 and 100/i);
  assert.match(migration, /ai_input_limit between 25 and 100/i);
  assert.match(
    migration,
    /cardinality\(followed_x_usernames\) <= 50/i,
  );
});
