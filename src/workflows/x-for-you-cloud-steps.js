import "server-only";

import {
  DescribeInstancesCommand,
  EC2Client,
  StartInstancesCommand,
  StopInstancesCommand,
} from "@aws-sdk/client-ec2";
import {
  DescribeInstanceInformationCommand,
  GetCommandInvocationCommand,
  SendCommandCommand,
  SSMClient,
} from "@aws-sdk/client-ssm";
import { awsCredentialsProvider } from "@vercel/oidc-aws-credentials-provider";
import { parseForYouResultRequest } from "../lib/x/for-you-result.js";

const X_HANDLE_PATTERN = /^@[A-Za-z0-9_]{1,15}$/;
const AWS_REGION_PATTERN = /^[a-z]{2}(?:-[a-z0-9]+)+-[1-9][0-9]*$/;
const INSTANCE_ID_PATTERN = /^i-(?:[0-9a-f]{8}|[0-9a-f]{17})$/;
const COMMAND_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WEBHOOK_PATH_PATTERN =
  /^\/\.well-known\/workflow\/v1\/webhook\/[A-Za-z0-9_-]{16,512}$/;
const DNS_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const EC2_STATES = new Set([
  "pending",
  "running",
  "shutting-down",
  "terminated",
  "stopping",
  "stopped",
]);
const PENDING_COMMAND_STATUSES = new Set([
  "Pending",
  "InProgress",
  "Delayed",
  "Cancelling",
]);
const FAILED_COMMAND_STATUSES = new Set([
  "Cancelled",
  "TimedOut",
  "Failed",
]);
const ACTIVE_STATUS = Object.freeze({ status: "enabled" });
const DISABLED_STATUS = Object.freeze({ status: "disabled" });
const SSM_EXECUTION_TIMEOUT_SECONDS = 1_200;
const PINNED_AWS_TARGET = Object.freeze({
  region: "us-east-2",
  instanceId: "i-064c47109859601d1",
});
const VERCEL_AWS_ROLE_ARN =
  "arn:aws:iam::563561751769:role/signal-foundry-vercel-x-for-you";

let testDependencies = null;

export class XForYouCloudStepError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "XForYouCloudStepError";
    this.code = code;
  }
}

function cloudError(code, message) {
  return new XForYouCloudStepError(code, message);
}

/**
 * Installs process-local fakes without adding unserializable clients to any
 * Workflow step arguments. The returned function restores the prior state.
 */
export function setXForYouCloudDependenciesForTests(dependencies) {
  if (
    dependencies !== null &&
    (!dependencies || typeof dependencies !== "object")
  ) {
    throw new TypeError("Test cloud dependencies must be an object or null.");
  }

  const previous = testDependencies;
  testDependencies = dependencies ? { ...dependencies } : null;
  return () => {
    testDependencies = previous;
  };
}

function runtimeEnvironment() {
  return testDependencies?.env ?? process.env;
}

function clientWithSend(kind, region) {
  const injectedClient = testDependencies?.[`${kind}Client`];
  if (injectedClient) {
    if (typeof injectedClient.send !== "function") {
      throw cloudError(
        "AWS_CLIENT_INVALID",
        "The X For You cloud client is unavailable.",
      );
    }
    return injectedClient;
  }

  const injectedSend = testDependencies?.[`${kind}Send`];
  if (typeof injectedSend === "function") {
    return { send: (command) => injectedSend(command, { region }) };
  }

  const options = {
    region,
    maxAttempts: 1,
    credentials: awsCredentialsProvider({
      roleArn: VERCEL_AWS_ROLE_ARN,
      roleSessionName: "signal-foundry-x-for-you",
      durationSeconds: 900,
      clientConfig: { region },
    }),
  };
  return kind === "ec2" ? new EC2Client(options) : new SSMClient(options);
}

async function sendAws(client, command, code) {
  try {
    return await client.send(command);
  } catch {
    throw cloudError(code, "The X For You cloud operation failed.");
  }
}

function isAwsErrorNamed(error, name) {
  return (
    error?.name === name ||
    error?.Code === name ||
    error?.code === name
  );
}

