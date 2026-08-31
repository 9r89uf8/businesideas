import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

import {
  DescribeInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
} from "@aws-sdk/client-ec2";
import {
  DescribeInstanceInformationCommand,
  GetCommandInvocationCommand,
  SendCommandCommand,
} from "@aws-sdk/client-ssm";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export%20default%20undefined",
      };
    }
    return nextResolve(specifier, context);
  },
});

const {
  XForYouCloudStepError,
  inspectXForYouCloudCommand,
  inspectXForYouCloudReadiness,
  parseXForYouCloudResult,
  readXForYouCloudActivation,
  resolveXForYouCloudActivation,
  sendXForYouCloudCollection,
  setXForYouCloudDependenciesForTests,
  startXForYouCloudInstance,
  stopXForYouCloudInstance,
  validateOneUseResultUrl,
} = await import("../src/workflows/x-for-you-cloud-steps.js");

const INSTANCE_ID = "i-064c47109859601d1";
const COMMAND_ID = "11111111-2222-4333-8444-555555555555";
const RESULT_URL =
  "https://signal-foundry.example.com/.well-known/workflow/v1/webhook/lJHkuMdQ2FxSFTbUMU84k";

function activeEnv(overrides = {}) {
  return {
    X_WEB_AUTOMATION_ENABLED: "true",
    X_WEB_AUTOMATION_APPROVED_ACCOUNT: "@SignalFoundry",
    ...overrides,
  };
}

async function withDependencies(dependencies, operation) {
  const restore = setXForYouCloudDependenciesForTests(dependencies);
  try {
    return await operation();
  } finally {
    restore();
  }
}

test("the exact activation flag gates every AWS call", async () => {
  for (const value of [undefined, "false", "TRUE", " true"] ) {
    let calls = 0;
    await withDependencies(
      {
        env: activeEnv({ X_WEB_AUTOMATION_ENABLED: value }),
        ec2Send: async () => {
          calls += 1;
        },
        ssmSend: async () => {
          calls += 1;
        },
      },
      async () => {
        assert.deepEqual(await readXForYouCloudActivation(), {
          status: "disabled",
        });
        assert.deepEqual(await startXForYouCloudInstance(), {
          status: "disabled",
        });
        assert.deepEqual(await inspectXForYouCloudReadiness(), {
          status: "disabled",
        });
        assert.deepEqual(
          await sendXForYouCloudCollection({ resultUrl: "not-a-url" }),
          { status: "disabled" },
        );
        assert.deepEqual(
          await inspectXForYouCloudCommand({ commandId: "not-an-id" }),
          { status: "disabled" },
        );
        assert.deepEqual(await stopXForYouCloudInstance(), {
          status: "disabled",
        });
      },
    );
    assert.equal(calls, 0);
  }
});

test("activation and cleanup targets reject non-exact values before AWS", async () => {
  assert.deepEqual(resolveXForYouCloudActivation({}), { enabled: false });
  assert.throws(
    () =>
      resolveXForYouCloudActivation({
        X_WEB_AUTOMATION_ENABLED: "true",
        X_WEB_AUTOMATION_APPROVED_ACCOUNT: "SignalFoundry",
      }),
    (error) =>
      error instanceof XForYouCloudStepError &&
      error.code === "ACTIVATION_INVALID",
  );

  let calls = 0;
  await withDependencies(
    {
      env: activeEnv(),
      ec2Send: async () => {
        calls += 1;
      },
    },
    async () => {
      await assert.rejects(stopXForYouCloudInstance({
        region: "us-east-2",
        instanceId: "i-unsafe;shutdown",
      }), (error) => {
        assert.equal(error.code, "AWS_TARGET_INVALID");
        return true;
      });
    },
  );
  assert.equal(calls, 0);
});

test("enabled activation pins the exact AWS target for guaranteed cleanup", async () => {
  const activation = await withDependencies(
    {
      env: activeEnv({
        X_FOR_YOU_AWS_REGION: "eu-west-1",
        X_FOR_YOU_AWS_INSTANCE_ID: "i-11111111111111111",
      }),
    },
    () => readXForYouCloudActivation(),
  );
  assert.deepEqual(activation, {
    status: "enabled",
    approvedAccount: "@SignalFoundry",
    region: "us-east-2",
    instanceId: INSTANCE_ID,
  });
});

test("start targets exactly one configured instance and returns bounded state", async () => {
  const result = await withDependencies(
    {
      env: activeEnv(),
      ec2Send: async (command, context) => {
        assert.ok(command instanceof StartInstancesCommand);
        assert.deepEqual(command.input, { InstanceIds: [INSTANCE_ID] });
        assert.deepEqual(context, { region: "us-east-2" });
        return {
          StartingInstances: [
            {
              InstanceId: INSTANCE_ID,
              PreviousState: { Name: "stopped" },
              CurrentState: { Name: "pending" },
            },
          ],
          ResponseMetadata: { arbitrary: "not returned" },
        };
      },
    },
    () => startXForYouCloudInstance(),
  );

  assert.deepEqual(result, { status: "starting", instanceId: INSTANCE_ID });
});

