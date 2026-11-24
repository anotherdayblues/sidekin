// 设置 → 声音 (plan/10 §9): the 宠物声音 switch, which service and voice, the
// key, and 试听. Saved on its own (voice.json), not with the companion form.
import { t, tn, named } from "./i18n.ts";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { native } from "./bridge.ts";
import services from "../../shared/voiceServices.json";

type Provider = keyof typeof services;
interface Voice {
  enabled: boolean;
  provider: string;
  voice: string;
  voiceLabel?: string;
  baseUrl: string;
  model: string;
  resourceId: string;
  appId: string;
  instructions: string;
  hasKey?: boolean;
  ready?: boolean;
}
const empty: Voice = {
  enabled: false,
  provider: "",
  voice: "",
  baseUrl: "",
  model: "",
  resourceId: "",
  appId: "",
  instructions: "",
};

export function mountVoice(group: HTMLElement) {
  const options = Object.entries(services)
    .map(
      ([id, s]) =>
        `<option value="${id}">${named("voiceService." + id, s.label)}</option>`,
    )
    .join("");
  group.insertAdjacentHTML(
    "beforeend",
    `<div class="switch-row"><span>${t("voice.on")}</span><input data-voice-on class="slide-switch" type="checkbox" role="switch" aria-label="${t("voice.on")}"></div>
    <label>${t("voice.provider")}<select data-voice-provider><option value="">${t("voice.none")}</option>${options}</select></label>
    <p class="set-note" data-voice-note></p>
    <div class="search-key-actions"><label for="voice-key">Key</label><input id="voice-key" data-voice-key type="password" autocomplete="off" placeholder="${t("online.keyHidden")}"><button type="button" data-voice-save-key>${t("model.saveKey")}</button></div>
    <label>${t("voice.voice")}<select data-voice-select aria-label="${t("voice.voice")}"></select></label>
    <div class="voice-actions"><button type="button" data-voice-list>${t("voice.fetch")}</button></div>
    <details class="set-more"><summary>${t("common.more")}</summary><div class="set-more-body">
      <label>${t("voice.manualId")}<input data-voice-name maxlength="200" spellcheck="false"></label>
      <label>${t("model.baseUrl")}<input data-voice-url type="url" spellcheck="false"></label>
      <label>${t("voice.model")}<input data-voice-model spellcheck="false"></label>
      <label data-only="volcengine">${t("voice.resource")}<input data-voice-resource placeholder="seed-tts-2.0" spellcheck="false"></label>
      <label data-only="volcengine">${t("voice.appId")}<input data-voice-app spellcheck="false"></label>
      <label data-only="openai">${t("voice.style")}<input data-voice-style maxlength="500" placeholder="${t("voice.styleHint")}"></label>
    </div></details>
    <div class="voice-actions"><button type="button" data-voice-save>${t("common.save")}</button><button type="button" data-voice-test>${t("voice.test")}</button></div>
    <output data-voice-status aria-live="polite"></output>`,
  );
  const $ = <T extends HTMLElement>(s: string) => group.querySelector<T>(s)!;
  const on = $<HTMLInputElement>("[data-voice-on]"),
    provider = $<HTMLSelectElement>("[data-voice-provider]"),
    name = $<HTMLInputElement>("[data-voice-name]"),
    key = $<HTMLInputElement>("[data-voice-key]"),
    url = $<HTMLInputElement>("[data-voice-url]"),
    model = $<HTMLInputElement>("[data-voice-model]"),
    resource = $<HTMLInputElement>("[data-voice-resource]"),
    app = $<HTMLInputElement>("[data-voice-app]"),
    style = $<HTMLInputElement>("[data-voice-style]"),
    status = $<HTMLOutputElement>("[data-voice-status]");
  const picker = $<HTMLSelectElement>("[data-voice-select]");
  const fetchButton = $<HTMLButtonElement>("[data-voice-list]");
  type Choice = { id: string; name: string };
  let choices: Choice[] = [];
  let generation = 0;
  let saved = empty;
  const context = () =>
    JSON.stringify([provider.value, url.value, model.value, resource.value]);
  function draw() {
    const current = name.value.trim();
    picker.replaceChildren(
      new Option(choices.length ? t("voice.pick") : t("voice.fetchFirst"), ""),
    );
    for (const v of choices) picker.add(new Option(v.name, v.id));
    if (current && !choices.some((v) => v.id === current))
      picker.add(
        new Option(
          current === saved.voice &&
            provider.value === saved.provider &&
            saved.voiceLabel
            ? saved.voiceLabel
            : t("voice.custom"),
          current,
        ),
      );
    picker.value = current;
    picker.disabled = picker.options.length === 1;
  }
  function invalidate() {
    generation++;
    choices = [];
    fetchButton.disabled = !provider.value;
    draw();
  }
  // This group sits inside the companion form but saves on its own: keep its
  // edits from the form's autosave, and Enter from submitting it.
  for (const type of ["change", "input"])
    group.addEventListener(type, (e) => e.stopPropagation());
  group.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT")
      e.preventDefault();
  });

  const say = (text: string) => (status.textContent = text);
  /** The service's hints: defaults as placeholders, example voices. */
  function hints() {
    const s = services[provider.value as Provider];
    $("[data-voice-note]").textContent = s
      ? named("voiceNote." + provider.value, s.note ?? "")
      : "";
    url.placeholder = s?.baseUrl ?? "";
    model.placeholder = s?.model ?? "";
    for (const el of group.querySelectorAll<HTMLElement>("[data-only]"))
      el.hidden = el.dataset.only !== provider.value;
    key.placeholder =
      provider.value && saved.provider === provider.value && saved.hasKey
        ? t("online.keyHidden")
        : t("voice.enterKey");
  }
  function show(value: Voice | null) {
    // Missing fields (an older file, or nothing saved yet) read as empty.
    const v = { ...empty, ...value };
    const previous = context();
    saved = v;
    on.checked = v.enabled;
    on.disabled = !v.ready && !v.enabled;
    provider.value = v.provider;
    name.value = v.voice;
    url.value = v.baseUrl;
    model.value = v.model;
    resource.value = v.resourceId;
    app.value = v.appId;
    style.value = v.instructions;
    hints();
    if (context() !== previous) invalidate();
    else draw();
    fetchButton.disabled = !provider.value;
  }
  const form = (): Voice => ({
    ...saved,
    provider: provider.value,
    voice: name.value,
    voiceLabel:
      choices.find((v) => v.id === name.value)?.name ??
      (provider.value === saved.provider && name.value === saved.voice
        ? saved.voiceLabel
        : "") ??
      "",
    baseUrl: url.value,
    model: model.value,
    resourceId: resource.value,
    appId: app.value,
    instructions: style.value,
  });
  async function call<T>(
    cmd: string,
    args: Record<string, unknown>,
    done: string,
  ) {
    if (!native) return void say(t("voice.previewNoSave"));
    try {
      const v = await invoke<T>(cmd, args);
      say(done);
      return v;
    } catch (e) {
      say(String(e));
    }
  }

  provider.onchange = () => {
    key.value = "";
    invalidate();
    if (provider.value === saved.provider) show(saved);
    else {
      for (const input of [name, url, model, resource, app, style])
        input.value = "";
      invalidate();
      hints();
    }
    say("");
  };
  for (const input of [url, model, resource])
    input.oninput = () => {
      name.value = "";
      invalidate();
      say("");
    };
  key.oninput = () => {
    invalidate();
    say("");
  };
  name.oninput = draw;
  picker.onchange = () => {
    name.value = picker.value;
  };
  fetchButton.onclick = async () => {
    const ticket = ++generation;
    fetchButton.disabled = true;
    say(t("voice.fetching"));
    try {
      const result = await invoke<{ voices: Choice[]; note: string }>(
        "list_voice_options",
        { voice: form(), key: key.value },
      );
      if (ticket !== generation) return;
      choices = result.voices;
      draw();
      say(
        choices.length
          ? [result.note, tn("voice.count", choices.length)]
              .filter(Boolean)
              .join(t("voice.joiner"))
          : t("voice.noneFound"),
      );
    } catch (e) {
      if (ticket === generation) say(String(e));
    } finally {
      if (ticket === generation) fetchButton.disabled = false;
    }
  };
  on.onchange = async () => {
    const v = await call<Voice>("set_voice_enabled", { on: on.checked }, "");
    if (v) show(v);
    else on.checked = saved.enabled;
  };
  async function save(done: string) {
    const draft = form();
    const typedKey = key.value.trim();
    let v = await call<Voice>("save_voice", { voice: draft }, done);
    if (v && typedKey) {
      v = await call<Voice>(
        "save_voice_key",
        { provider: draft.provider, key: typedKey },
        done,
      );
      if (v && key.value.trim() === typedKey) key.value = "";
    }
    if (v) show(v);
    return v;
  }
  $("[data-voice-save]").onclick = () => save(t("settings.saved"));
  $("[data-voice-save-key]").onclick = async () => {
    if (!provider.value) return void say(t("voice.pickProvider"));
    if (!key.value.trim()) return void say(t("voice.keyFirst"));
    await save(t("voice.keySaved"));
  };
  $("[data-voice-test]").onclick = async () => {
    if (!name.value.trim()) return void say(t("voice.pickFirst"));
    if (!(await save(""))) return;
    await call("test_voice", {}, t("voice.testing"));
  };

  if (native) {
    void invoke<Voice>("get_voice").then(show, () =>
      say(t("voice.unreadable")),
    );
    void listen<Voice>("voice-changed", (e) => show(e.payload));
  } else show(empty);
}
