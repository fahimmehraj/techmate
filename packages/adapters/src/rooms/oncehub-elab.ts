import type { RoomProvider, RoomProviderDescriptor } from "@technyu/application";
import type { OrganizationProviderInstallation, RoomCandidate } from "@technyu/core";
import { chromium } from "playwright";

const url = "https://go.oncehub.com/NYULeslie";
const rooms = [
  { id: "pre-money", name: "Pre-money conference room", capacity: 12 },
  { id: "lean-launchpad", name: "Lean/Launchpad", capacity: 50 },
] as const;

export const onceHubElabDescriptor: RoomProviderDescriptor = {
  id: "elab-oncehub",
  label: "NYU Leslie eLab (OnceHub)",
  organizationFields: [
    { key: "firstName", label: "Requester first name", source: "organization", required: true },
    { key: "lastName", label: "Requester last name", source: "organization", required: true },
    { key: "nyuEmail", label: "Requester NYU email", source: "organization", required: true },
    { key: "netId", label: "Requester NetID", source: "organization", required: true },
    { key: "affiliation", label: "NYU affiliation", source: "organization", required: true },
    { key: "school", label: "NYU school", source: "organization", required: true },
    { key: "organizationName", label: "Organization name", source: "organization", required: true },
    { key: "graduationYear", label: "Expected graduation year", source: "organization", required: false },
  ],
};

/** Browser adapter ported from event_organizer/elab_scrape. It only runs in room-worker. */
export class OnceHubElabRoomProvider implements RoomProvider {
  readonly id = onceHubElabDescriptor.id;
  readonly descriptor = onceHubElabDescriptor;

  validateOrganizationValues(values: Record<string, string>) {
    const normalized = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.trim()]));
    for (const field of this.descriptor.organizationFields) if (field.required && !normalized[field.key]) throw new Error(`${field.label} is required.`);
    if (!/^\S+@nyu\.edu$/i.test(normalized.nyuEmail ?? "")) throw new Error("Requester NYU email must end in @nyu.edu.");
    return normalized;
  }

  async search(input: { installation: OrganizationProviderInstallation; time: { startsAt: Date; endsAt: Date }; requirement: { attendeeCount: number } }): Promise<RoomCandidate[]> {
    this.validateOrganizationValues(input.installation.values);
    const durationMinutes = Math.round((input.time.endsAt.getTime() - input.time.startsAt.getTime()) / 60_000);
    const browser = await chromium.launch({ headless: true });
    try {
      const available: RoomCandidate[] = [];
      for (const room of rooms.filter((candidate) => candidate.capacity >= input.requirement.attendeeCount)) {
        const page = await browser.newPage();
        try {
          await selectRoomAndDuration(page, room.name, durationMinutes);
          const slot = await findSlot(page, input.time.startsAt);
          if (slot) available.push({ providerId: this.id, externalRoomId: room.id, name: room.name, capacity: room.capacity, availability: "available", observedAt: new Date(), bookingUrl: url });
        } finally { await page.close(); }
      }
      return available;
    } finally { await browser.close(); }
  }

  async submit(input: { installation: OrganizationProviderInstallation; booking: { room?: RoomCandidate }; meeting: { title: string; time: { startsAt: Date; endsAt: Date }; attendeeCount: number } }) {
    const values = this.validateOrganizationValues(input.installation.values);
    const room = input.booking.room;
    if (!room) throw new Error("Select an eLab room before submitting.");
    const duration = Math.round((input.meeting.time.endsAt.getTime() - input.meeting.time.startsAt.getTime()) / 60_000);
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await selectRoomAndDuration(page, room.name, duration);
      const slot = await findSlot(page, input.meeting.time.startsAt);
      if (!slot) throw new Error("The selected OnceHub time is no longer available.");
      await slot.click();
      const continueButton = page.getByRole("button", { name: "Continue" });
      if (await continueButton.count() !== 1) throw new Error("OnceHub did not show its booking form.");
      await continueButton.click();
      await page.locator("input#1_val_system").fill(input.meeting.title);
      await page.locator("input#2_val_system").fill(values.firstName!);
      await page.locator("input#60168_val").fill(values.lastName!);
      await page.locator("input#3_val_system").fill(values.nyuEmail!);
      await page.locator("input#15400_val").fill(values.netId!);
      await fillAngularChoice(page, "#input_10636_val", values.affiliation!);
      await fillAngularChoice(page, "#input_10637_val", values.school!);
      await page.locator("input#10734_val").fill(input.meeting.title);
      await page.locator("input#10735_val").fill(values.organizationName!);
      await page.locator("input#10737_val").fill(String(input.meeting.attendeeCount));
      if (values.graduationYear) await page.locator("input#57698_val").fill(values.graduationYear);
      const done = page.getByRole("button", { name: "Done" });
      if (await done.count() !== 1) throw new Error("OnceHub booking form is incomplete or changed.");
      await done.click();
      await page.waitForLoadState("networkidle");
      return { reference: await page.title() };
    } finally { await browser.close(); }
  }
}

async function selectRoomAndDuration(page: import("playwright").Page, roomName: string, duration: number) {
  await page.goto(url, { waitUntil: "networkidle" });
  const room = page.getByText(roomName, { exact: false });
  if (await room.count() !== 1) throw new Error(`OnceHub room ${roomName} was not found.`);
  await room.click();
  const durationDialog = page.locator("#durationConfirmBtn");
  if (await durationDialog.count()) {
    const index = [30, 45, 60, 75, 90, 105, 120].indexOf(duration);
    if (index < 0) throw new Error("eLab only supports booking durations from 30 to 120 minutes in 15-minute increments.");
    await page.locator("#input_meeting_duration").click();
    await page.locator(`#li_meeting_duration_${index}`).click();
    await durationDialog.click();
  }
}

async function findSlot(page: import("playwright").Page, start: Date) {
  const dateLabel = start.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "America/New_York" });
  const day = page.getByRole("button", { name: `Show available time slots for ${dateLabel}` });
  if (await day.count() !== 1) return undefined;
  await day.click();
  const time = start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
  const slot = page.getByRole("button", { name: time });
  return await slot.count() === 1 ? slot : undefined;
}

async function fillAngularChoice(page: import("playwright").Page, selector: string, value: string) {
  const input = page.locator(selector);
  await input.fill(value);
  const option = page.getByText(value, { exact: true });
  if (await option.count() !== 1) throw new Error(`OnceHub no longer offers ${value}.`);
  await option.click();
}
