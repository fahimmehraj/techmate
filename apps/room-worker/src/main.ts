import { serve } from "inngest/bun";
import { PostgresCoordinatorRepository } from "@technyu/db";
import { createRoomWorkflowFunctions, InngestOutboxPublisher, roomInngest, workflowError, workflowLog, workflowWarn } from "@technyu/workflows";

const repository = new PostgresCoordinatorRepository();
const outboxPublisher = new InngestOutboxPublisher(repository);
const port = Number(process.env.ROOM_WORKER_PORT ?? 3001);
const inngestHandler = serve({
  client: roomInngest,
  functions: createRoomWorkflowFunctions(repository, outboxPublisher),
  serveHost: process.env.ROOM_INNGEST_SERVE_HOST ?? `http://host.docker.internal:${port}`,
  servePath: "/api/inngest",
});

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health") return Response.json({
        ok: true,
        jobs: {
          baseUrlConfigured: Boolean(process.env.INNGEST_BASE_URL),
          eventKeyConfigured: Boolean(process.env.INNGEST_EVENT_KEY),
          signingKeyConfigured: Boolean(process.env.INNGEST_SIGNING_KEY),
          serveHost: process.env.ROOM_INNGEST_SERVE_HOST ?? null,
        },
      });
      if (url.pathname === "/api/inngest") {
        workflowLog("room-worker", "inngest.request.received", { method: request.method });
        return inngestHandler(request);
      }
      return new Response("Not found", { status: 404 });
    } catch (error) {
      workflowError("room-worker", "request.failed", error, { method: request.method, path: url.pathname });
      return Response.json({ message: "Room worker failed to process the request." }, { status: 500 });
    }
  },
});

workflowLog("room-worker", "server.started", {
  port,
  inngestBaseUrlConfigured: Boolean(process.env.INNGEST_BASE_URL),
  inngestEventKeyConfigured: Boolean(process.env.INNGEST_EVENT_KEY),
  inngestSigningKeyConfigured: Boolean(process.env.INNGEST_SIGNING_KEY),
  inngestServeHost: process.env.ROOM_INNGEST_SERVE_HOST ?? null,
});
if (!process.env.INNGEST_BASE_URL || !process.env.INNGEST_EVENT_KEY || !process.env.INNGEST_SIGNING_KEY) {
  workflowWarn("room-worker", "inngest.configuration.incomplete", {
    required: ["INNGEST_BASE_URL", "INNGEST_EVENT_KEY", "INNGEST_SIGNING_KEY"].filter((name) => !process.env[name]),
    consequence: "Room jobs will not be delivered by the local Inngest server.",
  });
}
