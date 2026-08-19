import { directMeetingInputSchema, confirmMeeting, startDirectMeeting, type OutboxPublisher } from "@technyu/application";
import { candidateSlots, type ActorContext, type OrganizationSetupState } from "@technyu/core";
import type { PostgresCoordinatorRepository } from "@technyu/db";
import { createCodeVerifier, createGoogleAuthorizationUrl, createState } from "../google/oauth.ts";
import { getGoogleBusyIntervals } from "../google/calendar.ts";
import { BuiltInRoomProviderRegistry } from "../rooms/registry.ts";
import { listDiscordPeopleWithRole, sendDiscordDm } from "./rest.ts";
import { planningEnrollmentDmContent } from "./planning-enrollment.ts";
import { extractMentionableAudience, mentionableAudienceSelect } from "./planning.ts";
import { dueDatePage, dueHourSelect, dueMinuteSelect, reminderPolicySelect, savedTeamSelect, taskComposer, taskListSelect, teamListSelect } from "./tasks.ts";
import { buttonRow, initialPrompt, json, message, modal, prompt, replacePrompt, textInput, updateMessage, type DiscordPrompt } from "./responses.ts";
import { verifyDiscordRequest } from "./verify.ts";

type DiscordInteraction = {
  id: string;
  type: number;
  guild_id?: string;
  channel_id?: string;
  member?: { user: { id: string }; roles: string[]; permissions?: string };
  user?: { id: string };
  data?: { name?: string; custom_id?: string; components?: ModalRow[]; options?: Array<{ name?: string; type?: number }>; values?: string[]; resolved?: { users?: Record<string, { username?: string; global_name?: string | null }>; roles?: Record<string, { id?: string }> } };
  guild?: { name?: string };
};
type ModalRow = { components?: Array<{ custom_id?: string; value?: string }> };
type PromptResponseMode = "initial" | "replace";
type DiscordInvocation = Partial<ActorContext> & {
  idempotencyKey: string;
  discordGuildId?: string;
  discordUserId: string;
  discordRoleIds: string[];
  isAdministrator: boolean;
  channelId: string;
};
const roomProviders = new BuiltInRoomProviderRegistry();

function requireActor(invocation: DiscordInvocation): ActorContext {
  if (!invocation.organizationId || !invocation.integrationId || !invocation.personId) throw new Error("Run /setup first.");
  return {
    idempotencyKey: invocation.idempotencyKey,
    organizationId: invocation.organizationId,
    integrationId: invocation.integrationId,
    personId: invocation.personId,
    capabilities: invocation.capabilities ?? new Set<"organization:admin">(),
  };
}

async function discordChannelEndpoint(invocation: DiscordInvocation, repository: PostgresCoordinatorRepository) {
  const actor = requireActor(invocation);
  if (!invocation.channelId) throw new Error("A Discord channel is required for this action.");
  return repository.upsertNotificationEndpoint({ organizationId: actor.organizationId, integrationId: actor.integrationId, driverId: "discord.channel", address: invocation.channelId });
}

function respondToPrompt(view: DiscordPrompt, mode: PromptResponseMode = "initial") {
  return mode === "replace" ? replacePrompt(view) : initialPrompt(view);
}

export async function handleDiscordInteraction(request: Request, repository: PostgresCoordinatorRepository, outboxPublisher: OutboxPublisher): Promise<Response> {
  const body = await request.text();
  if (!(await verifyDiscordRequest(request, body))) {
    console.warn("Rejected Discord interaction with an invalid signature", {
      hasSignature: Boolean(request.headers.get("x-signature-ed25519")),
      hasTimestamp: Boolean(request.headers.get("x-signature-timestamp")),
      publicKeyConfigured: /^[0-9a-f]{64}$/i.test(process.env.DISCORD_PUBLIC_KEY?.trim() ?? ""),
    });
    return new Response("invalid request signature", { status: 401 });
  }
  const interaction = JSON.parse(body) as DiscordInteraction;
  if (interaction.type === 1) return json({ type: 1 });
  const transport = toInvocation(interaction);
  const actor = await repository.resolveDiscordActor({ guildId: transport.discordGuildId, discordUserId: transport.discordUserId, idempotencyKey: transport.idempotencyKey, isAdministrator: transport.isAdministrator });
  const invocation: DiscordInvocation = { ...transport, ...actor };
  try {
    if (interaction.type === 2) return json(await handleCommand(interaction, invocation, repository, outboxPublisher));
    if (interaction.type === 3) return json(await handleComponent(interaction, invocation, repository, outboxPublisher));
    if (interaction.type === 5) return json(await handleModal(interaction, invocation, repository, outboxPublisher));
    return new Response("unsupported interaction", { status: 400 });
  } catch (error) {
    return json(message(error instanceof Error ? error.message : "Unable to complete that action.", { ephemeral: true }));
  }
}

async function handleCommand(interaction: DiscordInteraction, invocation: DiscordInvocation, repository: PostgresCoordinatorRepository, outboxPublisher: OutboxPublisher) {
  switch (interaction.data?.name) {
    case "setup": {
      if (!interaction.guild_id || !invocation.isAdministrator) throw new Error("Only a Discord Administrator can run /setup.");
      const { org } = await repository.setupOrganization({
        guildId: interaction.guild_id,
        name: interaction.guild?.name ?? "Discord organization",
        discordUserId: invocation.discordUserId,
      });
      const setup = await repository.getOrganizationSetupState(org.id);
      return message(renderSetupDashboard(setup), {
        ephemeral: true,
        components: [buttonRow(
          { customId: "setup:connect-organizer", label: setup.phase === "ready" ? "Replace organizer calendar" : setup.phase === "calendar_reconnect_required" ? "Reconnect organizer calendar" : "Connect organizer calendar", style: setup.phase === "ready" ? 2 : 3 },
          { customId: "provider:configure-oncehub", label: "Configure eLab / OnceHub" },
        )],
      });
    }
    case "profile": {
      if (!invocation.organizationId || !invocation.personId) throw new Error("An administrator must run /setup first.");
      const profile = await repository.getPersonProfile(invocation.personId);
      if (!profile?.calendarInviteEndpoint) return profileModal("profile:register", "Register your profile");
      return initialPrompt(await profilePrompt(invocation, repository));
    }
    case "settings": {
      if (!invocation.organizationId || !invocation.personId) throw new Error("An administrator must run /setup first.");
      const owner = await repository.isOrganizationOwner(invocation.organizationId, invocation.personId);
      if (!invocation.isAdministrator && !owner) throw new Error("Only a Web owner or Discord Administrator can open organization settings.");
      const baseUrl = process.env.APP_BASE_URL;
      if (!baseUrl) throw new Error("APP_BASE_URL is required to open settings.");
      const rawToken = randomToken();
      await repository.createWebLaunch({ organizationId: invocation.organizationId, personId: invocation.personId, operation: "settings", tokenHash: await hashToken(rawToken) });
      return message("Open organization settings in your browser.", { ephemeral: true, components: [buttonRow({ label: "Open settings", url: `${baseUrl.replace(/\/$/, "")}/web/launch/${rawToken}` })] });
    }
    case "meet":
      if (!invocation.organizationId) throw new Error("An administrator must run /setup first.");
      if (subcommand(interaction) === "plan" || subcommand(interaction) === "find") return beginPlanningSession(invocation, repository, "create");
      if (subcommand(interaction) === "cancel") return modal("meeting:cancel", "Cancel a meeting", [textInput("meeting_id", "Meeting ID", { placeholder: "UUID from the review card" })]);
      if (subcommand(interaction) === "reschedule") return modal("meeting:reschedule", "Choose a meeting to reschedule", [textInput("meeting_id", "Meeting ID", { placeholder: "UUID from the Calendar announcement" })]);
      return beginPlanningSession(invocation, repository, "create");
    case "provider":
      if (!invocation.organizationId || !invocation.personId) throw new Error("An administrator must run /setup first.");
      if (subcommand(interaction) === "list") return providerList(invocation.organizationId, repository);
      if (!invocation.isAdministrator) throw new Error("Only a Discord Administrator can configure providers.");
      if (subcommand(interaction) === "configure") return onceHubConfigStepOne();
      if (subcommand(interaction) === "disable") {
        const installation = await repository.disableProviderInstallation(invocation.organizationId, "elab-oncehub", invocation.personId);
        return message(installation ? "OnceHub is disabled for this server." : "OnceHub is not configured.", { ephemeral: true });
      }
      throw new Error("Use /provider list, /provider configure, or /provider disable.");
    case "task":
      return handleTaskCommand(interaction, invocation, repository, outboxPublisher);
    case "team":
      return handleTeamCommand(interaction, invocation, repository);
    default:
      throw new Error("Unknown command. Register /setup, /profile, and /meet in Discord.");
  }
}

