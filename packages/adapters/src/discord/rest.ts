function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function discordApi(path: string, init: RequestInit) {
  const response = await fetch(`https://discord.com/api/v10${path}`, {
    ...init,
    headers: {
      Authorization: `Bot ${required("DISCORD_BOT_TOKEN")}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(`Discord API request failed: ${await response.text()}`);
  return response;
}

export async function sendDiscordDm(discordUserId: string, content: string, components?: unknown[]) {
  const channel = await discordApi("/users/@me/channels", { method: "POST", body: JSON.stringify({ recipient_id: discordUserId }) });
  const payload = await channel.json() as { id: string };
  await discordApi(`/channels/${payload.id}/messages`, { method: "POST", body: JSON.stringify({ content, components }) });
}

export async function sendDiscordChannelMessage(channelId: string, content: string, components?: unknown[]) {
  await discordApi(`/channels/${channelId}/messages`, { method: "POST", body: JSON.stringify({ content, components }) });
}

/** Requires Discord's Server Members intent for complete role resolution. */
export async function listDiscordUsersWithRole(guildId: string, roleId: string): Promise<string[]> {
  return (await listDiscordPeopleWithRole(guildId, roleId)).map((person) => person.id);
}

/** Requires Discord's Server Members intent for complete role resolution. */
export async function listDiscordPeopleWithRole(guildId: string, roleId: string): Promise<Array<{ id: string; displayName: string }>> {
  const people: Array<{ id: string; displayName: string }> = [];
  let after: string | undefined;
  do {
    const suffix = new URLSearchParams({ limit: "1000", ...(after ? { after } : {}) });
    const response = await discordApi(`/guilds/${guildId}/members?${suffix}`, { method: "GET" });
    const members = await response.json() as Array<{ user: { id: string; username?: string; global_name?: string | null }; roles: string[] }>;
    const matching = members.filter((member) => member.roles.includes(roleId));
    people.push(...matching.map((member) => ({ id: member.user.id, displayName: member.user.global_name ?? member.user.username ?? member.user.id })));
    after = members.at(-1)?.user.id;
    if (members.length < 1000) break;
  } while (after);
  return people;
}
