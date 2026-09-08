export class TaskboxError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "TaskboxError";
    this.code = code;
    this.details = details;
  }
}

export function invariant(condition, code, message, details = undefined) {
  if (!condition) throw new TaskboxError(code, message, details);
}
