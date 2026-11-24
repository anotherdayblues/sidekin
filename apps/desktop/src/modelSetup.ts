import { t, tn, named } from "./i18n.ts";
import { modelSetupTemplate } from "./modelSetupTemplate.ts";
import { comboBox } from "./combo.ts";
import { invoke } from "@tauri-apps/api/core";
import { native } from "./bridge.ts";
import {
  services,
  type Service,
  type ModelDraft,
  type Protocol,
  type CompanionSettings,
} from "../../shared/companion.ts";
import { errorText } from "./errorText.ts";
import "./modelSetup.css";

interface View {
  draft: ModelDraft;
  hasKey: boolean;
  canClear?: boolean;
  revision: string;
  active: boolean;
}
const draftFrom = (s: CompanionSettings): ModelDraft => ({
  service: s.service,
  baseUrl: s.baseUrl,
  model: s.model,
  visionModel: s.visionModel,
  canSee: s.canSee,
  contextWindow: s.contextWindow,
  protocol: s.protocol || (services[s.service].protocol as Protocol),
});
const message = (e: unknown) =>
  errorText[String(e).replace(/^Error: /, "")] ??
  String(e).replace(/^Error: /, "");

export function modelSetup(
  app: HTMLElement,
  current: () => CompanionSettings,
  onApplied: (s: CompanionSettings) => void,
) {
  const dialog = document.createElement("dialog");
  dialog.className = "model-setup";
  dialog.innerHTML = modelSetupTemplate;
  app.append(dialog);
  const q = <T extends HTMLElement>(selector: string) =>
    dialog.querySelector<T>(selector)!;
  const form = q<HTMLFormElement>("[data-editor]"),
    grid = q(".model-services"),
    result = q<HTMLOutputElement>("[data-result]");
  const field = (name: string) =>
    form.elements.namedItem(name) as HTMLInputElement;
  comboBox(field("chat-model"));
  comboBox(field("vision-model"));
  let selected: Service = current().service,
    view: View | undefined,
    busy = false,
    readError = false,
    generation = 0,
    receipt: Record<string, View> = {};
  function redraw() {
    const info = services[selected],
      has = !!view?.hasKey,
      secret = field("secret"),
      nextAction = q("[data-next-action]");
    q("[data-key-label]").textContent = info.keyRequired
      ? "API Key"
      : t("model.keyOptional");
    secret.placeholder = has ? t("model.keySaved") : t("model.newKey");
    nextAction.textContent = has && !view?.active ? t("model.nextStep") : "";
    nextAction.hidden = !nextAction.textContent;
    field("endpoint").readOnly = selected !== "custom";
    q("[data-key-status]").textContent = readError
      ? t("model.readFailedRetry")
      : has
        ? view?.active
          ? t("model.keyInUse")
          : t("model.keyUnverified")
        : info.keyRequired
          ? t("model.noKey")
          : t("model.noKeyLocal");
    q("[data-clear-key]").hidden = !(view?.canClear ?? has);
    q<HTMLButtonElement>("[data-save-key]").disabled =
      busy || !field("secret").value.trim();
    q<HTMLButtonElement>("[data-test]").disabled = busy;
    q<HTMLButtonElement>("[data-models]").disabled = busy;
    q(".model-destination").textContent = t("model.destination", {
      url: field("endpoint").value.trim() || t("model.yourAddress"),
    });
    q("[data-protocol]").hidden = selected !== "custom";
  }
  function read(): ModelDraft {
    return {
      service: selected,
      baseUrl: field("endpoint").value.trim(),
      model: field("chat-model").value.trim(),
      visionModel: field("vision-model").value.trim(),
      protocol: field("protocol").value as Protocol,
      canSee: field("can-see").checked,
      contextWindow: field("context-size").valueAsNumber,
    };
  }
  const bind = (d: ModelDraft) =>
    d.service + " " + d.baseUrl.replace(/\/+$/, "");
  function previewView(d: ModelDraft): View {
    return (
      receipt[bind(d)] ?? {
        draft: d,
        hasKey: false,
        revision: "",
        active: false,
      }
    );
  }
  async function load(draft?: ModelDraft) {
    const id = ++generation;
    readError = false;
    lock(true);
    result.textContent = "";
    q("[data-confirm-clear]").hidden = true;
    try {
      const data = native
        ? await invoke<View>("model_setup_view", {
            service: selected,
            draft: draft ?? null,
          })
        : previewView(
            draft ??
              (selected === current().service
                ? draftFrom(current())
                : {
                    service: selected,
                    baseUrl: services[selected].baseUrl,
                    model: "",
                    visionModel: "",
                    canSee: false,
                    contextWindow: 32768,
                    protocol: services[selected].protocol as Protocol,
                  }),
          );
      if (id !== generation || !dialog.open) return;
      view = data;
      const d = data.draft;
      field("endpoint").value = d.baseUrl;
      field("protocol").value = d.protocol;
      field("chat-model").value = d.model;
      field("vision-model").value = d.visionModel;
      field("can-see").checked = d.canSee;
      field("context-size").value = String(d.contextWindow);
      field("secret").value = "";
      const { lists } = await import("../../shared/catalog.ts");
      if (id !== generation) return;
      const names = Object.values(lists[selected] ?? {}).map((m) => m.id);
      q<HTMLDataListElement>("#setup-chat-models").replaceChildren(
        ...names.map((n) => new Option(n, n)),
      );
      q("[data-list-note]").textContent = names.length
        ? t("model.builtinList")
        : t("model.typeName");
      redraw();
    } catch (e) {
      if (id === generation) {
        view = undefined;
        readError = true;
        result.textContent = message(e);
        q("[data-key-status]").textContent = t("model.readFailed");
      }
    } finally {
      if (id === generation) lock(false);
    }
  }
  async function openService(service: Service) {
    selected = service;
    readError = false;
    view = undefined;
    form.hidden = false;
    q("[data-services]").hidden = true;
    q("[data-back]").hidden = false;
    q("h2").textContent = named("service." + service, services[service].label);
    // Populate a matching draft before any asynchronous state lookup.
    const d =
      service === current().service
        ? draftFrom(current())
        : {
            ...draftFrom(current()),
            service,
            baseUrl: services[service].baseUrl,
            model: "",
            visionModel: "",
            protocol: services[service].protocol as Protocol,
          };
    field("endpoint").value = d.baseUrl;
    field("chat-model").value = d.model;
    field("vision-model").value = d.visionModel;
    field("protocol").value = d.protocol;
    field("context-size").value = String(d.contextWindow);
    field("secret").value = "";
    field("can-see").checked = d.canSee;
    redraw();
    await load();
  }
  function first() {
    generation++;
    readError = false;
    lock(false);
    view = undefined;
    field("secret").value = "";
    form.hidden = true;
    q("[data-services]").hidden = false;
    q("[data-back]").hidden = true;
    q("h2").textContent = t("onboard.pickService");
    grid.replaceChildren(
      ...Object.entries(services).map(([id, s]) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = named("service." + id, s.label);
        b.dataset.service = id;
        b.setAttribute("aria-pressed", String(id === current().service));
        b.onclick = () => void openService(id as Service);
        return b;
      }),
    );
  }
  function close() {
    generation++;
    field("secret").value = "";
    dialog.close();
  }
  q("[data-close]").onclick = close;
  q("[data-cancel]").onclick = first;
  q("[data-back]").onclick = first;
  dialog.oncancel = () => {
    generation++;
    field("secret").value = "";
  };
  function lock(on: boolean) {
    busy = on;
    for (const e of form.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
      "input,select,button",
    ))
      e.disabled = on;
    q<HTMLButtonElement>("[data-back]").disabled = on;
    redraw();
  }
  async function perform(action: () => Promise<void>) {
    if (busy) return;
    const id = generation;
    lock(true);
    result.textContent = "";
    try {
      await action();
    } catch (e) {
      if (id === generation) result.textContent = message(e);
    } finally {
      if (id === generation) lock(false);
    }
  }
  function ready() {
    if (field("secret").value.trim()) throw Error(t("model.saveKeyFirst"));
    if (!view) throw Error(t("model.readFirst"));
    const d = read();
    if (bind(d) !== bind(view.draft)) throw Error(t("model.addressChanged"));
    return { draft: d, revision: view.revision };
  }
  field("secret").oninput = redraw;
  for (const name of [
    "chat-model",
    "vision-model",
    "context-size",
    "can-see",
    "protocol",
  ])
    field(name).oninput = () => {
      result.textContent = "";
      redraw();
    };
  field("endpoint").oninput = () => {
    generation++;
    view = undefined;
    field("secret").value = "";
    result.textContent = "";
    redraw();
  };
  field("endpoint").onchange = () => void load(read());
  async function saveKey() {
    const d = read(),
      key = field("secret").value,
      id = generation;
    const saved = native
      ? await invoke<View>("model_setup_save_key", { draft: d, key })
      : {
          draft: d,
          hasKey: true,
          revision: String(Date.now()),
          active: false,
        };
    if (id !== generation) return;
    if (!saved.hasKey) throw Error(t("model.keyNotSaved"));
    view = saved;
    if (!native) receipt[bind(d)] = saved;
    field("secret").value = "";
    result.textContent = t("model.keySavedNext");
    redraw();
  }
  q("[data-save-key]").onclick = () => void perform(saveKey);
  q("[data-clear-key]").onclick = () => {
    q("[data-confirm-clear]").hidden = false;
  };
  q("[data-keep]").onclick = () => {
    q("[data-confirm-clear]").hidden = true;
  };
  q("[data-confirm]").onclick = () =>
    void perform(async () => {
      const input = ready(),
        id = generation;
      const cleared = native
        ? await invoke<View>("model_setup_clear_key", input)
        : { draft: input.draft, hasKey: false, revision: "", active: false };
      if (id !== generation) return;
      view = cleared;
      if (!native) delete receipt[bind(input.draft)];
      field("secret").value = "";
      q("[data-confirm-clear]").hidden = true;
      result.textContent = t("model.keyCleared");
      if (native)
        onApplied(await invoke<CompanionSettings>("companion_settings"));
      redraw();
    });
  q("[data-models]").onclick = () =>
    void perform(async () => {
      const input = ready(),
        id = generation,
        note = q("[data-list-note]");
      note.textContent = t("model.fetching");
      try {
        const response = native
          ? await invoke<{ models: string[]; source: string; error?: string }>(
              "model_setup_models",
              input,
            )
          : { models: ["preview-chat", "preview-vision"], source: "preview" };
        if (id !== generation) return;
        if (response.error) {
          note.textContent = t("model.listFailed");
          throw Error(message(response.error));
        }
        q<HTMLDataListElement>("#setup-chat-models").replaceChildren(
          ...response.models.map((n) => new Option(n, n)),
        );
        note.textContent = response.models.length
          ? tn("model.listCount", response.models.length)
          : t("model.listEmpty");
      } catch (e) {
        if (id === generation) note.textContent = t("model.listFailed");
        throw e;
      }
    });
  q("[data-test]").onclick = () =>
    void perform(async () => {
      const id = generation;
      if (field("secret").value.trim()) await saveKey();
      if (id !== generation) return;
      const input = ready();
      if (!input.draft.model) throw Error(t("model.enterName"));
      result.textContent = t("model.testing");
      const tested = native
        ? await invoke<{ ticket: string; firstMs: number; model: string }>(
            "model_setup_test",
            input,
          )
        : { ticket: "preview", firstMs: 35, model: input.draft.model };
      if (id !== generation || !dialog.open) return;
      const next = native
        ? await invoke<CompanionSettings>("model_setup_use", {
            ticket: tested.ticket,
          })
        : { ...current(), ...input.draft, enabled: true, modelVerified: true };
      if (id !== generation || !dialog.open) return;
      onApplied(next);
      if (view) view.active = true;
      result.textContent = t("model.verified", {
        model: tested.model,
        ms: tested.firstMs ?? "—",
      });
      redraw();
      close();
    });
  form.onsubmit = (e) => {
    e.preventDefault();
    q<HTMLButtonElement>("[data-test]").click();
  };
  return {
    open() {
      if (!dialog.open) dialog.showModal();
      first();
    },
    close,
  };
}
