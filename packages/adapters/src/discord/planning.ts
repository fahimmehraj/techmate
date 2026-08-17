export type DiscordMentionableData = {
  values?: string[];
  resolved?: {
    users?: Record<string, { username?: string; global_name?: string | null }>;
    roles?: Record<string, { id?: string }>;
  };
};

export function mentionableAudienceSelect(sessionId: string) {
  return {
    type: 1,
    components: [{
      type: 7,
      custom_id: `plan-audience:${sessionId}`,
      placeholder: "Add Discord users or roles",
      min_values: 1,
      max_values: 25,
    }],
  };
}

export function extractMentionableAudience(data: DiscordMentionableData) {
  const roleIds = new Set(Object.keys(data.resolved?.roles ?? {}));
  return (data.values ?? []).map((value) => roleIds.has(value)
    ? { kind: "group" as const, id: value, displayName: value }
    : { kind: "person" as const, id: value, displayName: data.resolved?.users?.[value]?.global_name ?? data.resolved?.users?.[value]?.username ?? value });
}
