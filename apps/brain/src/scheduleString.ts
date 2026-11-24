// Convert the model-facing schedule into the existing desktop scheduler's rules.
const days = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];
const units: Record<string, number> = {
  s: 1,
  sec: 1,
  second: 1,
  m: 60,
  min: 60,
  minute: 60,
  h: 3600,
  hr: 3600,
  hour: 3600,
  d: 86400,
  day: 86400,
};

function clock(raw: string) {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(raw);
  if (!match) throw Error("无效的日程时间");
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  if (minute > 59 || hour > 23 || (match[3] && (hour < 1 || hour > 12)))
    throw Error("无效的日程时间");
  if (match[3]) hour = (hour % 12) + (match[3].toLowerCase() === "pm" ? 12 : 0);
  return { hour, minute };
}

export function parseSchedule(input: unknown) {
  if (typeof input !== "string" || input.length > 256)
    throw Error("schedule 需要日程字符串");
  let value = input.trim();
  const duration =
    /^(?:(in|every)\s+)?(\d+)?\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)$/i.exec(
      value,
    );
  if (duration) {
    const unit = duration[3].toLowerCase();
    const seconds =
      Number(duration[2] ?? 1) *
      units[unit.length > 1 ? unit.replace(/s$/, "") : unit];
    if (!Number.isSafeInteger(seconds * 1000) || seconds <= 0)
      throw Error("时长超出范围");
    return duration[1]?.toLowerCase() === "in"
      ? { kind: "once", after_seconds: seconds }
      : { kind: "interval", seconds };
  }
  // Absolute times without an offset follow the device's local clock.
  if (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/i.test(
      value,
    )
  ) {
    const at = new Date(value);
    if (!Number.isFinite(at.getTime())) throw Error("无效的 ISO 时间");
    return { kind: "once", at: at.toISOString() };
  }
  const suffix = /\s+(UTC|[A-Za-z_]+\/[A-Za-z0-9_+\-/]+)$/.exec(value);
  const zone = suffix?.[1] ?? "local";
  if (suffix) {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    value = value.slice(0, suffix.index);
  }
  const cron =
    /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+(\*|[0-7](?:[-,][0-7])*)$/.exec(value);
  if (cron) {
    const time = clock(cron[2] + ":" + cron[1].padStart(2, "0"));
    if (cron[3] === "*") return { kind: "daily", ...time, zone };
    const selected = new Set<number>();
    for (const range of cron[3].split(",")) {
      if (!/^[0-7](?:-[0-7])?$/.test(range)) throw Error("无效的星期范围");
      const [a, b = a] = range.split("-").map(Number);
      if (b < a) throw Error("无效的星期范围");
      for (let n = a; n <= b; n++) selected.add(n || 7);
    }
    return {
      kind: "weekly",
      ...time,
      weekdays: [...selected].sort((a, b) => a - b),
      zone,
    };
  }
  const wall =
    /^(?:every\s+)?(.+?)\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)$/i.exec(
      value.toLowerCase(),
    );
  if (wall) {
    const time = clock(wall[2].trim()),
      spec = wall[1].trim();
    if (["day", "daily"].includes(spec))
      return { kind: "daily", ...time, zone };
    const weekdays = /^weekdays?$/.test(spec)
      ? [1, 2, 3, 4, 5]
      : /^weekends?$/.test(spec)
        ? [6, 7]
        : spec
            .split(/(?:\s*,\s*|\s+and\s+|\s+)/)
            .map(
              (day) =>
                days.findIndex((d) => d === day || d.slice(0, 3) === day) + 1,
            );
    if (weekdays.every(Boolean))
      return {
        kind: "weekly",
        ...time,
        weekdays: [...new Set(weekdays)],
        zone,
      };
  }
  throw Error("无法识别日程，请按 schedule 字段的示例填写");
}
