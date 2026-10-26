import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SharedRequestSchema } from "../schemas.ts";
import { sharedApply, sharedPreflight } from "../shared-apply.ts";
import type { RouteContext } from "./context.ts";

/** The shared policy across all sites: per-site preview and the apply to every site. */
export function sharedRoutes(app: FastifyInstance, ctx: RouteContext) {
  const parse = (req: FastifyRequest, reply: FastifyReply) => {
    const body = SharedRequestSchema.safeParse(req.body);
    if (!body.success) {
      ctx.invalid(reply, "Invalid shared change set", body.error);
      return null;
    }
    return body.data;
  };

  app.post("/api/shared/preflight", { bodyLimit: 32 * 1024 * 1024 }, async (req, reply) => {
    const body = parse(req, reply);
    if (!body) return;
    return { plans: await sharedPreflight(ctx.topology, req.session!, body) };
  });

  app.post("/api/shared/apply", { bodyLimit: 32 * 1024 * 1024 }, async (req, reply) => {
    if (!ctx.allowChange(req, reply, "Too many apply attempts. Wait a minute.")) return;
    if (!ctx.writesAllowed(reply)) return;
    const body = parse(req, reply);
    if (!body) return;
    if (body.confirm !== true) return reply.code(400).send({ error: { kind: "bad_request", message: "Confirmation missing." } });
    const result = await sharedApply(ctx.topology, req.session!, body);
    req.log.info(
      { event: "shared_apply", outcome: result.outcome, sites: result.sites.map((s) => `${s.siteId}:${s.status}${s.ha ? `/ha:${s.ha.step}` : ""}`) },
      "shared apply finished",
    );
    return { result };
  });
}
