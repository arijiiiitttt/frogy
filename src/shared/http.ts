import type { FastifyInstance } from "fastify";

/** Accept `content-type: application/json` with an empty body (treated as {}), instead of a 400. */
export function lenientJson(app: FastifyInstance): void {
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    try {
      const s = String(body ?? "").trim();
      done(null, s ? JSON.parse(s) : {});
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });
}