test("readiness requires both EC2 running and SSM Online", async () => {
  let ssmCalls = 0;
  const pending = await withDependencies(
    {
      env: activeEnv(),
      ec2Send: async (command) => {
        assert.ok(command instanceof DescribeInstancesCommand);
        return {
          Reservations: [
            { Instances: [{ InstanceId: INSTANCE_ID, State: { Name: "pending" } }] },
          ],
        };
      },
      ssmSend: async () => {
        ssmCalls += 1;
      },
    },
    () => inspectXForYouCloudReadiness(),
  );
  assert.deepEqual(pending, {
    status: "pending",
    instanceId: INSTANCE_ID,
    instanceState: "pending",
    ssmStatus: "not_checked",
  });
  assert.equal(ssmCalls, 0);

  const ready = await withDependencies(
    {
      env: activeEnv(),
      ec2Send: async () => ({
        Reservations: [
          { Instances: [{ InstanceId: INSTANCE_ID, State: { Name: "running" } }] },
        ],
      }),
      ssmSend: async (command) => {
        assert.ok(command instanceof DescribeInstanceInformationCommand);
        assert.deepEqual(command.input.Filters, [
          { Key: "InstanceIds", Values: [INSTANCE_ID] },
        ]);
        return {
          InstanceInformationList: [
            { InstanceId: INSTANCE_ID, PingStatus: "Online" },
          ],
        };
      },
    },
    () => inspectXForYouCloudReadiness(),
  );
  assert.deepEqual(ready, {
    status: "ready",
    instanceId: INSTANCE_ID,
    instanceState: "running",
    ssmStatus: "online",
  });

  const registering = await withDependencies(
    {
      env: activeEnv(),
      ec2Send: async () => ({
        Reservations: [
          { Instances: [{ InstanceId: INSTANCE_ID, State: { Name: "running" } }] },
        ],
      }),
      ssmSend: async () => {
        const error = new Error("agent has not registered yet");
        error.name = "InvalidInstanceId";
        throw error;
      },
    },
    () => inspectXForYouCloudReadiness(),
  );
  assert.deepEqual(registering, {
    status: "pending",
    instanceId: INSTANCE_ID,
    instanceState: "running",
    ssmStatus: "offline",
  });
});

