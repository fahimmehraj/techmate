type LogFields = Record<string, unknown>;

function write(level: "info" | "warn" | "error", service: string, event: string, fields: LogFields = {}) {
  const entry = JSON.stringify({
    at: new Date().toISOString(),
    level,
    service,
    event,
    ...fields,
  });
  if (level === "error") console.error(entry);
  else if (level === "warn") console.warn(entry);
  else console.info(entry);
}

export function workflowLog(service: string, event: string, fields?: LogFields) {
  write("info", service, event, fields);
}

export function workflowWarn(service: string, event: string, fields?: LogFields) {
  write("warn", service, event, fields);
}

export function workflowError(service: string, event: string, error: unknown, fields?: LogFields) {
  const details = error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { name: "UnknownError", message: String(error) };
  write("error", service, event, { ...fields, error: details });
}
