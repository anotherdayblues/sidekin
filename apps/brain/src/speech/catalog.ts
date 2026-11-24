import { t } from "../locale.ts";
import catalog from "../../../shared/systemVoices.json" with { type: "json" };
import services from "../../../shared/voiceServices.json" with { type: "json" };

export class VoiceCatalogError extends Error {}

type Provider = keyof typeof services;
type Draft = {
  provider: Provider;
  apiKey: string;
  baseUrl: string;
  model: string;
  resourceId: string;
};
export async function voiceCatalog(d: Draft, request = fetch) {
  const service = services[d.provider];
  if (!service) throw new VoiceCatalogError(t("voice.pickProvider"));
  const url = new URL(d.baseUrl || service.baseUrl);
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol === "ws:") url.protocol = "http:";
  const model = d.model || service.model;
  const voices = new Map<string, string>();
  function add(id: unknown, name: unknown) {
    if (typeof id === "string" && id.trim() && id.length <= 200)
      voices.set(id, typeof name === "string" && name.trim() ? name : id);
  }
  let note = "";
  const signal = AbortSignal.timeout(15000);
  async function get(endpoint: URL, body?: object) {
    const headers: Record<string, string> = {};
    if (d.apiKey) {
      if (d.provider === "elevenlabs") headers["xi-api-key"] = d.apiKey;
      else headers.Authorization = "Bearer " + d.apiKey;
    }
    if (body) headers["Content-Type"] = "application/json";
    let response: Response;
    try {
      response = await request(endpoint, {
        method: body ? "POST" : "GET",
        headers,
        body: body && JSON.stringify(body),
        signal,
        redirect: "error",
      });
    } catch {
      throw new VoiceCatalogError(t("voice.connectFailed"));
    }
    if (!response.ok)
      throw new VoiceCatalogError(
        response.status === 401 || response.status === 403
          ? t("voice.checkKey")
          : t("voice.noList", { status: response.status }),
      );
    return response.json();
  }
  if (d.provider === "elevenlabs" || d.provider === "minimax") {
    if (!d.apiKey) throw new VoiceCatalogError(t("voice.keyBeforeList"));
    if (d.provider === "elevenlabs") {
      const api = new URL("/v2/voices?page_size=100", url);
      const tokens = new Set<string>();
      for (;;) {
        const page = await get(api);
        for (const v of page.voices) add(v.voice_id, v.name);
        if (!page.has_more) break;
        const token = page.next_page_token;
        if (!token || tokens.has(token))
          throw new VoiceCatalogError(t("voice.partialList"));
        tokens.add(token);
        api.searchParams.set("next_page_token", token);
      }
    } else {
      const page = await get(new URL("/v1/get_voice", url), {
        voice_type: "all",
      });
      if (page.base_resp?.status_code !== 0)
        throw new VoiceCatalogError(t("voice.minimaxFailed"));
      for (const group of [
        page.system_voice,
        page.voice_cloning,
        page.voice_generation,
      ])
        for (const v of group ?? [])
          add(v.voice_id, v.voice_name || v.description?.[0]);
    }
  } else if (d.provider === "openai") {
    if (url.origin === "https://api.openai.com") {
      const names = [
        "alloy",
        "ash",
        "coral",
        "echo",
        "fable",
        "onyx",
        "nova",
        "sage",
        "shimmer",
      ];
      if (model.startsWith("gpt-4o-mini-tts"))
        names.push("ballad", "verse", "marin", "cedar");
      if (
        model.startsWith("gpt-4o-mini-tts") ||
        ["tts-1", "tts-1-hd"].includes(model)
      )
        for (const name of names) add(name, name);
    } else {
      const api = new URL(url);
      api.pathname = api.pathname.replace(/\/$/, "") + "/audio/voices";
      const page = await get(api);
      for (const v of page.voices ?? page.data ?? page)
        typeof v === "string"
          ? add(v, v)
          : add(v.voice_id ?? v.id ?? v.name, v.name);
    }
  } else {
    const system =
      catalog[
        (d.provider === "aliyun"
          ? model
          : d.resourceId || "seed-tts-2.0") as keyof typeof catalog
      ];
    for (const [id, name] of Object.entries(system ?? {})) add(id, name);
    note = t("voice.presets");
    if (d.provider === "aliyun" && d.apiKey) {
      try {
        for (let index = 0; ; index++) {
          const page = await get(
            new URL("/api/v1/services/audio/tts/customization", url),
            {
              model: "voice-enrollment",
              input: { action: "list_voice", page_index: index, page_size: 10 },
            },
          );
          const rows = page.output.voice_list;
          for (const v of rows)
            if (v.status === "OK" && v.voice_id?.startsWith(model + "-"))
              add(v.voice_id, v.voice_prompt || v.voice_id);
          if (rows.length < 10) break;
        }
        note = "";
      } catch {
        note = t("voice.presetsOnly");
      }
    }
  }
  return { voices: Array.from(voices, ([id, name]) => ({ id, name })), note };
}
