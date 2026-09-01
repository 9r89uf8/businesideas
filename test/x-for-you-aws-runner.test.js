import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildAwsCliEnvironment,
  deliverAwsCollectorResult,
  fetchAwsCollectorSecret,
  normalizeForYouResultUrl,
  parseAwsCollectorSecret,
  runAwsCollectorCommand,
} from "../src/lib/x/for-you/aws-runner.js";
import { COLLECTOR_COMMAND_MODES } from "../src/lib/x/for-you/command.js";
import {
  X_FOR_YOU_ERROR_CODES,
  XForYouSafetyError,
} from "../src/lib/x/for-you/errors.js";

function syntheticSecret() {
  return {
    email: "collector@example.test",
    username: "@SignalFoundry",
    password: "synthetic-password",
  };
}

async function createAwsFixture() {
  const root = await mkdtemp(join(tmpdir(), "tx1000-x-aws-"));
  const repositoryRoot = join(root, "repository");
  const runtimeDirectory = join(root, "runtime");
  await mkdir(repositoryRoot, { recursive: true });
  return {
    root,
    repositoryRoot,
    runtimeDirectory,
    env: {
      X_WEB_AUTOMATION_ENABLED: "true",
      X_WEB_AUTOMATION_APPROVED_ACCOUNT: "@SignalFoundry",
      X_FOR_YOU_AWS_SECRET_ID: "signal-foundry/x-for-you",
      X_FOR_YOU_RESULT_URL:
        "https://signal-foundry.vercel.app/.well-known/workflow/v1/webhook/abcdefghijklmnop",
      X_WEB_AUTOMATION_POST_LIMIT: "25",
      X_WEB_AUTOMATION_RUNTIME_DIR: runtimeDirectory,
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("AWS secret parsing accepts only bounded collector material", () => {
  const secret = syntheticSecret();
  const parsed = parseAwsCollectorSecret(JSON.stringify({
    X_LOGIN_EMAIL: secret.email,
    X_LOGIN_USERNAME: secret.username,
    X_LOGIN_PASSWORD: secret.password,
  }));
  assert.equal(parsed.username, "@SignalFoundry");
  assert.equal(parsed.password, "synthetic-password");

  for (const invalid of [
    "not-json",
    JSON.stringify({
      X_LOGIN_EMAIL: "collector@example.test",
      X_LOGIN_USERNAME: "wrong-handle",
      X_LOGIN_PASSWORD: "synthetic-password",
    }),
    JSON.stringify({
      X_LOGIN_EMAIL: "collector@example.test",
      X_LOGIN_USERNAME: "@SignalFoundry",
      X_LOGIN_PASSWORD: "",
    }),
    JSON.stringify({
      X_LOGIN_EMAIL: "collector@example.test",
      X_LOGIN_USERNAME: "@SignalFoundry",
      X_LOGIN_PASSWORD: "synthetic-password",
      status: "approved",
    }),
  ]) {
    assert.throws(
      () => parseAwsCollectorSecret(invalid),
      (error) => error?.code === X_FOR_YOU_ERROR_CODES.AWS_SECRET_UNAVAILABLE,
    );
  }
});

test("AWS CLI receives no application or static credential environment", () => {
  const cliEnvironment = buildAwsCliEnvironment({
    PATH: "/usr/bin",
    HOME: "/var/lib/signal-foundry-x",
    AWS_REGION: "us-east-2",
    AWS_ACCESS_KEY_ID: "static-access-key",
    AWS_SECRET_ACCESS_KEY: "static-secret-key",
    X_LOGIN_PASSWORD: "x-password",
    OPENAI_API_KEY: "openai-secret",
  });
  assert.deepEqual(cliEnvironment, {
    AWS_REGION: "us-east-2",
    HOME: "/var/lib/signal-foundry-x",
    PATH: "/usr/bin",
    AWS_CLI_AUTO_PROMPT: "off",
    AWS_PAGER: "",
  });
  assert.doesNotMatch(JSON.stringify(cliEnvironment), /password|access-key|secret/i);
});

test("Secrets Manager lookup uses argv without a shell", async () => {
  const secret = syntheticSecret();
  let invocation = null;
  const parsed = await fetchAwsCollectorSecret({
    secretId: "signal-foundry/x-for-you",
    env: { PATH: "/usr/bin", AWS_REGION: "us-east-2" },
    async execFile(file, args, options) {
      invocation = { file, args, options };
      return {
        stdout: JSON.stringify({
          SecretString: JSON.stringify({
            X_LOGIN_EMAIL: secret.email,
            X_LOGIN_USERNAME: secret.username,
            X_LOGIN_PASSWORD: secret.password,
          }),
        }),
        stderr: "",
      };
    },
  });

  assert.equal(parsed.username, "@SignalFoundry");
  assert.equal(invocation.file, "aws");
  assert.deepEqual(invocation.args, [
    "secretsmanager",
    "get-secret-value",
    "--secret-id",
    "signal-foundry/x-for-you",
    "--output",
    "json",
  ]);
  assert.equal(invocation.options.shell, undefined);
  assert.equal(invocation.options.env.X_LOGIN_PASSWORD, undefined);
});

test("disabled AWS invocation stops before Secrets Manager", async () => {
  let secretReads = 0;
  const events = [];
  const result = await runAwsCollectorCommand({
    env: { X_WEB_AUTOMATION_ENABLED: "false" },
    async fetchSecret() {
      secretReads += 1;
      throw new Error("must not read secret");
    },
    log(event, fields) {
      events.push({ event, fields });
    },
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.errorCode, X_FOR_YOU_ERROR_CODES.FEATURE_DISABLED);
  assert.equal(secretReads, 0);
  assert.deepEqual(events, [{
    event: "PERMISSION_DENIED",
    fields: { errorCode: X_FOR_YOU_ERROR_CODES.FEATURE_DISABLED },
  }]);
});

test("AWS invocation without a valid approved account stops before Secrets Manager", async () => {
  let secretReads = 0;
  for (const approvedAccount of [undefined, "SignalFoundry"]) {
    const result = await runAwsCollectorCommand({
      mode: COLLECTOR_COMMAND_MODES.CHECK,
      env: {
        X_WEB_AUTOMATION_ENABLED: "true",
        X_WEB_AUTOMATION_APPROVED_ACCOUNT: approvedAccount,
        X_FOR_YOU_AWS_SECRET_ID: "signal-foundry/x-for-you",
      },
      async fetchSecret() {
        secretReads += 1;
        throw new Error("must not read secret");
      },
    });
    assert.equal(
      result.errorCode,
      X_FOR_YOU_ERROR_CODES.AWS_CONFIGURATION_INVALID,
    );
  }
  assert.equal(secretReads, 0);
});

test("AWS invocation rejects an approved account that differs from the secret username", async (t) => {
  const fixture = await createAwsFixture();
  t.after(fixture.cleanup);
  let commandCalls = 0;
  const result = await runAwsCollectorCommand({
    mode: COLLECTOR_COMMAND_MODES.CHECK,
    env: fixture.env,
    repositoryRoot: fixture.repositoryRoot,
    fetchSecret: async () => ({
      ...syntheticSecret(),
      username: "@OtherAccount",
    }),
    async executeCommand() {
      commandCalls += 1;
    },
  });
  assert.equal(
    result.errorCode,
    X_FOR_YOU_ERROR_CODES.APPROVED_ACCOUNT_MISMATCH,
  );
  assert.equal(commandCalls, 0);
});

test("invalid Workflow result configuration stops before Secrets Manager", async () => {
  let secretReads = 0;
  const result = await runAwsCollectorCommand({
    mode: COLLECTOR_COMMAND_MODES.COLLECT,
    env: {
      X_WEB_AUTOMATION_ENABLED: "true",
      X_WEB_AUTOMATION_APPROVED_ACCOUNT: "@SignalFoundry",
      X_FOR_YOU_AWS_SECRET_ID: "signal-foundry/x-for-you",
      X_FOR_YOU_RESULT_URL: "https://example.test/output",
    },
    async fetchSecret() {
      secretReads += 1;
      throw new Error("must not read secret");
    },
  });
  assert.equal(result.exitCode, 2);
  assert.equal(
    result.errorCode,
    X_FOR_YOU_ERROR_CODES.AWS_CONFIGURATION_INVALID,
  );
  assert.equal(secretReads, 0);
});

test("AWS check passes credentials and per-call authorization without starting collection", async (t) => {
  const fixture = await createAwsFixture();
  t.after(fixture.cleanup);
  const secret = syntheticSecret();
  let receivedEnvironment = null;
  let deliveryCalls = 0;

  const result = await runAwsCollectorCommand({
    mode: COLLECTOR_COMMAND_MODES.CHECK,
    env: fixture.env,
    repositoryRoot: fixture.repositoryRoot,
    async fetchSecret() {
      return secret;
    },
    async executeCommand({ mode, env }) {
      assert.equal(mode, COLLECTOR_COMMAND_MODES.CHECK);
      receivedEnvironment = env;
      return Object.freeze({ exitCode: 0, status: "approved" });
    },
    async deliverResult() {
      deliveryCalls += 1;
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(deliveryCalls, 0);
  assert.equal(receivedEnvironment.X_LOGIN_EMAIL, secret.email);
  assert.equal(receivedEnvironment.X_LOGIN_PASSWORD, secret.password);
  assert.equal(
    receivedEnvironment.X_WEB_AUTOMATION_APPROVED_ACCOUNT,
    "@SignalFoundry",
  );
  assert.equal(receivedEnvironment.X_FOR_YOU_AWS_SECRET_ID, undefined);
  assert.equal(
    receivedEnvironment.X_WEB_AUTOMATION_INTERACTIVE_CHALLENGES,
    "false",
  );
});

test("AWS collection delivers only the completed outcome to the one-use Workflow URL", async (t) => {
  const fixture = await createAwsFixture();
  t.after(fixture.cleanup);
  const calls = [];
  const result = await runAwsCollectorCommand({
    mode: COLLECTOR_COMMAND_MODES.COLLECT,
    env: fixture.env,
    repositoryRoot: fixture.repositoryRoot,
    fetchSecret: async () => syntheticSecret(),
    executeCommand: async () => Object.freeze({
      exitCode: 0,
      status: "completed",
      outcome: Object.freeze({
        metadata: Object.freeze({ runId: "collector-run-1" }),
        candidates: Object.freeze([
          Object.freeze({ postId: "101", feedPosition: 1 }),
        ]),
      }),
    }),
    async deliverResult(options) {
      calls.push(options);
      return true;
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].resultUrl,
    fixture.env.X_FOR_YOU_RESULT_URL,
  );
  assert.deepEqual(calls[0].outcome.candidates, [
    { postId: "101", feedPosition: 1 },
  ]);
});

test("AWS collection delivers a safe terminal failure to the one-use Workflow URL", async (t) => {
  const fixture = await createAwsFixture();
  t.after(fixture.cleanup);
  const calls = [];
  const result = await runAwsCollectorCommand({
    mode: COLLECTOR_COMMAND_MODES.COLLECT,
    env: fixture.env,
    repositoryRoot: fixture.repositoryRoot,
    fetchSecret: async () => syntheticSecret(),
    executeCommand: async () => Object.freeze({
      exitCode: 1,
      status: "failed",
      errorCode: "MANUAL_ACTION_REQUIRED",
    }),
    async deliverResult(options) {
      calls.push(options);
      return true;
    },
  });

  assert.deepEqual(result, {
    exitCode: 1,
    status: "failed",
    errorCode: "MANUAL_ACTION_REQUIRED",
  });
  assert.deepEqual(calls, [{
    resultUrl: fixture.env.X_FOR_YOU_RESULT_URL,
    errorCode: "MANUAL_ACTION_REQUIRED",
  }]);
});

test("AWS setup failures use a validated callback without exposing details", async (t) => {
  const fixture = await createAwsFixture();
  t.after(fixture.cleanup);
  const calls = [];
  const failure = new Error("synthetic secret details");
  failure.code = X_FOR_YOU_ERROR_CODES.AWS_SECRET_UNAVAILABLE;

  const result = await runAwsCollectorCommand({
    mode: COLLECTOR_COMMAND_MODES.COLLECT,
    env: fixture.env,
    repositoryRoot: fixture.repositoryRoot,
    async fetchSecret() {
      throw failure;
    },
    async deliverResult(options) {
      calls.push(options);
      return true;
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(
    result.errorCode,
    X_FOR_YOU_ERROR_CODES.AWS_SECRET_UNAVAILABLE,
  );
  assert.deepEqual(calls, [{
    resultUrl: fixture.env.X_FOR_YOU_RESULT_URL,
    errorCode: X_FOR_YOU_ERROR_CODES.AWS_SECRET_UNAVAILABLE,
  }]);
  assert.doesNotMatch(JSON.stringify(calls), /synthetic secret details/);
});

test("a failed one-use callback is never attempted twice", async (t) => {
  const fixture = await createAwsFixture();
  t.after(fixture.cleanup);
  let deliveryCalls = 0;

  const result = await runAwsCollectorCommand({
    mode: COLLECTOR_COMMAND_MODES.COLLECT,
    env: fixture.env,
    repositoryRoot: fixture.repositoryRoot,
    fetchSecret: async () => syntheticSecret(),
    executeCommand: async () => Object.freeze({
      exitCode: 1,
      status: "failed",
      errorCode: "SESSION_EXPIRED",
    }),
    async deliverResult() {
      deliveryCalls += 1;
      throw new XForYouSafetyError(
        X_FOR_YOU_ERROR_CODES.AWS_RESULT_DELIVERY_FAILED,
        "The AWS collector result could not be delivered.",
      );
    },
  });

  assert.equal(deliveryCalls, 1);
  assert.deepEqual(result, {
    exitCode: 2,
    status: "failed",
    errorCode: X_FOR_YOU_ERROR_CODES.AWS_RESULT_DELIVERY_FAILED,
  });
});

test("collector result delivery posts only IDs and feed positions", async () => {
  let invocation = null;
  let cancelled = false;
  const result = await deliverAwsCollectorResult({
    resultUrl:
      "https://signal-foundry.vercel.app/.well-known/workflow/v1/webhook/abcdefghijklmnop",
    outcome: {
      metadata: { runId: "collector-run-1", ignored: "metadata" },
      candidates: [{ postId: "101", feedPosition: 1 }],
      ignored: "local output paths",
    },
    async fetchImpl(url, options) {
      invocation = { url, options };
      return {
        status: 202,
        body: {
          async cancel() {
            cancelled = true;
          },
        },
      };
    },
  });
  assert.equal(result, true);
  assert.equal(cancelled, true);
  assert.equal(invocation.options.method, "POST");
  assert.equal(invocation.options.redirect, "error");
  assert.equal(invocation.options.cache, "no-store");
  assert.deepEqual(JSON.parse(invocation.options.body), {
    collectorRunId: "collector-run-1",
    candidates: [{ postId: "101", feedPosition: 1 }],
  });
  assert.doesNotMatch(invocation.options.body, /ignored|metadata|output/i);
});

test("collector failure delivery posts only an allowlisted error code", async () => {
  const bodies = [];
  for (const errorCode of ["SESSION_EXPIRED", "unsafe secret detail"]) {
    await deliverAwsCollectorResult({
      resultUrl:
        "https://signal-foundry.vercel.app/.well-known/workflow/v1/webhook/abcdefghijklmnop",
      errorCode,
      async fetchImpl(_url, options) {
        bodies.push(JSON.parse(options.body));
        return { status: 202, body: { cancel: async () => {} } };
      },
    });
  }

  assert.deepEqual(bodies, [
    {
      status: "failed",
      errorCode: "SESSION_EXPIRED",
      candidates: [],
    },
    {
      status: "failed",
      errorCode: "COLLECTOR_FAILED",
      candidates: [],
    },
  ]);
  assert.doesNotMatch(JSON.stringify(bodies), /unsafe secret detail/);
});

test("Workflow result URL normalization accepts only a one-use HTTPS webhook", () => {
  assert.equal(
    normalizeForYouResultUrl(
      "https://signal-foundry.vercel.app/.well-known/workflow/v1/webhook/abcdefghijklmnop",
    ),
    "https://signal-foundry.vercel.app/.well-known/workflow/v1/webhook/abcdefghijklmnop",
  );
  for (const value of [
    "http://signal-foundry.vercel.app/.well-known/workflow/v1/webhook/abcdefghijklmnop",
    "https://example.com/output",
    "https://user:password@example.com/.well-known/workflow/v1/webhook/abcdefghijklmnop",
    "https://example.com/.well-known/workflow/v1/webhook/short",
    "https://example.com/.well-known/workflow/v1/webhook/abcdefghijklmnop?copy=1",
  ]) {
    assert.throws(
      () => normalizeForYouResultUrl(value),
      (error) => error?.code === X_FOR_YOU_ERROR_CODES.AWS_CONFIGURATION_INVALID,
    );
  }
});

test("the AWS entry graph keeps Playwright behind the collector gate", async () => {
  const [entrySource, runnerSource] = await Promise.all([
    readFile(new URL("../scripts/run-x-for-you-aws.js", import.meta.url), "utf8"),
    readFile(
      new URL("../src/lib/x/for-you/aws-runner.js", import.meta.url),
      "utf8",
    ),
  ]);
  assert.doesNotMatch(
    entrySource,
    /playwright|\/for-you\/(?:runner|browser)\.js/i,
  );
  assert.doesNotMatch(runnerSource, /playwright-core|\.\/runner\.js|\.\/browser\.js/i);
  assert.match(runnerSource, /executeCollectorCommand/);
});

test("the EC2 launcher accepts authorization only from each invocation", async () => {
  const [
    launcher,
    setup,
    bootstrap,
    exampleEnvironment,
    autoStopService,
    autoStopTimer,
  ] = await Promise.all([
    readFile(
      new URL("../deploy/aws/x-for-you/run.sh", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../scripts/setup-x-for-you-aws.sh", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL(
        "../deploy/aws/x-for-you/bootstrap-disabled-worker.sh",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../deploy/aws/x-for-you/x-for-you.env.example",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../deploy/aws/x-for-you/signal-foundry-x-for-you-auto-stop.service",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../deploy/aws/x-for-you/signal-foundry-x-for-you-auto-stop.timer",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);

  assert.match(launcher, /set \+x/);
  assert.match(launcher, /runuser/);
  assert.match(launcher, /env -i/);
  assert.match(launcher, /xvfb-run/);
  assert.match(launcher, /X_WEB_AUTOMATION_ENABLED/);
  assert.match(launcher, /X_WEB_AUTOMATION_APPROVED_ACCOUNT/);
  assert.match(launcher, /X_FOR_YOU_RESULT_URL/);
  const capture = launcher.indexOf(
    "read -r -d '' invocation_enabled",
  );
  const configLoad = launcher.indexOf('source "${config_file}"');
  const restore = launcher.indexOf(
    'export X_WEB_AUTOMATION_ENABLED="${invocation_enabled}"',
  );
  assert.ok(capture >= 0 && capture < configLoad && configLoad < restore);
  assert.doesNotMatch(
    launcher.slice(capture, configLoad),
    /if \(\s*! IFS= read/,
  );
  const cleanEnvironmentStart = launcher.indexOf("/usr/bin/env -i");
  const recursiveLauncherCall = launcher.indexOf('"$0" "$@"');
  assert.ok(
    cleanEnvironmentStart >= 0 &&
      cleanEnvironmentStart < recursiveLauncherCall,
  );
  assert.doesNotMatch(
    launcher.slice(cleanEnvironmentStart, recursiveLauncherCall),
    /X_WEB_AUTOMATION_|X_FOR_YOU_RESULT_URL/,
  );
  assert.match(launcher, /printf '%s\\0%s\\0%s\\0'/);
  assert.doesNotMatch(launcher, /X_LOGIN_(?:EMAIL|PASSWORD)\s*=/);
  assert.match(setup, /\/var\/lib\/signal-foundry\/\*/);
  assert.match(setup, /runtime path is unsafe/);
  assert.doesNotMatch(setup, /X_LOGIN_(?:EMAIL|PASSWORD)\s*=/);
  for (const installer of [setup, bootstrap]) {
    assert.match(installer, /repository_directory\}" != \/opt\/signal-foundry/);
    assert.match(
      installer,
      /systemctl enable --now signal-foundry-x-for-you-auto-stop\.timer/,
    );
  }
  assert.match(autoStopService, /ExecStart=\/usr\/sbin\/shutdown -h now/);
  assert.match(autoStopTimer, /OnBootSec=25min/);
  assert.match(
    autoStopTimer,
    /Unit=signal-foundry-x-for-you-auto-stop\.service/,
  );
  for (const persistentConfig of [setup, bootstrap, exampleEnvironment]) {
    assert.doesNotMatch(
      persistentConfig,
      /printf ['"]X_WEB_AUTOMATION_(?:ENABLED|APPROVED_ACCOUNT)|^X_WEB_AUTOMATION_(?:ENABLED|APPROVED_ACCOUNT)=/m,
    );
    assert.doesNotMatch(persistentConfig, /X_FOR_YOU_RESULT_URL/);
  }
  assert.doesNotMatch(
    exampleEnvironment,
    /X_LOGIN_(?:EMAIL|PASSWORD)|AWS_(?:ACCESS|SECRET)_KEY/,
  );
});
