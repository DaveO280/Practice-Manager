/**
 * Shared logic for updating client timePatterns / sessionCount / lastSeen when saving a session.
 * Only applied when isNewSession is true (insert), not on edit — avoids double-counting.
 */

export const isWithinHour = (time1, time2) => {
  const parseTime = (t) => {
    if (!t || typeof t !== 'string') return null;
    const parts = t.trim().split(/\s+/);
    if (parts.length < 2) return null;
    const [time, period] = [parts[0], parts[parts.length - 1]];
    let [hours, minutes] = time.split(':').map(Number);
    if (Number.isNaN(hours)) return null;
    minutes = Number.isNaN(minutes) ? 0 : minutes;
    if (period === 'PM' && hours !== 12) hours += 12;
    if (period === 'AM' && hours === 12) hours = 0;
    return hours * 60 + minutes;
  };

  const a = parseTime(time1);
  const b = parseTime(time2);
  if (a === null || b === null) return false;
  return Math.abs(a - b) <= 60;
};

/**
 * Mutates a shallow copy of client — pass a fresh object from DB, not React state.
 */
export function applyNewSessionToClient(client, session) {
  if (!client || !session?.clientId || client.id !== session.clientId) return client;
  if (!session.time || session.time === '—') return client;

  const date = session.date;
  if (!date) return client;

  const dayOfWeek =
    typeof session.dayOfWeek === 'number'
      ? session.dayOfWeek
      : (() => {
          const p = String(date).split('-').map(Number);
          if (p.length !== 3) return new Date(date).getDay();
          return new Date(p[0], p[1] - 1, p[2]).getDay();
        })();

  const patterns = Array.isArray(client.timePatterns) ? [...client.timePatterns] : [];
  let pattern = patterns.find((p) => p.dayOfWeek === dayOfWeek && isWithinHour(p.time, session.time));

  if (pattern) {
    pattern = { ...pattern, frequency: pattern.frequency + 1, lastOccurrence: date };
    const idx = patterns.findIndex(
      (p) => p.dayOfWeek === dayOfWeek && isWithinHour(p.time, session.time)
    );
    patterns[idx] = pattern;
  } else {
    patterns.push({
      dayOfWeek,
      time: session.time,
      frequency: 1,
      lastOccurrence: date
    });
  }

  return {
    ...client,
    timePatterns: patterns,
    lastSeen: date,
    sessionCount: (client.sessionCount || 0) + 1
  };
}
