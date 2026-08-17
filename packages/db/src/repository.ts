import { and, eq, inArray, isNull, sql as drizzleSql } from "drizzle-orm";
import { id, type AvailabilityCalendarConnection, type CandidateSlot, type ClientAudienceReference, type ClientInvocation, type Meeting, type MeetingParticipant, type MeetingPlanningSession, type OrganizationProviderInstallation, type OrganizationSetupState, type OrganizerCalendarConnection, type PlanningAttendee, type RoomBooking, type RoomCandidate, type Task, type TaskAssignment, type TaskReminderPolicy, type Team } from "@technyu/core";
import { validatePlanningTime, type CoordinatorRepository, type CreateDirectMeetingRecord, type PendingOutboxEvent } from "@technyu/application";
import { db } from "./client.ts";
import {
  calendarConnections,
  calendarEvents,
  candidateSlots,
  clientIdentities,
  discordIntegrationConfigs,
  integrationIdentities,
  jobs,
  meetingParticipants,
  meetings,
  members,
  organizations,
  organizationClientIntegrations,
  organizationOwners,
  organizationPeople,
  oauthStates,
  outboxEvents,
  planningAttendees,
  planningBrowserSessions,
  planningLaunchTokens,
  planningSessions,
  providerInstallations,
  roomBookings,
  personTaskReminderPreferences,
  taskAssignments,
  taskReminderDeliveries,
  tasks,
  teamMembers,
  teams,
  users,
  webIntegrationConfigs,
  webLaunches,
  webSessions,
} from "./schema.ts";

const asMeeting = (row: typeof meetings.$inferSelect): Meeting => ({
  id: id<"MeetingId">(row.id),
  organizationId: id<"OrganizationId">(row.organizationId),
  mode: row.mode as Meeting["mode"],
  status: row.status,
  title: row.title,
  timeZone: row.timeZone,
  time: row.startsAt && row.endsAt ? { startsAt: row.startsAt, endsAt: row.endsAt } : undefined,
  discoveryWindow: row.discoveryStartsAt && row.discoveryEndsAt ? { startsAt: row.discoveryStartsAt, endsAt: row.discoveryEndsAt } : undefined,
  location: row.location ?? undefined,
  notes: row.notes ?? undefined,
  createdBy: id<"UserId">(row.createdByUserId),
  notificationTarget: { client: row.notificationClient as "discord", channelId: row.notificationChannelId },
  version: row.version,
});

const asProviderInstallation = (row: typeof providerInstallations.$inferSelect): OrganizationProviderInstallation => ({
  id: id<"ProviderInstallationId">(row.id), organizationId: id<"OrganizationId">(row.organizationId), providerId: row.providerId,
  status: row.status, values: row.values, configuredBy: id<"UserId">(row.configuredByUserId),
});
const asRoomBooking = (row: typeof roomBookings.$inferSelect): RoomBooking => ({
  id: id<"RoomBookingId">(row.id), organizationId: id<"OrganizationId">(row.organizationId), meetingId: id<"MeetingId">(row.meetingId),
  providerInstallationId: id<"ProviderInstallationId">(row.providerInstallationId), createdBy: id<"UserId">(row.createdByUserId), status: row.status,
  room: row.room as unknown as RoomCandidate | undefined, providerReference: row.providerReference ?? undefined, failureReason: row.failureReason ?? undefined,
});

const asPlanningSession = (row: typeof planningSessions.$inferSelect): MeetingPlanningSession => ({
  id: id<"PlanningSessionId">(row.id), organizationId: id<"OrganizationId">(row.organizationId), createdBy: id<"UserId">(row.createdByUserId),
  kind: row.kind, sourceMeetingId: row.sourceMeetingId ? id<"MeetingId">(row.sourceMeetingId) : undefined,
  notificationTarget: { client: row.notificationClient as "discord", channelId: row.notificationChannelId }, status: row.status,
  title: row.title ?? undefined,
  selectedTime: row.selectedStartsAt && row.selectedEndsAt ? { startsAt: row.selectedStartsAt, endsAt: row.selectedEndsAt } : undefined,
  availabilityOverride: Boolean(row.availabilityOverride), expiresAt: row.expiresAt,
});

const asPlanningAttendee = (row: typeof planningAttendees.$inferSelect): PlanningAttendee => ({
  id: id<"PlanningAttendeeId">(row.id), planningSessionId: id<"PlanningSessionId">(row.planningSessionId),
  userId: row.userId ? id<"UserId">(row.userId) : undefined, memberId: row.memberId ? id<"MemberId">(row.memberId) : undefined,
  displayName: row.displayName, source: row.source as ClientAudienceReference, readiness: row.readiness,
});

const asTask = (row: typeof tasks.$inferSelect): Task => ({
  id: id<"TaskId">(row.id),
  organizationId: id<"OrganizationId">(row.organizationId),
  createdByPersonId: id<"OrganizationPersonId">(row.createdByPersonId),
  sourceIntegrationId: id<"OrganizationClientIntegrationId">(row.sourceIntegrationId),
  title: row.title,
  description: row.description ?? undefined,
  dueAt: row.dueAt ?? undefined,
  timeZone: row.timeZone,
  status: row.status,
  revision: row.revision,
});

const asTaskAssignment = (row: typeof taskAssignments.$inferSelect): TaskAssignment => ({
  id: id<"TaskAssignmentId">(row.id),
  taskId: id<"TaskId">(row.taskId),
  personId: id<"OrganizationPersonId">(row.personId),
  status: row.status,
  reminderPolicyOverride: row.reminderPolicyOverride ?? undefined,
  reminderRevision: row.reminderRevision,
  completedAt: row.completedAt ?? undefined,
});

const asTeam = (row: typeof teams.$inferSelect): Team => ({
  id: id<"TeamId">(row.id),
  organizationId: id<"OrganizationId">(row.organizationId),
  name: row.name,
  createdByPersonId: id<"OrganizationPersonId">(row.createdByPersonId),
});

const asPendingOutboxEvent = (row: typeof outboxEvents.$inferSelect): PendingOutboxEvent => ({
  id: row.id,
  type: row.type,
  aggregateId: row.aggregateId,
  expectedVersion: row.expectedVersion ?? undefined,
  payload: row.payload as PendingOutboxEvent["payload"],
});

function slugify(value: string) {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
  return slug || "organization";
}

export class PostgresCoordinatorRepository implements CoordinatorRepository {
  async isOrganizationOwner(organizationId: string, personId: string) {
    const row = await db.query.organizationOwners.findFirst({ where: and(eq(organizationOwners.organizationId, organizationId), eq(organizationOwners.personId, personId)) });
    return Boolean(row);
  }

  async listOrganizationPeople(organizationId: string) {
    return db.select().from(organizationPeople).where(and(eq(organizationPeople.organizationId, organizationId), eq(organizationPeople.status, "active"))).orderBy(organizationPeople.displayName);
  }

  async grantOrganizationOwner(input: { organizationId: string; grantedByPersonId: string; personId: string }) {
    if (!(await this.isOrganizationOwner(input.organizationId, input.grantedByPersonId))) throw new Error("Only a Web owner can grant Web ownership.");
    const person = await db.query.organizationPeople.findFirst({ where: and(eq(organizationPeople.id, input.personId), eq(organizationPeople.organizationId, input.organizationId)) });
    if (!person) throw new Error("That person is not part of this organization.");
    await db.insert(organizationOwners).values(input).onConflictDoNothing();
  }

  async revokeOrganizationOwner(input: { organizationId: string; requestedByPersonId: string; personId: string }) {
    if (!(await this.isOrganizationOwner(input.organizationId, input.requestedByPersonId))) throw new Error("Only a Web owner can revoke Web ownership.");
    const owners = await db.select().from(organizationOwners).where(eq(organizationOwners.organizationId, input.organizationId));
    if (owners.length <= 1 && owners.some((owner) => owner.personId === input.personId)) throw new Error("An organization must retain at least one Web owner.");
    await db.delete(organizationOwners).where(and(eq(organizationOwners.organizationId, input.organizationId), eq(organizationOwners.personId, input.personId)));
  }

  async createWebLaunch(input: { organizationId: string; personId: string; operation: "settings" | "planning" | "tasks"; tokenHash: string }) {
    const web = (await db.select({ integration: organizationClientIntegrations }).from(webIntegrationConfigs)
      .innerJoin(organizationClientIntegrations, eq(organizationClientIntegrations.id, webIntegrationConfigs.integrationId))
      .where(and(eq(organizationClientIntegrations.organizationId, input.organizationId), eq(organizationClientIntegrations.kind, "web"))))[0]?.integration;
    if (!web) throw new Error("This organization does not have a Web integration.");
    const [launch] = await db.insert(webLaunches).values({ webIntegrationId: web.id, personId: input.personId, operation: input.operation, tokenHash: input.tokenHash, expiresAt: new Date(Date.now() + 15 * 60_000) }).returning();
    return launch;
  }

  async redeemWebLaunch(input: { tokenHash: string; sessionTokenHash: string }) {
    return db.transaction(async (tx) => {
      const [launch] = await tx.update(webLaunches).set({ redeemedAt: new Date() })
        .where(and(eq(webLaunches.tokenHash, input.tokenHash), isNull(webLaunches.redeemedAt), drizzleSql`${webLaunches.expiresAt} > now()`)).returning();
      if (!launch) return undefined;
      const [session] = await tx.insert(webSessions).values({ webIntegrationId: launch.webIntegrationId, personId: launch.personId, operation: launch.operation, tokenHash: input.sessionTokenHash, expiresAt: new Date(Date.now() + 24 * 60 * 60_000) }).returning();
      return session;
    });
  }

  async getWebSession(tokenHash: string) {
    const rows = await db.select({ session: webSessions, integration: organizationClientIntegrations, person: organizationPeople }).from(webSessions)
      .innerJoin(organizationClientIntegrations, eq(organizationClientIntegrations.id, webSessions.webIntegrationId))
      .innerJoin(organizationPeople, eq(organizationPeople.id, webSessions.personId))
      .where(and(eq(webSessions.tokenHash, tokenHash), drizzleSql`${webSessions.expiresAt} > now()`));
    return rows[0];
  }
  async listPendingOutbox(limit = 50) {
    const rows = await db.select().from(outboxEvents)
      .where(eq(outboxEvents.status, "pending"))
      .orderBy(outboxEvents.createdAt)
      .limit(limit);
    return rows.map(asPendingOutboxEvent);
  }

  async markOutboxDispatched(id: string) {
    const rows = await db.update(outboxEvents).set({ status: "dispatched", dispatchedAt: new Date(), attempts: drizzleSql`${outboxEvents.attempts} + 1`, lastError: null })
      .where(and(eq(outboxEvents.id, id), eq(outboxEvents.status, "pending"))).returning({ id: outboxEvents.id });
    return rows.length === 1;
  }

  async markOutboxFailed(id: string, reason: string) {
    const rows = await db.update(outboxEvents).set({ status: "failed", attempts: drizzleSql`${outboxEvents.attempts} + 1`, lastError: reason })
      .where(and(eq(outboxEvents.id, id), eq(outboxEvents.status, "pending"))).returning({ id: outboxEvents.id });
    return rows.length === 1;
  }

