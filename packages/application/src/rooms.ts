import type { DateTimeRange, OrganizationProviderInstallation, RoomBooking, RoomCandidate, RoomRequirement } from "@technyu/core";

export type ProviderField = {
  key: string;
  label: string;
  required: boolean;
  source: "organization" | "meeting";
  options?: readonly string[];
};

export type RoomProviderDescriptor = {
  id: string;
  label: string;
  organizationFields: readonly ProviderField[];
};

/**
 * Provider-neutral boundary for room systems. A provider may be discovery-only;
 * callers must never treat `unknown` availability as a reservation.
 */
export interface RoomProvider {
  readonly id: string;
  readonly descriptor: RoomProviderDescriptor;
  validateOrganizationValues(values: Record<string, string>): Record<string, string>;
  search(input: { installation: OrganizationProviderInstallation; time: DateTimeRange; requirement: RoomRequirement }): Promise<RoomCandidate[]>;
  submit(input: { installation: OrganizationProviderInstallation; booking: RoomBooking; meeting: { title: string; time: DateTimeRange; attendeeCount: number } }): Promise<{ reference?: string }>;
}

export interface RoomProviderRegistry {
  get(providerId: string): RoomProvider | undefined;
  list(): RoomProvider[];
}

export function rankRoomCandidates(candidates: RoomCandidate[], requirement: RoomRequirement): RoomCandidate[] {
  return [...candidates]
    .filter((room) => !room.capacity || room.capacity >= requirement.attendeeCount)
    .sort((a, b) => availabilityScore(a.availability) - availabilityScore(b.availability) || (b.capacity ?? 0) - (a.capacity ?? 0));
}

function availabilityScore(availability: RoomCandidate["availability"]) {
  return availability === "available" ? 0 : availability === "unknown" ? 1 : 2;
}
