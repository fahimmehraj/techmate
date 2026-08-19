import { createGoogleCalendarEvent, deleteGoogleCalendarEvent } from "@technyu/adapters/google";
import { BuiltInNotificationDispatcher, sendDiscordChannelMessage, sendDiscordDm } from "@technyu/adapters/discord";
import { effectiveTaskReminderPolicy, isRecurringTaskReminder, nextTaskReminderAt, type OutboxPublisher } from "@technyu/application";
import type { PostgresCoordinatorRepository } from "@technyu/db";
import { apiInngest } from "./client.ts";
import { workflowError, workflowLog, workflowWarn } from "./log.ts";

export function createApiWorkflowFunctions(repository: PostgresCoordinatorRepository, publisher: OutboxPublisher) {
  const notifications = new BuiltInNotificationDispatcher();
  const outboxSweep = apiInngest.createFunction(
    { id: "outbox-sweep", retries: 3 },
    { cron: "* * * * *" },
    async ({ step }) => {
      const events = await step.run("load-pending-outbox", () => repository.listPendingOutbox());
      workflowLog("workflow-api", "outbox.sweep.loaded", { pendingCount: events.length });
      const outcomes = await step.run("publish-pending-outbox", () => publisher.publish(events));
      return { dispatched: outcomes.filter((outcome) => outcome.status === "accepted").length, deferred: outcomes.filter((outcome) => outcome.status === "deferred").length };
    },
  );
  const calendarSync = apiInngest.createFunction(
    { id: "calendar-sync", retries: 5 },
    { event: "coordinator/calendar.sync" },
    async ({ event, step }) => {
      workflowLog("workflow-api", "calendar.sync.received", { meetingId: event.data.meetingId, version: event.data.version });
      try {
        const loaded = await step.run("load-current-meeting", () => repository.loadCalendarSync(event.data.meetingId));
        const current = hydrateCalendarLoaded(loaded);
        if (!current) {
          workflowWarn("workflow-api", "calendar.sync.skipped", { meetingId: event.data.meetingId, reason: "meeting_not_calendar_pending_or_organizer_unavailable" });
          return { skipped: true };
        }
        if (event.data.version && current.meeting.version !== event.data.version) {
          workflowWarn("workflow-api", "calendar.sync.skipped", { meetingId: event.data.meetingId, reason: "stale_version", expectedVersion: event.data.version, currentVersion: current.meeting.version });
          return { skipped: true };
        }
        const existing = await step.run("load-existing-calendar-event", () => repository.getExistingCalendarEvent(current.meeting.id));
        workflowLog("workflow-api", "calendar.google.write.started", { meetingId: current.meeting.id, participantCount: current.participants.length, operation: existing ? "update" : "create" });
        const created = await step.run("sync-google-calendar", () => createGoogleCalendarEvent({
          organizer: current.organizer,
          refreshToken: current.encryptedRefreshToken,
          meeting: current.meeting,
          participants: current.participants,
          existingEventId: existing?.externalEventId,
        }));
        workflowLog("workflow-api", "calendar.google.write.succeeded", { meetingId: current.meeting.id, externalEventId: created.externalEventId, hasHtmlLink: Boolean(created.htmlLink) });
        await step.run("persist-calendar-sync", () => repository.completeCalendarSync({
          meetingId: current.meeting.id,
          connectionId: current.organizer.id,
          ...created,
        }));
        workflowLog("workflow-api", "calendar.sync.persisted", { meetingId: current.meeting.id });
        const announcement = hydrateAnnouncement(await step.run("load-announcement", () => repository.loadAnnouncement(current.meeting.id)));
        if (announcement?.endpoint?.driverId === "discord.channel") {
          const endpoint = announcement.endpoint;
          await step.run("announce-to-discord", () => sendDiscordChannelMessage(
            endpoint.address,
            formatAnnouncement(announcement.meeting, announcement.htmlLink ?? undefined),
            [{ type: 1, components: [{ type: 2, style: 1, custom_id: `room-start:${announcement.meeting.id}`, label: "Find a room" }] }],
          ));
          workflowLog("workflow-api", "calendar.discord.announced", { meetingId: current.meeting.id, endpointId: endpoint.id });
        }
        if (announcement?.meeting.time) {
          const when = new Date(announcement.meeting.time.startsAt.getTime() - 60 * 60_000);
          if (when > new Date()) {
            await step.sendEvent("queue-meeting-reminder", { name: "coordinator/meeting.remind", data: { meetingId: announcement.meeting.id, version: announcement.meeting.version, startsAt: announcement.meeting.time.startsAt.toISOString() }, id: `reminder:${announcement.meeting.id}:${announcement.meeting.version}` });
            workflowLog("workflow-api", "calendar.reminder.queued", { meetingId: current.meeting.id, version: announcement.meeting.version, sendsAt: when.toISOString() });
          }
        }
        workflowLog("workflow-api", "calendar.sync.completed", { meetingId: current.meeting.id });
        return { meetingId: current.meeting.id };
      } catch (error) {
        workflowError("workflow-api", "calendar.sync.failed", error, { meetingId: event.data.meetingId, version: event.data.version });
        throw error;
      }
    },
  );

  const calendarCancel = apiInngest.createFunction(
    { id: "calendar-cancel", retries: 5 },
    { event: "coordinator/calendar.cancel" },
    async ({ event, step }) => {
      workflowLog("workflow-api", "calendar.cancel.received", { meetingId: event.data.meetingId, version: event.data.version });
      try {
        const cancellation = await step.run("load-current-cancellation", () => repository.loadCalendarCancellation(event.data.meetingId));
        if (!cancellation) {
          workflowWarn("workflow-api", "calendar.cancel.skipped", { meetingId: event.data.meetingId, reason: "meeting_or_calendar_event_not_cancellable" });
          return { skipped: true };
        }
        await step.run("delete-google-calendar-event", () => deleteGoogleCalendarEvent({ organizer: cancellation.organizer, refreshToken: cancellation.encryptedRefreshToken, externalEventId: cancellation.externalEventId }));
        await step.run("persist-calendar-cancellation", () => repository.completeCalendarCancellation(undefined, event.data.meetingId));
        workflowLog("workflow-api", "calendar.cancel.completed", { meetingId: event.data.meetingId });
        return { meetingId: event.data.meetingId };
      } catch (error) {
        workflowError("workflow-api", "calendar.cancel.failed", error, { meetingId: event.data.meetingId, version: event.data.version });
        throw error;
      }
    },
  );

  const reminder = apiInngest.createFunction(
    { id: "meeting-reminder", retries: 3 },
    { event: "coordinator/meeting.remind" },
    async ({ event, step }) => {
      workflowLog("workflow-api", "reminder.received", { meetingId: event.data.meetingId, version: event.data.version, startsAt: event.data.startsAt });
      const startsAt = new Date(event.data.startsAt);
      await step.sleepUntil("one-hour-before-meeting", new Date(startsAt.getTime() - 60 * 60_000));
      const loaded = hydrateReminder(await step.run("reload-meeting", () => repository.loadReminder(event.data.meetingId)));
      if (!loaded || loaded.meeting.status !== "scheduled" || loaded.meeting.version !== event.data.version) {
        workflowWarn("workflow-api", "reminder.skipped", { meetingId: event.data.meetingId, reason: "meeting_changed_or_not_scheduled" });
        return { skipped: true };
      }
      const text = `Reminder: **${loaded.meeting.title}** starts in one hour.\n${loaded.meeting.time!.startsAt.toLocaleString("en-US", { timeZone: loaded.meeting.timeZone, dateStyle: "medium", timeStyle: "short" })}${loaded.htmlLink ? `\nGoogle Calendar: ${loaded.htmlLink}` : ""}`;
      await step.run("send-meeting-reminders", () => Promise.allSettled(loaded.endpoints.filter((endpoint) => endpoint.driverId === "discord.dm").map((endpoint) => sendDiscordDm(endpoint.address, text))));
      workflowLog("workflow-api", "reminder.completed", { meetingId: event.data.meetingId, recipientCount: loaded.endpoints.length });
      return { meetingId: event.data.meetingId };
    },
  );

  const taskAssignmentReminder = apiInngest.createFunction(
    { id: "task-assignment-reminder", retries: 3 },
    { event: "coordinator/task.assignment.remind" },
    async ({ event, step }) => {
      const assignmentId = event.data.assignmentId;
      const reminderVersion = event.data.reminderVersion;
      workflowLog("workflow-api", "task.reminder.received", { assignmentId, reminderVersion });
      const initial = hydrateTaskReminder(await step.run("load-task-assignment", () => repository.loadTaskReminder(assignmentId)));
      if (!canSendTaskReminder(initial, reminderVersion)) {
        workflowWarn("workflow-api", "task.reminder.skipped", { assignmentId, reminderVersion, reason: "assignment_not_open_or_stale" });
        return { skipped: true };
      }
      const policy = effectiveTaskReminderPolicy(initial.assignment.reminderPolicyOverride, initial.defaultPolicy);
      const scheduledFor = event.data.scheduledFor ? new Date(event.data.scheduledFor) : nextTaskReminderAt({ policy, dueAt: initial.task.dueAt });
      if (!scheduledFor || Number.isNaN(scheduledFor.valueOf())) {
        workflowWarn("workflow-api", "task.reminder.skipped", { assignmentId, reminderVersion, reason: "no_due_date_or_policy_disabled" });
        return { skipped: true };
      }
      workflowLog("workflow-api", "task.reminder.sleeping", { assignmentId, reminderVersion, policy, scheduledFor: scheduledFor.toISOString() });
      await step.sleepUntil(`wait-until-${scheduledFor.getTime()}`, scheduledFor);
      const current = hydrateTaskReminder(await step.run("reload-task-assignment", () => repository.loadTaskReminder(assignmentId)));
      if (!canSendTaskReminder(current, reminderVersion)) {
        workflowWarn("workflow-api", "task.reminder.skipped", { assignmentId, reminderVersion, reason: "assignment_changed_while_waiting" });
        return { skipped: true };
      }
      if (!current.endpoint) {
        workflowWarn("workflow-api", "task.reminder.delivery_failed", { assignmentId, reminderVersion, reason: "missing_direct_endpoint" });
        return { delivered: false, reason: "missing_direct_endpoint" };
      }
      if (current.endpoint.status !== "active") {
        const endpoint = current.endpoint;
        await step.run("record-unaddressable-delivery", () => repository.recordTaskReminderDelivery({ assignmentId, endpointId: endpoint.id, reminderRevision: reminderVersion, scheduledFor, status: "failed", error: "The selected direct-notification endpoint is disabled." }));
        workflowWarn("workflow-api", "task.reminder.delivery_failed", { assignmentId, reminderVersion, reason: "disabled_direct_endpoint" });
        return { delivered: false, reason: "disabled_direct_endpoint" };
      }
      const endpoint = current.endpoint;
      try {
        workflowLog("workflow-api", "task.reminder.delivery_started", { assignmentId, reminderVersion, driverId: endpoint.driverId });
        await step.run("send-task-direct-notification", () => notifications.dispatch({
          endpoint,
          event: {
            title: current.task.title,
            body: formatTaskReminder(current.task, scheduledFor),
            actions: [
            { kind: "complete_task_assignment", assignmentId, label: "Mark done" },
            { kind: "change_task_reminder", assignmentId, label: "Reminder settings" },
            ],
          },
          idempotencyKey: `task-reminder:${assignmentId}:${reminderVersion}:${scheduledFor.getTime()}`,
        }));
        await step.run("record-task-delivery", () => repository.recordTaskReminderDelivery({ assignmentId, endpointId: endpoint.id, reminderRevision: reminderVersion, scheduledFor, status: "sent" }));
        workflowLog("workflow-api", "task.reminder.delivery_succeeded", { assignmentId, reminderVersion });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await step.run("record-task-delivery-failure", () => repository.recordTaskReminderDelivery({ assignmentId, endpointId: endpoint.id, reminderRevision: reminderVersion, scheduledFor, status: "failed", error: message.slice(0, 500) }));
        workflowError("workflow-api", "task.reminder.delivery_failed", error, { assignmentId, reminderVersion, driverId: endpoint.driverId });
        throw error;
      }
      if (isRecurringTaskReminder(policy)) {
        const next = nextTaskReminderAt({ policy, dueAt: current.task.dueAt, after: scheduledFor });
        if (next) {
          await step.sendEvent("queue-next-task-reminder", {
            id: `task-reminder:${assignmentId}:${reminderVersion}:${next.getTime()}`,
            name: "coordinator/task.assignment.remind",
            data: { assignmentId, reminderVersion, scheduledFor: next.toISOString() },
          });
          workflowLog("workflow-api", "task.reminder.next_queued", { assignmentId, reminderVersion, scheduledFor: next.toISOString() });
        }
      }
      return { delivered: true };
    },
  );

  return [outboxSweep, calendarSync, calendarCancel, reminder, taskAssignmentReminder];
}

