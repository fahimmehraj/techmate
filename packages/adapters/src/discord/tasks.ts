import { buttonRow, prompt } from "./responses.ts";

type TeamOption = { id: string; name: string };
type AssignmentOption = { assignment: { id: string; status: string; reminderPolicyOverride?: string }; person: { displayName: string } };

export function taskAudienceSelect(taskId: string) {
  return {
    type: 1,
    components: [{ type: 7, custom_id: `task-audience:${taskId}`, placeholder: "Add Discord users or roles", min_values: 1, max_values: 25 }],
  };
}

export function savedTeamSelect(customId: string, teams: TeamOption[]) {
  if (!teams.length) return undefined;
  return {
    type: 1,
    components: [{
      type: 3,
      custom_id: customId,
      placeholder: "Add a saved team",
      min_values: 1,
      max_values: 1,
      options: teams.slice(0, 25).map((team) => ({ label: team.name.slice(0, 100), value: team.id })),
    }],
  };
}

export function taskComposer(input: { task: { id: string; title: string; description?: string; dueAt?: Date; status: string; timeZone: string }; assignments: AssignmentOption[]; teams: TeamOption[] }) {
  const due = input.task.dueAt?.toLocaleString("en-US", { timeZone: input.task.timeZone, dateStyle: "medium", timeStyle: "short" }) ?? "No due date";
  const assignees = input.assignments.length ? input.assignments.map(({ person, assignment }) => `${person.displayName}${assignment.status === "completed" ? " ✓" : ""}`).join(", ") : "None yet";
  return prompt(
    `**${input.task.title}**\n${input.task.description ?? "No description."}\nDue: ${due}\nAssignees: ${assignees}\nStatus: ${input.task.status}`,
    [
      taskAudienceSelect(input.task.id),
      savedTeamSelect(`task-team:${input.task.id}`, input.teams),
      buttonRow(
        { customId: `task-due:${input.task.id}:0`, label: "Set due date" },
        { customId: `task-edit:${input.task.id}`, label: "Edit details", style: 2 },
        ...(input.task.status === "draft" ? [{ customId: `task-activate:${input.task.id}`, label: "Create task", style: 3 }] : []),
        { customId: `task-cancel:${input.task.id}`, label: "Cancel task", style: 4 },
      ),
      buttonRow({ customId: "task-back", label: "Back to task list", style: 2 }),
    ],
  );
}

export function taskListSelect(entries: Array<{ task: { id: string; title: string; dueAt?: Date; timeZone: string }; assignment: { id: string; status: string } }>) {
  if (!entries.length) return undefined;
  return {
    type: 1,
    components: [{
      type: 3,
      custom_id: "task-select",
      placeholder: "Open a task",
      min_values: 1,
      max_values: 1,
      options: entries.slice(0, 25).map(({ task, assignment }) => ({
        label: task.title.slice(0, 100),
        description: task.dueAt ? `Due ${task.dueAt.toLocaleDateString("en-US", { timeZone: task.timeZone })}` : "No due date",
        value: assignment.id,
      })),
    }],
  };
}

export function reminderPolicySelect(customId: string, selected?: string) {
  return {
    type: 1,
    components: [{
      type: 3,
      custom_id: customId,
      placeholder: "Choose reminder behavior",
      min_values: 1,
      max_values: 1,
      options: [
        ["default", "Use my default"],
        ["daily_until_done", "Daily until done"],
        ["one_day_before", "One day before due"],
        ["one_hour_before", "One hour before due"],
        ["none", "No reminders"],
      ].map(([value, label]) => ({ value, label, default: value === selected })),
    }],
  };
}

export function teamListSelect(teams: TeamOption[]) {
  if (!teams.length) return undefined;
  return {
    type: 1,
    components: [{
      type: 3,
      custom_id: "team-select",
      placeholder: "Open a saved team",
      min_values: 1,
      max_values: 1,
      options: teams.slice(0, 25).map((team) => ({ label: team.name.slice(0, 100), value: team.id })),
    }],
  };
}

export function dueDatePage(taskId: string, page: number, now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + page * 24);
  const options = Array.from({ length: 24 }, (_, index) => {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
    const value = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
    return { label: date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }), value };
  });
  return {
    content: "Choose a due date. Dates are shown in the organization timezone.",
    components: [
      { type: 1, components: [{ type: 3, custom_id: `task-due-date:${taskId}:${page}`, placeholder: "Choose a date", min_values: 1, max_values: 1, options }] },
      buttonRow(
        ...(page > 0 ? [{ customId: `task-due:${taskId}:${page - 1}`, label: "Earlier", style: 2 }] : []),
        { customId: `task-due:${taskId}:${page + 1}`, label: "Later", style: 2 },
        { customId: `task-clear-due:${taskId}`, label: "No due date", style: 2 },
      ),
    ],
  };
}

export function dueHourSelect(taskId: string, date: string) {
  return {
    content: `Choose a time for ${date}.`,
    components: [{
      type: 1,
      components: [{
        type: 3,
        custom_id: `task-due-hour:${taskId}:${date}`,
        placeholder: "Choose a time",
        min_values: 1,
        max_values: 1,
        options: [
          { value: "end", label: "End of day (5:00 PM)" },
          ...Array.from({ length: 24 }, (_, hour) => ({ value: String(hour), label: new Date(2000, 0, 1, hour).toLocaleTimeString("en-US", { hour: "numeric" }) })),
        ],
      }],
    }],
  };
}

export function dueMinuteSelect(taskId: string, date: string, hour: string) {
  return {
    content: `Choose minutes past ${new Date(2000, 0, 1, Number(hour)).toLocaleTimeString("en-US", { hour: "numeric" })}.`,
    components: [{ type: 1, components: [{ type: 3, custom_id: `task-due-minute:${taskId}:${date}:${hour}`, placeholder: "Choose minutes", min_values: 1, max_values: 1, options: ["00", "15", "30", "45"].map((value) => ({ value, label: `:${value}` })) }] }],
  };
}
