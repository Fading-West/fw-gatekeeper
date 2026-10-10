export function getLocalDateString(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export const DEFAULT_FACTORY_TIME_ZONE = 'America/Chicago';

/** Format factory wall time without letting the viewer's DST rules alter it. */
export function formatFactoryLocalDateTime(value: string | null | undefined, emptyLabel = '—'): string {
  if (!value) return emptyLabel;
  const timestamp = value.trim().replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T');
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(timestamp);
  // Offset-free values already contain factory wall time. UTC here is only a
  // neutral calendar for formatting those fields, not an inferred instant.
  const date = new Date(hasOffset ? timestamp : `${timestamp}Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], {
    timeZone: hasOffset ? DEFAULT_FACTORY_TIME_ZONE : 'UTC',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

const LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
const DAYS_BY_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function isValidLocalDateString(value: unknown): value is string {
  if (typeof value !== 'string') {
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

export function getFactoryLocalDateString(
  date = new Date(),
  timeZone = DEFAULT_FACTORY_TIME_ZONE,
): string {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;

  if (!year || !month || !day) {
    return getLocalDateString(date);
  }

  return `${year}-${month}-${day}`;
}

export function resolveRequestDate(
  searchParams: URLSearchParams,
  options: { now?: Date; param?: string; timeZone?: string } = {},
): string {
  const param = options.param || 'date';
  const value = searchParams.get(param);
  if (value !== null && value !== '') {
    return value;
  }

  return getFactoryLocalDateString(options.now || new Date(), options.timeZone);
}

export function createLocalIsoTimestamp(date: string, time: string): string {
  if (!isValidLocalDateString(date)) {
    throw new RangeError('date must use YYYY-MM-DD format');
  }

  const match = LOCAL_TIME_RE.exec(time);
  if (!match) {
    throw new RangeError('time must use HH:mm or HH:mm:ss format');
  }

  const seconds = match[3] || '00';
  return `${date}T${match[1]}:${match[2]}:${seconds}`;
}
