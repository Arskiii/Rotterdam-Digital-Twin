/** Parse a Buienradar station clock as Europe/Amsterdam wall time.
 * The feed omits a UTC offset. Date.parse would otherwise use the host's
 * timezone, making the same observation appear fresh or future by location.
 */
export function dutchStationTime(value, now = Date.now()) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(value)) {
    throw new Error("Unexpected Buienradar station time");
  }
  const wallUtc = Date.parse(`${value}Z`);
  if (!Number.isFinite(wallUtc)) throw new Error("Invalid Buienradar station time");
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const candidates = [1, 2].map((hours) => wallUtc - hours * 3_600_000)
    .filter((time) => formatter.format(time).replace(" ", "T") === value);
  if (!candidates.length) throw new Error("Buienradar station time falls in a missing local hour");
  // The autumn clock change repeats one hour. Pick the most recent occurrence
  // already possible at receipt, without accepting an observation in the future.
  const possible = candidates.filter((time) => time <= now + 60_000);
  if (!possible.length) throw new Error("Buienradar station time is in the future");
  return new Date(Math.max(...possible)).toISOString();
}
