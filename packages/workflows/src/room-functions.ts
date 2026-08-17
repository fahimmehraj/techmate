import { BuiltInRoomProviderRegistry } from "@technyu/adapters/rooms";
import { rankRoomCandidates, type OutboxPublisher } from "@technyu/application";
import type { PostgresCoordinatorRepository } from "@technyu/db";
import { roomInngest } from "./client.ts";
import { workflowError, workflowLog, workflowWarn } from "./log.ts";

export function createRoomWorkflowFunctions(repository: PostgresCoordinatorRepository, publisher: OutboxPublisher) {
  const providers = new BuiltInRoomProviderRegistry();
  const discover = roomInngest.createFunction(
    { id: "room-discover", retries: 3 },
    { event: "coordinator/room.discover" },
    async ({ event, step }) => {
      workflowLog("workflow-room", "room.discovery.received", { roomBookingId: event.data.roomBookingId });
      try {
        const loaded = await step.run("load-room-discovery", () => repository.loadRoomDiscovery(event.data.roomBookingId));
        const current = hydrateRoomLoaded(loaded);
        if (!current) {
          workflowWarn("workflow-room", "room.discovery.skipped", { roomBookingId: event.data.roomBookingId, reason: "booking_not_discovering" });
          return { skipped: true };
        }
        const provider = providers.get(current.installation.providerId);
        if (!provider) throw new Error("This room provider is not installed in this deployment.");
        workflowLog("workflow-room", "room.provider.search.started", { roomBookingId: event.data.roomBookingId, meetingId: current.meeting.id, providerId: current.installation.providerId, attendeeCount: current.attendeeCount });
        const candidates = await step.run("search-provider", async () => rankRoomCandidates(await provider.search({ installation: current.installation, time: current.meeting.time!, requirement: { attendeeCount: current.attendeeCount, modality: "in_person" } }), { attendeeCount: current.attendeeCount, modality: "in_person" }));
        if (!candidates.length) throw new Error("No room is available for this meeting time.");
        workflowLog("workflow-room", "room.provider.search.succeeded", { roomBookingId: event.data.roomBookingId, candidateCount: candidates.length });
        await step.run("save-room-candidates", () => repository.completeRoomDiscovery(undefined, event.data.roomBookingId, candidates.map((candidate) => ({ ...candidate, observedAt: candidate.observedAt ? new Date(candidate.observedAt) : undefined }))));
        workflowLog("workflow-room", "room.discovery.completed", { roomBookingId: event.data.roomBookingId });
        return { roomBookingId: event.data.roomBookingId };
      } catch (error) {
        workflowError("workflow-room", "room.discovery.failed", error, { roomBookingId: event.data.roomBookingId });
        throw error;
      }
    },
  );
  const submit = roomInngest.createFunction(
    { id: "room-submit", retries: 3 },
    { event: "coordinator/room.submit" },
    async ({ event, step }) => {
      workflowLog("workflow-room", "room.submission.received", { roomBookingId: event.data.roomBookingId });
      try {
        const loaded = await step.run("load-room-submission", () => repository.loadRoomSubmission(event.data.roomBookingId));
        const current = hydrateRoomLoaded(loaded);
        if (!current) {
          workflowWarn("workflow-room", "room.submission.skipped", { roomBookingId: event.data.roomBookingId, reason: "booking_not_submitting" });
          return { skipped: true };
        }
        const provider = providers.get(current.installation.providerId);
        if (!provider) throw new Error("This room provider is not installed in this deployment.");
        workflowLog("workflow-room", "room.provider.submit.started", { roomBookingId: event.data.roomBookingId, meetingId: current.meeting.id, providerId: current.installation.providerId });
        const result = await step.run("submit-provider-request", () => provider.submit({ installation: current.installation, booking: current.booking, meeting: { title: current.meeting.title, time: current.meeting.time!, attendeeCount: current.attendeeCount } }));
        workflowLog("workflow-room", "room.provider.submit.succeeded", { roomBookingId: event.data.roomBookingId, hasProviderReference: Boolean(result.reference) });
        const outboxEvents = await step.run("save-room-submission", () => repository.completeRoomSubmission(undefined, event.data.roomBookingId, result.reference));
        await step.run("publish-calendar-sync", () => publisher.publish(outboxEvents));
        workflowLog("workflow-room", "room.submission.completed", { roomBookingId: event.data.roomBookingId, meetingId: current.meeting.id });
        return { roomBookingId: event.data.roomBookingId };
      } catch (error) {
        workflowError("workflow-room", "room.submission.failed", error, { roomBookingId: event.data.roomBookingId });
        throw error;
      }
    },
  );
  return [discover, submit];
}

function hydrateRoomLoaded(value: unknown) {
  if (!value) return undefined;
  const loaded = value as Awaited<ReturnType<PostgresCoordinatorRepository["loadRoomDiscovery"]>>;
  if (!loaded) return undefined;
  return { ...loaded, meeting: loaded.meeting.time ? { ...loaded.meeting, time: { startsAt: new Date(loaded.meeting.time.startsAt), endsAt: new Date(loaded.meeting.time.endsAt) } } : loaded.meeting };
}
