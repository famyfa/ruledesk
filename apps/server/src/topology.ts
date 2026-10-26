import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { validateBaseUrl, type EndpointConfig } from "@ruledeck/opnsense-client";

/**
 * Topology: which sites and firewalls RuleDeck may talk to. Written by the
 * operator, read-only for RuleDeck, contains NO secrets. It is also the
 * allowlist of URLs RuleDeck connects to (users can't make it connect anywhere else).
 *
 * {
 *   "version": 1,
 *   "sites": [
 *     { "id": "ber", "name": "Berlin",
 *       "primary":   { "url": "https://10.1.0.2", "caFile": "/etc/ruledeck/ber-ca.pem" },
 *       "secondary": { "url": "https://10.1.0.3" },               // optional (HA peer)
 *       "interfaces": { "LAN": { "key": "lan", "label": "LAN" },  // optional, needed for shared rules
 *                       "DMZ": { "key": "opt1", "label": "DMZ" } } }
 *   ]
 * }
 */

const NodeSchema = z
  .object({
    url: z.string().min(1).max(512),
    caFile: z.string().min(1).max(1024).optional(),
    /** SHA-256 certificate fingerprint to pin (hex, colons optional). */
    tlsFingerprint: z.string().regex(/^([0-9A-Fa-f]{2}:?){31}[0-9A-Fa-f]{2}$/, "tlsFingerprint must be a SHA-256 fingerprint").optional(),
  })
  .strict();
const IfaceSchema = z.object({ key: z.string().regex(/^[A-Za-z0-9_]{1,32}$/), label: z.string().min(1).max(64) }).strict();
const SiteSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "site id: lowercase letters, digits and dashes"),
    name: z.string().min(1).max(64),
    primary: NodeSchema,
    secondary: NodeSchema.optional(),
    timeoutMs: z.number().int().min(1000).max(120000).optional(),
    interfaces: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,31}$/, "logical interface names are UPPERCASE"), IfaceSchema).optional(),
  })
  .strict();
const TopologySchema = z.object({ version: z.literal(1), sites: z.array(SiteSchema).min(1).max(64) }).strict();

export interface NodeConfig extends EndpointConfig {
  baseUrl: string;
}

export interface SiteConfig {
  id: string;
  name: string;
  primary: NodeConfig;
  secondary?: NodeConfig;
  /** logical name -> { key, label } at this site */
  interfaces?: Record<string, { key: string; label: string }>;
}

export interface Topology {
  hash: string;
  sites: SiteConfig[];
}

export class TopologyError extends Error {}

export function parseTopology(text: string, readCa: (path: string) => string = (p) => readFileSync(p, "utf8")): Topology {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new TopologyError("The topology file is not valid JSON.");
  }
  const parsed = TopologySchema.safeParse(json);
  if (!parsed.success) {
    throw new TopologyError("Invalid topology: " + parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  const t = parsed.data;
  const ids = new Set<string>();
  const urls = new Set<string>();
  const logicalSets = new Set<string>();
  const sites: SiteConfig[] = t.sites.map((s) => {
    if (ids.has(s.id)) throw new TopologyError(`Duplicate site id "${s.id}".`);
    ids.add(s.id);
    const node = (n: { url: string; caFile?: string; tlsFingerprint?: string }, role: string): NodeConfig => {
      try {
        validateBaseUrl(n.url);
      } catch (err) {
        throw new TopologyError(`Site ${s.id} ${role}: ${(err as Error).message.replace("OPNSENSE_URL", "url")}`);
      }
      const origin = new URL(n.url).origin;
      if (urls.has(origin)) throw new TopologyError(`The URL ${origin} is used twice.`);
      urls.add(origin);
      let caPem: string | undefined;
      if (n.caFile) {
        try {
          caPem = readCa(n.caFile);
        } catch {
          throw new TopologyError(`Site ${s.id} ${role}: can't read caFile ${n.caFile}.`);
        }
      }
      return { baseUrl: n.url, caPem, tlsFingerprint: n.tlsFingerprint, timeoutMs: s.timeoutMs };
    };
    if (s.interfaces) {
      const keys = Object.values(s.interfaces).map((i) => i.key);
      if (new Set(keys).size !== keys.length) throw new TopologyError(`Site ${s.id}: two logical interfaces map to the same key.`);
      logicalSets.add(Object.keys(s.interfaces).sort().join(","));
    }
    return { id: s.id, name: s.name, primary: node(s.primary, "primary"), secondary: s.secondary ? node(s.secondary, "secondary") : undefined, interfaces: s.interfaces };
  });
  const withMaps = t.sites.filter((s) => s.interfaces).length;
  if (withMaps > 0 && withMaps < t.sites.length) throw new TopologyError("Either every site has an interfaces map or none does.");
  if (logicalSets.size > 1) throw new TopologyError("Every site must define the same logical interface names.");
  return { hash: createHash("sha256").update(text).digest("hex").slice(0, 16), sites };
}

export function loadTopology(path: string): Topology {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new TopologyError(`Can't read the topology file ${path}. Set RULEDECK_TOPOLOGY_FILE.`);
  }
  return parseTopology(text);
}

/**
 * What anyone (even before sign-in) may see: site names, no URLs. The interface map
 * (keys and labels, not secret but internal) only for signed-in users.
 */
export function publicTopology(t: Topology, signedIn = false) {
  return {
    hash: t.hash,
    // The interface map is not secret (names, keys, labels); the browser needs it to build the shared policy view.
    sites: t.sites.map((s) => ({ id: s.id, name: s.name, hasSecondary: !!s.secondary, interfaces: signedIn ? (s.interfaces ?? null) : null })),
    logicalInterfaces: signedIn ? Object.keys(t.sites[0]?.interfaces ?? {}) : [],
  };
}
