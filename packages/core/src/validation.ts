/**
 * Validators for addresses, ports and alias data. Rules mirror OPNsense 26.x
 * (AliasNameField, AliasContentField, PortField) where we know them; the firewall
 * still has the final word and its validation messages are shown as well.
 */

export function isIPv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^(0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255);
}

export function isIPv6(value: string): boolean {
  if (value.length === 0 || value.length > 45) return false;
  let v = value;
  const groupsNeeded = 8;
  // Embedded IPv4 tail, e.g. ::ffff:192.168.1.1
  const lastColon = v.lastIndexOf(":");
  if (v.includes(".")) {
    const tail = v.slice(lastColon + 1);
    if (!isIPv4(tail)) return false;
    v = v.slice(0, lastColon + 1) + "0:0";
  }
  const doubleColons = v.split("::").length - 1;
  if (doubleColons > 1) return false;
  const hex = /^[0-9a-fA-F]{1,4}$/;
  if (doubleColons === 1) {
    const [head = "", tail = ""] = v.split("::");
    const headParts = head === "" ? [] : head.split(":");
    const tailParts = tail === "" ? [] : tail.split(":");
    if (![...headParts, ...tailParts].every((g) => hex.test(g))) return false;
    return headParts.length + tailParts.length <= groupsNeeded - 1;
  }
  const parts = v.split(":");
  return parts.length === groupsNeeded && parts.every((g) => hex.test(g));
}

export function isIpAddress(value: string): boolean {
  return isIPv4(value) || isIPv6(value);
}

export function isCidr(value: string): boolean {
  const slash = value.indexOf("/");
  if (slash < 0) return false;
  const addr = value.slice(0, slash);
  const bits = value.slice(slash + 1);
  if (!/^\d{1,3}$/.test(bits)) return false;
  const n = Number(bits);
  if (isIPv4(addr)) return n >= 0 && n <= 32;
  if (isIPv6(addr)) return n >= 0 && n <= 128;
  return false;
}

/** `a-b` where both ends are IPs of the same family. */
export function isIpRange(value: string): boolean {
  const parts = value.split("-");
  if (parts.length !== 2) return false;
  const [a = "", b = ""] = parts;
  return (isIPv4(a) && isIPv4(b)) || (isIPv6(a) && isIPv6(b));
}

/** A literal address usable in a rule's source/destination field. */
export function isAddressLiteral(value: string): boolean {
  return isIpAddress(value) || isCidr(value) || isIpRange(value);
}

const PORT_NAME = /^[a-z][a-z0-9-]{0,30}$/i;

function isPortNumber(v: string): boolean {
  return /^\d{1,5}$/.test(v) && Number(v) >= 1 && Number(v) <= 65535;
}

/** Port number, range (`80-90` or `80:90`), or well-known service name. */
export function isPortLiteral(value: string, wellKnown?: ReadonlySet<string>): boolean {
  if (isPortNumber(value)) return true;
  const range = value.split(/[-:]/);
  if (range.length === 2) {
    const [a = "", b = ""] = range;
    return isPortNumber(a) && isPortNumber(b) && Number(a) <= Number(b);
  }
  if (wellKnown) return wellKnown.has(value.toLowerCase());
  return PORT_NAME.test(value);
}

// ---------------------------------------------------------------------------
// Alias names (mirrors OPNsense AliasNameField, 26.7)

const ALIAS_NAME = /^([a-zA-Z]|(([_a-zA-Z][a-zA-Z0-9]|[a-zA-Z][_a-zA-Z0-9])[_a-zA-Z0-9]{0,29}))$/;

/** pf reserved words from OPNsense AliasNameField (26.7.7). */
export const PF_RESERVED_WORDS: ReadonlySet<string> = new Set(
  (
    "af-to all allow-opts allow-related altq anchor antispoof any bandwidth binat binat-anchor binat-to bitmask " +
    "block block-policy bridge-to buckets cbq code codelq debug divert-reply divert-to dnpipe dnqueue drop dup-to " +
    "endpoint-independent ether fail-policy fairq fastroute file fingerprints flags floating flush for fragment from " +
    "global group hfsc hogs hostid icmp-type icmp6-type if-bound in include inet inet6 interval keep keepcounters l3 " +
    "label limit linkshare load log loginterface map-e-portset match matches max max-mss max-pkt-rate max-pkt-size " +
    "max-src-conn max-src-conn-rate max-src-nodes max-src-states min-ttl modulate nat nat-anchor nat-to no no-df " +
    "no-route no-sync on optimization os out overload pass pflow port prefer-ipv6-nexthop prio priority priq " +
    "probability proto qlimit queue quick random random-id rdr rdr-anchor rdr-to realtime reassemble received-on " +
    "reply-to require-order return return-icmp return-icmp6 return-rst ridentifier round-robin route route-to rtable " +
    "rule ruleset-optimization scrub set set-tos skip sloppy source-hash source-track state state-defaults " +
    "state-policy static-port sticky-address syncookies synproxy table tag tagged target tbrsize timeout to tos ttl " +
    "upperlimit urpf-failed user"
  ).split(" "),
);

