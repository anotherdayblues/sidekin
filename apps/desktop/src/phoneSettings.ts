// 设置 · 手机传文件 (plan/20): where things land, the size limit, what a
// removal from the pet does to a file the phone sent, and the phones that
// come straight in. Kept by the host (phone/mod.rs), not in the companion
// settings, so changes here stay out of that form's save.
import "./styles/phone-settings.css";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { native } from "./bridge.ts";
import { t, dateLocale } from "./i18n.ts";

interface Settings {
  folder: string;
  maxMb: number;
  discard: "trash" | "keep";
  trusted: { id: string; name: string; seen?: number }[];
  explained: boolean;
}
const SIZES = [500, 1024, 2048, 5120, 10240];

export function mountPhoneSettings(group: HTMLElement) {
  group.insertAdjacentHTML(
    "beforeend",
    `<div class="phone-folder"><span>${t("phone.settings.folder")}</span><code data-phone-folder></code><span class="phone-folder-acts"><button type="button" data-phone-open>${t("phone.settings.open")}</button><button type="button" data-phone-choose>${t("phone.settings.change")}</button><button type="button" data-phone-default>${t("phone.settings.reset")}</button></span></div>
    <details class="set-more"><summary>${t("phone.settings.more")}</summary><div class="set-more-body">
      <label>${t("phone.settings.max")}<select data-phone-max>${SIZES.map((mb) => `<option value="${mb}">${mb < 1024 ? `${mb} MB` : `${mb / 1024} GB`}</option>`).join("")}</select></label>
      <label>${t("phone.settings.discard")}<select data-phone-discard><option value="keep">${t("phone.settings.discard.keep")}</option><option value="trash">${t(/Mac/.test(navigator.platform || navigator.userAgent) ? "phone.settings.discard.trash" : "phone.settings.discard.trashWin")}</option></select></label>
      <p class="set-note">${t("phone.settings.discardNote")}</p>
      <div class="phone-trusted"><span>${t("phone.settings.trusted")}</span><ul data-phone-trusted></ul></div>
      <div class="phone-renew"><button type="button" data-phone-renew>${t("phone.settings.renew")}</button><p class="set-note" data-phone-renew-note>${t("phone.settings.renewNote")}</p></div>
    </div></details>`,
  );
  const get = <T extends HTMLElement>(q: string) => group.querySelector<T>(q)!;
  let current: Settings | null = null;
  const draw = (r: { settings: Settings; folder: string }) => {
    current = r.settings;
    get("[data-phone-folder]").textContent = r.folder;
    get("[data-phone-default]").hidden = !r.settings.folder;
    get<HTMLSelectElement>("[data-phone-max]").value = String(
      SIZES.reduce((best, mb) =>
        Math.abs(mb - r.settings.maxMb) < Math.abs(best - r.settings.maxMb)
          ? mb
          : best,
      ),
    );
    get<HTMLSelectElement>("[data-phone-discard]").value = r.settings.discard;
    const list = get("[data-phone-trusted]");
    list.innerHTML = r.settings.trusted.length
      ? r.settings.trusted
          .map(
            (d, i) =>
              `<li><span class="phone-device"><span></span><small></small></span><button type="button" data-phone-forget="${i}">${t("phone.settings.forget")}</button></li>`,
          )
          .join("")
      : `<li class="set-note">${t("phone.settings.trustedNone")}</li>`;
    // Names are what the phone called itself: text, never markup.
    r.settings.trusted.forEach((d, i) => {
      const row = list.children[i];
      row.querySelector(".phone-device > span")!.textContent = d.name;
      row.querySelector("small")!.textContent = d.seen
        ? t("phone.settings.seen", {
            when: new Date(d.seen).toLocaleString(dateLocale, {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            }),
          })
        : "";
    });
  };
  const save = (change: Partial<Settings>) => {
    if (!current || !native) return;
    void invoke<{ settings: Settings; folder: string } | null>(
      "phone_save_settings",
      {
        settings: { ...current, ...change },
      },
    ).then((r) => r && draw(r));
  };
  group.addEventListener("change", (e) => {
    const target = e.target as HTMLElement;
    if (!target.closest("[data-phone-max], [data-phone-discard]")) return;
    // Not a companion setting: keep its change out of the form's save.
    e.stopPropagation();
    save({
      maxMb: Number(get<HTMLSelectElement>("[data-phone-max]").value),
      discard: get<HTMLSelectElement>("[data-phone-discard]")
        .value as Settings["discard"],
    });
  });
  get("[data-phone-choose]").onclick = async () => {
    const dir = await open({ directory: true });
    if (typeof dir === "string") save({ folder: dir });
  };
  get("[data-phone-default]").onclick = () => save({ folder: "" });
  get("[data-phone-open]").onclick = () => {
    if (native) void invoke("phone_open_folder").catch(console.error);
  };
  get("[data-phone-renew]").onclick = () => {
    if (!native) return;
    void invoke("phone_renew").then(() => {
      get("[data-phone-renew-note]").textContent = t("phone.settings.renewed");
    });
  };
  get("[data-phone-trusted]").onclick = (e) => {
    const i = (e.target as HTMLElement).closest<HTMLElement>(
      "[data-phone-forget]",
    )?.dataset.phoneForget;
    if (i === undefined || !current) return;
    save({ trusted: current.trusted.filter((_, n) => n !== Number(i)) });
  };
  if (native)
    void invoke<{ settings: Settings; folder: string } | null>(
      "phone_settings",
    ).then((r) => r && draw(r));
  else
    draw({
      settings: {
        folder: "",
        maxMb: 2048,
        discard: "keep",
        trusted: [{ id: "a", name: "iPhone", seen: Date.now() - 3_600_000 }],
        explained: false,
      },
      folder: `~/Downloads/${t("app.name")}`,
    });
}
