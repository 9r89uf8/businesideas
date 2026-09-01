import { readFile } from "node:fs/promises";

const MAX_FIXTURE_BYTES = 32 * 1024;
const MAX_FIXTURE_NODES = 300;
const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const SIMPLE_SELECTOR_CACHE = new Map();

function decodeHtml(value) {
  return String(value)
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function normalizedText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function patternMatches(pattern, value, exact = false) {
  if (pattern instanceof RegExp) {
    pattern.lastIndex = 0;
    return pattern.test(value);
  }
  return exact ? value === String(pattern) : value.includes(String(pattern));
}

function parseAttributes(source) {
  const attributes = new Map();
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const name = match[1].toLowerCase();
    const value = decodeHtml(match[2] ?? match[3] ?? match[4] ?? "");
    attributes.set(name, value);
  }
  return attributes;
}

function splitSelector(value, separator) {
  const parts = [];
  let current = "";
  let bracketDepth = 0;
  let quote = null;

  for (const character of value) {
    if (quote) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
    } else if (character === "[") {
      bracketDepth += 1;
      current += character;
    } else if (character === "]") {
      bracketDepth -= 1;
      current += character;
    } else if (
      bracketDepth === 0 &&
      (separator === "," ? character === "," : /\s/.test(character))
    ) {
      if (current.trim()) parts.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseSimpleSelector(selector) {
  const cached = SIMPLE_SELECTOR_CACHE.get(selector);
  if (cached) return cached;

  const tagMatch = selector.match(/^[A-Za-z][A-Za-z0-9-]*/);
  const tagName = tagMatch?.[0].toLowerCase() || null;
  let rest = selector.slice(tagMatch?.[0].length || 0);
  const attributes = [];
  const attributePattern = /^\[([A-Za-z_:][A-Za-z0-9_:.-]*)(?:\s*(\*=|=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*(i)?\s*)?\]/;

  while (rest) {
    const match = rest.match(attributePattern);
    if (!match) throw new TypeError(`Unsupported fixture selector: ${selector}`);
    attributes.push({
      name: match[1].toLowerCase(),
      operator: match[2] || null,
      value: match[3] ?? match[4] ?? match[5] ?? null,
      insensitive: Boolean(match[6]),
    });
    rest = rest.slice(match[0].length);
  }

  if (!tagName && attributes.length === 0) {
    throw new TypeError(`Unsupported fixture selector: ${selector}`);
  }
  const parsed = Object.freeze({ tagName, attributes: Object.freeze(attributes) });
  SIMPLE_SELECTOR_CACHE.set(selector, parsed);
  return parsed;
}

function matchesSimpleSelector(node, selector) {
  const parsed = parseSimpleSelector(selector);
  if (parsed.tagName && node.tag !== parsed.tagName) return false;

  for (const condition of parsed.attributes) {
    if (!node.attributes.has(condition.name)) return false;
    if (!condition.operator) continue;
    let actual = node.attributes.get(condition.name);
    let expected = condition.value;
    if (condition.insensitive) {
      actual = actual.toLowerCase();
      expected = expected.toLowerCase();
    }
    if (condition.operator === "=" && actual !== expected) return false;
    if (condition.operator === "*=" && !actual.includes(expected)) return false;
  }
  return true;
}

function matchesSelectorChain(node, selector) {
  const parts = splitSelector(selector, " ");
  if (!matchesSimpleSelector(node, parts.at(-1))) return false;
  let ancestor = node.parent;
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    while (ancestor && !matchesSimpleSelector(ancestor, parts[index])) {
      ancestor = ancestor.parent;
    }
    if (!ancestor) return false;
    ancestor = ancestor.parent;
  }
  return true;
}

function elementText(node) {
  return normalizedText([
    ...node.text,
    ...node.children.map(elementText),
  ].join(" "));
}

function implicitRole(node) {
  const explicit = node.getAttribute("role");
  if (explicit) return explicit;
  if (node.tag === "button") return "button";
  if (node.tag === "main") return "main";
  if (node.tag === "nav") return "navigation";
  if (node.tag === "input" && node.getAttribute("type") !== "password") {
    return "textbox";
  }
  return null;
}

function accessibleName(node) {
  return normalizedText(
    node.getAttribute("aria-label") ||
      node.getAttribute("placeholder") ||
      elementText(node),
  );
}

function isVisibleNode(node) {
  for (let candidate = node; candidate; candidate = candidate.parent) {
    if (
      candidate.attributes.has("hidden") ||
      candidate.getAttribute("aria-hidden") === "true" ||
      /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(
        candidate.getAttribute("style") || "",
      )
    ) {
      return false;
    }
  }
  return true;
}

function descendants(node, { includeRoot = false } = {}) {
  const result = includeRoot && node.tag !== "#document" ? [node] : [];
  const queue = [...node.children];
  while (queue.length > 0) {
    const candidate = queue.shift();
    result.push(candidate);
    queue.push(...candidate.children);
  }
  return result;
}

class FixtureNode {
  constructor(tag, attributes, parent = null) {
    this.tag = tag;
    this.tagName = tag.toUpperCase();
    this.attributes = attributes;
    this.parent = parent;
    this.children = [];
    this.text = [];
  }

  get hidden() {
    return this.attributes.has("hidden");
  }

  getAttribute(name) {
    return this.attributes.get(String(name).toLowerCase()) ?? null;
  }

  closest(selector) {
    for (let candidate = this; candidate; candidate = candidate.parent) {
      if (
        candidate.tag !== "#document" &&
        splitSelector(selector, ",").some((part) =>
          matchesSelectorChain(candidate, part))
      ) {
        return candidate;
      }
    }
    return null;
  }
}

function parseFixtureHtml(html) {
  if (Buffer.byteLength(html, "utf8") > MAX_FIXTURE_BYTES) {
    throw new RangeError("The HTML fixture is too large.");
  }
  const documentNode = new FixtureNode("#document", new Map());
  const stack = [documentNode];
  const tokenPattern = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/?[A-Za-z][^>]*>|[^<]+/gi;
  let nodeCount = 0;
  let token;

  while ((token = tokenPattern.exec(html)) !== null) {
    const value = token[0];
    if (/^<!--|^<!doctype/i.test(value)) continue;
    if (value.startsWith("</")) {
      const tag = value.slice(2, -1).trim().toLowerCase();
      while (stack.length > 1 && stack.at(-1).tag !== tag) stack.pop();
      if (stack.length === 1) throw new TypeError("Malformed HTML fixture.");
      stack.pop();
      continue;
    }
    if (value.startsWith("<")) {
      const open = value.match(/^<([A-Za-z][A-Za-z0-9-]*)([\s\S]*?)\/?\s*>$/);
      if (!open) throw new TypeError("Unsupported HTML fixture tag.");
      const tag = open[1].toLowerCase();
      const node = new FixtureNode(tag, parseAttributes(open[2]), stack.at(-1));
      stack.at(-1).children.push(node);
      nodeCount += 1;
      if (nodeCount > MAX_FIXTURE_NODES) {
        throw new RangeError("The HTML fixture has too many nodes.");
      }
      if (!VOID_ELEMENTS.has(tag) && !/\/\s*>$/.test(value)) stack.push(node);
      continue;
    }
    if (normalizedText(value)) stack.at(-1).text.push(decodeHtml(value));
  }

  if (stack.length !== 1) throw new TypeError("Malformed HTML fixture.");
  return documentNode;
}

class FixtureLocator {
  constructor(nodes) {
    this.nodes = nodes;
  }

  first() {
    return new FixtureLocator(this.nodes.slice(0, 1));
  }

  nth(index) {
    return new FixtureLocator(this.nodes.slice(index, index + 1));
  }

  async count() {
    return this.nodes.length;
  }

  async isVisible() {
    return Boolean(this.nodes[0] && isVisibleNode(this.nodes[0]));
  }

  async getAttribute(name) {
    return this.nodes[0]?.getAttribute(name) ?? null;
  }

  async innerText() {
    return this.nodes[0] ? elementText(this.nodes[0]) : "";
  }

  async evaluate(callback, argument) {
    if (!this.nodes[0]) throw new Error("No fixture node matched.");
    return callback(this.nodes[0], argument);
  }

  locator(selector) {
    const selectorParts = splitSelector(selector, ",");
    const candidates = this.nodes.flatMap((node) => descendants(node));
    return new FixtureLocator(candidates.filter((node) =>
      selectorParts.some((part) => matchesSelectorChain(node, part))));
  }

  getByRole(role, { name } = {}) {
    const candidates = this.nodes.flatMap((node) => descendants(node));
    return new FixtureLocator(candidates.filter((node) =>
      implicitRole(node) === role &&
      (name === undefined || patternMatches(name, accessibleName(node), true))));
  }

  getByText(name, { exact = false } = {}) {
    const candidates = this.nodes.flatMap((node) =>
      descendants(node, { includeRoot: true }));
    return new FixtureLocator(candidates.filter((node) =>
      patternMatches(name, elementText(node), exact)));
  }
}

export async function loadXHtmlFixturePage(fileName, url) {
  if (!/^[a-z0-9-]+\.html$/.test(fileName)) {
    throw new TypeError("Invalid X HTML fixture name.");
  }
  const html = await readFile(
    new URL(`../fixtures/x-for-you/${fileName}`, import.meta.url),
    "utf8",
  );
  const root = parseFixtureHtml(html);
  const locator = new FixtureLocator([root]);
  return Object.freeze({
    url() {
      return url;
    },
    locator: locator.locator.bind(locator),
    getByRole: locator.getByRole.bind(locator),
    getByText: locator.getByText.bind(locator),
  });
}
