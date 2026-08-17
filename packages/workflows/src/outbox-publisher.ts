import type { OutboxDispatchOutcome, OutboxPublisher, PendingOutboxEvent } from "@technyu/application";
import type { PostgresCoordinatorRepository } from "@technyu/db";
import { apiInngest } from "./client.ts";
import { workflowError, workflowLog, workflowWarn } from "./log.ts";

const HANDOFF_TIMEOUT_MS = 1_500;
type SendEvent = (event: unknown) => Promise<unknown>;

export class InngestOutboxPublisher implements OutboxPublisher {
  constructor(
    private readonly repository: PostgresCoordinatorRepository,
    private readonly sendEvent: SendEvent = (event) => apiInngest.send(event as never),
  ) {}

  async publish(events: PendingOutboxEvent[]) {
    return Promise.all(events.map((event) => this.publishOne(event)));
  }

  async recoverPending(limit = 50) {
    const events = await this.repository.listPendingOutbox(limit);
    workflowLog("outbox-publisher", "outbox.recovery.loaded", { pendingCount: events.length });
    return this.publish(events);
  }

  private async publishOne(event: PendingOutboxEvent): Promise<OutboxDispatchOutcome> {
    const name = toInngestEventName(event.type);
    if (!name) {
      await this.repository.markOutboxFailed(event.id, `Unsupported outbox type: ${event.type}`);
      workflowWarn("outbox-publisher", "outbox.publish.unsupported", { outboxId: event.id, type: event.type, aggregateId: event.aggregateId });
      return { outboxId: event.id, status: "unsupported" };
    }

    workflowLog("outbox-publisher", "outbox.publish.started", { outboxId: event.id, type: event.type, eventName: name, aggregateId: event.aggregateId, version: event.expectedVersion });
    try {
      await withDeadline(
        this.sendEvent({ id: event.id, name, data: eventData(event) } as never),
        HANDOFF_TIMEOUT_MS,
      );
      const marked = await this.repository.markOutboxDispatched(event.id);
      workflowLog("outbox-publisher", "outbox.publish.accepted", { outboxId: event.id, eventName: name, aggregateId: event.aggregateId, markedDispatched: marked });
      return { outboxId: event.id, status: "accepted" };
    } catch (error) {
      try {
        await this.repository.recordOutboxDispatchFailure(event.id, errorMessage(error));
      } catch (recordError) {
        workflowError("outbox-publisher", "outbox.publish.failure_not_recorded", recordError, { outboxId: event.id, originalError: errorMessage(error) });
      }
      workflowError("outbox-publisher", "outbox.publish.deferred", error, { outboxId: event.id, type: event.type, eventName: name, aggregateId: event.aggregateId });
      return { outboxId: event.id, status: "deferred" };
    }
  }
}

function toInngestEventName(type: string) {
  const names: Record<string, "coordinator/calendar.sync" | "coordinator/calendar.cancel" | "coordinator/room.discover" | "coordinator/room.submit" | "coordinator/task.assignment.remind"> = {
    "meeting.calendar_sync_requested": "coordinator/calendar.sync",
    "meeting.calendar_cancel_requested": "coordinator/calendar.cancel",
    "room.discovery_requested": "coordinator/room.discover",
    "room.submission_requested": "coordinator/room.submit",
    "task.assignment_reminder_requested": "coordinator/task.assignment.remind",
  };
  return names[type];
}

function eventData(event: PendingOutboxEvent) {
  if (event.type.startsWith("meeting.")) {
    return { meetingId: event.aggregateId, version: event.expectedVersion };
  }
  if (event.type.startsWith("task.")) return { assignmentId: event.aggregateId, reminderVersion: event.expectedVersion };
  return { roomBookingId: event.aggregateId };
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Inngest handoff exceeded ${timeoutMs}ms.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