async function handleTaskCommand(interaction: DiscordInteraction, invocation: DiscordInvocation, repository: PostgresCoordinatorRepository, outboxPublisher: OutboxPublisher) {
  if (!invocation.organizationId || !invocation.personId || !invocation.integrationId) throw new Error("Run /setup first.");
  const command = subcommand(interaction) ?? "list";
  if (command === "create") return modal("task:create", "Create task", [
    textInput("title", "Task title", { placeholder: "Prepare sponsor outreach" }),
    textInput("description", "Details (optional)", { required: false, style: 2, placeholder: "What needs to be done?" }),
  ]);
  if (command === "preferences") return message("Choose your default task reminder behavior.", { ephemeral: true, components: [reminderPolicySelect("task-preferences")] });
  if (command === "list") return renderTaskList(invocation, repository);
  throw new Error("Use /task create, /task list, or /task preferences.");
}

async function handleTeamCommand(interaction: DiscordInteraction, invocation: DiscordInvocation, repository: PostgresCoordinatorRepository) {
  if (!invocation.organizationId || !invocation.personId) throw new Error("Run /setup first.");
  const command = subcommand(interaction) ?? "list";
  if (command === "create") return modal("team:create", "Create saved team", [textInput("name", "Team name", { placeholder: "Marketing" })]);
  return renderTeamList(invocation, repository);
}

async function renderTaskComposer(taskId: string, invocation: DiscordInvocation, repository: PostgresCoordinatorRepository, mode: PromptResponseMode = "initial") {
  if (!invocation.organizationId || !invocation.personId) throw new Error("Run /setup first.");
  const task = await repository.getTaskForCreator({ taskId, creatorPersonId: invocation.personId });
  if (!task) throw new Error("Only the task creator can edit this task.");
  const [assignments, teams] = await Promise.all([repository.getTaskAssignments(task.id), repository.listTeams(invocation.organizationId)]);
  return respondToPrompt(taskComposer({ task, assignments, teams }), mode);
}

async function renderTaskList(invocation: DiscordInvocation, repository: PostgresCoordinatorRepository, mode: PromptResponseMode = "initial") {
  if (!invocation.organizationId || !invocation.personId) throw new Error("Run /setup first.");
  const [entries, created] = await Promise.all([
    repository.listTasksForPerson({ organizationId: invocation.organizationId, personId: invocation.personId }),
    repository.listTasksCreatedBy({ organizationId: invocation.organizationId, personId: invocation.personId }),
  ]);
  if (!entries.length && !created.length) return respondToPrompt(prompt("You have no open tasks or active tasks you created."), mode);
  const problems = [
    ...entries.filter((entry) => entry.latestDelivery?.status === "failed"),
    ...created.flatMap((task) => task.assignments.filter((entry) => entry.latestDelivery?.status === "failed")),
  ];
  const components: Array<Record<string, unknown> | undefined> = [taskListSelect(entries)];
  if (created.length) {
    components.push(buttonRow(...created.slice(0, 5).map((task) => ({
      customId: `task-owner:${task.task.id}`,
      label: `Manage ${task.task.title}`.slice(0, 80),
      style: 2,
    }))));
  }
  const baseUrl = process.env.APP_BASE_URL;
  if (baseUrl) {
    const rawToken = randomToken();
    await repository.createWebLaunch({ organizationId: invocation.organizationId, personId: invocation.personId, operation: "tasks", tokenHash: await hashToken(rawToken) });
    components.push(buttonRow({ label: "Open task dashboard", url: `${baseUrl.replace(/\/$/, "")}/web/launch/${rawToken}` }));
  }
  const assignedText = entries.length
    ? entries.map((entry) => `• ${entry.task.title}${entry.task.dueAt ? ` — due ${entry.task.dueAt.toLocaleString("en-US", { timeZone: entry.task.timeZone, dateStyle: "medium", timeStyle: "short" })}` : ""}`).join("\n")
    : "None";
  const createdText = created.length
    ? created.map(({ task }) => `• ${task.title}${task.dueAt ? ` — due ${task.dueAt.toLocaleString("en-US", { timeZone: task.timeZone, dateStyle: "medium", timeStyle: "short" })}` : ""}`).join("\n")
    : "None";
  return respondToPrompt(prompt(`**Assigned to you**\n${assignedText}\n\n**Created by you**\n${createdText}${problems.length ? `\n\n⚠️ ${problems.length} task reminder delivery issue(s). Open a task you created or assigned to yourself for details.` : ""}`, components), mode);
}

async function renderTaskCard(assignmentId: string, invocation: DiscordInvocation, repository: PostgresCoordinatorRepository, mode: PromptResponseMode = "initial") {
  if (!invocation.organizationId || !invocation.personId) throw new Error("Run /setup first.");
  const entries = await repository.listTasksForPerson({ organizationId: invocation.organizationId, personId: invocation.personId, includeCompleted: true });
  const entry = entries.find((candidate) => candidate.assignment.id === assignmentId);
  if (!entry) throw new Error("This task is not assigned to you.");
  const due = entry.task.dueAt?.toLocaleString("en-US", { timeZone: entry.task.timeZone, dateStyle: "medium", timeStyle: "short" }) ?? "No due date";
  const failure = entry.latestDelivery?.status === "failed" ? `\n⚠️ Reminder delivery unavailable: ${entry.latestDelivery.error ?? "unknown reason"}` : "";
  const isCreator = entry.task.createdByPersonId === invocation.personId;
  const components = [buttonRow(
    ...(entry.assignment.status === "open" ? [{ customId: `task-complete:${entry.assignment.id}`, label: "Mark done", style: 3 }] : []),
    { customId: `task-reminder:${entry.assignment.id}`, label: "Reminder settings", style: 2 },
    ...(isCreator ? [{ customId: `task-edit:${entry.task.id}`, label: "Edit", style: 2 }, { customId: `task-due:${entry.task.id}:0`, label: "Due date", style: 2 }, { customId: `task-cancel:${entry.task.id}`, label: "Cancel", style: 4 }] : []),
  ), buttonRow({ customId: "task-back", label: "Back to task list", style: 2 })];
  return respondToPrompt(prompt(`**${entry.task.title}**\n${entry.task.description ?? "No description."}\nDue: ${due}\nCreated by: ${entry.creatorName}\nYour status: ${entry.assignment.status}${failure}`, components), mode);
}

