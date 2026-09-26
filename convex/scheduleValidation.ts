export const SCHEDULE_NAME_ERROR = "Schedule name must not be blank.";
export const SCHEDULE_DAYS_ERROR = "Schedule days must be a nonempty JSON array of unique weekday integers from 0 through 6.";

export function isValidScheduleName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function parseScheduleDays(value: unknown): number[] | null {
  if (typeof value !== "string") return null;
  try {
    const days: unknown = JSON.parse(value);
    if (!Array.isArray(days) || days.length === 0 || days.length > 7 ||
        !days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6) ||
        new Set(days).size !== days.length) return null;
    return days as number[];
  } catch {
    return null;
  }
}
