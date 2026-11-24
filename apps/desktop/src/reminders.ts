import { t, tn, dateLocale } from "./i18n.ts";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { native, state } from "./bridge.ts";
import { reminderEditor } from "./reminderEditor.ts";
interface Schedule {
  kind: "once" | "interval" | "daily" | "weekly";
  hour?: number;
  minute?: number;
  weekdays?: number[];
  seconds?: number;
  zone?: string;
}
interface Reminder {
  name: string;
  id: number;
  message: string;
  mode?: string;
  rule: Schedule;
  nextAt: number | null;
  snoozeAt: number | null;
  paused: boolean;
  pending: boolean;
}
export interface Notice {
  id: number;
  revision: number;
  reminder: number;
  pet: string;
  message: string;
  missed: boolean;
  due: number;
}
function description(r: Schedule) {
  if (r.kind === "once") return t("reminders.once");
  if (r.kind === "interval")
    return tn("reminders.everySeconds", r.seconds ?? 0);
  const day =
    r.kind === "weekly"
      ? t("reminders.weekly", {
          days: (r.weekdays ?? [])
            .map((n) => t("reminders.dayNames").split(",")[n - 1])
            .join(t("reminders.dayJoiner")),
        })
      : t("reminders.daily");
  return (
    day +
    " " +
    String(r.hour).padStart(2, "0") +
    ":" +
    String(r.minute).padStart(2, "0") +
    " · " +
    (!r.zone || r.zone === "local" ? t("reminders.localZone") : r.zone)
  );
}
export function remindersPage(form: HTMLElement) {
  const section = document.createElement("section");
  section.className = "companion-reminders";
  form.append(section);
  let seq = 0;
  let editing = false;
  async function refresh() {
    if (editing) return;
    const ticket = ++seq;
    try {
      const petId = native ? (await state()).settings.activeId : "fixture";
      const rows = native
        ? await invoke<Reminder[]>("list_reminders")
        : [
            {
              id: 1,
              name: "喝水",
              message: "喝水",
              rule: { kind: "daily" as const, hour: 15, minute: 0 },
              nextAt: new Date().setHours(15, 0, 0, 0),
              snoozeAt: null,
              paused: false,
              pending: false,
            },
          ];
      if (seq !== ticket) return;
      section.replaceChildren();
      if (!rows.length) {
        const p = document.createElement("p");
        p.className = "memo-empty";
        p.textContent = t("reminders.empty");
        section.append(p);
      }
      // Three groups: due today, later, paused (plan/11 交互和分区 第 3.2 节).
      const end = new Date();
      end.setHours(23, 59, 59, 999);
      const groups: [string, Reminder[]][] = [
        [t("reminders.today"), []],
        [t("reminders.later"), []],
        [t("reminders.paused"), []],
      ];
      for (const r of rows) {
        const next = r.snoozeAt ?? r.nextAt;
        if (r.paused) groups[2][1].push(r);
        else if (r.pending || (next && next <= end.getTime()))
          groups[0][1].push(r);
        else groups[1][1].push(r);
      }
      for (const [title, list] of groups) {
        if (!list.length) continue;
        const h = document.createElement("h3");
        h.textContent = title;
        section.append(h);
        for (const r of list) {
          const row = document.createElement("div");
          row.className = "companion-entry reminder-row";
          row.dataset.state = r.paused
            ? "paused"
            : r.pending
              ? "pending"
              : "on";
          section.append(row);
          const next = r.snoozeAt ?? r.nextAt;
          const time = document.createElement("span");
          time.className = "reminder-time";
          time.textContent = next
            ? new Date(next).toLocaleTimeString(dateLocale, {
                hour: "2-digit",
                minute: "2-digit",
                hourCycle: "h23",
              })
            : "—";
          const label = document.createElement("span");
          label.className = "reminder-text";
          const what = document.createElement("b");
          what.textContent = r.name;
          const when = document.createElement("small");
          when.textContent =
            description(r.rule) +
            " · " +
            (r.paused
              ? t("reminders.paused")
              : r.pending
                ? t("reminders.pending")
                : next
                  ? t("reminders.next") +
                    new Date(next).toLocaleString(dateLocale, {
                      month: "numeric",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                  : t("reminders.done"));
          label.append(what, when);
          row.append(time, label);
          const acts = document.createElement("span");
          acts.className = "memo-acts";
          row.append(acts);
          function button(text: string, fn: () => void) {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "link";
            b.textContent = text;
            b.onclick = fn;
            acts.append(b);
          }
          async function update(action: string) {
            try {
              await invoke("manage_reminder", { petId, id: r.id, action });
              await refresh();
            } catch (e) {
              when.textContent = String(e);
            }
          }
          button(t("common.editLong"), () => {
            if (editing) return;
            editing = true;
            ++seq;
            reminderEditor(
              row,
              r,
              async (name, message, mode, schedule) => {
                await invoke("edit_reminder", {
                  id: r.id,
                  name,
                  message,
                  mode,
                  schedule,
                });
              },
              () => {
                editing = false;
                void refresh();
              },
            );
          });
          if (!r.paused)
            button(t("reminders.runNow"), () => void update("run"));
          if (r.paused || r.pending || next)
            button(
              r.paused ? t("reminders.resume") : t("reminders.pause"),
              () => void update(r.paused ? "resume" : "pause"),
            );
          button(t("common.delete"), () => {
            acts.replaceChildren();
            button(t("common.confirmDelete"), () => void update("delete"));
            button(t("common.cancel"), () => void refresh());
          });
        }
      }
    } catch {
      section.textContent = t("reminders.pickPet");
    }
  }
  if (native)
    void listen("reminders-changed", () => {
      if (section.offsetParent) void refresh();
    });
  return refresh;
}
