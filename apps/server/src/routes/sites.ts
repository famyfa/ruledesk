import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { track } from "../auth.ts";
import { ApplyRequestSchema } from "../schemas.ts";
import { applyToSite, snapshotOf } from "../sites.ts";
import type { RouteContext } from "./context.ts";

/** One site's rules and aliases: connection check, snapshot, live log, apply. */

const LogQuery = z.object({
  limit: z.coerce.number().int().min(1).max(2000).default(200),
  /** md5 digest of the newest line the browser already has */
  digest: z.string().regex(/^[0-9a-f]{32}$/).optional(),
});

export function siteRoutes(app: FastifyInstance, ctx: RouteContext) {
  app.post("/api/sites/:id/connect", async (req, reply) => {
    const s = ctx.siteFor(req, reply);
    if (!s) return;
    const r = await ctx.withSite(s, reply, () => s.client.probe());
    if (!r) return;
    return { site: ctx.siteView(ctx.topology.sites.find((x) => x.id === s.siteId)!, s) };
  });

  app.get("/api/sites/:id/snapshot", async (req, reply) => {
    const s = ctx.siteFor(req, reply);
    if (!s) return;
    const snapshot = await ctx.withSite(s, reply, () => snapshotOf(s));
    if (!snapshot) return;
    return { snapshot };
  });

  /** Firewall log of the site's primary (read-only), newest first. Pass `digest` to get only newer lines. */
  app.get("/api/sites/:id/log", async (req, reply) => {
    const s = ctx.siteFor(req, reply);
    if (!s) return;
    const q = LogQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: { kind: "bad_request", message: "Invalid log request." } });
    if (!ctx.limiters.log.take(req.session!.id)) {
      return reply.code(429).send({ error: { kind: "rate_limited", message: "Reading the log too often. Slow down." } });
    }
    const result = await ctx.withSite(s, reply, () => track(s, () => s.client.readFirewallLog({ limit: q.data.limit, sinceDigest: q.data.digest })));
    if (!result) return;
    return result;
  });

  app.post("/api/sites/:id/apply", { bodyLimit: 16 * 1024 * 1024 }, async (req, reply) => {
    const s = ctx.siteFor(req, reply);
    if (!s) return;
    if (!ctx.allowChange(req, reply, "Too many apply attempts. Wait a minute.")) return;
    if (!ctx.writesAllowed(reply)) return;
    const body = ApplyRequestSchema.safeParse(req.body);
    if (!body.success) return ctx.invalid(reply, "Invalid change set", body.error);
    if (body.data.baseline.firewallId !== s.siteId) {
      return reply.code(400).send({ error: { kind: "bad_request", message: "The changes were made for a different site." } });
    }
    const f = s.info.features;
    if (!f.rulesWrite || !f.aliasesWrite) {
      return reply.code(403).send({ error: { kind: "unsupported", message: f.notes[0] ?? "Editing is not supported for this firewall version." } });
    }
    const wc = { baseline: body.data.baseline, current: body.data.current, past: [], future: [] };
    const result = await ctx.withSite(s, reply, () => applyToSite(s, wc, { acknowledgeRisks: body.data.acknowledgeRisks }));
    if (!result) return;
    // One line per apply for the operator's logs. The real audit trail is the
    // firewall's own config history, which records the OPNsense user.
    req.log.info(
      {
        event: "apply",
        site: s.siteId,
        user: s.user,
        outcome: result.outcome,
        writes: `${result.state.written}/${result.state.totalWrites}`,
        activated: result.state.activated,
        verified: result.state.verified,
      },
      "apply finished",
    );
    return { result };
  });
}