/**
 * A few common service/protocol names that OPNsense also rejects (it checks
 * getservbyname/getprotobyname on the firewall, which we can't fully replicate).
 */
const COMMON_SERVICE_NAMES: ReadonlySet<string> = new Set([
  "http", "https", "ssh", "ftp", "smtp", "dns", "domain", "ntp", "telnet", "pop3", "imap", "snmp",
  "tcp", "udp", "icmp", "ip", "ipv6", "esp", "ah", "gre", "carp", "pfsync", "ospf", "igmp",
]);

export function validateAliasName(
  name: string,
  existingNames: Iterable<string> = [],
  ownName?: string,
): string[] {
  const issues: string[] = [];
  if (!name) return ["Name is required."];
  if (!ALIAS_NAME.test(name)) {
    issues.push(
      "Use letters, digits and underscores, start with a letter or single underscore, max 31 characters.",
    );
  }
  if (PF_RESERVED_WORDS.has(name)) issues.push(`"${name}" is a reserved keyword.`);
  if (COMMON_SERVICE_NAMES.has(name.toLowerCase())) issues.push(`"${name}" is a service or protocol name.`);
  for (const existing of existingNames) {
    if (existing === ownName) continue;
    if (existing.toLowerCase() === name.toLowerCase()) {
      issues.push(`An alias named "${existing}" already exists.`);
      break;
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Alias entries

/** Split pasted text into entries: newlines, commas, semicolons, whitespace. */
export function parseEntryList(text: string): string[] {
  return text
    .split(/[\n\r,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface EntryCheck {
  entry: string;
  error?: string;
  duplicate?: boolean;
}

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const MAC = /^[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){1,5}$/;

function isAliasRef(v: string, aliasNames: ReadonlySet<string>): boolean {
  return aliasNames.has(v);
}

/**
 * Check each entry for an alias of the given type. Types we don't validate
 * locally (url, geoip, ...) pass through; OPNsense validates them on save.
 */
export function checkAliasEntries(
  type: string,
  entries: string[],
  aliasNames: ReadonlySet<string> = new Set(),
): EntryCheck[] {
  const seen = new Set<string>();
  return entries.map((entry) => {
    const result: EntryCheck = { entry };
    const key = entry.toLowerCase();
    if (seen.has(key)) result.duplicate = true;
    seen.add(key);
    const error = entryError(type, entry, aliasNames);
    if (error) result.error = error;
    return result;
  });
}

function entryError(type: string, entry: string, aliasNames: ReadonlySet<string>): string | undefined {
  const bare = entry.startsWith("!") ? entry.slice(1) : entry;
  switch (type) {
    case "host":
      if (isIpAddress(bare) || isIpRange(entry) || isAliasRef(entry, aliasNames) || HOSTNAME.test(entry)) return;
      return `"${entry}" is not a valid hostname, IP address or range.`;
    case "network":
      if (isIpAddress(bare) || isCidr(bare) || isIpRange(entry) || isAliasRef(entry, aliasNames)) return;
      return `"${entry}" is not a network.`;
    case "port":
      if (isPortLiteral(entry) || isAliasRef(entry, aliasNames)) return;
      return `"${entry}" is not a valid port.`;
    case "networkgroup":
      if (isAliasRef(entry, aliasNames)) return;
      return `"${entry}" is not a known alias.`;
    case "mac":
      if (MAC.test(entry)) return;
      return `"${entry}" is not a valid (partial) MAC address.`;
    case "asn":
      if (/^\d+$/.test(entry) && Number(entry) >= 1 && Number(entry) <= 4294967296) return;
      return `"${entry}" is not a valid ASN.`;
    default:
      return;
  }
}

/** Entry problems summarized as messages, or [] when all entries are fine. */
export function validateAliasEntries(
  type: string,
  entries: string[],
  aliasNames?: ReadonlySet<string>,
): string[] {
  const issues: string[] = [];
  for (const c of checkAliasEntries(type, entries, aliasNames)) {
    if (c.error) issues.push(c.error);
    if (c.duplicate) issues.push(`"${c.entry}" is listed more than once.`);
  }
  if (["host", "network", "port", "networkgroup", "mac", "asn"].includes(type) && entries.length === 0) {
    issues.push("Add at least one entry.");
  }
  return issues;
}
