export type PlanningEnrollmentNeed = "invite_email" | "availability";

export function planningEnrollmentDmContent(plannerDiscordUserId: string, need: PlanningEnrollmentNeed) {
  if (!plannerDiscordUserId) throw new Error("Unable to identify the meeting planner.");
  const request = need === "invite_email"
    ? "needs your calendar invite email"
    : "needs you to connect Google free/busy availability";
  return `<@${plannerDiscordUserId}> is planning a meeting and ${request}.`;
}
