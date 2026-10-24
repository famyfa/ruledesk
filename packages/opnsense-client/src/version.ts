import type { FeatureFlags } from "@ruledeck/core";

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  raw: string;
}

/** Parse OPNsense versions like "26.7", "26.7.7", "26.1.11_2", "26.7.r1". */
export function parseVersion(raw: string): ParsedVersion | null {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(raw.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] ?? 0), raw };
}

/** Series we have checked against the OPNsense source (docs/api-compatibility.md). */
export const VERIFIED_SERIES = ["26.1", "26.7"] as const;

/**
 * Feature flags for a firewall version. Unknown versions are read-only until
 * someone verifies them, and the reason is stated.
 */
export function featuresFor(version: string | null): FeatureFlags {
  if (version === null) {
    return {
      rulesRead: true,
      rulesWrite: false,
      aliasesWrite: false,
      portSelectOptions: false,
      notes: ["Can't read the OPNsense version: your OPNsense user needs the \"System: Firmware\" privilege. Editing stays disabled until the version is known."],
    };
  }
  const v = parseVersion(version);
  const notes: string[] = [];
  if (!v) {
    return {
      rulesRead: true,
      rulesWrite: false,
      aliasesWrite: false,
      portSelectOptions: false,
      notes: [`Unrecognized OPNsense version "${version}". Editing is disabled.`],
    };
  }
  const series = `${v.major}.${v.minor}`;
  const verified = (VERIFIED_SERIES as readonly string[]).includes(series);
  const atLeast = (maj: number, min: number) => v.major > maj || (v.major === maj && v.minor >= min);

  if (!atLeast(24, 7)) {
    notes.push(`OPNsense ${series} predates the rules API RuleDeck uses. Only reading is attempted.`);
  } else if (!verified) {
    notes.push(`OPNsense ${series} has not been verified with RuleDeck. Editing is disabled until it is.`);
  }
  return {
    rulesRead: true,
    rulesWrite: verified,
    aliasesWrite: verified,
    portSelectOptions: atLeast(26, 1),
    notes,
  };
}
