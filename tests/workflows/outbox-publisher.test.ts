import { describe, expect, test } from "bun:test";
import type { PendingOutboxEvent } from "../../packages/application/src/ports.ts";
import type { PostgresCoordinatorRepository } from "../../packages/db/src/repository.ts";
import { InngestOutboxPublisher } from "../../packages/workflows/src/outbox-publisher.ts";

const event: PendingOutboxEvent = {
  id: "outbox-1",
  type: "meeting.calendar_sync_requested",
  aggregateId: "meeting-1",
  expectedVersion: 2,
  payload: {},
};

function repository(overrides: Partial<Record<"listPendingOutbox" | "markOutboxDispatched" | "markOutboxFailed" | "recordOutboxDispatchFailure", unknown>> = {}) {
  return {
    listPendingOutbox: async () => [],
    markOutboxDispatched: async () => true,
    markOutboxFailed: async () => true,
    recordOutboxDispatchFailure: async () => true,
    ...overrides,
  } as unknown as PostgresCoordinatorRepository;
}

describe("Inngest outbox publisher", () => {
  test("routes task assignment reminders through the durable assignment aggregate", async () => {
    const sent: unknown[] = [];
    const taskEvent = { ...event, type: "task.assignment_reminder_requested", aggregateId: "assignment-1", expectedVersion: 4 };
    const publisher = new InngestOutboxPublisher(repository({ markOutboxDispatched: async () => true }), async (payload) => { sent.push(payload); });

    await expect(publisher.publish([taskEvent])).resolves.toEqual([{ outboxId: taskEvent.id, status: "accepted" }]);
    expect(sent).toEqual([{ id: taskEvent.id, name: "coordinator/task.assignment.remind", data: { assignmentId: "assignment-1", reminderVersion: 4 } }]);
  });

  test("hands an event to Inngest with the durable outbox ID and marks it dispatched", async () => {
    const sent: unknown[] = [];
    const marked: string[] = [];
    const publisher = new InngestOutboxPublisher(repository({
      markOutboxDispatched: async (id: string) => { marked.push(id); return true; },
    }), async (payload) => { sent.push(payload); });

    await expect(publisher.publish([event])).resolves.toEqual([{ outboxId: event.id, status: "accepted" }]);
    expect(sent).toEqual([{ id: event.id, name: "coordinator/calendar.sync", data: { meetingId: event.aggregateId, version: event.expectedVersion } }]);
    expect(marked).toEqual([event.id]);
  });

  test("keeps an event pending when the immediate handoff fails", async () => {
    const failures: Array<[string, string]> = [];
    const publisher = new InngestOutboxPublisher(repository({
      recordOutboxDispatchFailure: async (id: string, reason: string) => { failures.push([id, reason]); return true; },
    }), async () => { throw new Error("Inngest unavailable"); });

    await expect(publisher.publish([event])).resolves.toEqual([{ outboxId: event.id, status: "deferred" }]);
    expect(failures).toEqual([[event.id, "Inngest unavailable"]]);
  });

  test("makes unsupported work terminal without sending it", async () => {
    const failed: string[] = [];
    const publisher = new InngestOutboxPublisher(repository({
      markOutboxFailed: async (id: string) => { failed.push(id); return true; },
    }), async () => { throw new Error("should not send"); });

    await expect(publisher.publish([{ ...event, type: "unknown.work" }])).resolves.toEqual([{ outboxId: event.id, status: "unsupported" }]);
    expect(failed).toEqual([event.id]);
  });

  test("recovery republishes pending rows with their original idempotency IDs", async () => {
    const sent: unknown[] = [];
    const publisher = new InngestOutboxPublisher(repository({ listPendingOutbox: async () => [event] }), async (payload) => { sent.push(payload); });

    await publisher.recoverPending();
    expect(sent).toEqual([{ id: event.id, name: "coordinator/calendar.sync", data: { meetingId: event.aggregateId, version: event.expectedVersion } }]);
  });

  test("immediate and recovery handoffs retain the same idempotency ID", async () => {
    const sent: Array<{ id: string }> = [];
    const publisher = new InngestOutboxPublisher(repository({ listPendingOutbox: async () => [event] }), async (payload) => { sent.push(payload as { id: string }); });

    await Promise.all([publisher.publish([event]), publisher.recoverPending()]);
    expect(sent).toHaveLength(2);
    expect(sent.map((payload) => payload.id)).toEqual([event.id, event.id]);
  });
});
