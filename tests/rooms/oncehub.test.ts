import { describe, expect, test } from "bun:test";
import { OnceHubElabRoomProvider } from "../../packages/adapters/src/rooms/oncehub-elab.ts";

describe("OnceHub eLab provider configuration", () => {
  const provider = new OnceHubElabRoomProvider();
  const valid = {
    firstName: "Alex", lastName: "Chen", nyuEmail: "ac1234@nyu.edu", netId: "ac1234",
    affiliation: "Undergrad", school: "Tandon", organizationName: "Tech@NYU", graduationYear: "",
  };

  test("declares only organization-owned requester fields", () => {
    expect(provider.descriptor.organizationFields.map((field) => field.key)).toEqual([
      "firstName", "lastName", "nyuEmail", "netId", "affiliation", "school", "organizationName", "graduationYear",
    ]);
  });

  test("normalizes valid configuration and requires an NYU requester email", () => {
    expect(provider.validateOrganizationValues({ ...valid, firstName: " Alex " }).firstName).toBe("Alex");
    expect(() => provider.validateOrganizationValues({ ...valid, nyuEmail: "alex@example.com" })).toThrow("@nyu.edu");
  });
});