async function renderTeamList(invocation: DiscordInvocation, repository: PostgresCoordinatorRepository, mode: PromptResponseMode = "initial") {
  if (!invocation.organizationId) throw new Error("Run /setup first.");
  const teams = await repository.listTeams(invocation.organizationId);
  const content = teams.length ? `**Saved teams**\n${teams.map((team) => `• ${team.name}`).join("\n")}` : "No saved teams yet. Use /team create to make one.";
  return respondToPrompt(prompt(content, [teamListSelect(teams)]), mode);
}

async function renderTeamCard(teamId: string, invocation: DiscordInvocation, repository: PostgresCoordinatorRepository, mode: PromptResponseMode = "initial") {
  if (!invocation.organizationId || !invocation.personId) throw new Error("Run /setup first.");
  const team = await repository.getTeam({ organizationId: invocation.organizationId, teamId });
  if (!team) throw new Error("That saved team no longer exists.");
  const members = await repository.getTeamPeople({ organizationId: invocation.organizationId, teamId });
  const canEdit = team.createdByPersonId === invocation.personId;
  return respondToPrompt(prompt(`**${team.name}**\nMembers: ${members.length ? members.map((member) => member.displayName).join(", ") : "None"}${canEdit ? "" : "\nOnly the team creator can change its members."}`, [
    ...(canEdit ? [{ type: 1, components: [{ type: 7, custom_id: `team-audience:${team.id}`, placeholder: "Add Discord users or roles", min_values: 1, max_values: 25 }] }] : []),
    buttonRow({ customId: "team-back", label: "Back to saved teams", style: 2 }),
  ]), mode);
}

/**
 * Commands in a server are resolved through its Discord guild. DMs have no
 * guild, so action buttons sent by the reminder worker authenticate through
 * the assignment they carry instead. This keeps the DM route scoped to exactly
 * one task and avoids guessing which organization a Discord account means.
 */
async function resolveTaskAssignmentInvocation(invocation: DiscordInvocation, assignmentId: string, repository: PostgresCoordinatorRepository) {
  if (invocation.organizationId && invocation.personId && invocation.integrationId) return invocation;
  if (!invocation.discordUserId) throw new Error("Unable to identify your Discord account.");
  const actor = await repository.resolveTaskAssignmentDiscordActor({ assignmentId, discordUserId: invocation.discordUserId });
  if (!actor) throw new Error("This task action is not assigned to your Discord account.");
  return { ...invocation, ...actor };
}

