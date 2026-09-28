import { DEFAULT_FACTORY_TIME_ZONE, isValidFactoryLocalDateKey } from "./localDate";

// Build once per query: reuse the formatter and each day's possible UTC offsets.
export function createRecognitionTimestampSortKey() {
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: DEFAULT_FACTORY_TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const offsetsByDate = new Map<string, number[]>();
  const localSecond = (epoch: number) => {
    const parts = formatter.formatToParts(epoch);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)!.value;
    return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}`;
  };

  return (timestamp: string): string => {
    const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(timestamp.trim());
    if (!match || !isValidFactoryLocalDateKey(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4] || 0) > 59) return "";
    const wallSecond = `${match[1]}T${match[2]}:${match[3]}:${match[4] || "00"}`;
    let epoch: number;
    if (match[6]) {
      epoch = Date.parse(wallSecond + match[6]);
    } else {
      const wallEpoch = Date.parse(wallSecond + "Z");
      let offsets = offsetsByDate.get(match[1]);
      if (!offsets) {
        const noon = Date.parse(`${match[1]}T12:00:00Z`);
        offsets = [...new Set([-1, 0, 1].map(day => {
          const sample = noon + day * 86_400_000;
          return Date.parse(localSecond(sample) + "Z") - sample;
        }))];
        offsetsByDate.set(match[1], offsets);
      }
      const candidates = offsets.map(offset => wallEpoch - offset)
        .filter(candidate => localSecond(candidate) === wallSecond);
      // Legacy timestamps lack an offset. Choose the earlier occurrence in a
      // repeated fall-back hour. Nonexistent spring-forward times sort last.
      epoch = candidates.length ? Math.min(...candidates) : NaN;
    }
    if (!Number.isFinite(epoch)) return "";
    // Preserve kiosk microseconds (and finer precision) without Date's
    // millisecond truncation. Removing trailing zeros makes equal instants tie.
    const fraction = (match[5] || "").replace(/0+$/, "");
    return `${new Date(epoch).toISOString().slice(0, 19)}.${fraction}`;
  };
}
