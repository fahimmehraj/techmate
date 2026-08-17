import type { DirectNotification, DirectNotificationDispatcher, DirectNotificationResult } from "@technyu/application";
import { sendDiscordDm } from "./rest.ts";

/**
 * The client switch stays intentionally small. New direct-message clients add
 * one adapter here; web is not an inbox and has no branch.
 */
export class BuiltInDirectNotificationDispatcher implements DirectNotificationDispatcher {
  async send(input: DirectNotification): Promise<DirectNotificationResult> {
    if (input.client !== "discord") throw new Error(`No direct-notification adapter is installed for ${input.client}.`);
    const components = input.actions.length ? [{
      type: 1,
      components: input.actions.map((action) => ({
        type: 2,
        style: action.kind === "complete_task_assignment" ? 3 : 2,
        custom_id: action.kind === "complete_task_assignment" ? `task-complete:${action.assignmentId}` : `task-reminder:${action.assignmentId}`,
        label: action.label,
      })),
    }] : undefined;
    await sendDiscordDm(input.recipientSubjectId, `**${input.title}**\n${input.body}`, components);
    return { status: "sent" };
  }
}