test("collection sends one quiet shell command and never returns its result URL", async () => {
  let sentCommand;
  const result = await withDependencies(
    {
      env: activeEnv(),
      ssmClient: {
        async send(command) {
          sentCommand = command;
          return {
            Command: {
              CommandId: COMMAND_ID,
              Status: "Pending",
              Parameters: { arbitrary: "not returned" },
            },
          };
        },
      },
    },
    () => sendXForYouCloudCollection({ resultUrl: RESULT_URL }),
  );

  assert.ok(sentCommand instanceof SendCommandCommand);
  assert.equal(sentCommand.input.DocumentName, "AWS-RunShellScript");
  assert.deepEqual(sentCommand.input.InstanceIds, [INSTANCE_ID]);
  assert.equal(sentCommand.input.Parameters.commands.length, 1);
  assert.deepEqual(sentCommand.input.Parameters.executionTimeout, ["1200"]);
  assert.equal(sentCommand.input.TimeoutSeconds, 1200);
  const script = sentCommand.input.Parameters.commands[0];
  assert.match(script, /set \+x/);
  assert.match(script, /export X_WEB_AUTOMATION_ENABLED='true'/);
  assert.match(
    script,
    /export X_WEB_AUTOMATION_APPROVED_ACCOUNT='@SignalFoundry'/,
  );
  assert.match(script, /export X_FOR_YOU_RESULT_URL='https:\/\//);
  assert.match(script, /\/usr\/local\/bin\/signal-foundry-x-for-you/);
  assert.match(script, /shutdown -h \+20/);
  assert.match(script, /trap stop_worker EXIT/);
  assert.match(script, /shutdown -h now/);
  assert.match(script, />\/dev\/null 2>&1/);
  assert.doesNotMatch(script, /exec \/usr\/bin\/env/);
  assert.equal(script.includes("echo"), false);
  assert.deepEqual(result, { status: "sent", commandId: COMMAND_ID });
  assert.equal(JSON.stringify(result).includes(RESULT_URL), false);
  assert.equal(sendXForYouCloudCollection.maxRetries, 0);
});

test("the webhook parser step returns only the validated collector result", async () => {
  const body = JSON.stringify({
    collectorRunId: "collector-run-1",
    candidates: [
      { postId: "1900000000000000002", feedPosition: 2 },
      { postId: "1900000000000000001", feedPosition: 1 },
    ],
  });
  const request = new Request(RESULT_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

  assert.deepEqual(await parseXForYouCloudResult(request), {
    collectorRunId: "collector-run-1",
    candidates: [
      { postId: "1900000000000000001", feedPosition: 1 },
      { postId: "1900000000000000002", feedPosition: 2 },
    ],
  });
  assert.equal(parseXForYouCloudResult.maxRetries, 0);
});

test("result URLs are restricted to one-use HTTPS Workflow endpoints", () => {
  assert.equal(validateOneUseResultUrl(RESULT_URL), RESULT_URL);

  for (const value of [
    RESULT_URL.replace("https:", "http:"),
    "https://localhost/.well-known/workflow/v1/webhook/lJHkuMdQ2FxSFTbUMU84k",
    "https://127.0.0.1/.well-known/workflow/v1/webhook/lJHkuMdQ2FxSFTbUMU84k",
    "https://user:password@example.com/.well-known/workflow/v1/webhook/lJHkuMdQ2FxSFTbUMU84k",
    "https://example.com:8443/.well-known/workflow/v1/webhook/lJHkuMdQ2FxSFTbUMU84k",
    "https://example.com/.well-known/workflow/v1/webhook/short",
    "https://example.com/not-a-workflow-webhook/lJHkuMdQ2FxSFTbUMU84k",
    `${RESULT_URL}?token=second`,
    `${RESULT_URL}#fragment`,
    `${RESULT_URL};shutdown`,
  ]) {
    assert.throws(
      () => validateOneUseResultUrl(value),
      (error) =>
        error instanceof XForYouCloudStepError &&
        error.code === "RESULT_URL_INVALID" &&
        !error.message.includes(value),
    );
  }
});

test("command inspection treats eventual consistency and active states as pending", async () => {
  const eventual = await withDependencies(
    {
      env: activeEnv(),
      ssmSend: async (command) => {
        assert.ok(command instanceof GetCommandInvocationCommand);
        const error = new Error("not visible yet");
        error.name = "InvocationDoesNotExist";
        throw error;
      },
    },
    () => inspectXForYouCloudCommand({ commandId: COMMAND_ID }),
  );
  assert.deepEqual(eventual, { status: "pending", commandId: COMMAND_ID });

  for (const [awsStatus, expectedStatus] of [
    ["Pending", "pending"],
    ["InProgress", "pending"],
    ["Delayed", "pending"],
    ["Success", "succeeded"],
    ["Failed", "failed"],
  ]) {
    const result = await withDependencies(
      {
        env: activeEnv(),
        ssmSend: async () => ({
          CommandId: COMMAND_ID,
          InstanceId: INSTANCE_ID,
          Status: awsStatus,
          StandardOutputContent: RESULT_URL,
          StandardErrorContent: "arbitrary remote output",
        }),
      },
      () => inspectXForYouCloudCommand({ commandId: COMMAND_ID }),
    );
    assert.deepEqual(result, { status: expectedStatus, commandId: COMMAND_ID });
    assert.equal(JSON.stringify(result).includes(RESULT_URL), false);
  }
});

test("stop is idempotent for stopping and stopped instance responses", async () => {
  for (const state of ["stopping", "stopped"]) {
    const result = await withDependencies(
      {
        env: activeEnv(),
        ec2Send: async (command) => {
          assert.ok(command instanceof StopInstancesCommand);
          assert.deepEqual(command.input, {
            InstanceIds: [INSTANCE_ID],
            Force: false,
            Hibernate: false,
          });
          return {
            StoppingInstances: [
              { InstanceId: INSTANCE_ID, CurrentState: { Name: state } },
            ],
          };
        },
      },
      () => stopXForYouCloudInstance(),
    );
    assert.deepEqual(result, { status: state, instanceId: INSTANCE_ID });
  }
});

test("a pinned cleanup target still stops after the activation flag is disabled", async () => {
  let calls = 0;
  const result = await withDependencies(
    {
      env: activeEnv({ X_WEB_AUTOMATION_ENABLED: "false" }),
      ec2Send: async (command, context) => {
        calls += 1;
        assert.ok(command instanceof StopInstancesCommand);
        assert.deepEqual(context, { region: "us-east-2" });
        return {
          StoppingInstances: [
            { InstanceId: INSTANCE_ID, CurrentState: { Name: "stopping" } },
          ],
        };
      },
    },
    () => stopXForYouCloudInstance({
      region: "us-east-2",
      instanceId: INSTANCE_ID,
    }),
  );
  assert.equal(calls, 1);
  assert.deepEqual(result, { status: "stopping", instanceId: INSTANCE_ID });
});

test("AWS failures are replaced with bounded generic errors", async () => {
  await withDependencies(
    {
      env: activeEnv(),
      ec2Send: async () => {
        throw new Error("arbitrary AWS output with secret material");
      },
    },
    async () => {
      await assert.rejects(startXForYouCloudInstance(), (error) => {
        assert.ok(error instanceof XForYouCloudStepError);
        assert.equal(error.code, "INSTANCE_START_FAILED");
        assert.equal(error.message, "The X For You cloud operation failed.");
        assert.equal(error.message.includes("secret material"), false);
        return true;
      });
    },
  );
});