  async recordOutboxDispatchFailure(id: string, reason: string) {
    const rows = await db.update(outboxEvents).set({ attempts: drizzleSql`${outboxEvents.attempts} + 1`, lastError: reason })
      .where(and(eq(outboxEvents.id, id), eq(outboxEvents.status, "pending"))).returning({ id: outboxEvents.id });
    return rows.length === 1;
  }

  async emitOutbox(input: { organizationId: string; type: string; aggregateId: string; expectedVersion?: number; payload?: Record<string, string | number | boolean | null> }) {
    const [event] = await db.insert(outboxEvents).values({ ...input, payload: input.payload ?? {} }).onConflictDoNothing().returning();
    return event ? asPendingOutboxEvent(event) : undefined;
  }
  async findOrganization(guildId: string) {
    return db.query.organizations.findFirst({ where: eq(organizations.discordGuildId, guildId) });
  }

  async setupOrganization(input: { guildId: string; name: string; discordUserId: string }) {
    return db.transaction(async (tx) => {
      let org = await tx.query.organizations.findFirst({ where: eq(organizations.discordGuildId, input.guildId) });
      if (!org) {
        [org] = await tx.insert(organizations).values({ discordGuildId: input.guildId, name: input.name }).returning();
      }
      if (!org) throw new Error("Unable to create organization.");
      const existing = await tx.select({ user: users }).from(users).innerJoin(clientIdentities, eq(clientIdentities.userId, users.id))
        .where(and(eq(users.organizationId, org.id), eq(clientIdentities.client, "discord"), eq(clientIdentities.subjectId, input.discordUserId)));
      let user = existing[0]?.user;
      if (!user) {
        [user] = await tx.insert(users).values({ organizationId: org.id }).returning();
        if (user) await tx.insert(clientIdentities).values({ userId: user.id, client: "discord", subjectId: input.discordUserId });
      }
      if (!user) throw new Error("Unable to create setup user.");
      let discordIntegration = (await tx.select({ integration: organizationClientIntegrations }).from(discordIntegrationConfigs)
        .innerJoin(organizationClientIntegrations, eq(organizationClientIntegrations.id, discordIntegrationConfigs.integrationId))
        .where(eq(discordIntegrationConfigs.guildId, input.guildId)))[0]?.integration;
      if (!discordIntegration) {
        [discordIntegration] = await tx.insert(organizationClientIntegrations).values({ organizationId: org.id, kind: "discord" }).returning();
        if (!discordIntegration) throw new Error("Unable to create Discord integration.");
        await tx.insert(discordIntegrationConfigs).values({ integrationId: discordIntegration.id, guildId: input.guildId });
        const [webIntegration] = await tx.insert(organizationClientIntegrations).values({ organizationId: org.id, kind: "web" }).returning();
        if (!webIntegration) throw new Error("Unable to create Web integration.");
        await tx.insert(webIntegrationConfigs).values({ integrationId: webIntegration.id, slug: `${slugify(org.name)}-${org.id.slice(0, 8)}` });
      }
      let person = (await tx.select({ person: organizationPeople }).from(integrationIdentities)
        .innerJoin(organizationPeople, eq(organizationPeople.id, integrationIdentities.personId))
        .where(and(eq(integrationIdentities.integrationId, discordIntegration.id), eq(integrationIdentities.externalSubjectId, input.discordUserId))))[0]?.person;
      if (!person) {
        [person] = await tx.insert(organizationPeople).values({ organizationId: org.id, displayName: input.discordUserId }).returning();
        if (!person) throw new Error("Unable to create organization person.");
        await tx.insert(integrationIdentities).values({ integrationId: discordIntegration.id, personId: person.id, externalSubjectId: input.discordUserId });
      }
      const owners = await tx.select().from(organizationOwners).where(eq(organizationOwners.organizationId, org.id));
      if (!owners.length) await tx.insert(organizationOwners).values({ organizationId: org.id, personId: person.id, grantedByPersonId: person.id });
      return { org, user };
    });
  }

  async getOrganizationSetupState(organizationId: string): Promise<OrganizationSetupState> {
    const organizer = await db.query.calendarConnections.findFirst({
      where: and(eq(calendarConnections.organizationId, organizationId), eq(calendarConnections.kind, "organizer")),
    });
    const installations = await db.select({ providerId: providerInstallations.providerId, status: providerInstallations.status })
      .from(providerInstallations)
      .where(eq(providerInstallations.organizationId, organizationId));
    const phase: OrganizationSetupState["phase"] = !organizer
      ? "calendar_required"
      : organizer.status === "active"
        ? "ready"
        : "calendar_reconnect_required";
    return {
      phase,
      organizer: organizer ? { organizerEmail: organizer.accountEmail as OrganizerCalendarConnection["organizerEmail"], status: organizer.status } : undefined,
      providers: installations,
    };
  }

  async resolveInvocation(input: Omit<ClientInvocation, "organizationId" | "userId">): Promise<ClientInvocation> {
    if (!input.discordGuildId) return input;
    const org = await this.findOrganization(input.discordGuildId);
    if (!org) return { ...input, organizationId: undefined, userId: undefined };
    const existing = await db.select({ user: users }).from(users).innerJoin(clientIdentities, eq(clientIdentities.userId, users.id))
      .where(and(eq(users.organizationId, org.id), eq(clientIdentities.client, "discord"), eq(clientIdentities.subjectId, input.discordUserId)));
    let user = existing[0]?.user;
    if (!user) {
      [user] = await db.insert(users).values({ organizationId: org.id }).returning();
      if (user) await db.insert(clientIdentities).values({ userId: user.id, client: "discord", subjectId: input.discordUserId });
    }
    const integration = (await db.select({ integration: organizationClientIntegrations }).from(discordIntegrationConfigs)
      .innerJoin(organizationClientIntegrations, eq(organizationClientIntegrations.id, discordIntegrationConfigs.integrationId))
      .where(eq(discordIntegrationConfigs.guildId, input.discordGuildId)))[0]?.integration;
    let person = integration ? (await db.select({ person: organizationPeople }).from(integrationIdentities)
      .innerJoin(organizationPeople, eq(organizationPeople.id, integrationIdentities.personId))
      .where(and(eq(integrationIdentities.integrationId, integration.id), eq(integrationIdentities.externalSubjectId, input.discordUserId))))[0]?.person : undefined;
    if (integration && !person) {
      [person] = await db.insert(organizationPeople).values({ organizationId: org.id, displayName: input.discordUserId }).returning();
      if (person) await db.insert(integrationIdentities).values({ integrationId: integration.id, personId: person.id, externalSubjectId: input.discordUserId });
    }
    return {
      ...input,
      organizationId: id<"OrganizationId">(org.id),
      userId: id<"UserId">(user!.id),
      integrationId: integration ? id<"OrganizationClientIntegrationId">(integration.id) : undefined,
      personId: person ? id<"OrganizationPersonId">(person.id) : undefined,
    };
  }

  /**
   * A Discord DM does not include a guild, so normal invocation resolution has
   * no organization to anchor it to. Task-action component IDs carry an
   * assignment ID, which is a safe, narrow anchor: resolve the actor only when
   * their Discord identity is the person assigned to that task's source
   * integration.
   */
  async resolveTaskAssignmentDiscordActor(input: { assignmentId: string; discordUserId: string }) {
    const rows = await db.select({
      organizationId: tasks.organizationId,
      personId: taskAssignments.personId,
      integrationId: tasks.sourceIntegrationId,
    }).from(taskAssignments)
      .innerJoin(tasks, eq(tasks.id, taskAssignments.taskId))
      .innerJoin(organizationClientIntegrations, eq(organizationClientIntegrations.id, tasks.sourceIntegrationId))
      .innerJoin(integrationIdentities, and(
        eq(integrationIdentities.integrationId, tasks.sourceIntegrationId),
        eq(integrationIdentities.personId, taskAssignments.personId),
        eq(integrationIdentities.externalSubjectId, input.discordUserId),
      ))
      .where(and(
        eq(taskAssignments.id, input.assignmentId),
        eq(organizationClientIntegrations.kind, "discord"),
        eq(organizationClientIntegrations.status, "active"),
      ));
    const row = rows[0];
    return row ? {
      organizationId: id<"OrganizationId">(row.organizationId),
      personId: id<"OrganizationPersonId">(row.personId),
      integrationId: id<"OrganizationClientIntegrationId">(row.integrationId),
    } : undefined;
  }

  async registerMember(input: { organizationId: string; userId: string; displayName: string; inviteEmail: string }) {
    return db.transaction(async (tx) => {
      const outboxEventsCreated: PendingOutboxEvent[] = [];
      const caller = await tx.query.users.findFirst({ where: eq(users.id, input.userId) });
      if (!caller) throw new Error("Current user was not found.");
      const normalizedEmail = input.inviteEmail.toLowerCase();
      const existing = await tx.query.members.findFirst({
        where: and(eq(members.organizationId, input.organizationId), eq(members.calendarInviteEmail, normalizedEmail)),
      });
      let member = existing;
      if (existing) {
        const memberOwner = await tx.query.users.findFirst({ where: eq(users.memberId, existing.id) });
        if (memberOwner && memberOwner.id !== caller.id) {
          throw new Error("That invite email already belongs to another registered member.");
        }
        if (caller.memberId && caller.memberId !== existing.id) {
          throw new Error("That invite email already belongs to another registered member.");
        }
      } else if (caller.memberId) {
        [member] = await tx.update(members).set({
          displayName: input.displayName,
          calendarInviteEmail: normalizedEmail,
          updatedAt: new Date(),
        }).where(eq(members.id, caller.memberId)).returning();
        if (!member) throw new Error("Unable to update member profile.");
        const affected = await tx.select({ meetingId: meetingParticipants.meetingId, organizationId: meetings.organizationId, status: meetings.status, version: meetings.version })
          .from(meetingParticipants).innerJoin(meetings, eq(meetings.id, meetingParticipants.meetingId))
          .where(and(eq(meetingParticipants.memberId, member.id), inArray(meetings.status, ["awaiting_confirmation", "calendar_pending", "scheduled"]), drizzleSql`${meetings.startsAt} > now()`));
        const affectedIds = affected.map((meeting) => meeting.meetingId);
        if (affectedIds.length > 0) {
          await tx.update(meetingParticipants).set({
            displayNameSnapshot: member.displayName,
            calendarInviteEmailSnapshot: member.calendarInviteEmail,
          }).where(and(eq(meetingParticipants.memberId, member.id), inArray(meetingParticipants.meetingId, affectedIds)));
        }
        for (const meeting of affected) {
          if (meeting.status !== "scheduled") continue;
          const [resync] = await tx.update(meetings).set({
            status: "calendar_pending",
            version: meeting.version + 1,
            updatedAt: new Date(),
          }).where(and(eq(meetings.id, meeting.meetingId), eq(meetings.version, meeting.version), eq(meetings.status, "scheduled"))).returning({ version: meetings.version });
          if (!resync) continue;
          const [outbox] = await tx.insert(outboxEvents).values({ organizationId: meeting.organizationId, type: "meeting.calendar_sync_requested", aggregateId: meeting.meetingId, expectedVersion: resync.version, payload: {} }).onConflictDoNothing().returning();
          if (outbox) outboxEventsCreated.push(asPendingOutboxEvent(outbox));
        }
      } else {
        [member] = await tx.insert(members).values({
          organizationId: input.organizationId,
          displayName: input.displayName,
          calendarInviteEmail: normalizedEmail,
        }).returning();
      }
      if (!member) throw new Error("Unable to register member.");
      await tx.update(users).set({ memberId: member.id }).where(eq(users.id, input.userId));
      return { ...member, outboxEvents: outboxEventsCreated };
    });
  }

