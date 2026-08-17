type DiscordComponent = Record<string, unknown>;
type OptionalDiscordComponent = DiscordComponent | undefined;

/** A renderable Discord prompt, independent from how the interaction began. */
export type DiscordPrompt = {
  content: string;
  components?: OptionalDiscordComponent[];
};

export const prompt = (content: string, components?: OptionalDiscordComponent[]): DiscordPrompt => ({ content, components });

export const message = (content: string, options: { ephemeral?: boolean; components?: OptionalDiscordComponent[] } = {}) => ({
  type: 4,
  data: {
    content,
    flags: options.ephemeral ? 64 : undefined,
    components: options.components?.filter((component): component is DiscordComponent => Boolean(component)),
  },
});

/** Replaces the message that supplied a component interaction. */
export const updateMessage = (content: string, components?: OptionalDiscordComponent[]) => ({
  type: 7,
  data: { content, components: components?.filter((component): component is DiscordComponent => Boolean(component)) },
});

export const initialPrompt = (view: DiscordPrompt, ephemeral = true) => message(view.content, { ephemeral, components: view.components });
export const replacePrompt = (view: DiscordPrompt) => updateMessage(view.content, view.components);

export const modal = (customId: string, title: string, components: DiscordComponent[]) => ({
  type: 9,
  data: { custom_id: customId, title, components },
});

export const textInput = (customId: string, label: string, options: { required?: boolean; placeholder?: string; style?: 1 | 2; value?: string } = {}) => ({
  type: 1,
  components: [{
    type: 4,
    custom_id: customId,
    label,
    style: options.style ?? 1,
    required: options.required ?? true,
    placeholder: options.placeholder,
    value: options.value,
  }],
});

export const buttonRow = (...buttons: Array<{ customId?: string; label: string; style?: number; url?: string }>) => ({
  type: 1,
  components: buttons.map((button) => ({
    type: 2,
    style: button.url ? 5 : (button.style ?? 1),
    custom_id: button.customId,
    label: button.label,
    url: button.url,
  })),
});

export const json = (data: unknown) => Response.json(data);
