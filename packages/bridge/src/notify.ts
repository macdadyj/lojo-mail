import { execFile } from "node:child_process";

export type Notifier = (summary: string, body: string) => void;

/** Best effort: no notification daemon, no problem. */
export const desktopNotifier: Notifier = (summary, body) => {
  try {
    const child = execFile("notify-send", ["--app-name=lojo-mail", "--urgency=normal", summary, body], { shell: false, timeout: 5_000 }, () => {});
    child.on("error", () => {});
  } catch {
    return;
  }
};