  async createOauthState(input: {
    state: string;
    organizationId: string;
    userId: string;
    memberId?: string;
    kind: "organizer" | "availability";
    codeVerifier: string;
  }) {
    if ((input.kind === "availability") !== Boolean(input.memberId)) {
      throw new Error("Availability authorization must be attached to a registered member.");
    }
    await db.insert(oauthStates).values({
      state: input.state,
      organizationId: input.organizationId,
      userId: input.userId,
      memberId: input.memberId,
      kind: input.kind,
      codeVerifier: input.codeVerifier,
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
  }

  async consumeOauthState(state: string) {
    const [row] = await db.delete(oauthStates).where(eq(oauthStates.state, state)).returning();
    if (!row || row.expiresAt < new Date()) return undefined;
    return row;
  }

  async setOrganizerConnection(input: { organizationId: string; accountEmail: string; encryptedRefreshToken: string }) {
    return db.transaction(async (tx) => {
      const existing = await tx.query.calendarConnections.findFirst({
        where: and(eq(calendarConnections.organizationId, input.organizationId), eq(calendarConnections.kind, "organizer")),
      });
      const [connection] = existing
        ? await tx.update(calendarConnections).set({
            calendarId: "primary",
            accountEmail: input.accountEmail,
            encryptedRefreshToken: input.encryptedRefreshToken,
            status: "active",
            updatedAt: new Date(),
          }).where(eq(calendarConnections.id, existing.id)).returning()
        : await tx.insert(calendarConnections).values({
            organizationId: input.organizationId,
            kind: "organizer",
            calendarId: "primary",
            accountEmail: input.accountEmail,
            encryptedRefreshToken: input.encryptedRefreshToken,
          }).returning();
      if (!connection) throw new Error("Unable to save organizer calendar connection.");
      return connection;
    });
  }

  async getMemberForUser(userId: string) {
    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user?.memberId) return undefined;
    return db.query.members.findFirst({ where: eq(members.id, user.memberId) });
  }

  async getProfile(userId: string) {
    const member = await this.getMemberForUser(userId);
    if (!member) return { member: undefined, availability: undefined };
    const availability = await db.query.calendarConnections.findFirst({
      where: and(
        eq(calendarConnections.kind, "availability"),
        eq(calendarConnections.memberId, member.id),
        eq(calendarConnections.status, "active"),
      ),
    });
    return { member, availability };
  }

  async upsertAvailabilityConnection(input: {
    organizationId: string;
    memberId: string;
    accountEmail: string;
    encryptedRefreshToken: string;
  }) {
    return db.transaction(async (tx) => {
      const member = await tx.query.members.findFirst({
        where: and(eq(members.id, input.memberId), eq(members.organizationId, input.organizationId)),
      });
      if (!member) throw new Error("The member for this availability connection no longer exists.");
      const existing = await tx.query.calendarConnections.findFirst({
        where: and(eq(calendarConnections.kind, "availability"), eq(calendarConnections.memberId, input.memberId)),
      });
      const [connection] = existing
        ? await tx.update(calendarConnections).set({
            accountEmail: input.accountEmail,
            encryptedRefreshToken: input.encryptedRefreshToken,
            calendarId: null,
            status: "active",
            updatedAt: new Date(),
          }).where(eq(calendarConnections.id, existing.id)).returning()
        : await tx.insert(calendarConnections).values({
            organizationId: input.organizationId,
            memberId: input.memberId,
            kind: "availability",
            accountEmail: input.accountEmail,
            encryptedRefreshToken: input.encryptedRefreshToken,
          }).returning();
      if (!connection) throw new Error("Unable to save availability connection.");
      return connection;
    });
  }

  async disconnectAvailability(userId: string) {
    const member = await this.getMemberForUser(userId);
    if (!member) throw new Error("Register your profile before managing calendar availability.");
    const deleted = await db.delete(calendarConnections).where(and(
      eq(calendarConnections.kind, "availability"),
      eq(calendarConnections.memberId, member.id),
    )).returning({ id: calendarConnections.id });
    return deleted.length > 0;
  }

  async loadAvailabilityConnection(memberId: string): Promise<(AvailabilityCalendarConnection & { encryptedRefreshToken: string }) | undefined> {
    const row = await db.query.calendarConnections.findFirst({
      where: and(
        eq(calendarConnections.kind, "availability"),
        eq(calendarConnections.memberId, memberId),
        eq(calendarConnections.status, "active"),
      ),
    });
    if (!row) return undefined;
    return {
      id: id<"CalendarConnectionId">(row.id),
      organizationId: id<"OrganizationId">(row.organizationId),
      memberId: id<"MemberId">(row.memberId!),
      provider: "google_calendar",
      googleAccountEmail: row.accountEmail as AvailabilityCalendarConnection["googleAccountEmail"],
      status: row.status,
      encryptedRefreshToken: row.encryptedRefreshToken,
    };
  }

  async createDirectMeeting(input: CreateDirectMeetingRecord): Promise<Meeting> {
    if (!input.time) throw new Error("A direct meeting requires a start and end time.");
    const [row] = await db.insert(meetings).values({
      organizationId: input.organizationId,
      mode: input.mode,
      status: input.status,
      title: input.title,
      timeZone: input.timeZone,
      startsAt: input.time.startsAt,
      endsAt: input.time.endsAt,
      location: input.location,
      notes: input.notes,
      createdByUserId: input.createdBy,
      notificationClient: input.notificationTarget.client,
      notificationChannelId: input.notificationTarget.channelId,
    }).returning();
    if (!row) throw new Error("Unable to create meeting.");
    return asMeeting(row);
  }

  async createDiscoveryMeeting(input: Omit<Meeting, "id" | "version" | "time"> & { discoveryWindow: NonNullable<Meeting["discoveryWindow"]> }): Promise<Meeting> {
    const [row] = await db.insert(meetings).values({
      organizationId: input.organizationId,
      mode: "discovery",
      status: "discovering",
      title: input.title,
      timeZone: input.timeZone,
      discoveryStartsAt: input.discoveryWindow.startsAt,
      discoveryEndsAt: input.discoveryWindow.endsAt,
      location: input.location,
      notes: input.notes,
      createdByUserId: input.createdBy,
      notificationClient: input.notificationTarget.client,
      notificationChannelId: input.notificationTarget.channelId,
    }).returning();
    if (!row) throw new Error("Unable to create availability discovery.");
    return asMeeting(row);
  }

  async saveCandidateSlots(meetingId: string, slots: Array<Omit<CandidateSlot, "id" | "meetingId">>) {
    await db.transaction(async (tx) => {
      await tx.delete(candidateSlots).where(eq(candidateSlots.meetingId, meetingId));
      if (slots.length) await tx.insert(candidateSlots).values(slots.map((slot) => ({
        meetingId,
        startsAt: slot.time.startsAt,
        endsAt: slot.time.endsAt,
        connectedParticipantCount: slot.connectedParticipantCount,
        unconnectedParticipantCount: slot.unconnectedParticipantCount,
        rank: slot.rank,
      })));
    });
  }

  async getCandidateSlots(meetingId: string): Promise<CandidateSlot[]> {
    const rows = await db.select().from(candidateSlots).where(eq(candidateSlots.meetingId, meetingId)).orderBy(candidateSlots.rank);
    return rows.map((row) => ({
      id: id<"CandidateSlotId">(row.id),
      meetingId: id<"MeetingId">(row.meetingId),
      time: { startsAt: row.startsAt, endsAt: row.endsAt },
      connectedParticipantCount: row.connectedParticipantCount,
      unconnectedParticipantCount: row.unconnectedParticipantCount,
      rank: row.rank,
    }));
  }

  async chooseCandidateSlot(input: { meetingId: string; candidateId: string }) {
    return db.transaction(async (tx) => {
      const candidate = await tx.query.candidateSlots.findFirst({
        where: and(eq(candidateSlots.id, input.candidateId), eq(candidateSlots.meetingId, input.meetingId)),
      });
      if (!candidate) throw new Error("That candidate time no longer exists.");
      const [meeting] = await tx.update(meetings).set({
        startsAt: candidate.startsAt,
        endsAt: candidate.endsAt,
        status: "awaiting_confirmation",
        version: drizzleSql`${meetings.version} + 1`,
        updatedAt: new Date(),
      }).where(and(eq(meetings.id, input.meetingId), eq(meetings.status, "discovering"))).returning();
      if (!meeting) throw new Error("This availability discovery has already changed.");
      return asMeeting(meeting);
    });
  }

  async addParticipant(input: MeetingParticipant): Promise<void> {
    await db.insert(meetingParticipants).values({
      meetingId: input.meetingId,
      memberId: input.memberId,
      kind: input.kind,
      displayNameSnapshot: input.displayNameSnapshot,
      calendarInviteEmailSnapshot: input.calendarInviteEmailSnapshot,
      attendanceRole: input.attendanceRole,
    }).onConflictDoNothing();
  }

  async addOrReuseExternalMember(input: { organizationId: string; name: string; email: string }) {
    const normalized = input.email.trim().toLowerCase();
    const existing = await db.query.members.findFirst({
      where: and(eq(members.organizationId, input.organizationId), eq(members.calendarInviteEmail, normalized)),
    });
    if (existing) return existing;
    const [member] = await db.insert(members).values({
      organizationId: input.organizationId,
      displayName: input.name,
      calendarInviteEmail: normalized,
    }).returning();
    if (!member) throw new Error("Unable to create invitee.");
    return member;
  }

  async getMembersByEmails(organizationId: string, emails: string[]) {
    if (!emails.length) return [];
    return db.select().from(members).where(and(eq(members.organizationId, organizationId), inArray(members.calendarInviteEmail, emails.map((email) => email.toLowerCase()))));
  }

  async getAvailabilityConnections(memberIds: string[]) {
    if (!memberIds.length) return [];
    return db.select().from(calendarConnections).where(and(
      eq(calendarConnections.kind, "availability"),
      eq(calendarConnections.status, "active"),
      inArray(calendarConnections.memberId, memberIds),
    ));
  }

  async getMembersForDiscordUsers(organizationId: string, discordUserIds: string[]) {
    if (!discordUserIds.length) return [];
    return db.select({ member: members, discordUserId: clientIdentities.subjectId }).from(users)
      .innerJoin(members, eq(members.id, users.memberId))
      .innerJoin(clientIdentities, and(eq(clientIdentities.userId, users.id), eq(clientIdentities.client, "discord")))
      .where(and(eq(users.organizationId, organizationId), inArray(clientIdentities.subjectId, discordUserIds)));
  }

  async listProviderInstallations(organizationId: string): Promise<OrganizationProviderInstallation[]> {
    const rows = await db.select().from(providerInstallations).where(eq(providerInstallations.organizationId, organizationId));
    return rows.map(asProviderInstallation);
  }

  async getProviderInstallation(organizationId: string, providerId: string) {
    const row = await db.query.providerInstallations.findFirst({ where: and(eq(providerInstallations.organizationId, organizationId), eq(providerInstallations.providerId, providerId)) });
    return row ? asProviderInstallation(row) : undefined;
  }

  async saveProviderInstallation(input: { organizationId: string; providerId: string; values: Record<string, string>; status: "configuring" | "enabled" | "disabled"; configuredBy: string }) {
    const existing = await this.getProviderInstallation(input.organizationId, input.providerId);
    const [row] = existing
      ? await db.update(providerInstallations).set({ values: input.values, status: input.status, configuredByUserId: input.configuredBy, updatedAt: new Date() }).where(eq(providerInstallations.id, existing.id)).returning()
      : await db.insert(providerInstallations).values({ organizationId: input.organizationId, providerId: input.providerId, values: input.values, status: input.status, configuredByUserId: input.configuredBy }).returning();
    if (!row) throw new Error("Unable to save provider installation.");
    return asProviderInstallation(row);
  }

  async disableProviderInstallation(organizationId: string, providerId: string, configuredBy: string) {
    const [row] = await db.update(providerInstallations).set({ status: "disabled", configuredByUserId: configuredBy, updatedAt: new Date() })
      .where(and(eq(providerInstallations.organizationId, organizationId), eq(providerInstallations.providerId, providerId))).returning();
    return row ? asProviderInstallation(row) : undefined;
  }

  async createRoomBooking(input: { meetingId: string; providerInstallationId: string; createdBy: string }) {
    return db.transaction(async (tx) => {
      const meeting = await tx.query.meetings.findFirst({ where: eq(meetings.id, input.meetingId) });
      if (!meeting?.startsAt || !meeting.endsAt || meeting.status !== "scheduled") throw new Error("Schedule the meeting before finding a room.");
      const [booking] = await tx.insert(roomBookings).values({ organizationId: meeting.organizationId, meetingId: input.meetingId, providerInstallationId: input.providerInstallationId, createdByUserId: input.createdBy }).returning();
      if (!booking) throw new Error("Unable to create room booking.");
      const [outbox] = await tx.insert(outboxEvents).values({ organizationId: meeting.organizationId, type: "room.discovery_requested", aggregateId: booking.id, payload: {} }).onConflictDoNothing().returning();
      return { ...asRoomBooking(booking), outboxEvents: outbox ? [asPendingOutboxEvent(outbox)] : [] };
    });
  }

  async loadRoomDiscovery(roomBookingId: string) {
    const booking = await db.query.roomBookings.findFirst({ where: eq(roomBookings.id, roomBookingId) });
    if (!booking || booking.status !== "discovering") return undefined;
    const meeting = await this.getMeetingForConfirmation(booking.meetingId);
    const installation = await db.query.providerInstallations.findFirst({ where: eq(providerInstallations.id, booking.providerInstallationId) });
    if (!meeting?.time || !installation || installation.status !== "enabled") return undefined;
    const participants = await this.getMeetingParticipants(meeting.id);
    return { booking: asRoomBooking(booking), meeting, installation: asProviderInstallation(installation), attendeeCount: participants.length };
  }

  async completeRoomDiscovery(jobId: string | undefined, roomBookingId: string, candidates: RoomCandidate[]) {
    await db.transaction(async (tx) => {
      const booking = await tx.query.roomBookings.findFirst({ where: eq(roomBookings.id, roomBookingId) });
      if (!booking) throw new Error("Room booking not found.");
      await tx.update(roomBookings).set({ status: "awaiting_confirmation", room: candidates[0] as unknown as Record<string, unknown>, updatedAt: new Date() }).where(eq(roomBookings.id, roomBookingId));
      if (jobId) await tx.update(jobs).set({ status: "succeeded", leaseExpiresAt: null }).where(eq(jobs.id, jobId));
    });
  }

  async getRoomBooking(roomBookingId: string) {
    const row = await db.query.roomBookings.findFirst({ where: eq(roomBookings.id, roomBookingId) });
    return row ? asRoomBooking(row) : undefined;
  }

  async selectRoomBookingCandidate(input: { roomBookingId: string; userId: string; room: RoomCandidate }) {
    const [row] = await db.update(roomBookings).set({ room: input.room as unknown as Record<string, unknown>, updatedAt: new Date() })
      .where(and(eq(roomBookings.id, input.roomBookingId), eq(roomBookings.createdByUserId, input.userId), eq(roomBookings.status, "awaiting_confirmation"))).returning();
    if (!row) throw new Error("Only the room-flow creator can select a pending room.");
    return asRoomBooking(row);
  }

  async submitRoomBooking(roomBookingId: string, userId: string) {
    return db.transaction(async (tx) => {
      const [booking] = await tx.update(roomBookings).set({ status: "submitting", updatedAt: new Date() })
        .where(and(eq(roomBookings.id, roomBookingId), eq(roomBookings.createdByUserId, userId), eq(roomBookings.status, "awaiting_confirmation"))).returning();
      if (!booking) throw new Error("Only the room-flow creator can submit this request once.");
      const [outbox] = await tx.insert(outboxEvents).values({ organizationId: booking.organizationId, type: "room.submission_requested", aggregateId: booking.id, payload: {} }).onConflictDoNothing().returning();
      return { ...asRoomBooking(booking), outboxEvents: outbox ? [asPendingOutboxEvent(outbox)] : [] };
    });
  }

  async loadRoomSubmission(roomBookingId: string) {
    const booking = await db.query.roomBookings.findFirst({ where: eq(roomBookings.id, roomBookingId) });
    if (!booking || booking.status !== "submitting") return undefined;
    const meeting = await this.getMeetingForConfirmation(booking.meetingId);
    const installation = await db.query.providerInstallations.findFirst({ where: eq(providerInstallations.id, booking.providerInstallationId) });
    if (!meeting?.time || !installation) return undefined;
    return { booking: asRoomBooking(booking), meeting, installation: asProviderInstallation(installation), attendeeCount: (await this.getMeetingParticipants(meeting.id)).length };
  }

  async completeRoomSubmission(jobId: string | undefined, roomBookingId: string, reference?: string) {
    return db.transaction(async (tx) => {
      const booking = await tx.query.roomBookings.findFirst({ where: eq(roomBookings.id, roomBookingId) });
      if (!booking?.room) throw new Error("Room booking is missing a selected room.");
      const room = booking.room as unknown as RoomCandidate;
      const meeting = await tx.query.meetings.findFirst({ where: eq(meetings.id, booking.meetingId) });
      if (!meeting) throw new Error("Meeting not found.");
      await tx.update(roomBookings).set({ status: "request_submitted", providerReference: reference, updatedAt: new Date() }).where(eq(roomBookings.id, roomBookingId));
      const [updated] = await tx.update(meetings).set({ location: `eLab request pending — ${room.name}`, status: "calendar_pending", version: meeting.version + 1, updatedAt: new Date() })
        .where(and(eq(meetings.id, meeting.id), eq(meetings.status, "scheduled"))).returning({ version: meetings.version });
      if (!updated) throw new Error("Meeting is no longer scheduled.");
      const [outbox] = await tx.insert(outboxEvents).values({ organizationId: meeting.organizationId, type: "meeting.calendar_sync_requested", aggregateId: meeting.id, expectedVersion: updated.version, payload: {} }).onConflictDoNothing().returning();
      if (jobId) await tx.update(jobs).set({ status: "succeeded", leaseExpiresAt: null }).where(eq(jobs.id, jobId));
      return outbox ? [asPendingOutboxEvent(outbox)] : [];
    });
  }

  async failRoomBooking(jobId: string, roomBookingId: string, reason: string) {
    await db.transaction(async (tx) => {
      await tx.update(roomBookings).set({ status: "failed", failureReason: reason, updatedAt: new Date() }).where(eq(roomBookings.id, roomBookingId));
      await tx.update(jobs).set({ status: "failed", lastError: reason, leaseExpiresAt: null }).where(eq(jobs.id, jobId));
    });
  }

  async getMeetingForConfirmation(meetingId: string): Promise<Meeting | undefined> {
    const row = await db.query.meetings.findFirst({ where: eq(meetings.id, meetingId) });
    return row ? asMeeting(row) : undefined;
  }

  async getMeetingParticipants(meetingId: string): Promise<MeetingParticipant[]> {
    const rows = await db.select().from(meetingParticipants).where(eq(meetingParticipants.meetingId, meetingId));
    return rows.map((row) => ({
      meetingId: id<"MeetingId">(row.meetingId),
      memberId: row.memberId ? id<"MemberId">(row.memberId) : undefined,
      kind: row.kind as MeetingParticipant["kind"],
      displayNameSnapshot: row.displayNameSnapshot,
      calendarInviteEmailSnapshot: row.calendarInviteEmailSnapshot as MeetingParticipant["calendarInviteEmailSnapshot"],
      attendanceRole: row.attendanceRole as MeetingParticipant["attendanceRole"],
    }));
  }

  async markCalendarPending(meetingId: string, expectedVersion: number): Promise<PendingOutboxEvent | undefined> {
    return db.transaction(async (tx) => {
      const [meeting] = await tx.update(meetings).set({ status: "calendar_pending", version: expectedVersion + 1, updatedAt: new Date() })
        .where(and(eq(meetings.id, meetingId), eq(meetings.status, "awaiting_confirmation"), eq(meetings.version, expectedVersion)))
        .returning({ id: meetings.id, organizationId: meetings.organizationId, version: meetings.version });
      if (!meeting) return undefined;
      const [outbox] = await tx.insert(outboxEvents).values({ organizationId: meeting.organizationId, type: "meeting.calendar_sync_requested", aggregateId: meeting.id, expectedVersion: meeting.version, payload: {} }).onConflictDoNothing().returning();
      return outbox ? asPendingOutboxEvent(outbox) : undefined;
    });
  }

  async getOrganizerConnection(organizationId: string): Promise<OrganizerCalendarConnection | undefined> {
    const row = await db.query.calendarConnections.findFirst({
      where: and(eq(calendarConnections.organizationId, organizationId), eq(calendarConnections.kind, "organizer"), eq(calendarConnections.status, "active")),
    });
    if (!row || !row.calendarId) return undefined;
    return {
      id: id<"CalendarConnectionId">(row.id),
      organizationId: id<"OrganizationId">(row.organizationId),
      calendarId: row.calendarId,
      organizerEmail: row.accountEmail as OrganizerCalendarConnection["organizerEmail"],
      provider: "google_calendar",
      status: row.status,
    };
  }

  async canManageMeeting(meetingId: string, invocation: ClientInvocation) {
    const meeting = await this.getMeetingForConfirmation(meetingId);
    if (!meeting || meeting.organizationId !== invocation.organizationId || !invocation.userId) return false;
    return meeting.createdBy === invocation.userId;
  }

  async cancelMeeting(meetingId: string) {
    return db.transaction(async (tx) => {
      const meeting = await tx.query.meetings.findFirst({ where: eq(meetings.id, meetingId) });
      if (!meeting) throw new Error("Meeting not found.");
      if (meeting.status === "cancelled") throw new Error("This meeting is already cancelled.");
      await tx.update(meetings).set({ status: "cancelled", version: meeting.version + 1, updatedAt: new Date() }).where(eq(meetings.id, meetingId));
      const event = await tx.query.calendarEvents.findFirst({ where: eq(calendarEvents.meetingId, meetingId) });
      const [outbox] = event
        ? await tx.insert(outboxEvents).values({ organizationId: meeting.organizationId, type: "meeting.calendar_cancel_requested", aggregateId: meetingId, expectedVersion: meeting.version + 1, payload: {} }).onConflictDoNothing().returning()
        : [];
      return { calendarEventExisted: Boolean(event), outboxEvents: outbox ? [asPendingOutboxEvent(outbox)] : [] };
    });
  }

  async createPlanningSession(input: { organizationId: string; createdByUserId: string; notificationChannelId: string; kind?: "create" | "reschedule"; sourceMeetingId?: string }) {
    const [row] = await db.insert(planningSessions).values({
      organizationId: input.organizationId,
      createdByUserId: input.createdByUserId,
      notificationChannelId: input.notificationChannelId,
      kind: input.kind ?? "create",
      sourceMeetingId: input.sourceMeetingId,
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
    }).returning();
    if (!row) throw new Error("Unable to start a planning session.");
    return asPlanningSession(row);
  }

  async addDiscordPlanningAudience(input: { planningSessionId: string; organizationId: string; source: ClientAudienceReference; discordUserIds: Array<{ id: string; displayName: string }> }) {
    return db.transaction(async (tx) => {
      const session = await tx.query.planningSessions.findFirst({ where: eq(planningSessions.id, input.planningSessionId) });
      if (!session || session.organizationId !== input.organizationId || session.expiresAt < new Date()) throw new Error("This planning session has expired.");
      for (const candidate of input.discordUserIds) {
        const existing = await tx.select({ user: users }).from(users).innerJoin(clientIdentities, eq(clientIdentities.userId, users.id))
          .where(and(eq(users.organizationId, input.organizationId), eq(clientIdentities.client, "discord"), eq(clientIdentities.subjectId, candidate.id)));
        let user = existing[0]?.user;
        if (!user) {
          [user] = await tx.insert(users).values({ organizationId: input.organizationId }).returning();
          if (user) await tx.insert(clientIdentities).values({ userId: user.id, client: "discord", subjectId: candidate.id });
        }
        if (!user) continue;
        const member = user.memberId ? await tx.query.members.findFirst({ where: eq(members.id, user.memberId) }) : undefined;
        const connection = member ? await tx.query.calendarConnections.findFirst({ where: and(eq(calendarConnections.memberId, member.id), eq(calendarConnections.kind, "availability"), eq(calendarConnections.status, "active")) }) : undefined;
        const readiness = !member ? "needs_invite_email" : !connection ? "needs_availability" : "ready";
        await tx.insert(planningAttendees).values({
          planningSessionId: session.id,
          userId: user.id,
          memberId: member?.id,
          displayName: member?.displayName ?? candidate.displayName,
          source: input.source,
          readiness,
        }).onConflictDoNothing();
      }
      const attendees = await tx.select().from(planningAttendees).where(eq(planningAttendees.planningSessionId, session.id));
      const nextStatus = attendees.length > 0 && attendees.every((attendee) => attendee.readiness === "ready" || attendee.readiness === "unverified") ? "ready" : "waiting_for_requirements";
      await tx.update(planningSessions).set({ status: nextStatus, updatedAt: new Date() }).where(eq(planningSessions.id, session.id));
      return attendees.map(asPlanningAttendee);
    });
  }

  async getPlanningSession(sessionId: string) {
    const session = await db.query.planningSessions.findFirst({ where: eq(planningSessions.id, sessionId) });
    if (!session) return undefined;
    const attendees = await db.select().from(planningAttendees).where(eq(planningAttendees.planningSessionId, session.id));
    return { session: asPlanningSession(session), attendees: attendees.map(asPlanningAttendee), guests: session.guestEmails };
  }

  async createPlanningLaunchToken(input: { planningSessionId: string; tokenHash: string }) {
    await db.insert(planningLaunchTokens).values({ planningSessionId: input.planningSessionId, tokenHash: input.tokenHash, expiresAt: new Date(Date.now() + 15 * 60_000) });
  }

  async redeemPlanningLaunchToken(input: { tokenHash: string; browserTokenHash: string }) {
    return db.transaction(async (tx) => {
      const [token] = await tx.update(planningLaunchTokens).set({ redeemedAt: new Date() })
        .where(and(eq(planningLaunchTokens.tokenHash, input.tokenHash), isNull(planningLaunchTokens.redeemedAt), drizzleSql`${planningLaunchTokens.expiresAt} > now()`))
        .returning();
      if (!token) return undefined;
      const [browser] = await tx.insert(planningBrowserSessions).values({ planningSessionId: token.planningSessionId, tokenHash: input.browserTokenHash, expiresAt: new Date(Date.now() + 24 * 60 * 60_000) }).returning();
      return browser;
    });
  }

  async getPlanningSessionForBrowserToken(tokenHash: string) {
    const rows = await db.select({ session: planningSessions }).from(planningBrowserSessions)
      .innerJoin(planningSessions, eq(planningSessions.id, planningBrowserSessions.planningSessionId))
      .where(and(eq(planningBrowserSessions.tokenHash, tokenHash), drizzleSql`${planningBrowserSessions.expiresAt} > now()`));
    const session = rows[0]?.session;
    if (!session || session.expiresAt < new Date()) return undefined;
    const attendees = await db.select().from(planningAttendees).where(eq(planningAttendees.planningSessionId, session.id));
    return { session: asPlanningSession(session), attendees: attendees.map(asPlanningAttendee), guests: session.guestEmails };
  }

  async savePlanningDraft(input: { sessionId: string; title?: string; startsAt?: Date; endsAt?: Date; guests?: Array<{ displayName: string; email: string }>; availabilityOverride?: boolean }) {
    const [row] = await db.update(planningSessions).set({
      title: input.title,
      selectedStartsAt: input.startsAt,
      selectedEndsAt: input.endsAt,
      guestEmails: input.guests,
      availabilityOverride: input.availabilityOverride === undefined ? undefined : Number(input.availabilityOverride),
      updatedAt: new Date(),
    }).where(and(eq(planningSessions.id, input.sessionId), drizzleSql`${planningSessions.expiresAt} > now()`)).returning();
    if (!row) throw new Error("This planning session has expired.");
    return asPlanningSession(row);
  }

  async getPlanningAvailability(sessionId: string) {
    const rows = await db.select({ attendee: planningAttendees, member: members, connection: calendarConnections }).from(planningAttendees)
      .leftJoin(members, eq(members.id, planningAttendees.memberId))
      .leftJoin(calendarConnections, and(eq(calendarConnections.memberId, members.id), eq(calendarConnections.kind, "availability"), eq(calendarConnections.status, "active")))
      .where(eq(planningAttendees.planningSessionId, sessionId));
    return rows.map((row) => ({ attendee: asPlanningAttendee(row.attendee), member: row.member ?? undefined, connection: row.connection ?? undefined }));
  }

  async listPlanningEnrollmentRequests(sessionId: string) {
    const rows = await db.select({ attendee: planningAttendees, discordUserId: clientIdentities.subjectId }).from(planningAttendees)
      .innerJoin(clientIdentities, and(eq(clientIdentities.userId, planningAttendees.userId), eq(clientIdentities.client, "discord")))
      .where(eq(planningAttendees.planningSessionId, sessionId));
    return rows.filter((row) => row.attendee.readiness === "needs_invite_email" || row.attendee.readiness === "needs_availability")
      .map((row) => ({ attendeeId: row.attendee.id, discordUserId: row.discordUserId, readiness: row.attendee.readiness }));
  }

  async getPlanningEnrollment(attendeeId: string, discordUserId: string) {
    const rows = await db.select({ attendee: planningAttendees, session: planningSessions, user: users, member: members }).from(planningAttendees)
      .innerJoin(planningSessions, eq(planningSessions.id, planningAttendees.planningSessionId))
      .innerJoin(users, eq(users.id, planningAttendees.userId))
      .innerJoin(clientIdentities, and(eq(clientIdentities.userId, users.id), eq(clientIdentities.client, "discord"), eq(clientIdentities.subjectId, discordUserId)))
      .leftJoin(members, eq(members.id, planningAttendees.memberId))
      .where(eq(planningAttendees.id, attendeeId));
    const row = rows[0];
    return row ? { attendee: asPlanningAttendee(row.attendee), session: asPlanningSession(row.session), user: row.user, member: row.member ?? undefined } : undefined;
  }

  async registerPlanningAttendeeEmail(input: { attendeeId: string; discordUserId: string; email: string }) {
    return db.transaction(async (tx) => {
      const found = await tx.select({ attendee: planningAttendees, session: planningSessions, user: users }).from(planningAttendees)
        .innerJoin(planningSessions, eq(planningSessions.id, planningAttendees.planningSessionId))
        .innerJoin(users, eq(users.id, planningAttendees.userId))
        .innerJoin(clientIdentities, and(eq(clientIdentities.userId, users.id), eq(clientIdentities.client, "discord"), eq(clientIdentities.subjectId, input.discordUserId)))
        .where(eq(planningAttendees.id, input.attendeeId));
      const row = found[0];
      if (!row) throw new Error("This enrollment request is not valid for your Discord account.");
      const email = input.email.trim().toLowerCase();
      const existing = await tx.query.members.findFirst({ where: and(eq(members.organizationId, row.session.organizationId), eq(members.calendarInviteEmail, email)) });
      const member = existing ?? (await tx.insert(members).values({ organizationId: row.session.organizationId, displayName: row.attendee.displayName, calendarInviteEmail: email }).returning())[0];
      if (!member) throw new Error("Unable to save the invite email.");
      await tx.update(users).set({ memberId: member.id }).where(eq(users.id, row.user.id));
      await tx.update(planningAttendees).set({ memberId: member.id, readiness: "needs_availability" }).where(eq(planningAttendees.id, row.attendee.id));
      return { organizationId: row.session.organizationId, userId: row.user.id, memberId: member.id, displayName: member.displayName };
    });
  }

  async setPlanningAttendeeFallbackEmail(input: { sessionId: string; attendeeId: string; email: string }) {
    return db.transaction(async (tx) => {
      const row = await tx.select({ attendee: planningAttendees, session: planningSessions, user: users }).from(planningAttendees)
        .innerJoin(planningSessions, eq(planningSessions.id, planningAttendees.planningSessionId))
        .innerJoin(users, eq(users.id, planningAttendees.userId))
        .where(and(eq(planningAttendees.id, input.attendeeId), eq(planningSessions.id, input.sessionId)));
      const found = row[0];
      if (!found) throw new Error("That attendee is not part of this planning session.");
      const email = input.email.trim().toLowerCase();
      const existing = await tx.query.members.findFirst({ where: and(eq(members.organizationId, found.session.organizationId), eq(members.calendarInviteEmail, email)) });
      const member = existing ?? (await tx.insert(members).values({ organizationId: found.session.organizationId, displayName: found.attendee.displayName, calendarInviteEmail: email }).returning())[0];
      if (!member) throw new Error("Unable to save the fallback invite email.");
      await tx.update(users).set({ memberId: member.id }).where(eq(users.id, found.user.id));
      await tx.update(planningAttendees).set({ memberId: member.id, readiness: "unverified" }).where(eq(planningAttendees.id, found.attendee.id));
      const attendees = await tx.select().from(planningAttendees).where(eq(planningAttendees.planningSessionId, found.session.id));
      const status = attendees.every((attendee) => attendee.readiness === "ready" || attendee.readiness === "unverified") ? "ready" : "waiting_for_requirements";
      await tx.update(planningSessions).set({ status, updatedAt: new Date() }).where(eq(planningSessions.id, found.session.id));
      return asPlanningAttendee({ ...found.attendee, memberId: member.id, readiness: "unverified" });
    });
  }

  async refreshPlanningReadinessForMember(memberId: string) {
    const affected = await db.select({ sessionId: planningAttendees.planningSessionId }).from(planningAttendees).where(eq(planningAttendees.memberId, memberId));
    if (!affected.length) return;
    await db.update(planningAttendees).set({ readiness: "ready" }).where(eq(planningAttendees.memberId, memberId));
    for (const { sessionId } of affected) {
      const attendees = await db.select().from(planningAttendees).where(eq(planningAttendees.planningSessionId, sessionId));
      const status = attendees.every((attendee) => attendee.readiness === "ready" || attendee.readiness === "unverified") ? "ready" : "waiting_for_requirements";
      await db.update(planningSessions).set({ status, updatedAt: new Date() }).where(eq(planningSessions.id, sessionId));
    }
  }

  async confirmPlanningSession(sessionId: string) {
    return db.transaction(async (tx) => {
      const session = await tx.query.planningSessions.findFirst({ where: eq(planningSessions.id, sessionId) });
      if (!session || session.expiresAt < new Date()) throw new Error("This planning session has expired.");
      if (session.status === "confirmed") throw new Error("This planning session was already confirmed.");
      if (!session.title?.trim() || !session.selectedStartsAt || !session.selectedEndsAt) throw new Error("Choose a title and a meeting time before confirming.");
      validatePlanningTime({ startsAt: session.selectedStartsAt, endsAt: session.selectedEndsAt });
      const attendees = await tx.select().from(planningAttendees).where(eq(planningAttendees.planningSessionId, session.id));
      if (!attendees.length) throw new Error("Select at least one Discord attendee.");
      const unresolved = attendees.filter((attendee) => attendee.readiness !== "ready" && attendee.readiness !== "unverified");
      if (unresolved.length) throw new Error("Some attendees still need an invite email or availability connection.");
      const participantRows = await Promise.all(attendees.map(async (attendee) => {
        if (!attendee.memberId) throw new Error("An unverified attendee needs an invite email before confirmation.");
        const member = await tx.query.members.findFirst({ where: eq(members.id, attendee.memberId) });
        if (!member) throw new Error("A selected attendee no longer exists.");
        return { memberId: member.id, kind: "registered_member", displayNameSnapshot: member.displayName, calendarInviteEmailSnapshot: member.calendarInviteEmail, attendanceRole: "required" as const };
      }));
      const guestRows = session.guestEmails.map((guest) => ({ memberId: null, kind: "email_guest", displayNameSnapshot: guest.displayName || guest.email, calendarInviteEmailSnapshot: guest.email.trim().toLowerCase(), attendanceRole: "required" as const }));
      let meetingId: string;
      let version: number;
      if (session.kind === "reschedule" && session.sourceMeetingId) {
        const [meeting] = await tx.update(meetings).set({ title: session.title.trim(), startsAt: session.selectedStartsAt, endsAt: session.selectedEndsAt, status: "calendar_pending", version: drizzleSql`${meetings.version} + 1`, updatedAt: new Date() })
          .where(eq(meetings.id, session.sourceMeetingId)).returning();
        if (!meeting) throw new Error("The meeting to reschedule no longer exists.");
        await tx.delete(meetingParticipants).where(eq(meetingParticipants.meetingId, meeting.id));
        await tx.insert(meetingParticipants).values([...participantRows, ...guestRows].map((participant) => ({ ...participant, meetingId: meeting.id })));
        meetingId = meeting.id; version = meeting.version;
      } else {
        const [meeting] = await tx.insert(meetings).values({ organizationId: session.organizationId, mode: "direct", status: "calendar_pending", title: session.title.trim(), timeZone: "America/New_York", startsAt: session.selectedStartsAt, endsAt: session.selectedEndsAt, createdByUserId: session.createdByUserId, notificationClient: session.notificationClient, notificationChannelId: session.notificationChannelId }).returning();
        if (!meeting) throw new Error("Unable to create the meeting.");
        await tx.insert(meetingParticipants).values([...participantRows, ...guestRows].map((participant) => ({ ...participant, meetingId: meeting.id })));
        meetingId = meeting.id; version = meeting.version;
      }
      const [outbox] = await tx.insert(outboxEvents).values({ organizationId: session.organizationId, type: "meeting.calendar_sync_requested", aggregateId: meetingId, expectedVersion: version, payload: {} }).onConflictDoNothing().returning();
      await tx.update(planningSessions).set({ status: "confirmed", confirmedAt: new Date(), updatedAt: new Date() }).where(eq(planningSessions.id, session.id));
      return { meetingId, outboxEvents: outbox ? [asPendingOutboxEvent(outbox)] : [] };
    });
  }

  async leaseNextJob(kinds?: string[]) {
    const [job] = await db.execute<{
      id: string; organization_id: string; kind: string; payload: { meetingId?: string; roomBookingId?: string; version?: number }; attempts: number;
    }>(drizzleSql`
      UPDATE jobs SET status = 'leased', attempts = attempts + 1, lease_expires_at = now() + interval '5 minutes'
      WHERE id = (
        SELECT id FROM jobs
        WHERE status = 'ready' AND run_after <= now() ${kinds?.length ? drizzleSql`AND kind IN (${drizzleSql.join(kinds.map((kind) => drizzleSql`${kind}`), drizzleSql`, `)})` : drizzleSql``}
        ORDER BY run_after, created_at
        FOR UPDATE SKIP LOCKED LIMIT 1
      )
      RETURNING id, organization_id, kind, payload, attempts
    `);
    return job;
  }

  async loadCalendarSync(meetingId: string) {
    const meeting = await this.getMeetingForConfirmation(meetingId);
    if (!meeting || meeting.status !== "calendar_pending") return undefined;
    const participants = await this.getMeetingParticipants(meetingId);
    const connectionRow = await db.query.calendarConnections.findFirst({
      where: and(eq(calendarConnections.organizationId, meeting.organizationId), eq(calendarConnections.kind, "organizer"), eq(calendarConnections.status, "active")),
    });
    if (!connectionRow?.calendarId) return undefined;
    const organizer: OrganizerCalendarConnection = {
      id: id<"CalendarConnectionId">(connectionRow.id),
      organizationId: id<"OrganizationId">(connectionRow.organizationId),
      calendarId: connectionRow.calendarId,
      organizerEmail: connectionRow.accountEmail as OrganizerCalendarConnection["organizerEmail"],
      provider: "google_calendar",
      status: connectionRow.status,
    };
    return { meeting, participants, organizer, encryptedRefreshToken: connectionRow.encryptedRefreshToken };
  }

  async getExistingCalendarEvent(meetingId: string) {
    return db.query.calendarEvents.findFirst({ where: eq(calendarEvents.meetingId, meetingId) });
  }

  async completeCalendarSync(input: { jobId?: string; meetingId: string; connectionId: string; externalEventId: string; htmlLink?: string }) {
    await db.transaction(async (tx) => {
      await tx.insert(calendarEvents).values({
        meetingId: input.meetingId,
        calendarConnectionId: input.connectionId,
        externalEventId: input.externalEventId,
        htmlLink: input.htmlLink,
      }).onConflictDoUpdate({ target: calendarEvents.meetingId, set: { externalEventId: input.externalEventId, htmlLink: input.htmlLink, updatedAt: new Date() } });
      const meeting = await tx.query.meetings.findFirst({ where: eq(meetings.id, input.meetingId) });
      if (meeting) {
        await tx.update(meetings).set({ status: "scheduled", version: meeting.version + 1, updatedAt: new Date() }).where(eq(meetings.id, input.meetingId));
      }
      if (input.jobId) await tx.update(jobs).set({ status: "succeeded", leaseExpiresAt: null }).where(eq(jobs.id, input.jobId));
    });
  }

  async loadCalendarCancellation(meetingId: string) {
    const meeting = await this.getMeetingForConfirmation(meetingId);
    if (!meeting || meeting.status !== "cancelled") return undefined;
    const connectionRow = await db.query.calendarConnections.findFirst({
      where: and(eq(calendarConnections.organizationId, meeting.organizationId), eq(calendarConnections.kind, "organizer"), eq(calendarConnections.status, "active")),
    });
    if (!connectionRow?.calendarId) return undefined;
    const event = await this.getExistingCalendarEvent(meetingId);
    if (!event) return undefined;
    return {
      organizer: {
        id: id<"CalendarConnectionId">(connectionRow.id),
        organizationId: id<"OrganizationId">(connectionRow.organizationId),
        calendarId: connectionRow.calendarId,
        organizerEmail: connectionRow.accountEmail as OrganizerCalendarConnection["organizerEmail"],
        provider: "google_calendar" as const,
        status: connectionRow.status,
      },
      encryptedRefreshToken: connectionRow.encryptedRefreshToken,
      externalEventId: event.externalEventId,
    };
  }

  async completeCalendarCancellation(jobId: string | undefined, meetingId: string) {
    await db.transaction(async (tx) => {
      await tx.update(calendarEvents).set({ status: "cancelled", updatedAt: new Date() }).where(eq(calendarEvents.meetingId, meetingId));
      if (jobId) await tx.update(jobs).set({ status: "succeeded", leaseExpiresAt: null }).where(eq(jobs.id, jobId));
    });
  }

  async loadAnnouncement(meetingId: string) {
    const meeting = await this.getMeetingForConfirmation(meetingId);
    if (!meeting?.time || meeting.status !== "scheduled") return undefined;
    const event = await this.getExistingCalendarEvent(meetingId);
    return { meeting, htmlLink: event?.htmlLink };
  }

  async loadReminder(meetingId: string) {
    const meeting = await this.getMeetingForConfirmation(meetingId);
    if (!meeting) return undefined;
    const rows = await db.select({ discordUserId: clientIdentities.subjectId })
      .from(meetingParticipants)
      .innerJoin(users, eq(users.memberId, meetingParticipants.memberId))
      .innerJoin(clientIdentities, and(eq(clientIdentities.userId, users.id), eq(clientIdentities.client, "discord")))
      .where(eq(meetingParticipants.meetingId, meetingId));
    const event = await db.query.calendarEvents.findFirst({ where: eq(calendarEvents.meetingId, meetingId) });
    return { meeting, discordUserIds: [...new Set(rows.map((row) => row.discordUserId))], htmlLink: event?.htmlLink };
  }

  async upsertIntegrationPeople(input: { integrationId: string; people: Array<{ subjectId: string; displayName: string }> }) {
    if (!input.people.length) return [];
    return db.transaction(async (tx) => {
      const integration = await tx.query.organizationClientIntegrations.findFirst({ where: eq(organizationClientIntegrations.id, input.integrationId) });
      if (!integration || integration.status !== "active") throw new Error("This client integration is unavailable.");
      const resolved: Array<{ id: string; displayName: string }> = [];
      for (const candidate of input.people) {
        const existing = (await tx.select({ person: organizationPeople }).from(integrationIdentities)
          .innerJoin(organizationPeople, eq(organizationPeople.id, integrationIdentities.personId))
          .where(and(eq(integrationIdentities.integrationId, input.integrationId), eq(integrationIdentities.externalSubjectId, candidate.subjectId))))[0]?.person;
        let person = existing;
        if (!person) {
          [person] = await tx.insert(organizationPeople).values({ organizationId: integration.organizationId, displayName: candidate.displayName }).returning();
          if (!person) throw new Error("Unable to create organization person.");
          await tx.insert(integrationIdentities).values({ integrationId: input.integrationId, personId: person.id, externalSubjectId: candidate.subjectId });
        } else if (candidate.displayName && person.displayName !== candidate.displayName) {
          [person] = await tx.update(organizationPeople).set({ displayName: candidate.displayName, updatedAt: new Date() }).where(eq(organizationPeople.id, person.id)).returning();
        }
        if (person) resolved.push({ id: person.id, displayName: person.displayName });
      }
      return resolved;
    });
  }

  async createTeam(input: { organizationId: string; createdByPersonId: string; name: string; personIds: string[] }) {
    if (!input.personIds.length) throw new Error("A team must contain at least one person.");
    return db.transaction(async (tx) => {
      const creator = await tx.query.organizationPeople.findFirst({ where: and(eq(organizationPeople.id, input.createdByPersonId), eq(organizationPeople.organizationId, input.organizationId), eq(organizationPeople.status, "active")) });
      if (!creator) throw new Error("Only an active organization person can create a team.");
      const people = await tx.select({ id: organizationPeople.id }).from(organizationPeople).where(and(eq(organizationPeople.organizationId, input.organizationId), inArray(organizationPeople.id, [...new Set(input.personIds)]), eq(organizationPeople.status, "active")));
      if (people.length !== new Set(input.personIds).size) throw new Error("Every team member must belong to this organization.");
      const [team] = await tx.insert(teams).values({ organizationId: input.organizationId, createdByPersonId: input.createdByPersonId, name: input.name.trim() }).returning();
      if (!team) throw new Error("Unable to create team.");
      await tx.insert(teamMembers).values(people.map((person) => ({ teamId: team.id, personId: person.id })));
      return asTeam(team);
    });
  }

  async listTeams(organizationId: string) {
    const rows = await db.select().from(teams).where(eq(teams.organizationId, organizationId)).orderBy(teams.name);
    return rows.map(asTeam);
  }

  async getTeam(input: { organizationId: string; teamId: string }) {
    const row = await db.query.teams.findFirst({ where: and(eq(teams.id, input.teamId), eq(teams.organizationId, input.organizationId)) });
    return row ? asTeam(row) : undefined;
  }

  async getTeamPeople(input: { organizationId: string; teamId: string }) {
    return db.select({ id: organizationPeople.id, displayName: organizationPeople.displayName }).from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .innerJoin(organizationPeople, eq(organizationPeople.id, teamMembers.personId))
      .where(and(eq(teamMembers.teamId, input.teamId), eq(teams.organizationId, input.organizationId), eq(organizationPeople.status, "active")));
  }

  /** Resolve a reusable internal team back to the client identities needed by
   * a concrete connector. The team itself stays client-neutral; only this
   * boundary knows that a Discord planning picker needs Discord subject IDs. */
  async getIntegrationPeople(input: { integrationId: string; personIds: string[] }) {
    if (!input.personIds.length) return [];
    return db.select({
      personId: organizationPeople.id,
      displayName: organizationPeople.displayName,
      subjectId: integrationIdentities.externalSubjectId,
    }).from(integrationIdentities)
      .innerJoin(organizationPeople, eq(organizationPeople.id, integrationIdentities.personId))
      .where(and(
        eq(integrationIdentities.integrationId, input.integrationId),
        inArray(integrationIdentities.personId, [...new Set(input.personIds)]),
        eq(organizationPeople.status, "active"),
      ));
  }

  async addTeamMembers(input: { teamId: string; createdByPersonId: string; personIds: string[] }) {
    if (!input.personIds.length) return [];
    return db.transaction(async (tx) => {
      const team = await tx.query.teams.findFirst({ where: and(eq(teams.id, input.teamId), eq(teams.createdByPersonId, input.createdByPersonId)) });
      if (!team) throw new Error("Only the team creator can edit this team.");
      const people = await tx.select({ id: organizationPeople.id }).from(organizationPeople).where(and(eq(organizationPeople.organizationId, team.organizationId), inArray(organizationPeople.id, [...new Set(input.personIds)]), eq(organizationPeople.status, "active")));
      if (people.length !== new Set(input.personIds).size) throw new Error("Every team member must belong to this organization.");
      await tx.insert(teamMembers).values(people.map((person) => ({ teamId: team.id, personId: person.id }))).onConflictDoNothing();
      await tx.update(teams).set({ updatedAt: new Date() }).where(eq(teams.id, team.id));
      return this.getTeamPeople({ organizationId: team.organizationId, teamId: team.id });
    });
  }

  async createTaskDraft(input: { organizationId: string; createdByPersonId: string; sourceIntegrationId: string; title: string; description?: string; timeZone: string }) {
    return db.transaction(async (tx) => {
      const creator = await tx.query.organizationPeople.findFirst({ where: and(eq(organizationPeople.id, input.createdByPersonId), eq(organizationPeople.organizationId, input.organizationId), eq(organizationPeople.status, "active")) });
      const integration = await tx.query.organizationClientIntegrations.findFirst({ where: and(eq(organizationClientIntegrations.id, input.sourceIntegrationId), eq(organizationClientIntegrations.organizationId, input.organizationId), eq(organizationClientIntegrations.status, "active")) });
      if (!creator || !integration || integration.kind === "web") throw new Error("Tasks must be created from an active notification-capable client.");
      const [task] = await tx.insert(tasks).values({ organizationId: input.organizationId, createdByPersonId: input.createdByPersonId, sourceIntegrationId: input.sourceIntegrationId, title: input.title.trim(), description: input.description?.trim() || null, timeZone: input.timeZone }).returning();
      if (!task) throw new Error("Unable to create task draft.");
      return asTask(task);
    });
  }

  async getTask(taskId: string) {
    const row = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    return row ? asTask(row) : undefined;
  }

  async getTaskForCreator(input: { taskId: string; creatorPersonId: string }) {
    const row = await db.query.tasks.findFirst({ where: and(eq(tasks.id, input.taskId), eq(tasks.createdByPersonId, input.creatorPersonId)) });
    return row ? asTask(row) : undefined;
  }

  async getTaskAssignments(taskId: string) {
    const rows = await db.select({ assignment: taskAssignments, person: organizationPeople }).from(taskAssignments)
      .innerJoin(organizationPeople, eq(organizationPeople.id, taskAssignments.personId))
      .where(eq(taskAssignments.taskId, taskId)).orderBy(organizationPeople.displayName);
    return rows.map((row) => ({ assignment: asTaskAssignment(row.assignment), person: { id: row.person.id, displayName: row.person.displayName } }));
  }

  async updateTask(input: { taskId: string; creatorPersonId: string; title?: string; description?: string | null; dueAt?: Date | null }) {
    return db.transaction(async (tx) => {
      const existing = await tx.query.tasks.findFirst({ where: and(eq(tasks.id, input.taskId), eq(tasks.createdByPersonId, input.creatorPersonId)) });
      if (!existing || existing.status === "completed" || existing.status === "cancelled") throw new Error("Only the task creator can edit an active task.");
      const patch: Record<string, unknown> = { revision: existing.revision + 1, updatedAt: new Date() };
      if (input.title !== undefined) patch.title = input.title.trim();
      if (input.description !== undefined) patch.description = input.description?.trim() || null;
      if (input.dueAt !== undefined) patch.dueAt = input.dueAt;
      const [updated] = await tx.update(tasks).set(patch).where(eq(tasks.id, existing.id)).returning();
      if (!updated) throw new Error("Unable to update task.");
      const outboxEventsCreated = updated.status === "open" ? await this.rescheduleOpenAssignments(tx, updated.id, updated.organizationId) : [];
      return { task: asTask(updated), outboxEvents: outboxEventsCreated };
    });
  }

  async addTaskAssignments(input: { taskId: string; creatorPersonId: string; personIds: string[] }) {
    if (!input.personIds.length) return { assignments: [], outboxEvents: [] as PendingOutboxEvent[] };
    return db.transaction(async (tx) => {
      const task = await tx.query.tasks.findFirst({ where: and(eq(tasks.id, input.taskId), eq(tasks.createdByPersonId, input.creatorPersonId)) });
      if (!task || task.status === "completed" || task.status === "cancelled") throw new Error("Only the task creator can change an active task audience.");
      const ids = [...new Set(input.personIds)];
      const people = await tx.select({ id: organizationPeople.id }).from(organizationPeople).where(and(eq(organizationPeople.organizationId, task.organizationId), inArray(organizationPeople.id, ids), eq(organizationPeople.status, "active")));
      if (people.length !== ids.length) throw new Error("Every assignee must belong to this organization.");
      const inserted = await tx.insert(taskAssignments).values(people.map((person) => ({ taskId: task.id, personId: person.id }))).onConflictDoNothing().returning();
      const outboxEventsCreated: PendingOutboxEvent[] = [];
      if (task.status === "open" && task.dueAt) {
        for (const assignment of inserted) outboxEventsCreated.push(...await this.emitTaskReminder(tx, task, assignment));
      }
      return { assignments: inserted.map(asTaskAssignment), outboxEvents: outboxEventsCreated };
    });
  }

  async removeTaskAssignment(input: { taskId: string; creatorPersonId: string; personId: string }) {
    return db.transaction(async (tx) => {
      const task = await tx.query.tasks.findFirst({ where: and(eq(tasks.id, input.taskId), eq(tasks.createdByPersonId, input.creatorPersonId)) });
      if (!task || task.status === "completed" || task.status === "cancelled") throw new Error("Only the task creator can change an active task audience.");
      const assignments = await tx.select().from(taskAssignments).where(eq(taskAssignments.taskId, task.id));
      if (assignments.length <= 1 && assignments.some((assignment) => assignment.personId === input.personId)) throw new Error("A task must retain at least one assignee.");
      await tx.delete(taskAssignments).where(and(eq(taskAssignments.taskId, task.id), eq(taskAssignments.personId, input.personId)));
    });
  }

  async activateTask(input: { taskId: string; creatorPersonId: string }) {
    return db.transaction(async (tx) => {
      const task = await tx.query.tasks.findFirst({ where: and(eq(tasks.id, input.taskId), eq(tasks.createdByPersonId, input.creatorPersonId), eq(tasks.status, "draft")) });
      if (!task) throw new Error("Only the task creator can activate this draft.");
      const assignments = await tx.select().from(taskAssignments).where(eq(taskAssignments.taskId, task.id));
      if (!assignments.length) throw new Error("Add at least one assignee before creating this task.");
      const [updated] = await tx.update(tasks).set({ status: "open", revision: task.revision + 1, updatedAt: new Date() }).where(eq(tasks.id, task.id)).returning();
      if (!updated) throw new Error("Unable to activate task.");
      const outboxEventsCreated: PendingOutboxEvent[] = [];
      if (updated.dueAt) for (const assignment of assignments) outboxEventsCreated.push(...await this.emitTaskReminder(tx, updated, assignment));
      return { task: asTask(updated), outboxEvents: outboxEventsCreated };
    });
  }

  async completeTaskAssignment(input: { assignmentId: string; personId: string }) {
    return db.transaction(async (tx) => {
      const [assignment] = await tx.update(taskAssignments).set({ status: "completed", completedAt: new Date(), reminderRevision: drizzleSql`${taskAssignments.reminderRevision} + 1`, updatedAt: new Date() })
        .where(and(eq(taskAssignments.id, input.assignmentId), eq(taskAssignments.personId, input.personId), eq(taskAssignments.status, "open"))).returning();
      if (!assignment) throw new Error("Only the assignee can mark this task done.");
      const remaining = await tx.select({ id: taskAssignments.id }).from(taskAssignments).where(and(eq(taskAssignments.taskId, assignment.taskId), eq(taskAssignments.status, "open")));
      if (!remaining.length) await tx.update(tasks).set({ status: "completed", updatedAt: new Date(), revision: drizzleSql`${tasks.revision} + 1` }).where(eq(tasks.id, assignment.taskId));
      return asTaskAssignment(assignment);
    });
  }

  async cancelTask(input: { taskId: string; creatorPersonId: string }) {
    const [task] = await db.update(tasks).set({ status: "cancelled", revision: drizzleSql`${tasks.revision} + 1`, updatedAt: new Date() })
      .where(and(eq(tasks.id, input.taskId), eq(tasks.createdByPersonId, input.creatorPersonId), inArray(tasks.status, ["draft", "open"]))).returning();
    if (!task) throw new Error("Only the task creator can cancel an active task.");
    return asTask(task);
  }

  async setPersonTaskReminderPreference(input: { personId: string; defaultPolicy: TaskReminderPolicy }) {
    return db.transaction(async (tx) => {
      await tx.insert(personTaskReminderPreferences).values({ personId: input.personId, defaultPolicy: input.defaultPolicy, updatedAt: new Date() })
        .onConflictDoUpdate({ target: personTaskReminderPreferences.personId, set: { defaultPolicy: input.defaultPolicy, updatedAt: new Date() } });
      const rows = await tx.select({ assignment: taskAssignments, task: tasks }).from(taskAssignments).innerJoin(tasks, eq(tasks.id, taskAssignments.taskId))
        .where(and(eq(taskAssignments.personId, input.personId), isNull(taskAssignments.reminderPolicyOverride), eq(taskAssignments.status, "open"), eq(tasks.status, "open")));
      const outboxEventsCreated: PendingOutboxEvent[] = [];
      for (const row of rows) {
        const [assignment] = await tx.update(taskAssignments).set({ reminderRevision: drizzleSql`${taskAssignments.reminderRevision} + 1`, updatedAt: new Date() }).where(eq(taskAssignments.id, row.assignment.id)).returning();
        if (assignment && row.task.dueAt) outboxEventsCreated.push(...await this.emitTaskReminder(tx, row.task, assignment));
      }
      return outboxEventsCreated;
    });
  }

  async setTaskAssignmentReminderOverride(input: { assignmentId: string; personId: string; policy?: TaskReminderPolicy }) {
    return db.transaction(async (tx) => {
      const [assignment] = await tx.update(taskAssignments).set({ reminderPolicyOverride: input.policy ?? null, reminderRevision: drizzleSql`${taskAssignments.reminderRevision} + 1`, updatedAt: new Date() })
        .where(and(eq(taskAssignments.id, input.assignmentId), eq(taskAssignments.personId, input.personId), eq(taskAssignments.status, "open"))).returning();
      if (!assignment) throw new Error("Only the assignee can change this reminder.");
      const task = await tx.query.tasks.findFirst({ where: eq(tasks.id, assignment.taskId) });
      const outboxEventsCreated = task?.status === "open" && task.dueAt ? await this.emitTaskReminder(tx, task, assignment) : [];
      return { assignment: asTaskAssignment(assignment), outboxEvents: outboxEventsCreated };
    });
  }

  async loadTaskReminder(assignmentId: string) {
    const rows = await db.select({ assignment: taskAssignments, task: tasks, preference: personTaskReminderPreferences, integration: organizationClientIntegrations, identity: integrationIdentities })
      .from(taskAssignments)
      .innerJoin(tasks, eq(tasks.id, taskAssignments.taskId))
      .innerJoin(organizationClientIntegrations, eq(organizationClientIntegrations.id, tasks.sourceIntegrationId))
      .leftJoin(personTaskReminderPreferences, eq(personTaskReminderPreferences.personId, taskAssignments.personId))
      .leftJoin(integrationIdentities, and(eq(integrationIdentities.integrationId, tasks.sourceIntegrationId), eq(integrationIdentities.personId, taskAssignments.personId)))
      .where(eq(taskAssignments.id, assignmentId));
    const row = rows[0];
    if (!row) return undefined;
    return {
      task: asTask(row.task),
      assignment: asTaskAssignment(row.assignment),
      defaultPolicy: row.preference?.defaultPolicy ?? "daily_until_done" as TaskReminderPolicy,
      client: row.integration.kind as "discord" | "slack" | "web",
      recipientSubjectId: row.identity?.externalSubjectId,
    };
  }

  async recordTaskReminderDelivery(input: { assignmentId: string; integrationId: string; reminderRevision: number; scheduledFor: Date; status: "sent" | "failed" | "skipped"; error?: string }) {
    await db.insert(taskReminderDeliveries).values({ ...input, error: input.error ?? null }).onConflictDoUpdate({
      target: [taskReminderDeliveries.assignmentId, taskReminderDeliveries.reminderRevision, taskReminderDeliveries.scheduledFor],
      set: { status: input.status, error: input.error ?? null, integrationId: input.integrationId },
    });
  }

  async listTasksForPerson(input: { organizationId: string; personId: string; includeCompleted?: boolean }) {
    const rows = await db.select({ task: tasks, assignment: taskAssignments, creator: organizationPeople }).from(taskAssignments)
      .innerJoin(tasks, eq(tasks.id, taskAssignments.taskId))
      .innerJoin(organizationPeople, eq(organizationPeople.id, tasks.createdByPersonId))
      .where(and(eq(tasks.organizationId, input.organizationId), eq(taskAssignments.personId, input.personId), input.includeCompleted ? drizzleSql`true` : eq(taskAssignments.status, "open")))
      .orderBy(tasks.dueAt, tasks.createdAt);
    return Promise.all(rows.map(async (row) => {
      const latest = (await db.select().from(taskReminderDeliveries).where(eq(taskReminderDeliveries.assignmentId, row.assignment.id)).orderBy(drizzleSql`${taskReminderDeliveries.createdAt} desc`).limit(1))[0];
      return { task: asTask(row.task), assignment: asTaskAssignment(row.assignment), creatorName: row.creator.displayName, latestDelivery: latest ? { status: latest.status, error: latest.error ?? undefined, scheduledFor: latest.scheduledFor } : undefined };
    }));
  }

  /** Creator-facing task view. It deliberately includes every assignee's most
   * recent delivery outcome so the person responsible for a task can spot a
   * blocked DM without needing to be assigned to that task themselves. */
  async listTasksCreatedBy(input: { organizationId: string; personId: string; includeCompleted?: boolean }) {
    const rows = await db.select().from(tasks)
      .where(and(
        eq(tasks.organizationId, input.organizationId),
        eq(tasks.createdByPersonId, input.personId),
        input.includeCompleted ? inArray(tasks.status, ["draft", "open", "completed"]) : inArray(tasks.status, ["draft", "open"]),
      ))
      .orderBy(tasks.dueAt, tasks.createdAt);
    return Promise.all(rows.map(async (task) => {
      const assignments = await this.getTaskAssignments(task.id);
      const assignmentViews = await Promise.all(assignments.map(async (entry) => {
        const latest = (await db.select().from(taskReminderDeliveries)
          .where(eq(taskReminderDeliveries.assignmentId, entry.assignment.id))
          .orderBy(drizzleSql`${taskReminderDeliveries.createdAt} desc`)
          .limit(1))[0];
        return {
          ...entry,
          latestDelivery: latest ? { status: latest.status, error: latest.error ?? undefined, scheduledFor: latest.scheduledFor } : undefined,
        };
      }));
      return { task: asTask(task), assignments: assignmentViews };
    }));
  }

  private async rescheduleOpenAssignments(tx: any, taskId: string, organizationId: string) {
    const assignments = await tx.select().from(taskAssignments).where(and(eq(taskAssignments.taskId, taskId), eq(taskAssignments.status, "open")));
    const task = await tx.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    if (!task) return [] as PendingOutboxEvent[];
    const outboxEventsCreated: PendingOutboxEvent[] = [];
    for (const current of assignments) {
      const [assignment] = await tx.update(taskAssignments).set({ reminderRevision: drizzleSql`${taskAssignments.reminderRevision} + 1`, updatedAt: new Date() }).where(eq(taskAssignments.id, current.id)).returning();
      if (assignment && task.dueAt) outboxEventsCreated.push(...await this.emitTaskReminder(tx, task, assignment));
    }
    return outboxEventsCreated;
  }

  private async emitTaskReminder(tx: any, task: typeof tasks.$inferSelect, assignment: typeof taskAssignments.$inferSelect) {
    const [event] = await tx.insert(outboxEvents).values({ organizationId: task.organizationId, type: "task.assignment_reminder_requested", aggregateId: assignment.id, expectedVersion: assignment.reminderRevision, payload: {} }).onConflictDoNothing().returning();
    return event ? [asPendingOutboxEvent(event)] : [];
  }

  async completeJob(jobId: string) {
    await db.update(jobs).set({ status: "succeeded", leaseExpiresAt: null }).where(eq(jobs.id, jobId));
  }

  async failJob(jobId: string, error: string) {
    await db.update(jobs).set({ status: "failed", lastError: error, leaseExpiresAt: null }).where(eq(jobs.id, jobId));
  }
}
