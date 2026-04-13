import type { FastifyInstance } from "fastify";

/**
 * Register the `/health` liveness endpoint.
 *
 * @remarks
 * This route is intentionally trivial and never hits any dependency so
 * that orchestrators can use it to detect process-up state without
 * causing side effects or spurious failures during startup.
 */
export function registerHealthRoute(app: FastifyInstance): void {
  app.get("/health", async () => ({ status: "ok" }));
}
