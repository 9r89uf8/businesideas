const MAX_URL_LENGTH = 2_048;

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata",
  "instance-data",
  "metadata.google.internal",
  "metadata.google.com",
  "metadata.aws.internal",
  "metadata.azure.internal",
]);

const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home",
  ".lan",
  ".test",
  ".invalid",
  ".onion",
];

function parseIpv4(hostname) {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;

  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    return value <= 255 ? value : null;
  });
  return octets.some((value) => value === null) ? null : octets;
}

function isReservedIpv4(octets) {
  const [a, b, c] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function expandIpv6(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host.includes(":")) return null;

  const embeddedIpv4Match = host.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/);
  let normalized = host;
  if (embeddedIpv4Match) {
    const ipv4 = parseIpv4(embeddedIpv4Match[1]);
    if (!ipv4) return null;
    const high = ((ipv4[0] << 8) | ipv4[1]).toString(16);
    const low = ((ipv4[2] << 8) | ipv4[3]).toString(16);
    normalized = `${host.slice(0, -embeddedIpv4Match[1].length)}${high}:${low}`;
  }

  if ((normalized.match(/::/g) || []).length > 1) return null;
  const [leftPart, rightPart] = normalized.split("::");
  const left = leftPart ? leftPart.split(":") : [];
  const right = rightPart ? rightPart.split(":") : [];
  const missing = normalized.includes("::") ? 8 - left.length - right.length : 0;
  const groups = normalized.includes("::")
    ? [...left, ...Array(missing).fill("0"), ...right]
    : left;

  if (
    groups.length !== 8 ||
    groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))
  ) {
    return null;
  }

  return groups.map((group) => Number.parseInt(group, 16));
}

function isReservedIpv6(groups) {
  const first = groups[0];
  const isGlobalUnicast = first >= 0x2000 && first <= 0x3fff;
  const isIetfProtocolAssignment =
    first === 0x2001 && groups[1] <= 0x01ff;
  const isDocumentation = first === 0x2001 && groups[1] === 0x0db8;
  const isBenchmarking =
    first === 0x2001 && groups[1] === 0x0002 && groups[2] === 0;
  const isTeredo = first === 0x2001 && groups[1] === 0;
  const isSixToFour = first === 0x2002;
  const isDocumentationV2 = first === 0x3fff && groups[1] <= 0x0fff;

  // Public research links should use ordinary global-unicast addresses. This
  // rejects loopback, unspecified, mapped/compatible IPv4, ULA, link-local,
  // site-local, multicast, documentation, benchmarking, and transition ranges.
  return (
    !isGlobalUnicast ||
    isIetfProtocolAssignment ||
    isDocumentation ||
    isBenchmarking ||
    isTeredo ||
    isSixToFour ||
    isDocumentationV2
  );
}

function blockedHostname(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host || BLOCKED_HOSTNAMES.has(host)) return true;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return true;
  }

  const ipv4 = parseIpv4(host);
  if (ipv4) return isReservedIpv4(ipv4);

  if (host.includes(":")) {
    const ipv6 = expandIpv6(host);
    return !ipv6 || isReservedIpv6(ipv6);
  }

  if (!host.includes(".")) return true;

  // Hostnames containing only numeric/address punctuation should have been
  // normalized to a valid IP by URL. Reject leftovers rather than treating a
  // malformed numeric host as public DNS.
  return /^[0-9a-f.:[\]-]+$/i.test(host);
}

export function normalizePublicResearchUrl(value) {
  if (typeof value !== "string") return null;
  const input = value.trim();
  if (!input || input.length > MAX_URL_LENGTH) return null;

  let url;
  try {
    url = new URL(input);
  } catch {
    return null;
  }

  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    blockedHostname(url.hostname)
  ) {
    return null;
  }

  if (url.hostname.endsWith(".")) {
    url.hostname = url.hostname.slice(0, -1);
  }
  url.hash = "";
  return url.toString();
}

export function isPublicResearchUrl(value) {
  return normalizePublicResearchUrl(value) !== null;
}
