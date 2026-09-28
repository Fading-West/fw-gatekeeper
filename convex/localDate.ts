export const DEFAULT_FACTORY_TIME_ZONE = "America/Chicago";

export type FactoryLocalDateOptions = {
  timeZone?: string;
  utcOffsetMinutes?: number;
};

export type TimestampQueryRange = {
  startTimestamp: string;
  endTimestamp: string;
};

const LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ABSOLUTE_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:?\d{2})$/i;
const DAYS_BY_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function isValidFactoryLocalDateKey(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  const match = LOCAL_DATE_RE.exec(value);
  if (!match) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }

  const maxDay = month === 2 && isLeapYear(year) ? 29 : DAYS_BY_MONTH[month - 1];
  return day <= maxDay;
}

function assertFactoryLocalDateKey(dateKey: string) {
  if (!isValidFactoryLocalDateKey(dateKey)) {
    throw new RangeError("dateKey must use YYYY-MM-DD format");
  }
}

function shiftDateKey(dateKey: string, days: number) {
  assertFactoryLocalDateKey(dateKey);
  const [year, month, day] = dateKey.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function getDateKeyFromAbsoluteTimestamp(timestamp: string, options: FactoryLocalDateOptions) {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  if (options.utcOffsetMinutes !== undefined) {
    const localTime = new Date(parsed.getTime() + options.utcOffsetMinutes * 60 * 1000);
    return localTime.toISOString().slice(0, 10);
  }

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: options.timeZone || DEFAULT_FACTORY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(parsed);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return year && month && day ? `${year}-${month}-${day}` : null;
}

function getTimestampFromAbsoluteTimestamp(timestamp: string, options: FactoryLocalDateOptions) {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  if (options.utcOffsetMinutes !== undefined) {
    const localTime = new Date(parsed.getTime() + options.utcOffsetMinutes * 60 * 1000);
    return localTime.toISOString().slice(0, 19);
  }

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: options.timeZone || DEFAULT_FACTORY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(parsed);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  const hour = parts.find((part) => part.type === "hour")?.value;
  const minute = parts.find((part) => part.type === "minute")?.value;
  const second = parts.find((part) => part.type === "second")?.value;
  return year && month && day && hour && minute && second
    ? `${year}-${month}-${day}T${hour}:${minute}:${second}`
    : null;
}

export function getFactoryLocalDateKey(
  timestamp: string | null | undefined,
  options: FactoryLocalDateOptions = {},
) {
  if (typeof timestamp !== "string") {
    return null;
  }

  const trimmed = timestamp.trim().replace(/^(\d{4}-\d{2}-\d{2}) /, "$1T");
  if (ABSOLUTE_TIMESTAMP_RE.test(trimmed)) {
    return getDateKeyFromAbsoluteTimestamp(trimmed, options);
  }

  const datePrefix = trimmed.slice(0, 10);
  return isValidFactoryLocalDateKey(datePrefix) ? datePrefix : null;
}

export function getFactoryLocalTimestamp(
  timestamp: string | null | undefined,
  options: FactoryLocalDateOptions = {},
) {
  if (typeof timestamp !== "string") {
    return null;
  }

  const trimmed = timestamp.trim().replace(/^(\d{4}-\d{2}-\d{2}) /, "$1T");
  if (ABSOLUTE_TIMESTAMP_RE.test(trimmed)) {
    return getTimestampFromAbsoluteTimestamp(trimmed, options);
  }

  return trimmed || null;
}

export function timestampBelongsToFactoryLocalDate(
  timestamp: string | null | undefined,
  dateKey: string,
  options: FactoryLocalDateOptions = {},
) {
  assertFactoryLocalDateKey(dateKey);
  return getFactoryLocalDateKey(timestamp, options) === dateKey;
}

export function getPreviousFactoryLocalDateKey(dateKey: string) {
  return shiftDateKey(dateKey, -1);
}

export function getNextFactoryLocalDateKey(dateKey: string) {
  return shiftDateKey(dateKey, 1);
}

export function buildConservativeFactoryLocalTimestampRanges(dateKey: string): TimestampQueryRange[] {
  assertFactoryLocalDateKey(dateKey);
  return [
    {
      startTimestamp: getPreviousFactoryLocalDateKey(dateKey),
      endTimestamp: shiftDateKey(dateKey, 2),
    },
  ];
}
