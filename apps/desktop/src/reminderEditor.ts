import { t } from "./i18n.ts";
export interface Timing {
  kind: "once" | "interval" | "daily" | "weekly";
  at?: string;
  after_seconds?: number;
  seconds?: number;
  hour?: number;
  minute?: number;
  weekdays?: number[];
  zone?: string;
}
export function reminderEditor(
  parent: HTMLElement,
  current: {
    name: string;
    message: string;
    mode?: string;
    rule: Timing;
    nextAt: number | null;
  },
  save: (
    name: string,
    message: string,
    mode: string,
    schedule?: Timing,
  ) => Promise<void>,
  close: () => void,
) {
  const panel = document.createElement("fieldset");
  parent.append(panel);
  const legend = document.createElement("legend");
  legend.textContent = t("reminders.editTask");
  panel.append(legend);
  function field<T extends HTMLElement>(name: string, node: T) {
    const label = document.createElement("label");
    label.style.display = "block";
    label.append(name + " ", node);
    panel.append(label);
    return node;
  }
  function select(
    name: string,
    options: Record<string, string>,
    value: string,
  ) {
    const node = field(name, document.createElement("select"));
    for (const [v, l] of Object.entries(options)) node.add(new Option(l, v));
    node.value = value;
    return node;
  }
  const name = field(t("reminders.taskName"), document.createElement("input"));
  name.value = current.name;
  const text = field(
    t("reminders.instruction"),
    document.createElement("textarea"),
  );
  text.value = current.message;
  text.maxLength = 1000;
  const mode = select(
    t("reminders.mode"),
    { notify: t("reminders.notify"), agent: t("reminders.agent") },
    current.mode ?? "notify",
  );
  const kind = select(
    t("reminders.repeat"),
    {
      once: t("reminders.kindOnce"),
      interval: t("reminders.kindInterval"),
      daily: t("reminders.daily"),
      weekly: t("reminders.kindWeekly"),
    },
    current.rule.kind,
  );
  const time = field(t("reminders.time"), document.createElement("input"));
  time.type = "time";
  time.value = [current.rule.hour ?? 12, current.rule.minute ?? 0]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
  const zone = field(t("reminders.zone"), document.createElement("input"));
  zone.value = current.rule.zone ?? "local";
  const days = field(t("reminders.weekdays"), document.createElement("input"));
  days.value = current.rule.weekdays?.join(",") ?? "1";
  const seconds = field(
    t("reminders.seconds"),
    document.createElement("input"),
  );
  seconds.type = "number";
  seconds.min = "1";
  seconds.value = String(current.rule.seconds ?? 3600);
  const once = field(t("reminders.localTime"), document.createElement("input"));
  once.type = "datetime-local";
  if (current.nextAt) {
    const t = new Date(current.nextAt);
    once.value = new Date(t.getTime() - t.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  }
  const fields = [kind, time, zone, days, seconds, once];
  let changed = false;
  function visibility() {
    for (const [n, show] of [
      [time, ["daily", "weekly"].includes(kind.value)],
      [zone, ["daily", "weekly"].includes(kind.value)],
      [days, kind.value === "weekly"],
      [seconds, kind.value === "interval"],
      [once, kind.value === "once"],
    ] as const)
      n.parentElement!.style.display = show ? "block" : "none";
  }
  fields.forEach(
    (n) =>
      (n.oninput = () => {
        changed = true;
        visibility();
      }),
  );
  visibility();
  const status = document.createElement("small");
  panel.append(status);
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = t("common.cancel");
  cancel.onclick = close;
  const ok = document.createElement("button");
  ok.type = "button";
  ok.textContent = t("common.save");
  panel.append(ok, cancel);
  ok.onclick = async () => {
    try {
      let schedule: Timing | undefined;
      if (changed) {
        const [hour, minute] = time.value.split(":").map(Number);
        if (kind.value === "once")
          schedule = { kind: "once", at: new Date(once.value).toISOString() };
        else if (kind.value === "interval")
          schedule = { kind: "interval", seconds: Number(seconds.value) };
        else
          schedule = {
            kind: kind.value as "daily" | "weekly",
            hour,
            minute,
            zone: zone.value.trim() || "local",
            ...(kind.value === "weekly"
              ? { weekdays: days.value.split(/[,， ]+/).map(Number) }
              : {}),
          };
      }
      panel.disabled = true;
      await save(name.value.trim(), text.value.trim(), mode.value, schedule);
      close();
    } catch (e) {
      panel.disabled = false;
      status.textContent = String(e);
    }
  };
  text.focus();
}