async function handleComponent(interaction: DiscordInteraction, invocation: DiscordInvocation, repository: PostgresCoordinatorRepository, outboxPublisher: OutboxPublisher) {
  const [kind, value, extra] = interaction.data?.custom_id?.split(":") ?? [];
  if (kind === "task-select") {
    const assignmentId = interaction.data?.values?.[0];
    if (!assignmentId) throw new Error("Choose a task first.");
    return renderTaskCard(assignmentId, invocation, repository, "replace");
  }
  if (kind === "task-back") return renderTaskList(invocation, repository, "replace");
  if (kind === "task-owner" && value) return renderTaskComposer(value, invocation, repository, "replace");
  if (kind === "task-audience" && value) {
    if (!invocation.personId) throw new Error("Unable to resolve the current person.");
    const people = await resolveDiscordAudience(interaction, invocation, repository);
    const result = await repository.addTaskAssignments({ taskId: value, creatorPersonId: invocation.personId, personIds: people.map((person) => person.id) });
    await outboxPublisher.publish(result.outboxEvents);
    return renderTaskComposer(value, invocation, repository, "replace");
  }
  if (kind === "task-team" && value) {
    if (!invocation.organizationId || !invocation.personId) throw new Error("Run /setup first.");
    const teamId = interaction.data?.values?.[0];
    if (!teamId) throw new Error("Choose a saved team.");
    const people = await repository.getTeamPeople({ organizationId: invocation.organizationId, teamId });
    const result = await repository.addTaskAssignments({ taskId: value, creatorPersonId: invocation.personId, personIds: people.map((person) => person.id) });
    await outboxPublisher.publish(result.outboxEvents);
    return renderTaskComposer(value, invocation, repository, "replace");
  }
  if (kind === "task-activate" && value) {
    if (!invocation.personId) throw new Error("Unable to resolve the current person.");
    const result = await repository.activateTask({ taskId: value, creatorPersonId: invocation.personId });
    await outboxPublisher.publish(result.outboxEvents);
    return renderTaskComposer(value, invocation, repository, "replace");
  }
  if (kind === "task-complete" && value) {
    const taskInvocation = await resolveTaskAssignmentInvocation(invocation, value, repository);
    await repository.completeTaskAssignment({ assignmentId: value, personId: taskInvocation.personId! });
    return replacePrompt(prompt("Marked done. Your task reminders have stopped."));
  }
  if (kind === "task-reminder" && value) {
    await resolveTaskAssignmentInvocation(invocation, value, repository);
    return replacePrompt(prompt("Choose a reminder setting for this task.", [reminderPolicySelect(`task-reminder-select:${value}`), buttonRow({ customId: `task-reminder-card:${value}`, label: "Back to task", style: 2 })]));
  }
  if (kind === "task-reminder-select" && value) {
    const taskInvocation = await resolveTaskAssignmentInvocation(invocation, value, repository);
    const chosen = interaction.data?.values?.[0];
    if (!chosen) throw new Error("Choose a reminder setting.");
    const policy = chosen === "default" ? undefined : chosen as "daily_until_done" | "one_day_before" | "one_hour_before" | "none";
    const result = await repository.setTaskAssignmentReminderOverride({ assignmentId: value, personId: taskInvocation.personId!, policy });
    await outboxPublisher.publish(result.outboxEvents);
    return renderTaskCard(value, taskInvocation, repository, "replace");
  }
  if (kind === "task-preferences") {
    if (!invocation.personId) throw new Error("Unable to resolve the current person.");
    const selected = interaction.data?.values?.[0];
    if (!selected || selected === "default") throw new Error("Choose a default reminder setting.");
    const policy = selected as "daily_until_done" | "one_day_before" | "one_hour_before" | "none";
    const events = await repository.setPersonTaskReminderPreference({ personId: invocation.personId, defaultPolicy: policy });
    await outboxPublisher.publish(events);
    return replacePrompt(prompt(`Your default task reminder is now **${formatReminderPolicy(policy)}**. Open tasks using your default were rescheduled.`, [reminderPolicySelect("task-preferences", policy)]));
  }
  if (kind === "task-edit" && value) {
    if (!invocation.personId) throw new Error("Unable to resolve the current person.");
    const task = await repository.getTaskForCreator({ taskId: value, creatorPersonId: invocation.personId });
    if (!task) throw new Error("Only the task creator can edit this task.");
    return modal(`task-edit:${value}`, "Edit task", [textInput("title", "Task title", { value: task.title }), textInput("description", "Details (optional)", { required: false, style: 2, value: task.description })]);
  }
  if (kind === "task-due" && value) {
    const view = dueDatePage(value, Number(extra ?? "0"));
    return replacePrompt(prompt(view.content, view.components));
  }
  if (kind === "task-due-date" && value) {
    const date = interaction.data?.values?.[0];
    if (!date) throw new Error("Choose a date.");
    const view = dueHourSelect(value, date);
    return replacePrompt(prompt(view.content, view.components));
  }
  if (kind === "task-due-hour" && value) {
    const date = extra;
    const hour = interaction.data?.values?.[0];
    if (!date || !hour) throw new Error("Choose a date and time.");
    if (hour === "end") return saveTaskDueDate(value, date, 17, 0, invocation, repository, outboxPublisher);
    const view = dueMinuteSelect(value, date, hour);
    return replacePrompt(prompt(view.content, view.components));
  }
  if (kind === "task-due-minute" && value) {
    const [, , date, hour] = interaction.data?.custom_id?.split(":") ?? [];
    const minute = interaction.data?.values?.[0];
    if (!date || hour === undefined || !minute) throw new Error("Choose a date and time.");
    return saveTaskDueDate(value, date, Number(hour), Number(minute), invocation, repository, outboxPublisher);
  }
  if (kind === "task-clear-due" && value) {
    if (!invocation.personId) throw new Error("Unable to resolve the current person.");
    const result = await repository.updateTask({ taskId: value, creatorPersonId: invocation.personId, dueAt: null });
    await outboxPublisher.publish(result.outboxEvents);
    return renderTaskComposer(value, invocation, repository, "replace");
  }
  if (kind === "task-cancel" && value) {
    if (!invocation.personId) throw new Error("Unable to resolve the current person.");
    await repository.cancelTask({ taskId: value, creatorPersonId: invocation.personId });
    return replacePrompt(prompt("Task cancelled. No further reminders will be sent."));
  }
  if (kind === "task-reminder-card" && value) {
    const taskInvocation = await resolveTaskAssignmentInvocation(invocation, value, repository);
    return renderTaskCard(value, taskInvocation, repository, "replace");
  }
  if (kind === "team-select") {
    const teamId = interaction.data?.values?.[0];
    if (!teamId) throw new Error("Choose a saved team.");
    return renderTeamCard(teamId, invocation, repository, "replace");
  }
  if (kind === "team-back") return renderTeamList(invocation, repository, "replace");
  if (kind === "team-audience" && value) {
    if (!invocation.personId) throw new Error("Unable to resolve the current person.");
    const people = await resolveDiscordAudience(interaction, invocation, repository);
    await repository.addTeamMembers({ teamId: value, createdByPersonId: invocation.personId, personIds: people.map((person) => person.id) });
    return renderTeamCard(value, invocation, repository, "replace");
  }
  if (kind === "meeting-confirm" && value) {
    const events = await confirmMeeting(repository, requireActor(invocation), value);
    const outcomes = await outboxPublisher.publish(events);
    return replacePrompt(prompt(handoffMessage(outcomes, "Creating the Google Calendar event now. The channel will receive the event link when it succeeds.", "Meeting confirmed. Calendar synchronization is queued for automatic retry.")));
  }
  if (kind === "plan-audience" && value) return addPlanningAudience(interaction, invocation, repository, value);
  if (kind === "plan-team" && value) return addPlanningTeamAudience(interaction, invocation, repository, value);
  if (kind === "plan-enroll" && value) return continuePlanningEnrollment(interaction, repository, value);
  if (kind === "room-start" && value) {
    if (!invocation.organizationId || !invocation.personId) throw new Error("Run /setup first.");
    const installation = await repository.getProviderInstallation(invocation.organizationId, "elab-oncehub");
    if (!installation || installation.status !== "enabled") throw new Error("Configure eLab / OnceHub in /provider configure before finding a room.");
    const booking = await repository.createRoomBooking({ meetingId: value, providerInstallationId: installation.id, createdByPersonId: invocation.personId });
    const outcomes = await outboxPublisher.publish(booking.outboxEvents);
    return replacePrompt(prompt(handoffMessage(outcomes, "Searching eLab availability now. The result will be posted in this channel.", "Room search is queued for automatic retry.")));
  }
  if (kind === "room-submit" && value) {
    if (!invocation.personId) throw new Error("Unable to resolve the current person.");
    const booking = await repository.submitRoomBooking(value, invocation.personId);
    const outcomes = await outboxPublisher.publish(booking.outboxEvents);
    return replacePrompt(prompt(handoffMessage(outcomes, "Submitting the eLab room request now. Calendar invitations will follow only if OnceHub accepts the request.", "Room submission is queued for automatic retry.")));
  }
  if (kind === "provider" && value === "configure-oncehub") {
    if (!invocation.isAdministrator) throw new Error("Only a Discord Administrator can configure providers.");
    return onceHubConfigStepOne();
  }
  if (kind === "provider" && value === "oncehub-step2") {
    if (!invocation.isAdministrator) throw new Error("Only a Discord Administrator can configure providers.");
    return onceHubConfigStepTwo();
  }
  if (kind === "meeting-slot" && value && extra) {
    if (!(await repository.canManageMeeting(value, requireActor(invocation)))) throw new Error("Only the meeting creator can choose a meeting time.");
    const meeting = await repository.chooseCandidateSlot({ meetingId: value, candidateId: extra });
    if (!meeting.time) throw new Error("The selected candidate is missing its time.");
    return replacePrompt(prompt(`Selected **${meeting.title}**\n${formatTime(meeting.time.startsAt, meeting.timeZone)}\nReview and send Calendar invitations when ready.\nMeeting ID: \`${meeting.id}\``, [buttonRow({ customId: `meeting-confirm:${meeting.id}`, label: "Confirm and send invites", style: 3 }, { customId: `room-start:${meeting.id}`, label: "Find an eLab room" })]));
  }
  if (kind === "setup" && value === "connect-organizer") return startGoogleConnection(repository, invocation, "organizer", "replace");
  if (kind === "profile" && value === "connect-availability") return startGoogleConnection(repository, invocation, "availability", "replace");
  if (kind === "profile" && value === "disconnect-availability") {
    if (!invocation.personId) throw new Error("Unable to resolve the current person.");
    const removed = await repository.disconnectAvailability(invocation.personId);
    return replacePrompt(await profilePrompt(invocation, repository, removed ? "Availability connection removed." : "No availability connection was active."));
  }
  if (kind === "profile" && value === "edit") {
    if (!invocation.personId) throw new Error("Unable to resolve the current person.");
    const profile = await repository.getPersonProfile(invocation.personId);
    if (!profile?.calendarInviteEndpoint) throw new Error("Register your profile first.");
    return profileModal("profile:edit", "Edit your profile", profile.person.displayName, profile.calendarInviteEndpoint.address);
  }
  throw new Error("This action has expired.");
}

