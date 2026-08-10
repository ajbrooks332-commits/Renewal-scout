import { logger } from "./logger";
import { scanDueServices } from "./research-service";

let schedulerHandle: ReturnType<typeof setInterval> | null = null;

function msUntilNext(hour: number, minute: number, tz: string): number {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const get = (type: string) =>
    parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);
  const nowH = get("hour");
  const nowM = get("minute");
  const nowS = get("second");

  const totalNowSecs = nowH * 3600 + nowM * 60 + nowS;
  const targetSecs = hour * 3600 + minute * 60;
  let diff = targetSecs - totalNowSecs;
  if (diff <= 0) diff += 24 * 3600;
  return diff * 1000;
}

export function startScheduler(): void {
  if (!process.env["SCHEDULER_ENABLED"] || process.env["SCHEDULER_ENABLED"] === "false") {
    logger.info("Scheduler disabled via SCHEDULER_ENABLED=false");
    return;
  }

  const hour = parseInt(process.env["SCHEDULER_HOUR"] ?? "7", 10);
  const minute = parseInt(process.env["SCHEDULER_MINUTE"] ?? "30", 10);
  const tz = process.env["APP_TIMEZONE"] ?? "Europe/London";

  function scheduleNext() {
    const delay = msUntilNext(hour, minute, tz);
    logger.info(
      { nextRunMs: delay, hour, minute, tz },
      "Scheduler: next due check"
    );
    schedulerHandle = setTimeout(async () => {
      logger.info("Scheduler: running due check");
      try {
        const runIds = await scanDueServices();
        logger.info({ queued: runIds.length }, "Scheduler: due check complete");
      } catch (err) {
        logger.error({ err }, "Scheduler: due check error");
      }
      scheduleNext();
    }, delay);
  }

  scheduleNext();
}

export function stopScheduler(): void {
  if (schedulerHandle) {
    clearTimeout(schedulerHandle);
    schedulerHandle = null;
    logger.info("Scheduler stopped");
  }
}