export function resolveXForYouCloudActivation(env = process.env) {
  if (env?.X_WEB_AUTOMATION_ENABLED !== "true") {
    return Object.freeze({ enabled: false });
  }

  const approvedAccount = env.X_WEB_AUTOMATION_APPROVED_ACCOUNT;
  if (!X_HANDLE_PATTERN.test(approvedAccount || "")) {
    throw cloudError(
      "ACTIVATION_INVALID",
      "The X For You activation configuration is invalid.",
    );
  }

  return Object.freeze({ enabled: true, approvedAccount });
}

function validateAwsTarget(target) {
  const region = target?.region;
  const instanceId = target?.instanceId;
  if (
    typeof region !== "string" ||
    region.length > 32 ||
    !AWS_REGION_PATTERN.test(region) ||
    !INSTANCE_ID_PATTERN.test(instanceId || "")
  ) {
    throw cloudError(
      "AWS_TARGET_INVALID",
      "The X For You AWS target configuration is invalid.",
    );
  }
  return Object.freeze({ region, instanceId });
}

function resolveActiveCloudConfig() {
  const env = runtimeEnvironment();
  const activation = resolveXForYouCloudActivation(env);
  if (!activation.enabled) return activation;
  return Object.freeze({
    ...activation,
    ...PINNED_AWS_TARGET,
  });
}

function requireCommandId(value) {
  if (!COMMAND_ID_PATTERN.test(value || "")) {
    throw cloudError(
      "COMMAND_ID_INVALID",
      "The X For You cloud command identifier is invalid.",
    );
  }
  return value;
}

function validDnsHostname(hostname) {
  const unwrapped = hostname.replace(/^\[|\]$/g, "");
  const ipv4Parts = unwrapped.split(".");
  const isIpv4 =
    ipv4Parts.length === 4 &&
    ipv4Parts.every(
      (part) => /^\d{1,3}$/.test(part) && Number(part) <= 255,
    );
  const isIpLiteral = unwrapped.includes(":") || isIpv4;

  return (
    hostname.length >= 4 &&
    hostname.length <= 253 &&
    !hostname.endsWith(".") &&
    !hostname.toLowerCase().endsWith(".local") &&
    hostname.toLowerCase() !== "localhost" &&
    !isIpLiteral &&
    hostname.split(".").length >= 2 &&
    hostname.split(".").every((label) => DNS_LABEL_PATTERN.test(label))
  );
}

export function validateOneUseResultUrl(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 2_048 ||
    /[\0\r\n]/.test(value)
  ) {
    throw cloudError(
      "RESULT_URL_INVALID",
      "The X For You result URL is invalid.",
    );
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw cloudError(
      "RESULT_URL_INVALID",
      "The X For You result URL is invalid.",
    );
  }

  if (
    url.href !== value ||
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !validDnsHostname(url.hostname) ||
    !WEBHOOK_PATH_PATTERN.test(url.pathname)
  ) {
    throw cloudError(
      "RESULT_URL_INVALID",
      "The X For You result URL is invalid.",
    );
  }

  return url.href;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function buildCollectorShellCommand({ approvedAccount, resultUrl }) {
  return [
    "set -eu",
    "set +x",
    "umask 077",
    "/usr/sbin/shutdown -h +20 >/dev/null 2>&1 || true",
    "stop_worker() { /usr/sbin/shutdown -h now >/dev/null 2>&1 || true; }",
    "trap stop_worker EXIT",
    `export X_WEB_AUTOMATION_ENABLED=${shellQuote("true")}`,
    `export X_WEB_AUTOMATION_APPROVED_ACCOUNT=${shellQuote(approvedAccount)}`,
    `export X_FOR_YOU_RESULT_URL=${shellQuote(resultUrl)}`,
    "/usr/local/bin/signal-foundry-x-for-you >/dev/null 2>&1",
  ].join("\n");
}

function normalizeEc2State(value) {
  return EC2_STATES.has(value) ? value : "unknown";
}

