export type LogLevel = "info" | "warn" | "error";

/** Values are ids, counts, and status codes. Never tokens, passwords, addresses, or message content. */
export type LogFields = Record<string, string | number | boolean | undefined>;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export function jsonLogger(write: (line: string) => void = (line) => process.stderr.write(line)): Logger {
  const emit = (level: LogLevel, event: string, fields: LogFields = {}) => {
    write(`${JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields })}\n`);
  };
  return {
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
  };
}

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : "unknown error";
}
