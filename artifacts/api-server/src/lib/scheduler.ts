import { logger } from "./logger";
import { scanDueServices } from "./research-service";

let schedulerHandle: ReturnType<typeof setTimeout> | null = null;

/**
 * Strict SCHEDULER_ENABLED check.
 * Only the case-insensitive string "true" enables the scheduler.
 * "1", "yes", "TRUE", unset, or any other value disables it.
 */
export function isSchedulerEnabled(): boolean {
  return (process.env["SCHEDULER_ENABLED"] ?? "").toLowerCase() === "true";
}

/**
 * Validate scheduler configuration at startup.
 * Returns a list of warning messages (empty = valid).
 */
export function validateSchedulerConfig(): string[] {
  const warnings: string[] = [];
  const hour = parseInt(process.env["SCHEDULER_HOUR"] ?? "7", 10);
  const minute = parseInt(process.env["SCHEDULER_MINUTE"] ?? "30", 10);
  const tz = process.env["APP_TIMEZONE"] ?? "Europe/London";

  if (isNaN(hour) || hour < 0 || hour > 23) {
    warnings.push(`SCHEDULER_HOUR=${process.env["SCHEDULER_HOUR"]} is invalid — must be 0–23.`);
  }
  if (isNaN(minute) || minute < 0 || minute > 59) {
    warnings.push(`SCHEDULER_MINUTE=${process.env["SCHEDULER_MINUTE"]} is invalid — must be 0–59.`);
  }
  try {
    Intl.DateTimeFormat("en-GB", { timeZone: tz });
  } catch {
    warnings.push(`APP_TIMEZONE=${tz} is not a valid IANA timezone.`);
  }
  return warnings;
}

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

/**
 * Start the daily research scheduler.
 *
 * The scheduler only INSERTS due research jobs — it does NOT execute them.
 * The worker poll loop (see worker.ts) picks up queued jobs and executes them.
 *
 * SCHEDULER_ENABLED is parsed strictly: only the case-insensitive value "true"
 * enables the scheduler. Any other value (including "1", "yes", unset) disables it.
 */
export function startScheduler(): void {
  if (!isSchedulerEnabled()) {
    logger.info("Scheduler disabled via SCHEDULER_ENABLED (not 'true')");
    return;
  }

  const configWarnings = validateSchedulerConfig();
  if (configWarnings.length > 0) {
    // Fail closed: invalid hour/minute/timezone values produce incorrect or
    // crashing scheduling. Disable the scheduler rather than mis-schedule.
    for (const w of configWarnings) {
      logger.error({ warning: w }, "Scheduler config invalid — scheduler disabled");
    }
    logger.error(
      "Scheduler disabled due to invalid configuration. " +
      "Fix SCHEDULER_HOUR, SCHEDULER_MINUTE, and APP_TIMEZONE then restart.",
    );
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
        logger.info({ queued: runIds.length }, "Scheduler: due check complete — jobs queued for worker");
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