function findConfiguredInstance(response, instanceId) {
  const matches = [];
  for (const reservation of response?.Reservations ?? []) {
    for (const instance of reservation?.Instances ?? []) {
      if (instance?.InstanceId === instanceId) matches.push(instance);
    }
  }
  if (matches.length !== 1) {
    throw cloudError(
      "INSTANCE_UNAVAILABLE",
      "The X For You cloud instance is unavailable.",
    );
  }
  return matches[0];
}

async function describeConfiguredInstance(config, ec2Client) {
  const response = await sendAws(
    ec2Client,
    new DescribeInstancesCommand({ InstanceIds: [config.instanceId] }),
    "INSTANCE_DESCRIBE_FAILED",
  );
  return findConfiguredInstance(response, config.instanceId);
}

export async function readXForYouCloudActivation() {
  "use step";

  const config = resolveActiveCloudConfig();
  return config.enabled
    ? Object.freeze({
        ...ACTIVE_STATUS,
        approvedAccount: config.approvedAccount,
        region: config.region,
        instanceId: config.instanceId,
      })
    : DISABLED_STATUS;
}
readXForYouCloudActivation.maxRetries = 0;

export async function parseXForYouCloudResult(request) {
  "use step";

  return parseForYouResultRequest(request);
}
parseXForYouCloudResult.maxRetries = 0;

export async function startXForYouCloudInstance() {
  "use step";

  const config = resolveActiveCloudConfig();
  if (!config.enabled) return DISABLED_STATUS;

  const response = await sendAws(
    clientWithSend("ec2", config.region),
    new StartInstancesCommand({ InstanceIds: [config.instanceId] }),
    "INSTANCE_START_FAILED",
  );
  const change = (response?.StartingInstances ?? []).find(
    (item) => item?.InstanceId === config.instanceId,
  );
  const state = normalizeEc2State(change?.CurrentState?.Name);
  if (!change || !["pending", "running"].includes(state)) {
    throw cloudError(
      "INSTANCE_START_FAILED",
      "The X For You cloud instance could not be started.",
    );
  }

  return Object.freeze({
    status: state === "running" ? "running" : "starting",
    instanceId: config.instanceId,
  });
}
startXForYouCloudInstance.maxRetries = 2;

export async function inspectXForYouCloudReadiness() {
  "use step";

  const config = resolveActiveCloudConfig();
  if (!config.enabled) return DISABLED_STATUS;

  const instance = await describeConfiguredInstance(
    config,
    clientWithSend("ec2", config.region),
  );
  const instanceState = normalizeEc2State(instance?.State?.Name);
  if (instanceState !== "running") {
    return Object.freeze({
      status: "pending",
      instanceId: config.instanceId,
      instanceState,
      ssmStatus: "not_checked",
    });
  }

  let response;
  try {
    response = await clientWithSend("ssm", config.region).send(
      new DescribeInstanceInformationCommand({
        Filters: [{ Key: "InstanceIds", Values: [config.instanceId] }],
        MaxResults: 5,
      }),
    );
  } catch (error) {
    if (isAwsErrorNamed(error, "InvalidInstanceId")) {
      return Object.freeze({
        status: "pending",
        instanceId: config.instanceId,
        instanceState,
        ssmStatus: "offline",
      });
    }
    throw cloudError(
      "SSM_READINESS_FAILED",
      "The X For You cloud readiness status is unavailable.",
    );
  }
  const information = (response?.InstanceInformationList ?? []).find(
    (item) => item?.InstanceId === config.instanceId,
  );
  const ssmStatus = information?.PingStatus === "Online" ? "online" : "offline";

  return Object.freeze({
    status: ssmStatus === "online" ? "ready" : "pending",
    instanceId: config.instanceId,
    instanceState,
    ssmStatus,
  });
}
inspectXForYouCloudReadiness.maxRetries = 3;