async function handleModal(interaction: DiscordInteraction, invocation: DiscordInvocation, repository: PostgresCoordinatorRepository, outboxPublisher: OutboxPublisher) {
  const values = modalValues(interaction.data?.components ?? []);
  if (interaction.data?.custom_id === "task:create") {
    if (!invocation.organizationId || !invocation.personId || !invocation.integrationId) throw new Error("Run /setup first.");
    const task = await repository.createTaskDraft({
      organizationId: invocation.organizationId,
      createdByPersonId: invocation.personId,
      sourceIntegrationId: invocation.integrationId,
      title: requiredValue(values, "title"),
      description: values.description,
      timeZone: "America/New_York",
    });
    return renderTaskComposer(task.id, invocation, repository);
  }
  if (interaction.data?.custom_id?.startsWith("task-edit:")) {
    if (!invocation.personId) throw new Error("Unable to resolve the current person.");
    const taskId = interaction.data.custom_id.slice("task-edit:".length);
    const result = await repository.updateTask({ taskId, creatorPersonId: invocation.personId, title: requiredValue(values, "title"), description: values.description ?? "" });
    await outboxPublisher.publish(result.outboxEvents);
    return renderTaskComposer(taskId, invocation, repository);
  }
  if (interaction.data?.custom_id === "team:create") {
    if (!invocation.organizationId || !invocation.personId) throw new Error("Run /setup first.");
    const team = await repository.createTeam({ organizationId: invocation.organizationId, createdByPersonId: invocation.personId, name: requiredValue(values, "name"), personIds: [invocation.personId] });
    return renderTeamCard(team.id, invocation, repository);
  }
  if (interaction.data?.custom_id === "profile:register" || interaction.data?.custom_id === "profile:edit") {
    if (!invocation.organizationId || !invocation.personId) throw new Error("An administrator must run /setup first.");
    const profile = await repository.registerPersonProfile({
      organizationId: invocation.organizationId,
      personId: invocation.personId,
      displayName: requiredValue(values, "display_name"),
      inviteEmail: requiredValue(values, "invite_email"),
    });
    const outcomes = await outboxPublisher.publish(profile.outboxEvents);
    const resync = profile.outboxEvents.length ? ` ${handoffMessage(outcomes, "Existing future Calendar invitations are being updated.", "Existing future Calendar invitations are queued for automatic retry.")}` : "";
    return initialPrompt(await profilePrompt(invocation, repository, `Profile saved. Future Calendar invitations will be sent to ${profile.endpoint.address}.${resync}`));
  }
  if (interaction.data?.custom_id?.startsWith("plan-enroll-email:")) {
    const attendeeId = interaction.data.custom_id.slice("plan-enroll-email:".length);
    const discordUserId = interaction.member?.user.id ?? interaction.user?.id;
    if (!discordUserId) throw new Error("Unable to identify your Discord account.");
    const enrollment = await repository.registerPlanningAttendeeEmail({ attendeeId, discordUserId, email: requiredValue(values, "invite_email") });
    const url = await createPlanningAvailabilityUrl(repository, enrollment);
    return message("Invite email saved. Connect Google availability so the planner can display your busy times.", { ephemeral: true, components: [buttonRow({ label: "Connect Google availability", url })] });
  }
  if (interaction.data?.custom_id === "meeting:plan") {
    const startsAt = new Date(requiredValue(values, "starts_at"));
    if (Number.isNaN(startsAt.valueOf())) throw new Error("Start time must be a valid ISO-8601 timestamp with timezone.");
    const attendees = await resolveAttendees(requiredValue(values, "attendees"), invocation, repository);
    if (attendees.length === 0) throw new Error("Include at least one attendee.");
    const endpoint = await discordChannelEndpoint(invocation, repository);
    const meeting = await startDirectMeeting(repository, requireActor(invocation), directMeetingInputSchema.parse({
      title: requiredValue(values, "title"),
      startsAt,
      durationMinutes: Number(requiredValue(values, "duration_minutes")),
      timezone: "America/New_York",
      location: values.location || undefined,
    }), endpoint.id);
    for (const attendee of attendees) {
      await repository.addParticipant({
        meetingId: meeting.id,
        kind: "email_guest",
        displayNameSnapshot: attendee.displayName,
        calendarInviteEmailSnapshot: attendee.calendarInviteEmail as never,
        attendanceRole: "required",
      });
    }
    if (!meeting.time) throw new Error("Direct meeting is missing its scheduled time.");
    return message(`Review: **${meeting.title}**\n${meeting.time.startsAt.toLocaleString("en-US", { timeZone: meeting.timeZone })}\n${attendees.length} Calendar invitee(s).\nMeeting ID: \`${meeting.id}\``, {
      ephemeral: true,
      components: [buttonRow({ customId: `meeting-confirm:${meeting.id}`, label: "Confirm and send invites", style: 3 }, { customId: `room-start:${meeting.id}`, label: "Find an eLab room" })],
    });
  }
  if (interaction.data?.custom_id === "meeting:find") return submitDiscovery(values, invocation, repository);
  if (interaction.data?.custom_id === "provider:oncehub-step1") {
    if (!invocation.organizationId || !invocation.personId) throw new Error("Run /setup first.");
    if (!invocation.isAdministrator) throw new Error("Only a Discord Administrator can configure providers.");
    await repository.saveProviderInstallation({ organizationId: invocation.organizationId, providerId: "elab-oncehub", status: "configuring", configuredByPersonId: invocation.personId, values: {
      firstName: requiredValue(values, "first_name"), lastName: requiredValue(values, "last_name"), nyuEmail: requiredValue(values, "nyu_email"), netId: requiredValue(values, "net_id"), organizationName: requiredValue(values, "organization_name"),
    } });
    return message("Requester details saved. Continue with the organization details.", { ephemeral: true, components: [buttonRow({ customId: "provider:oncehub-step2", label: "Continue eLab setup", style: 3 })] });
  }
  if (interaction.data?.custom_id === "provider:oncehub-step2") {
    if (!invocation.organizationId || !invocation.personId) throw new Error("Run /setup first.");
    if (!invocation.isAdministrator) throw new Error("Only a Discord Administrator can configure providers.");
    const existing = await repository.getProviderInstallation(invocation.organizationId, "elab-oncehub");
    if (!existing) throw new Error("Start eLab setup from the first step.");
    const provider = roomProviders.get("elab-oncehub")!;
    const config = provider.validateOrganizationValues({ ...existing.values, affiliation: requiredValue(values, "affiliation"), school: requiredValue(values, "school"), graduationYear: values.graduation_year?.trim() ?? "" });
    await repository.saveProviderInstallation({ organizationId: invocation.organizationId, providerId: "elab-oncehub", status: "enabled", configuredByPersonId: invocation.personId, values: config });
    return message("eLab / OnceHub is enabled for this server.", { ephemeral: true });
  }
  if (interaction.data?.custom_id === "meeting:cancel") return cancelMeeting(values, invocation, repository, outboxPublisher);
  if (interaction.data?.custom_id === "meeting:reschedule") {
    const meetingId = requiredValue(values, "meeting_id");
    if (!(await repository.canManageMeeting(meetingId, requireActor(invocation)))) throw new Error("Only the meeting creator can reschedule it.");
    return beginPlanningSession(invocation, repository, "reschedule", meetingId);
  }
  throw new Error("This form has expired.");
}

