const applicationId = required("DISCORD_APPLICATION_ID");
const token = required("DISCORD_BOT_TOKEN");

const commands = [
  { name: "setup", description: "Set up the coordinator for this server", default_member_permissions: "0" },
  { name: "profile", description: "Manage your invite email and availability" },
  { name: "settings", description: "Open organization settings" },
  {
    name: "meet", description: "Plan or manage a meeting", options: [
      { type: 1, name: "plan", description: "Open the interactive meeting planner" },
      { type: 1, name: "reschedule", description: "Reschedule an existing meeting" },
      { type: 1, name: "cancel", description: "Cancel an existing meeting" },
    ],
  },
  {
    name: "provider", description: "Configure room providers", options: [
      { type: 1, name: "list", description: "List supported provider status" },
      { type: 1, name: "configure", description: "Configure eLab / OnceHub" },
      { type: 1, name: "disable", description: "Disable eLab / OnceHub" },
    ],
  },
  {
    name: "task", description: "Create and manage organization tasks", options: [
      { type: 1, name: "create", description: "Create a task" },
      { type: 1, name: "list", description: "List your open tasks" },
      { type: 1, name: "preferences", description: "Set your task reminder defaults" },
    ],
  },
  {
    name: "team", description: "Create and view saved teams", options: [
      { type: 1, name: "create", description: "Create a reusable saved team" },
      { type: 1, name: "list", description: "List saved teams" },
    ],
  },
];

const response = await fetch(`https://discord.com/api/v10/applications/${applicationId}/commands`, {
  method: "PUT",
  headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify(commands),
});
if (!response.ok) throw new Error(await response.text());
console.log("Discord commands registered.");

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
