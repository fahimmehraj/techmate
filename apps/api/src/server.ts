import { handleDiscordInteraction } from "@technyu/adapters/discord";
import { exchangeGoogleCode, getGoogleBusyIntervals } from "@technyu/adapters/google";
import { PostgresCoordinatorRepository } from "@technyu/db";
import { serve } from "inngest/bun";
import { apiInngest, createApiWorkflowFunctions, InngestOutboxPublisher, workflowError, workflowLog, workflowWarn } from "@technyu/workflows";

const repository = new PostgresCoordinatorRepository();
const outboxPublisher = new InngestOutboxPublisher(repository);
const port = Number(process.env.PORT ?? 3000);
const inngestHandler = serve({
  client: apiInngest,
  functions: createApiWorkflowFunctions(repository, outboxPublisher),
  serveHost: process.env.INNGEST_SERVE_HOST,
  servePath: "/api/inngest",
});

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/health") return Response.json({
        ok: true,
        jobs: {
          baseUrlConfigured: Boolean(process.env.INNGEST_BASE_URL),
          eventKeyConfigured: Boolean(process.env.INNGEST_EVENT_KEY),
          signingKeyConfigured: Boolean(process.env.INNGEST_SIGNING_KEY),
          serveHost: process.env.INNGEST_SERVE_HOST ?? null,
        },
      });
      if (request.method === "POST" && url.pathname === "/discord/interactions") return handleDiscordInteraction(request, repository, outboxPublisher);
      if (url.pathname === "/api/inngest") {
        workflowLog("api", "inngest.request.received", { method: request.method });
        return inngestHandler(request);
      }
      if (request.method === "GET" && url.pathname.startsWith("/web/launch/")) return redeemWebLaunch(request, url);
      if (request.method === "GET" && url.pathname === "/tasks") return serveTaskDashboard(request);
      if (request.method === "GET" && url.pathname.startsWith("/plan/launch/")) return redeemPlanningLaunch(request, url);
      if (url.pathname === "/api/planning/session") return planningSession(request);
      if (request.method === "GET" && url.pathname === "/api/planning/availability") return planningAvailability(request, url);
      if (request.method === "PATCH" && url.pathname === "/api/planning/draft") return savePlanningDraft(request);
      if (request.method === "POST" && url.pathname === "/api/planning/fallback-email") return saveFallbackEmail(request);
      if (request.method === "POST" && url.pathname === "/api/planning/confirm") return confirmPlanning(request);
      if (request.method === "GET" && url.pathname.startsWith("/plan")) return servePlanner(url.pathname);
      if (request.method === "GET" && url.pathname === "/oauth/google/callback") {
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || !state) return html("Google authorization was cancelled or malformed.", 400);
        const saved = await repository.consumeOauthState(state);
        if (!saved) return html("This authorization link expired. Return to Discord and start again.", 400);
        const connected = await exchangeGoogleCode(code, saved.codeVerifier);
        if (saved.kind === "organizer") {
          await repository.setOrganizerConnection({
            organizationId: saved.organizationId,
            authorizedByPersonId: saved.personId!,
            accountEmail: connected.email,
            encryptedRefreshToken: connected.encryptedRefreshToken,
          });
          return html("Tech@NYU organizer calendar connected. You can return to Discord.");
        }
        if (!saved.personId) return html("This availability authorization is not attached to a person.", 400);
        await repository.upsertAvailabilityConnection({
          organizationId: saved.organizationId,
          personId: saved.personId,
          accountEmail: connected.email,
          encryptedRefreshToken: connected.encryptedRefreshToken,
        });
        await repository.refreshPlanningReadinessForPerson(saved.personId);
        return html("Your Google availability is connected. You can return to Discord.");
      }
      return new Response("Not found", { status: 404 });
    } catch (error) {
      workflowError("api", "request.failed", error, { method: request.method, path: url.pathname });
      if (url.pathname.startsWith("/api/")) {
        return Response.json({ message: error instanceof Error ? error.message : "Unable to complete that request." }, { status: 400 });
      }
      return new Response("Internal server error", { status: 500 });
    }
  },
});

