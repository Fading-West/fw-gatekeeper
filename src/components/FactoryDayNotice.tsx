export function FactoryDayNotice({ date, today }: { date: string; today: string }) {
  return (
    <div role="status" className="mb-6 rounded-xl border border-amber-400/30 bg-amber-400/5 px-4 py-3 text-sm text-amber-100">
      A new factory day has started ({today}). You are still viewing {date}; your selected date and any unsaved work have been kept.
      {' '}Save your work, then use the date picker to switch to today.
    </div>
  );
}