function formatAnnouncement(meeting: { title: string; time?: { startsAt: Date }; timeZone: string; location?: string }, htmlLink?: string) {
  const time = meeting.time!.startsAt.toLocaleString("en-US", { timeZone: meeting.timeZone, dateStyle: "medium", timeStyle: "short" });
  return `📅 **${meeting.title}**\n${time}${meeting.location ? `\nLocation: ${meeting.location}` : ""}${htmlLink ? `\nGoogle Calendar: ${htmlLink}` : ""}`;
}

function hydrateMeeting<T extends { time?: { startsAt: Date | string; endsAt: Date | string } }>(meeting: T): T {
  if (!meeting.time) return meeting;
  return { ...meeting, time: { startsAt: new Date(meeting.time.startsAt), endsAt: new Date(meeting.time.endsAt) } } as T;
}

function hydrateCalendarLoaded(value: unknown) {
  if (!value) return undefined;
  const loaded = value as Awaited<ReturnType<PostgresCoordinatorRepository["loadCalendarSync"]>>;
  return loaded ? { ...loaded, meeting: hydrateMeeting(loaded.meeting) } : undefined;
}

function hydrateAnnouncement(value: unknown) {
  if (!value) return undefined;
  const loaded = value as Awaited<ReturnType<PostgresCoordinatorRepository["loadAnnouncement"]>>;
  return loaded ? { ...loaded, meeting: hydrateMeeting(loaded.meeting) } : undefined;
}

