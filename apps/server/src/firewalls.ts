import type { FirewallInfo, FirewallSnapshot } from "@ruledeck/core";
import { featuresFor, OpnsenseClient, OpnsenseError } from "@ruledeck/opnsense-client";
import type { FirewallConfig } from "./config.ts";

export type ConnectionState =
  | { status: "unknown" }
  | { status: "connected"; info: FirewallInfo; checkedAt: string }
  | { status: "error"; error: ReturnType<OpnsenseError["toJSON"]>; checkedAt: string };

/** Holds one client per configured firewall. Secrets stay in here. */
export class FirewallRegistry {
  private clients = new Map<string, { cfg: FirewallConfig; client: OpnsenseClient; state: ConnectionState }>();

  constructor(configs: FirewallConfig[]) {
    for (const cfg of configs) {
      this.clients.set(cfg.id, {
        cfg,
        client: new OpnsenseClient({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, apiSecret: cfg.apiSecret, caPem: cfg.caPem, timeoutMs: cfg.timeoutMs }),
        state: { status: "unknown" },
      });
    }
  }

  /** Public description: no URL credentials, no secrets. */
  list() {
    return [...this.clients.values()].map(({ cfg, client, state }) => ({
      id: cfg.id,
      name: cfg.name,
      host: new URL(client.http.origin).host,
      state,
    }));
  }

  has(id: string) {
    return this.clients.has(id);
  }

  private entry(id: string) {
    const e = this.clients.get(id);
    if (!e) throw new OpnsenseError("protocol", `Unknown firewall "${id}".`);
    return e;
  }

  /** Connect (or re-check) and detect version/features. */
  async connect(id: string): Promise<ConnectionState> {
    const e = this.entry(id);
    const checkedAt = new Date().toISOString();
    try {
      const productVersion = await e.client.getVersion();
      e.state = {
        status: "connected",
        info: { id, name: e.cfg.name, productVersion, features: featuresFor(productVersion) },
        checkedAt,
      };
    } catch (err) {
      const oe = err instanceof OpnsenseError ? err : new OpnsenseError("network", "Connection failed.");
      e.state = { status: "error", error: oe.toJSON(), checkedAt };
    }
    return e.state;
  }

  async snapshot(id: string): Promise<FirewallSnapshot> {
    const e = this.entry(id);
    const res = await e.client.readAll();
    return { firewallId: id, loadedAt: new Date().toISOString(), ...res };
  }

  async close() {
    await Promise.all([...this.clients.values()].map((c) => c.client.close()));
  }
}
