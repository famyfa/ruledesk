import type { FastifyInstance } from "fastify";
import { isNewId, serviceById, type ServiceWc } from "@ruledeck/core";
import { track } from "../auth.ts";
import { ServiceApplySchema } from "../schemas.ts";
import { applyServiceToSite } from "../sites.ts";
import type { RouteContext } from "./context.ts";

/** Services (DHCP, DNS, gateways, ...) and certificates of one site. */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function serviceRoutes(app: FastifyInstance, ctx: RouteContext) {
  /** Certificates and CAs of the site (expiry overview). Only whitelisted fields; the firewall's list also contains private keys. */
  app.get("/api/sites/:id/certificates", async (req, reply) => {
    const s = ctx.siteFor(req, reply);
    if (!s) return;
    const certs = await ctx.withSite(s, reply, () => track(s, () => s.client.listCertificates()));
    if (!certs) return;
    return { certificates: certs };
  });

  /** One service (settings and tables) as flat maps; secret fields are empty. */
  app.get("/api/sites/:id/services/:svc", async (req, reply) => {
    const s = ctx.siteFor(req, reply);
    if (!s) return;
    const def = serviceById((req.params as { svc: string }).svc);
    if (!def) return reply.code(404).send({ error: { kind: "not_found", message: "Unknown service." } });
    const snapshot = await ctx.withSite(s, reply, () => track(s, () => s.client.readServiceSnapshot(def, s.siteId)));
    if (!snapshot) return;
    return { snapshot, readOnly: !!def.readOnly };
  });

  app.post("/api/sites/:id/services/:svc/apply", { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const s = ctx.siteFor(req, reply);
    if (!s) return;
    const def = serviceById((req.params as { svc: string }).svc);
    if (!def) return reply.code(404).send({ error: { kind: "not_found", message: "Unknown service." } });
    if (!ctx.allowChange(req, reply)) return;
    if (!ctx.writesAllowed(reply, def.readOnly ? `${def.label} is read-only in RuleDeck.` : undefined)) return;
    const body = ServiceApplySchema.safeParse(req.body);
    if (!body.success) return ctx.invalid(reply, "Invalid change set", body.error);
    const { baseline, current } = body.data;
    if (baseline.siteId !== s.siteId || baseline.serviceId !== def.id) {
      return reply.code(400).send({ error: { kind: "bad_request", message: "The changes were made for a different site or service." } });
    }
    const known = new Set(def.grids.map((g) => g.id));
    for (const gid of [...Object.keys(baseline.grids), ...Object.keys(current.grids)]) {
      if (!known.has(gid)) return reply.code(400).send({ error: { kind: "bad_request", message: `Unknown table "${gid}".` } });
    }
    for (const rows of Object.values(current.grids)) {
      for (const r of rows) {
        if (!isNewId(r.id) && !UUID_RE.test(r.id)) return reply.code(400).send({ error: { kind: "bad_request", message: "Invalid entry id." } });
      }
    }
    const wc = { baseline: { ...baseline, options: {}, defaults: {} } as ServiceWc["baseline"], settings: current.settings, grids: current.grids } as ServiceWc;
    const result = await ctx.withSite(s, reply, () => applyServiceToSite(s, def, wc));
    if (!result) return;
    // Counts only: change contents can include secrets.
    req.log.info(
      { event: "service_apply", site: s.siteId, service: def.id, user: s.user, outcome: result.outcome, writes: `${result.state.written}/${result.state.totalWrites}`, verified: result.state.verified },
      "service apply finished",
    );
    return { result };
  });
}