export async function sendXForYouCloudCollection({ resultUrl } = {}) {
  "use step";

  const config = resolveActiveCloudConfig();
  if (!config.enabled) return DISABLED_STATUS;
  const validatedUrl = validateOneUseResultUrl(resultUrl);
  const command = buildCollectorShellCommand({
    approvedAccount: config.approvedAccount,
    resultUrl: validatedUrl,
  });

  const response = await sendAws(
    clientWithSend("ssm", config.region),
    new SendCommandCommand({
      DocumentName: "AWS-RunShellScript",
      InstanceIds: [config.instanceId],
      Parameters: {
        commands: [command],
        executionTimeout: [String(SSM_EXECUTION_TIMEOUT_SECONDS)],
      },
      TimeoutSeconds: SSM_EXECUTION_TIMEOUT_SECONDS,
      Comment: "Signal Foundry X For You collection",
    }),
    "COMMAND_SEND_FAILED",
  );
  const commandId = requireCommandId(response?.Command?.CommandId);

  return Object.freeze({ status: "sent", commandId });
}
// SendCommand has no idempotency token. Never allow Workflow to repeat it.
sendXForYouCloudCollection.maxRetries = 0;

export async function inspectXForYouCloudCommand({ commandId } = {}) {
  "use step";

  const config = resolveActiveCloudConfig();
  if (!config.enabled) return DISABLED_STATUS;
  const validatedCommandId = requireCommandId(commandId);

  let response;
  try {
    response = await clientWithSend("ssm", config.region).send(
      new GetCommandInvocationCommand({
        CommandId: validatedCommandId,
        InstanceId: config.instanceId,
      }),
    );
  } catch (error) {
    if (isAwsErrorNamed(error, "InvocationDoesNotExist")) {
      return Object.freeze({
        status: "pending",
        commandId: validatedCommandId,
      });
    }
    throw cloudError(
      "COMMAND_STATUS_FAILED",
      "The X For You cloud command status is unavailable.",
    );
  }

  if (
    response?.CommandId !== validatedCommandId ||
    response?.InstanceId !== config.instanceId
  ) {
    throw cloudError(
      "COMMAND_STATUS_FAILED",
      "The X For You cloud command status is unavailable.",
    );
  }

  if (PENDING_COMMAND_STATUSES.has(response.Status)) {
    return Object.freeze({
      status: "pending",
      commandId: validatedCommandId,
    });
  }
  if (response.Status === "Success") {
    return Object.freeze({
      status: "succeeded",
      commandId: validatedCommandId,
    });
  }
  if (FAILED_COMMAND_STATUSES.has(response.Status)) {
    return Object.freeze({
      status: "failed",
      commandId: validatedCommandId,
    });
  }

  throw cloudError(
    "COMMAND_STATUS_FAILED",
    "The X For You cloud command status is unavailable.",
  );
}
inspectXForYouCloudCommand.maxRetries = 3;

export async function stopXForYouCloudInstance(target) {
  "use step";

  let config;
  if (target !== undefined) {
    if (
      !target ||
      typeof target !== "object" ||
      Array.isArray(target) ||
      Object.keys(target).length !== 2
    ) {
      throw cloudError(
        "AWS_TARGET_INVALID",
        "The X For You AWS target configuration is invalid.",
      );
    }
    config = validateAwsTarget(target);
  } else {
    config = resolveActiveCloudConfig();
    if (!config.enabled) return DISABLED_STATUS;
  }

  const response = await sendAws(
    clientWithSend("ec2", config.region),
    new StopInstancesCommand({
      InstanceIds: [config.instanceId],
      Force: false,
      Hibernate: false,
    }),
    "INSTANCE_STOP_FAILED",
  );
  const change = (response?.StoppingInstances ?? []).find(
    (item) => item?.InstanceId === config.instanceId,
  );
  const state = normalizeEc2State(change?.CurrentState?.Name);
  if (!change || !["stopping", "stopped"].includes(state)) {
    throw cloudError(
      "INSTANCE_STOP_FAILED",
      "The X For You cloud instance could not be stopped.",
    );
  }

  return Object.freeze({
    status: state,
    instanceId: config.instanceId,
  });
}
stopXForYouCloudInstance.maxRetries = 3;
