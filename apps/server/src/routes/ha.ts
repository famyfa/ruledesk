import type { FastifyInstance } from "fastify";
import { track } from "../auth.ts";
import { readHa } from "../ha.ts";
import { HaSwitchSchema } from "../schemas.ts";
import { haSwitchSite } from "../sites.ts";
import type { RouteContext } from "./context.ts";

/** HA state of a site and the graceful switchover (CARP maintenance mode). */
export function haRoutes(app: FastifyInstance, ctx: RouteContext) {
  /** HA state of the site's primary node (CARP VIPs, maintenance mode, peer reachable) with the switch checks. */
  app.get("/api/sites/:id/ha", async (req, reply) => {
    const s = ctx.siteFor(req, reply);
    if (!s) return;
    const view = await ctx.withSite(s, reply, () => track(s, () => readHa(s.client)));
    if (!view) return;
    return view;
  });

  /** Enter or leave CARP maintenance mode on the primary node. Sent at most once. */
  app.post("/api/sites/:id/ha/switch", async (req, reply) => {
    const s = ctx.siteFor(req, reply);
    if (!s) return;
    if (!ctx.allowChange(req, reply)) return;
    if (!ctx.writesAllowed(reply)) return;
    const body = HaSwitchSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: { kind: "bad_request", message: "Say whether to enter or leave maintenance mode." } });
    const result = await ctx.withSite(s, reply, () => haSwitchSite(s, body.data.enter));
    if (!result) return;
    req.log.info({ event: "ha_switch", site: s.siteId, user: s.user, enter: result.enter, outcome: result.outcome }, "ha switch finished");
    return { result };
  });
}
