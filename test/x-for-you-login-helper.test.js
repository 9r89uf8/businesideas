import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const helperPath = path.join(
  repositoryRoot,
  "scripts",
  "open-x-for-you-login.ps1",
);

test("manual X login npm command is operator-only and parameterless", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  );
  assert.equal(
    packageJson.scripts["x:for-you:login"],
    "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/open-x-for-you-login.ps1",
  );

  const source = await readFile(helperPath, "utf8");
  assert.match(source, /\[CmdletBinding\(\)\]\s*param\(\)/);
  assert.match(source, /\$Region = "us-east-2"/);
  assert.match(source, /\$InstanceId = "i-064c47109859601d1"/);
  assert.doesNotMatch(source, /AuthorizeSecurityGroupIngress|CreateSecurityGroup/);
  const withoutHereStrings = source.replace(
    /@"\r?\n[\s\S]*?\r?\n"@/g,
    '@"<here-string>"@',
  );
  assert.doesNotMatch(withoutHereStrings, /\\\s*$/m);
});

test("manual X login never accesses collector credentials or page content", async () => {
  const source = await readFile(helperPath, "utf8");
  assert.doesNotMatch(
    source,
    /GetSecretValue|secretsmanager|X_LOGIN_(?:EMAIL|USERNAME|PASSWORD)|\.env\b/i,
  );
  assert.doesNotMatch(
    source,
    /Read-Host|ReadKey|playwright|querySelector|\.locator\(|\.fill\(|\.click\(/i,
  );
  assert.doesNotMatch(source, /create-post|send-post|tweet/i);
  assert.match(source, /Windows\.Forms\.MessageBox/);
  assert.match(source, /https:\/\/x\.com\/i\/flow\/login/);
});

test("manual X login uses only a signed temporary official SSM plugin", async () => {
  const source = await readFile(helperPath, "utf8");
  assert.match(
    source,
    /https:\/\/s3\.amazonaws\.com\/session-manager-downloads\/plugin\/latest\/windows\/SessionManagerPlugin\.zip/,
  );
  assert.match(source, /Expand-Archive[\s\S]*package\.zip[\s\S]*Expand-Archive/);
  assert.match(source, /Get-AuthenticodeSignature/);
  assert.match(source, /Amazon Web Services, Inc\./);
  assert.match(source, /\[Version\]"1\.2\.764\.0"/);
  assert.doesNotMatch(source, /install\.bat|SessionManagerPluginSetup\.exe/i);
  assert.match(source, /Remove-RestrictedTemporaryDirectory/);
});

test("manual desktop is loopback-only, bounded, and preserves the cloud profile", async () => {
  const source = await readFile(helperPath, "utf8");
  assert.match(source, /AWS-StartPortForwardingSession/);
  assert.match(source, /exec \/usr\/bin\/bash <<'SIGNAL_FOUNDRY_X_LOGIN'/);
  assert.match(source, /\.Replace\("`r`n", "`n"\)\.Replace\("`r", "`n"\)/);
  assert.match(source, /\/usr\/bin\/Xvfb[\s\S]*-nolisten tcp/);
  assert.match(source, /\/usr\/bin\/x11vnc[\s\S]*-localhost/);
  assert.match(
    source,
    /\/usr\/bin\/websockify[\s\S]*"127\.0\.0\.1:`\$\{novnc_port\}"[\s\S]*"127\.0\.0\.1:`\$\{vnc_port\}"/,
  );
  assert.doesNotMatch(source, /0\.0\.0\.0|--no-sandbox/);
  assert.match(
    source,
    /\$ChromeProfileDirectory = "\/var\/lib\/signal-foundry\/x-for-you\/chrome-profile"/,
  );
  assert.match(source, /\$MaxSessionSeconds = 900/);
  assert.match(source, /shutdown -h \+"`\$\{shutdown_lease_minutes\}"/);
  assert.match(source, /for package_name in x11vnc novnc websockify/);
  assert.match(
    source,
    /apt-get install -y[\s\S]*--no-install-recommends `\$\{temporary_packages\}/,
  );
  assert.match(source, /apt-get purge -y[\s\S]*`\$\{temporary_packages\}/);
  assert.doesNotMatch(source, /apt-get autoremove|\bautoremove\s+-/);
});

test("manual desktop owns a fail-closed profile lock and always stops EC2", async () => {
  const source = await readFile(helperPath, "utf8");
  assert.match(source, /set -o noclobber/);
  assert.ok(
    source.indexOf("set -o noclobber") <
      source.indexOf("for package_name in x11vnc novnc websockify"),
    "profile lock must be acquired before temporary package installation",
  );
  assert.match(source, /actual_lock_payload[\s\S]*== "`\$\{lock_payload\}"/);
  assert.match(source, /finally\s*\{/);
  assert.match(
    source,
    /finally\s*\{[\s\S]*"ec2", "stop-instances"[\s\S]*"ec2", "wait", "instance-stopped"/,
  );
  assert.match(source, /taskkill\.exe/);
  assert.match(source, /\/PID \(\[string\]\$Process\.Id\) \/T \/F/);
  assert.match(source, /New-RemoteStopScript/);
});
