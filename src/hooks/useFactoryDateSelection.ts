'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getFactoryLocalDateString } from '@/lib/date';

/** Follow today until a date is chosen or editing starts. Never roll a draft to another day. */
export function useFactoryDateSelection(urlDate: string | null, followToday = true) {
  const [visitDay] = useState(getFactoryLocalDateString);
  const [today, setToday] = useState(visitDay);
  const [date, setSelectedDate] = useState(urlDate || visitDay);
  const kept = useRef(!followToday || Boolean(urlDate));
  const keepDate = useCallback(() => { kept.current = true; }, []);
  const setDate = useCallback((value: string) => {
    kept.current = true;
    setSelectedDate(value);
  }, []);

  // Only actual URL date changes reset the selection, including back/forward
  // and removing the parameter. Unrelated filters must not discard work.
  useEffect(() => {
    kept.current = !followToday || Boolean(urlDate);
    setSelectedDate(urlDate || getFactoryLocalDateString());
  }, [followToday, urlDate]);

  useEffect(() => {
    const checkDay = () => {
      const currentDay = getFactoryLocalDateString();
      setToday(currentDay);
      if (!kept.current) setSelectedDate(currentDay);
    };
    checkDay();
    // Re-read the factory clock rather than adding 24 hours: DST days differ
    // in length, and a sleeping/background tab may miss the midnight tick.
    const interval = setInterval(checkDay, 30_000);
    const pageDocument = typeof document === 'undefined' ? null : document;
    pageDocument?.addEventListener?.('visibilitychange', checkDay);
    return () => {
      clearInterval(interval);
      pageDocument?.removeEventListener?.('visibilitychange', checkDay);
    };
  }, []);

  return { date, setDate, keepDate, today, newDay: today !== visitDay && date !== today };
}