async function resolveDiscordAudience(interaction: DiscordInteraction, invocation: DiscordInvocation, repository: PostgresCoordinatorRepository) {
  if (!invocation.integrationId || !interaction.guild_id) throw new Error("This action must run inside the configured Discord server.");
  const selections = extractMentionableAudience(interaction.data ?? {});
  const candidates: Array<{ subjectId: string; displayName: string }> = [];
  for (const selection of selections) {
    if (selection.kind === "person") {
      candidates.push({ subjectId: selection.id, displayName: selection.displayName });
    } else {
      const rolePeople = await listDiscordPeopleWithRole(interaction.guild_id, selection.id);
      candidates.push(...rolePeople.map((person) => ({ subjectId: person.id, displayName: person.displayName })));
    }
  }
  const unique = [...new Map(candidates.map((person) => [person.subjectId, person])).values()];
  if (!unique.length) throw new Error("That selection did not resolve to any Discord users.");
  return repository.upsertIntegrationPeople({ integrationId: invocation.integrationId, people: unique });
}

async function saveTaskDueDate(taskId: string, date: string, hour: number, minute: number, invocation: DiscordInvocation, repository: PostgresCoordinatorRepository, outboxPublisher: OutboxPublisher) {
  if (!invocation.personId) throw new Error("Unable to resolve the current person.");
  const task = await repository.getTaskForCreator({ taskId, creatorPersonId: invocation.personId });
  if (!task) throw new Error("Only the task creator can set this due date.");
  const dueAt = dateInTimeZone(date, hour, minute, task.timeZone);
  if (dueAt <= new Date()) throw new Error("Choose a due time in the future.");
  const result = await repository.updateTask({ taskId, creatorPersonId: invocation.personId, dueAt });
  await outboxPublisher.publish(result.outboxEvents);
  return renderTaskComposer(taskId, invocation, repository, "replace");
}

function dateInTimeZone(date: string, hour: number, minute: number, timeZone: string) {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day || hour < 0 || hour > 23 || minute < 0 || minute > 59) throw new Error("Choose a valid due date and time.");
  const requested = Date.UTC(year, month - 1, day, hour, minute);
  let result = new Date(requested);
  for (let index = 0; index < 2; index += 1) {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(result);
    const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
    const represented = Date.UTC(values.year!, values.month! - 1, values.day!, values.hour!, values.minute!);
    result = new Date(result.getTime() + requested - represented);
  }
  return result;
}

function formatReminderPolicy(policy: "daily_until_done" | "one_day_before" | "one_hour_before" | "none") {
  return { daily_until_done: "daily until done", one_day_before: "one day before due", one_hour_before: "one hour before due", none: "no reminders" }[policy];
}

function discoveryModal() {
  return modal("meeting:find", "Find a meeting time", [
    textInput("title", "Meeting title", { placeholder: "Tech@NYU Leadership" }),
    textInput("window_start", "Earliest start (ISO-8601)", { placeholder: "2026-09-08T09:00:00-04:00" }),
    textInput("window_end", "Latest end (ISO-8601)", { placeholder: "2026-09-12T18:00:00-04:00" }),
    textInput("duration_minutes", "Duration in minutes", { placeholder: "60" }),
    textInput("attendees", "Attendees: one `Name <email>` per line", { style: 2, placeholder: "Alex Chen <alex@example.com>\nJamie Park <jamie@example.com>" }),
  ]);
}

async function beginPlanningSession(invocation: DiscordInvocation, repository: PostgresCoordinatorRepository, kind: "create" | "reschedule", sourceMeetingId?: string) {
  const actor = requireActor(invocation);
  const endpoint = await discordChannelEndpoint(invocation, repository);
  const session = await repository.createPlanningSession({ organizationId: actor.organizationId, createdByPersonId: actor.personId, initiatedViaIntegrationId: actor.integrationId, statusAnnouncementEndpointId: endpoint.id, kind, sourceMeetingId });
  return message("Start by selecting the Discord users and roles who should attend. The interactive calendar opens after that.", {
    ephemeral: true,
    components: [mentionableAudienceSelect(session.id), savedTeamSelect(`plan-team:${session.id}`, await repository.listTeams(actor.organizationId))],
  });
}

async function addPlanningAudience(interaction: DiscordInteraction, invocation: DiscordInvocation, repository: PostgresCoordinatorRepository, sessionId: string) {
  const actor = requireActor(invocation);
  if (!interaction.guild_id) throw new Error("Planning must happen inside the configured Discord server.");
  const loaded = await repository.getPlanningSession(sessionId);
  if (!loaded || loaded.session.organizationId !== actor.organizationId || loaded.session.createdByPersonId !== actor.personId) throw new Error("Only the person who started this planning session can edit it.");
  const selections = extractMentionableAudience(interaction.data ?? {});
  for (const selection of selections) {
    if (selection.kind === "person") {
      const people = await repository.upsertIntegrationPeople({ integrationId: actor.integrationId, people: [{ subjectId: selection.id, displayName: selection.displayName }] });
      await repository.addPlanningAudience({ planningSessionId: sessionId, actor, source: { kind: "client_group", integrationId: actor.integrationId, subjectId: selection.id }, people: people.map((person) => ({ personId: person.id, displayName: person.displayName })) });
      continue;
    }
    const people = await listDiscordPeopleWithRole(interaction.guild_id, selection.id);
    const resolved = await repository.upsertIntegrationPeople({ integrationId: actor.integrationId, people: people.map((person) => ({ subjectId: person.id, displayName: person.displayName })) });
    await repository.addPlanningAudience({ planningSessionId: sessionId, actor, source: { kind: "client_group", integrationId: actor.integrationId, subjectId: selection.id }, people: resolved.map((person) => ({ personId: person.id, displayName: person.displayName })) });
  }
  return finishPlanningAudience(sessionId, invocation.discordUserId, repository);
}

async function addPlanningTeamAudience(interaction: DiscordInteraction, invocation: DiscordInvocation, repository: PostgresCoordinatorRepository, sessionId: string) {
  const actor = requireActor(invocation);
  if (!interaction.guild_id) throw new Error("Planning must happen inside the configured Discord server.");
  const loaded = await repository.getPlanningSession(sessionId);
  if (!loaded || loaded.session.organizationId !== actor.organizationId || loaded.session.createdByPersonId !== actor.personId) throw new Error("Only the person who started this planning session can edit it.");
  const teamId = interaction.data?.values?.[0];
  if (!teamId) throw new Error("Choose a saved team.");
  const teamPeople = await repository.getTeamPeople({ organizationId: actor.organizationId, teamId });
  if (!teamPeople.length) throw new Error("That saved team has no active members.");
  const discordPeople = await repository.getIntegrationPeople({ integrationId: actor.integrationId, personIds: teamPeople.map((person) => person.id) });
  if (discordPeople.length !== teamPeople.length) throw new Error("Every saved-team member needs an active Discord identity before it can be used for Discord meeting planning.");
  await repository.addPlanningAudience({ planningSessionId: sessionId, actor, source: { kind: "team", teamId: teamId as never }, people: discordPeople.map((person) => ({ personId: person.personId, displayName: person.displayName })) });
  return finishPlanningAudience(sessionId, invocation.discordUserId, repository);
}

