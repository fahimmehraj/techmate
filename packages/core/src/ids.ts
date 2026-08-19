export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type OrganizationId = Brand<string, "OrganizationId">;
export type OrganizationPersonId = Brand<string, "OrganizationPersonId">;
export type OrganizationClientIntegrationId = Brand<string, "OrganizationClientIntegrationId">;
export type MeetingId = Brand<string, "MeetingId">;
export type TeamId = Brand<string, "TeamId">;
export type CandidateSlotId = Brand<string, "CandidateSlotId">;
export type ProviderInstallationId = Brand<string, "ProviderInstallationId">;
export type RoomBookingId = Brand<string, "RoomBookingId">;
export type CalendarConnectionId = Brand<string, "CalendarConnectionId">;
export type NotificationEndpointId = Brand<string, "NotificationEndpointId">;
export type NotificationEndpointBindingId = Brand<string, "NotificationEndpointBindingId">;
export type PlanningAudienceSelectionId = Brand<string, "PlanningAudienceSelectionId">;
export type JobId = Brand<string, "JobId">;
export type PlanningSessionId = Brand<string, "PlanningSessionId">;
export type PlanningAttendeeId = Brand<string, "PlanningAttendeeId">;
export type TaskId = Brand<string, "TaskId">;
export type TaskAssignmentId = Brand<string, "TaskAssignmentId">;
export type EmailAddress = Brand<string, "EmailAddress">;

export const id = <T extends string>(value: string) => value as Brand<string, T>;
export const email = (value: string) => value.trim().toLowerCase() as EmailAddress;
