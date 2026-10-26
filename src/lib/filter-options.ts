/**
 * Sorted, de-duplicated options for a filter <select>, always including the applied value.
 * A <select> whose value has no matching option shows its first option ("All ...") while the
 * stale filter still applies, and re-choosing "All" fires no change, so keep it visible instead.
 */
export function filterOptions(values: string[], selected: string) {
  const options = new Set(values);
  if (selected && selected !== 'all') options.add(selected);
  return Array.from(options).sort((a, b) => a.localeCompare(b));
}
