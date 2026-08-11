import type { Service } from "@workspace/db";

export type DateString = string | null | undefined;

function parseDate(d: DateString): Date | null {
  if (!d) return null;
  const parsed = new Date(d);
  return isNaN(parsed.getTime()) ? null : parsed;
}

export function targetDate(service: Service): string | null {
  const dates: string[] = [];
  if (service.renewalDate) dates.push(service.renewalDate);
  if (service.contractEndDate) dates.push(service.contractEndDate);
  if (!dates.length) return null;
  return dates.sort()[0];
}

export function daysUntilTarget(
  service: Service,
  today?: Date
): number | null {
  const t = targetDate(service);
  if (!t) return null;
  const target = parseDate(t);
  if (!target) return null;
  const base = today ?? new Date();
  const todayUTC = new Date(
    Date.UTC(base.getFullYear(), base.getMonth(), base.getDate())
  );
  const targetUTC = new Date(
    Date.UTC(target.getFullYear(), target.getMonth(), target.getDate())
  );
  return Math.round(
    (targetUTC.getTime() - todayUTC.getTime()) / (1000 * 60 * 60 * 24)
  );
}

export function needsResearch(service: Service, today?: Date): boolean {
  if (!service.active || !service.autoResearch) return false;
  const base = today ?? new Date();
  const todayStr = base.toISOString().slice(0, 10);
  if (service.nextResearchAt) {
    return service.nextResearchAt <= todayStr;
  }
  const remaining = daysUntilTarget(service, base);
  return (
    remaining !== null &&
    remaining >= 0 &&
    remaining <= service.researchWindowDays
  );
}

export function calculateNextResearchDate(
  service: Service,
  today?: Date
): string | null {
  const base = today ?? new Date();
  const remaining = daysUntilTarget(service, base);
  if (remaining === null || remaining < 0) return null;
  let interval: number;
  if (remaining > 30) interval = 14;
  else if (remaining > 14) interval = 7;
  else if (remaining > 3) interval = 3;
  else interval = 1;
  const proposed = new Date(base);
  proposed.setDate(proposed.getDate() + interval);
  const proposedStr = proposed.toISOString().slice(0, 10);
  const target = targetDate(service);
  if (!target) return proposedStr;
  return proposedStr < target ? proposedStr : target;
}

/**
 * Returns the effective annual cost in GBP (decimal), derived from
 * the integer-pence columns stored in the database.
 * Returns null if neither cost is set.
 */
export function effectiveAnnualCost(service: Service): number | null {
  if (service.annualCostPence !== null && service.annualCostPence !== undefined)
    return service.annualCostPence / 100;
  if (service.monthlyCostPence !== null && service.monthlyCostPence !== undefined)
    return (service.monthlyCostPence * 12) / 100;
  return null;
}