async function finishPlanningAudience(sessionId: string, plannerDiscordUserId: string, repository: PostgresCoordinatorRepository) {
  const refreshed = await repository.getPlanningSession(sessionId);
  if (!refreshed) throw new Error("This planning session disappeared.");
  const pending = refreshed.attendees.filter((attendee) => attendee.readiness !== "ready" && attendee.readiness !== "unverified");
  const rawToken = randomToken();
  await repository.createPlanningLaunchToken({ planningSessionId: sessionId, tokenHash: await hashToken(rawToken) });
  const baseUrl = process.env.APP_BASE_URL;
  if (!baseUrl) throw new Error("APP_BASE_URL is required to open the web planner.");
  const launchUrl = `${baseUrl.replace(/\/$/, "")}/plan/launch/${rawToken}`;
  const requests = await repository.listPlanningEnrollmentRequests(sessionId);
  await Promise.allSettled(requests.map(async (request) => {
    if (request.readiness === "needs_invite_email") {
      return sendDiscordDm(request.discordUserId, planningEnrollmentDmContent(plannerDiscordUserId, "invite_email"), [buttonRow({ customId: `plan-enroll:${request.attendeeId}`, label: "Add invite email", style: 3 })]);
    }
    const enrollment = await repository.getPlanningEnrollment(request.attendeeId, request.discordUserId);
    if (!enrollment?.person.invitationEmail) return;
    const url = await createPlanningAvailabilityUrl(repository, { organizationId: enrollment.session.organizationId, personId: enrollment.person.id, displayName: enrollment.person.displayName });
    return sendDiscordDm(request.discordUserId, planningEnrollmentDmContent(plannerDiscordUserId, "availability"), [buttonRow({ label: "Connect Google availability", url })]);
  }));
  const status = pending.length
    ? `${pending.length} attendee(s) still need an invite email or Google availability. They will appear as pending in the planner.`
    : "Everyone selected has an invite email and connected availability.";
  return updateMessage(`**Planning audience:** ${refreshed.attendees.length} attendee(s)\n${status}`, [
    mentionableAudienceSelect(sessionId),
    savedTeamSelect(`plan-team:${sessionId}`, await repository.listTeams(refreshed.session.organizationId)),
    buttonRow({ label: "Open interactive planner", url: launchUrl, style: 3 }),
  ]);
}

async function continuePlanningEnrollment(interaction: DiscordInteraction, repository: PostgresCoordinatorRepository, attendeeId: string) {
  const discordUserId = interaction.member?.user.id ?? interaction.user?.id;
  if (!discordUserId) throw new Error("Unable to identify your Discord account.");
  const enrollment = await repository.getPlanningEnrollment(attendeeId, discordUserId);
  if (!enrollment) throw new Error("This enrollment request has expired.");
  if (!enrollment.person.invitationEmail) return modal(`plan-enroll-email:${attendeeId}`, "Add calendar invite email", [textInput("invite_email", "Calendar invite email", { placeholder: "you@example.com" })]);
  const url = await createPlanningAvailabilityUrl(repository, { organizationId: enrollment.session.organizationId, personId: enrollment.person.id, displayName: enrollment.person.displayName });
  return replacePrompt(prompt("Connect Google availability so the planner can display only your busy times.", [buttonRow({ label: "Connect Google availability", url })]));
}

async function createPlanningAvailabilityUrl(repository: PostgresCoordinatorRepository, enrollment: { organizationId: string; personId: string; displayName: string }) {
  const state = createState();
  const codeVerifier = createCodeVerifier();
  await repository.createOauthState({ state, organizationId: enrollment.organizationId, personId: enrollment.personId, kind: "availability", codeVerifier });
  return createGoogleAuthorizationUrl({ state, codeVerifier, kind: "availability" });
}

function randomToken() {
  return crypto.getRandomValues(new Uint8Array(32)).reduce((value, byte) => value + byte.toString(16).padStart(2, "0"), "");
}

