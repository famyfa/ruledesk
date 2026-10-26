import { computeServiceChanges, createServiceWc, type Item, type ServiceDef, type ServiceWc } from "@ruledeck/core";
import { api } from "./api.ts";

/**
 * Staged service changes live in this tab's sessionStorage (one draft per site and service),
 * like staged rule changes. Closing the tab or signing out drops them; the server stores nothing.
 */

export const DRAFT_PREFIX = "ruledeck.svc.";
export const draftKey = (siteId: string, svc: string) => `${DRAFT_PREFIX}${siteId}.${svc}`;

export function loadDraft(key: string): ServiceWc | null {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as ServiceWc) : null;
  } catch {
    return null;
  }
}

/** A copy without typed secrets: passwords and keys stay in memory only, never in browser storage. */
function withoutSecrets(wc: ServiceWc): ServiceWc {
  const secrets = new Set(wc.baseline.secrets);
  const strip = (item: Item): Item => Object.fromEntries(Object.entries(item).map(([k, v]) => [k, secrets.has(k) ? "" : v]));
  return {
    baseline: { ...wc.baseline, options: {} },
    settings: wc.settings ? strip(wc.settings) : null,
    grids: Object.fromEntries(Object.entries(wc.grids).map(([g, rows]) => [g, rows.map((r) => ({ id: r.id, item: strip(r.item) }))])),
  };
}

/** Save the draft (without secrets), or drop it when nothing is staged. */
export function saveDraft(siteId: string, def: ServiceDef, wc: ServiceWc | null): void {
  const key = draftKey(siteId, def.id);
  try {
    if (wc && computeServiceChanges(def, wc).length) sessionStorage.setItem(key, JSON.stringify(withoutSecrets(wc)));
    else sessionStorage.removeItem(key);
  } catch {
    /* storage unavailable: edits stay in memory */
  }
}

/** The working copy of a service at a site: the staged draft (with fresh option lists) or a fresh read. */
export async function loadServiceWc(siteId: string, def: ServiceDef): Promise<ServiceWc> {
  const { snapshot } = await api.service(siteId, def.id);
  const draft = loadDraft(draftKey(siteId, def.id));
  return draft ? { ...draft, baseline: { ...draft.baseline, options: snapshot.options, defaults: snapshot.defaults } } : createServiceWc(snapshot);
}