workflowLog("api", "server.started", {
  port,
  discordPublicKeyConfigured: isDiscordPublicKeyConfigured(),
  inngestBaseUrlConfigured: Boolean(process.env.INNGEST_BASE_URL),
  inngestEventKeyConfigured: Boolean(process.env.INNGEST_EVENT_KEY),
  inngestSigningKeyConfigured: Boolean(process.env.INNGEST_SIGNING_KEY),
  inngestServeHost: process.env.INNGEST_SERVE_HOST ?? null,
});
void outboxPublisher.recoverPending().catch((error) => workflowError("api", "outbox.recovery.startup_failed", error));
if (!process.env.INNGEST_BASE_URL || !process.env.INNGEST_EVENT_KEY || !process.env.INNGEST_SIGNING_KEY || !process.env.INNGEST_SERVE_HOST) {
  workflowWarn("api", "inngest.configuration.incomplete", {
    required: ["INNGEST_BASE_URL", "INNGEST_EVENT_KEY", "INNGEST_SIGNING_KEY", "INNGEST_SERVE_HOST"].filter((name) => !process.env[name]),
    consequence: "Calendar and room jobs will remain queued or be sent to the wrong Inngest endpoint.",
  });
}

function html(text: string, status = 200) {
  return new Response(`<!doctype html><title>Tech@NYU Coordinator</title><p>${text}</p>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isDiscordPublicKeyConfigured() {
  return /^[0-9a-f]{64}$/i.test(process.env.DISCORD_PUBLIC_KEY?.trim() ?? "");
}

async function redeemPlanningLaunch(request: Request, url: URL) {
  const rawLaunchToken = url.pathname.slice("/plan/launch/".length);
  if (!/^[a-f0-9]{64}$/i.test(rawLaunchToken)) return new Response("Invalid planning link.", { status: 400 });
  const browserToken = randomToken();
  const redeemed = await repository.redeemPlanningLaunchToken({ tokenHash: await hashToken(rawLaunchToken), browserTokenHash: await hashToken(browserToken) });
  if (!redeemed) return new Response("This planning link has expired or was already opened.", { status: 410 });
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return new Response(null, { status: 303, headers: { Location: "/plan/", "Set-Cookie": `technyu_planner=${browserToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400${secure}`, "Referrer-Policy": "no-referrer" } });
}

async function redeemWebLaunch(request: Request, url: URL) {
  const rawLaunchToken = url.pathname.slice("/web/launch/".length);
  if (!/^[a-f0-9]{64}$/i.test(rawLaunchToken)) return new Response("Invalid Web launch link.", { status: 400 });
  const browserToken = randomToken();
  const redeemed = await repository.redeemWebLaunch({ tokenHash: await hashToken(rawLaunchToken), sessionTokenHash: await hashToken(browserToken) });
  if (!redeemed) return new Response("This Web launch link has expired or was already opened.", { status: 410 });
  const secure = url.protocol === "https:" ? "; Secure" : "";
  if (redeemed.operation === "tasks") {
    return new Response(null, { status: 303, headers: { Location: "/tasks", "Set-Cookie": `technyu_web=${browserToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400${secure}`, "Referrer-Policy": "no-referrer" } });
  }
  return new Response("<!doctype html><title>Coordinator settings</title><p>Settings access is active. This Web settings surface is being connected to the organization configuration API.</p>", {
    headers: { "content-type": "text/html; charset=utf-8", "Set-Cookie": `technyu_web=${browserToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400${secure}`, "Referrer-Policy": "no-referrer" },
  });
}

async function serveTaskDashboard(request: Request) {
  const token = webSessionToken(request);
  const session = token ? await repository.getWebSession(await hashToken(token)) : undefined;
  if (!session || session.session.operation !== "tasks") return new Response("Task dashboard unavailable.", { status: 401 });
  const [entries, created] = await Promise.all([
    repository.listTasksForPerson({ organizationId: session.integration.organizationId, personId: session.person.id, includeCompleted: true }),
    repository.listTasksCreatedBy({ organizationId: session.integration.organizationId, personId: session.person.id, includeCompleted: true }),
  ]);
  const rows = entries.map((entry) => `<tr><td>${escapeHtml(entry.task.title)}</td><td>${escapeHtml(entry.task.description ?? "—")}</td><td>${entry.task.dueAt ? escapeHtml(entry.task.dueAt.toLocaleString("en-US", { timeZone: entry.task.timeZone, dateStyle: "medium", timeStyle: "short" })) : "—"}</td><td>${escapeHtml(entry.assignment.status)}</td><td>${entry.latestDelivery?.status === "failed" ? `Unavailable${entry.latestDelivery.error ? ` — ${escapeHtml(entry.latestDelivery.error)}` : ""}` : entry.latestDelivery?.status ?? "Not scheduled"}</td></tr>`).join("");
  const createdRows = created.flatMap(({ task, assignments }) => assignments.map((entry) => `<tr><td>${escapeHtml(task.title)}</td><td>${escapeHtml(entry.person.displayName)}</td><td>${escapeHtml(entry.assignment.status)}</td><td>${entry.latestDelivery?.status === "failed" ? `Unavailable${entry.latestDelivery.error ? ` — ${escapeHtml(entry.latestDelivery.error)}` : ""}` : entry.latestDelivery?.status ?? "Not scheduled"}</td></tr>`)).join("");
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your tasks</title><style>body{font-family:ui-sans-serif,system-ui,sans-serif;margin:0;background:#f7f7fb;color:#20202b}main{max-width:1000px;margin:48px auto;padding:0 20px}section{margin:32px 0}table{width:100%;border-collapse:collapse;background:white;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px #0001}th,td{text-align:left;padding:14px;border-bottom:1px solid #eee;vertical-align:top}th{color:#555;font-size:.8rem;text-transform:uppercase;letter-spacing:.04em}p{color:#666}</style></head><body><main><h1>Your tasks</h1><p>Read-only view. Manage tasks and reminders in the client where they were created.</p><section><h2>Assigned to you</h2>${rows ? `<table><thead><tr><th>Task</th><th>Details</th><th>Due</th><th>Your status</th><th>Reminder delivery</th></tr></thead><tbody>${rows}</tbody></table>` : "<p>You have no assigned tasks.</p>"}</section><section><h2>Created by you</h2>${createdRows ? `<table><thead><tr><th>Task</th><th>Assignee</th><th>Status</th><th>Reminder delivery</th></tr></thead><tbody>${createdRows}</tbody></table>` : "<p>You have not created any active or completed tasks.</p>"}</section></main></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "Referrer-Policy": "no-referrer" } });
}

async function planningSession(request: Request) {
  const session = await plannerSession(request);
  return session ? Response.json(session) : new Response("Planning session unavailable.", { status: 401 });
}

async function planningAvailability(request: Request, url: URL) {
  const current = await plannerSession(request);
  if (!current) return new Response("Planning session unavailable.", { status: 401 });
  const start = new Date(url.searchParams.get("start") ?? "");
  const end = new Date(url.searchParams.get("end") ?? "");
  if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf()) || end <= start || end.getTime() - start.getTime() > 32 * 24 * 60 * 60_000) return new Response("Request one valid calendar range of at most 32 days.", { status: 400 });
  const rows = await repository.getPlanningAvailability(current.session.id);
  const attendees = await Promise.all(rows.map(async ({ attendee, connection }) => ({
    id: attendee.id,
    displayName: attendee.displayName,
    readiness: attendee.readiness,
    busy: connection ? await getGoogleBusyIntervals({ refreshToken: connection.encryptedRefreshToken, range: { startsAt: start, endsAt: end }, timeZone: "America/New_York" }) : [],
  })));
  return Response.json({ attendees });
}

async function savePlanningDraft(request: Request) {
  const current = await plannerSession(request);
  if (!current) return new Response("Planning session unavailable.", { status: 401 });
  const input = await request.json() as { title?: string; startsAt?: string; endsAt?: string; guests?: Array<{ displayName?: string; email?: string }>; availabilityOverride?: boolean };
  const startsAt = input.startsAt ? new Date(input.startsAt) : undefined;
  const endsAt = input.endsAt ? new Date(input.endsAt) : undefined;
  if ((startsAt && Number.isNaN(startsAt.valueOf())) || (endsAt && Number.isNaN(endsAt.valueOf()))) return new Response("Invalid selected time.", { status: 400 });
  const guests = (input.guests ?? []).map((guest) => ({ displayName: guest.displayName?.trim() || guest.email?.trim() || "", email: guest.email?.trim().toLowerCase() || "" }));
  if (guests.some((guest) => !/^\S+@\S+\.\S+$/.test(guest.email))) return new Response("Each guest needs a valid email.", { status: 400 });
  const saved = await repository.savePlanningDraft({ sessionId: current.session.id, title: input.title?.trim(), startsAt, endsAt, guests, availabilityOverride: Boolean(input.availabilityOverride) });
  return Response.json(saved);
}

async function confirmPlanning(request: Request) {
  const current = await plannerSession(request);
  if (!current) return new Response("Planning session unavailable.", { status: 401 });
  workflowLog("api", "planner.confirm.received", { planningSessionId: current.session.id });
  try {
    const result = await repository.confirmPlanningSession(current.session.id);
    const outcomes = await outboxPublisher.publish(result.outboxEvents);
    const calendarSync = outcomes.some((outcome) => outcome.status === "accepted") ? "accepted" : "deferred";
    workflowLog("api", "planner.confirm.calendar_sync_handoff", { planningSessionId: current.session.id, meetingId: result.meetingId, calendarSync });
    return Response.json({ meetingId: result.meetingId, calendarSync });
  } catch (error) {
    workflowError("api", "planner.confirm.failed", error, { planningSessionId: current.session.id });
    return Response.json({ message: error instanceof Error ? error.message : "Unable to confirm the meeting." }, { status: 400 });
  }
}

async function saveFallbackEmail(request: Request) {
  const current = await plannerSession(request);
  if (!current) return new Response("Planning session unavailable.", { status: 401 });
  const input = await request.json() as { attendeeId?: string; email?: string };
  if (!input.attendeeId || !input.email || !/^\S+@\S+\.\S+$/.test(input.email)) return new Response("Provide an attendee and a valid email.", { status: 400 });
  return Response.json(await repository.setPlanningAttendeeFallbackEmail({ sessionId: current.session.id, attendeeId: input.attendeeId, email: input.email }));
}

async function plannerSession(request: Request) {
  const token = request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith("technyu_planner="))?.slice("technyu_planner=".length);
  return token ? repository.getPlanningSessionForBrowserToken(await hashToken(token)) : undefined;
}

function webSessionToken(request: Request) {
  return request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith("technyu_web="))?.slice("technyu_web=".length);
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

async function servePlanner(pathname: string) {
  const relative = pathname === "/plan" || pathname === "/plan/" ? "index.html" : pathname.slice("/plan/".length);
  if (relative.includes("..")) return new Response("Not found", { status: 404 });
  const asset = Bun.file(new URL(`../../web/dist/${relative}`, import.meta.url));
  if (await asset.exists()) return new Response(asset);
  return new Response("Planner frontend has not been built. Run bun --filter @technyu/web build.", { status: 503 });
}

function randomToken() {
  return crypto.getRandomValues(new Uint8Array(32)).reduce((value, byte) => value + byte.toString(16).padStart(2, "0"), "");
}

async function hashToken(value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
