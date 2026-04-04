import { getVeniceFinalScheduleText } from './veniceOutput';

describe('getVeniceFinalScheduleText', () => {
  test('keeps only schedule block after preface and before notes', () => {
    const input = `The user wants me to extract names and times.
Here's the schedule extracted from your handwritten planner (week of March 2–8, 2026):

Monday, March 2

10:30 AM — Jen
12:00 PM — Ashton

Tuesday, March 3

10:30 AM — Sam
1:00 PM — Kai

Notes:
Several entries are uncertain`;

    const output = getVeniceFinalScheduleText(input);

    expect(output).toBe(`Monday, March 2
10:30 AM — Jen
12:00 PM — Ashton
Tuesday, March 3
10:30 AM — Sam
1:00 PM — Kai`);
  });

  test('strips parenthetical commentary from lines', () => {
    const input = `Monday, March 2:
- 11:00 - Jan (looks like "11" in the 11:00 slot, name looks like Jan or similar)
- 12:00 - Ashton (12 slot)
- 4:50 - Annie (written between 4-5, looks like 4:50)`;

    const output = getVeniceFinalScheduleText(input);

    expect(output).toBe(`Monday, March 2
11:00 - Jan
12:00 - Ashton
4:50 - Annie`);
  });

  test('strips bullets and trailing colons from day headers', () => {
    const input = `Monday, March 2:
- 9:00 AM — Jan
Tuesday, March 3:
- 10:30 AM — Sam`;

    const output = getVeniceFinalScheduleText(input);

    expect(output).toBe(`Monday, March 2
9:00 AM — Jan
Tuesday, March 3
10:30 AM — Sam`);
  });

  test('falls back to first day header when no preface exists', () => {
    const input = `Some reasoning line
another line
Wednesday, March 4
10:30 — Jenna
2:00 — Alice`;

    const output = getVeniceFinalScheduleText(input);

    expect(output).toBe(`Wednesday, March 4
10:30 — Jenna
2:00 — Alice`);
  });

  test('returns original text when no day headers are found', () => {
    const input = `No schedule here
just prose`;

    const output = getVeniceFinalScheduleText(input);

    expect(output).toBe(input);
  });
});
