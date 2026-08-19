import type { DirectNotificationResult, NotificationDispatcher, NotificationDispatch } from "@technyu/application";
import { sendDiscordDm } from "./rest.ts";

/**
 * The client switch stays intentionally small. New direct-message clients add
 * one adapter here; web is not an inbox and has no branch.
 */
export class BuiltInNotificationDispatcher implements NotificationDispatcher {
  async dispatch(input: NotificationDispatch): Promise<DirectNotificationResult> {
    if (input.endpoint.driverId !== "discord.dm") throw new Error(`No notification adapter is installed for ${input.endpoint.driverId}.`);
    const components = input.event.actions.length ? [{
      type: 1,
      components: input.event.actions.map((action) => ({
        type: 2,
        style: action.kind === "complete_task_assignment" ? 3 : 2,
        custom_id: action.kind === "complete_task_assignment" ? `task-complete:${action.assignmentId}` : `task-reminder:${action.assignmentId}`,
        label: action.label,
      })),
    }] : undefined;
    await sendDiscordDm(input.endpoint.address, `**${input.event.title}**\n${input.event.body}`, components);
    return { status: "sent" };
  }
}