function hydrateReminder(value: unknown) {
  if (!value) return undefined;
  const loaded = value as Awaited<ReturnType<PostgresCoordinatorRepository["loadReminder"]>>;
  return loaded ? { ...loaded, meeting: hydrateMeeting(loaded.meeting) } : undefined;
}

function hydrateTaskReminder(value: unknown) {
  if (!value) return undefined;
  const loaded = value as Awaited<ReturnType<PostgresCoordinatorRepository["loadTaskReminder"]>>;
  if (!loaded) return undefined;
  return { ...loaded, task: { ...loaded.task, dueAt: loaded.task.dueAt ? new Date(loaded.task.dueAt) : undefined } };
}

function canSendTaskReminder(value: ReturnType<typeof hydrateTaskReminder>, reminderVersion: number): value is NonNullable<ReturnType<typeof hydrateTaskReminder>> {
  return Boolean(value && value.task.status === "open" && value.assignment.status === "open" && value.assignment.reminderRevision === reminderVersion);
}

function formatTaskReminder(task: { description?: string; dueAt?: Date; timeZone: string }, scheduledFor: Date) {
  const due = task.dueAt?.toLocaleString("en-US", { timeZone: task.timeZone, dateStyle: "medium", timeStyle: "short" });
  return `${task.description ? `${task.description}\n` : ""}${due ? `Due: ${due}` : ""}${scheduledFor ? "\nYou can update your personal reminder setting below." : ""}`.trim();
}
