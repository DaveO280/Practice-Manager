export const getVeniceFinalScheduleText = (rawText) => {
  if (!rawText || typeof rawText !== 'string') return rawText;

  const dayHeaderRegex = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i;
  const lines = rawText.split('\n').map((l) => l.trim()).filter(Boolean);

  // If model adds "Here's the schedule..." preface, start after it.
  const prefaceIndex = lines.findIndex((l) => /here(?:'|')s the schedule/i.test(l));
  const fromPreface = prefaceIndex >= 0 ? lines.slice(prefaceIndex + 1) : lines;

  // Start at first day header if present.
  const firstDayIdx = fromPreface.findIndex((l) => dayHeaderRegex.test(l));
  const fromDay = firstDayIdx >= 0 ? fromPreface.slice(firstDayIdx) : fromPreface;

  // Stop before note sections.
  const noteIdx = fromDay.findIndex((l) => /^(Note|Notes)\b/i.test(l));
  const core = noteIdx >= 0 ? fromDay.slice(0, noteIdx) : fromDay;

  const cleaned = core.map((line) => {
    // Strip leading bullet "- "
    let l = line.replace(/^[-–—•]\s*/, '');
    // Strip trailing parenthetical commentary like (looks like "11"...)
    l = l.replace(/\s*\(.*$/, '');
    // Strip trailing colon from day headers ("Monday, March 2:" -> "Monday, March 2")
    if (dayHeaderRegex.test(l)) {
      l = l.replace(/:?\s*$/, '');
    }
    return l.trim();
  }).filter(Boolean).join('\n').trim();

  return cleaned || rawText;
};