async function hashToken(value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function onceHubConfigStepOne() {
  return modal("provider:oncehub-step1", "Configure eLab / OnceHub", [
    textInput("first_name", "Requester first name"), textInput("last_name", "Requester last name"), textInput("nyu_email", "Requester NYU email"), textInput("net_id", "Requester NetID"), textInput("organization_name", "Organization name", { value: "Tech@NYU" }),
  ]);
}
function onceHubConfigStepTwo() {
  return modal("provider:oncehub-step2", "Configure eLab / OnceHub", [
    textInput("affiliation", "NYU affiliation", { placeholder: "Undergrad" }), textInput("school", "NYU school", { placeholder: "Tandon" }), textInput("graduation_year", "Expected graduation year (optional)", { required: false }),
  ]);
}
async function providerList(organizationId: string, repository: PostgresCoordinatorRepository) {
  const installations = await repository.listProviderInstallations(organizationId);
  return message(roomProviders.list().map((provider) => {
    const installation = installations.find((item) => item.providerId === provider.id);
    return `• **${provider.descriptor.label}** — ${installation?.status ?? "not configured"}`;
  }).join("\n"), { ephemeral: true });
}

function renderSetupDashboard(setup: OrganizationSetupState) {
  const calendar = setup.phase === "ready"
    ? `Connected as ${setup.organizer?.organizerEmail}`
    : setup.phase === "calendar_reconnect_required"
      ? `Reconnect required for ${setup.organizer?.organizerEmail ?? "the previous organizer account"}`
      : "Required — no organization Calendar is connected";
  const onceHub = setup.providers.find((provider) => provider.providerId === "elab-oncehub");
  return [
    "**Coordinator setup**",
    `Google Calendar: ${calendar}`,
    `eLab / OnceHub (optional): ${onceHub?.status ?? "not configured"}`,
    setup.phase === "ready" ? "Setup is ready for meeting invitations." : "Connect the organization-owned Google Calendar to enable meeting invitations.",
  ].join("\n");
}


async function submitDiscovery(values: Record<string, string>, invocation: DiscordInvocation, repository: PostgresCoordinatorRepository) {
  const actor = requireActor(invocation);
  const startsAt = parseDateTime(requiredValue(values, "window_start"), "Earliest start");
  const endsAt = parseDateTime(requiredValue(values, "window_end"), "Latest end");
  const durationMinutes = Number(requiredValue(values, "duration_minutes"));
  if (!Number.isInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 480) throw new Error("Duration must be between 15 and 480 minutes.");
  if (startsAt >= endsAt || startsAt <= new Date()) throw new Error("The availability window must be in the future and have an end after its start.");
  const attendees = await resolveAttendees(requiredValue(values, "attendees"), invocation, repository);
  if (!attendees.length) throw new Error("Include at least one attendee.");
  const meeting = await repository.createDiscoveryMeeting({
    organizationId: actor.organizationId,
    mode: "discovery",
    status: "discovering",
    title: requiredValue(values, "title"),
    timeZone: "America/New_York",
    discoveryWindow: { startsAt, endsAt },
    createdByPersonId: actor.personId,
    initiatedViaIntegrationId: actor.integrationId,
    statusAnnouncementEndpointId: (await discordChannelEndpoint(invocation, repository)).id,
  });
  const memberIds: string[] = [];
  for (const attendee of attendees) {
    await repository.addParticipant({
      meetingId: meeting.id,
      kind: "email_guest",
      displayNameSnapshot: attendee.displayName,
      calendarInviteEmailSnapshot: attendee.calendarInviteEmail as never,
      attendanceRole: "required",
    });
  }
  const connections = await repository.getAvailabilityConnections(memberIds);
  const queried = await Promise.allSettled(connections.map((connection) => getGoogleBusyIntervals({
    refreshToken: connection.encryptedRefreshToken,
    range: { startsAt, endsAt },
    timeZone: meeting.timeZone,
  })));
  const busy = queried.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  const connectedCount = queried.filter((result) => result.status === "fulfilled").length;
  const slots = candidateSlots({ window: { startsAt, endsAt }, durationMinutes, busyIntervals: busy }).slice(0, 20);
  await repository.saveCandidateSlots(meeting.id, slots.map((time, index) => ({
    time,
    connectedParticipantCount: connectedCount,
    unconnectedParticipantCount: attendees.length - connectedCount,
    rank: index + 1,
  })));
  const candidates = await repository.getCandidateSlots(meeting.id);
  if (!candidates.length) return message(`No ${durationMinutes}-minute time is free for all ${connectedCount} connected attendee(s). ${attendees.length - connectedCount} attendee(s) have no usable availability connection and were not used for scoring.`, { ephemeral: true });
  return message(`Found ${candidates.length} candidate time(s). Availability was used for ${connectedCount}/${attendees.length} attendee(s); others are still invited but were not scored.`, {
    ephemeral: true,
    components: candidates.slice(0, 5).map((candidate) => buttonRow({
      customId: `meeting-slot:${meeting.id}:${candidate.id}`,
      label: formatTime(candidate.time.startsAt, meeting.timeZone),
      style: 1,
    })),
  });
}

async function cancelMeeting(values: Record<string, string>, invocation: DiscordInvocation, repository: PostgresCoordinatorRepository, outboxPublisher: OutboxPublisher) {
  const meetingId = requiredValue(values, "meeting_id");
  if (!(await repository.canManageMeeting(meetingId, requireActor(invocation)))) throw new Error("Only the meeting creator can cancel it.");
  const cancellation = await repository.cancelMeeting(meetingId);
  const outcomes = await outboxPublisher.publish(cancellation.outboxEvents);
  return message(cancellation.calendarEventExisted
    ? handoffMessage(outcomes, "Meeting cancelled. Google Calendar will email its invitees shortly.", "Meeting cancelled. Calendar cancellation is queued for automatic retry.")
    : "Meeting cancelled before a Calendar event was created.", { ephemeral: true });
}

function handoffMessage(outcomes: Awaited<ReturnType<OutboxPublisher["publish"]>>, accepted: string, deferred: string) {
  return outcomes.some((outcome) => outcome.status === "accepted") ? accepted : deferred;
}

function profileModal(customId: string, title: string, displayName?: string, inviteEmail?: string) {
  return modal(customId, title, [
    textInput("display_name", "Name", { placeholder: "Alex Chen", value: displayName }),
    textInput("invite_email", "Calendar invite email", { placeholder: "alex@example.com", value: inviteEmail }),
  ]);
}

async function profilePrompt(invocation: DiscordInvocation, repository: PostgresCoordinatorRepository, notice?: string): Promise<DiscordPrompt> {
  if (!invocation.personId) throw new Error("Unable to resolve the current person.");
  const profile = await repository.getPersonProfile(invocation.personId);
  if (!profile?.calendarInviteEndpoint) throw new Error("Register your profile before managing it.");
  const connected = profile.availability ? `connected as ${profile.availability.accountEmail}` : "not connected";
  return prompt(`${notice ? `${notice}\n\n` : ""}**Profile**\nCalendar invitations: ${profile.calendarInviteEndpoint.address}\nAvailability: ${connected}`, [buttonRow(
    { customId: "profile:edit", label: "Edit profile" },
    profile.availability
      ? { customId: "profile:disconnect-availability", label: "Disconnect availability", style: 4 }
      : { customId: "profile:connect-availability", label: "Connect availability", style: 3 },
  )]);
}

async function startGoogleConnection(
  repository: PostgresCoordinatorRepository,
  invocation: DiscordInvocation,
  kind: "organizer" | "availability",
  mode: PromptResponseMode = "initial",
) {
  const actor = requireActor(invocation);
  if (kind === "organizer" && !invocation.isAdministrator) {
    throw new Error("Only a Discord Administrator can connect the organizer calendar.");
  }
  const profile = kind === "availability" ? await repository.getPersonProfile(actor.personId) : undefined;
  if (kind === "availability" && !profile?.calendarInviteEndpoint) throw new Error("Register your profile before connecting availability.");
  const state = createState();
  const codeVerifier = createCodeVerifier();
  await repository.createOauthState({
    state,
    organizationId: actor.organizationId,
    personId: actor.personId,
    kind,
    codeVerifier,
  });
  const authorizationUrl = await createGoogleAuthorizationUrl({ state, codeVerifier, kind });
  const label = kind === "organizer" ? "Connect organizer calendar" : "Connect Google availability";
  return respondToPrompt(prompt(kind === "organizer"
    ? "Sign in with the organization-owned coordinator account. Events will be created on its primary calendar."
    : "Authorize only free/busy access for the Google account you want to use when finding meeting times.", [buttonRow({ label, url: authorizationUrl })]), mode);
}

function toInvocation(interaction: DiscordInteraction): DiscordInvocation {
  const permissions = BigInt(interaction.member?.permissions ?? "0");
  return {
    idempotencyKey: interaction.id,
    discordGuildId: interaction.guild_id,
    discordUserId: interaction.member?.user.id ?? interaction.user?.id ?? "",
    discordRoleIds: interaction.member?.roles ?? [],
    isAdministrator: (permissions & 0x8n) === 0x8n,
    channelId: interaction.channel_id ?? "",
  };
}

function modalValues(rows: ModalRow[]) {
  return Object.fromEntries(rows.flatMap((row) => row.components ?? []).flatMap((component) => component.custom_id ? [[component.custom_id, component.value ?? ""]] : []));
}
function requiredValue(values: Record<string, string>, key: string) {
  const value = values[key]?.trim();
  if (!value) throw new Error(`${key.replaceAll("_", " ")} is required.`);
  return value;
}
async function resolveAttendees(value: string, invocation: DiscordInvocation, repository: PostgresCoordinatorRepository) {
  if (!invocation.organizationId) throw new Error("An administrator must run /setup first.");
  const resolved = [] as Array<{ displayName: string; calendarInviteEmail: string }>;
  const seenEmails = new Set<string>();
  for (const line of value.split("\n").map((line) => line.trim()).filter(Boolean)) {
    const match = /^(.*?)\s*<([^<>\s]+@[^<>\s]+)>$/.exec(line);
    if (!match?.[1] || !match[2]) throw new Error(`Use Name <email> for every attendee: ${line}`);
    addResolved({ displayName: match[1].trim(), calendarInviteEmail: match[2].trim().toLowerCase() });
  }
  return resolved;

  function addResolved(member: { displayName: string; calendarInviteEmail: string }) {
    const email = member.calendarInviteEmail.toLowerCase();
    if (!seenEmails.has(email)) {
      seenEmails.add(email);
      resolved.push(member);
    }
  }
}

function parseDateTime(value: string, label: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error(`${label} must be a valid ISO-8601 timestamp with timezone.`);
  return date;
}
function formatTime(time: Date, timeZone: string) {
  return time.toLocaleString("en-US", { timeZone, dateStyle: "medium", timeStyle: "short" });
}
function subcommand(interaction: DiscordInteraction) {
  return interaction.data?.options?.find((option) => option.type === 1)?.name;
}
