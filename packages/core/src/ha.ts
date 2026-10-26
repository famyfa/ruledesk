/**
 * High availability: what a node reports about its CARP virtual IPs, and the
 * pure rules for a graceful switchover (CARP maintenance mode on the node
 * RuleDeck is signed in to, so its VIPs move to the peer).
 */

export type CarpStatus = "MASTER" | "BACKUP" | "INIT" | "DISABLED" | string;

export interface CarpVip {
  interface: string;
  vhid: string;
  subnet: string;
  status: CarpStatus;
  /** "carp" for real CARP VIPs; IP aliases etc. are ignored for the role. */
  mode: string;
}

export interface HaState {
  vips: CarpVip[];
  /** net.inet.carp.demotion; 0 = healthy. */
  demotion: number;
  /** net.inet.carp.allow; false = CARP switched off on this node. */
  allow: boolean;
  /** Persistent CARP maintenance mode. */
  maintenance: boolean;
}

export type HaRole = "master" | "backup" | "mixed" | "none";

export function carpVips(s: HaState): CarpVip[] {
  return s.vips.filter((v) => v.mode === "carp");
}

/** What this node currently is, judged by its CARP VIPs. */
export function haRole(s: HaState): HaRole {
  const v = carpVips(s);
  if (!v.length) return "none";
  if (v.every((x) => x.status === "MASTER")) return "master";
  if (v.every((x) => x.status === "BACKUP")) return "backup";
  return "mixed";
}

export interface HaCheck {
  id: string;
  ok: boolean;
  text: string;
}

export interface SwitchChecks {
  /** The switch can start. */
  allowed: boolean;
  /** Nothing to do: the node already is where the switch would put it. */
  already: boolean;
  checks: HaCheck[];
}

/**
 * Checks before entering (`enter: true`) or leaving CARP maintenance mode.
 * `peerReachable` comes from the HA sync link (this node can talk to its peer).
 */
export function switchChecks(s: HaState, enter: boolean, peerReachable: boolean): SwitchChecks {
  const role = haRole(s);
  const checks: HaCheck[] = [];
  if (enter) {
    checks.push({ id: "carp", ok: carpVips(s).length > 0, text: "This node has CARP virtual IPs." });
    checks.push({ id: "allow", ok: s.allow, text: "CARP is enabled on this node." });
    checks.push({ id: "peer", ok: peerReachable, text: "The HA peer answers over the sync link." });
    checks.push({ id: "healthy", ok: s.demotion === 0 || s.maintenance, text: "No CARP demotion: this node is healthy." });
    checks.push({ id: "master", ok: role === "master" || s.maintenance, text: "This node is currently the master for all its VIPs." });
    const already = s.maintenance;
    return { allowed: !already && checks.every((c) => c.ok), already, checks };
  }
  checks.push({ id: "maintenance", ok: s.maintenance, text: "This node is in CARP maintenance mode." });
  checks.push({ id: "allow", ok: s.allow, text: "CARP is enabled on this node." });
  return { allowed: s.maintenance && s.allow, already: !s.maintenance, checks };
}

/** Has the node reached the state a finished switch should have? */
export function switchSettled(s: HaState, enter: boolean): boolean {
  if (enter) return s.maintenance && carpVips(s).every((v) => v.status !== "MASTER");
  return !s.maintenance && haRole(s) === "master";
}

export function describeHa(s: HaState): string {
  const role = haRole(s);
  if (s.maintenance) return role === "backup" ? "Maintenance mode: the peer carries the traffic" : "Maintenance mode: waiting for the peer to take over";
  if (!s.allow) return "CARP is switched off on this node";
  return { master: "Master", backup: "Backup", mixed: "Mixed: some VIPs master, some backup", none: "No CARP virtual IPs" }[role];
}
