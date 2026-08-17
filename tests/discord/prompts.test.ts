import { describe, expect, test } from "bun:test";
import { initialPrompt, prompt, replacePrompt } from "../../packages/adapters/src/discord/responses.ts";
import { taskComposer } from "../../packages/adapters/src/discord/tasks.ts";

describe("Discord prompt responses", () => {
  test("uses a source message only when starting a prompt", () => {
    const response = initialPrompt(prompt("Task draft"));
    expect(response.type).toBe(4);
    expect(response.data.flags).toBe(64);
  });

  test("updates the originating prompt for component transitions", () => {
    const response = replacePrompt(prompt("Choose a due date"));
    expect(response.type).toBe(7);
    expect(response.data.content).toBe("Choose a due date");
  });

  test("keeps task-composer navigation inside the same prompt", () => {
    const view = taskComposer({
      task: { id: "task-1", title: "Prepare demo", status: "draft", timeZone: "America/New_York" },
      assignments: [],
      teams: [],
    });
    const components = view.components ?? [];
    expect(JSON.stringify(components)).toContain("task-back");
    expect(replacePrompt(view).type).toBe(7);
  });
});
