import { t, setLocale } from "./locale.ts";
import { voiceCatalog, VoiceCatalogError } from "./speech/catalog.ts";
import { hasDirectSearch } from "../../shared/searchServices.ts";
import { disconnectMcp } from "./mcp.ts";
import { createInterface } from "node:readline";
import { requests } from "./runtime.ts";
import { fetchSearch } from "./web.ts";
import { translate } from "./translate.ts";
import { answerQuestion } from "./clarify.ts";
import { respond } from "./conversation.ts";
import {
  listModels,
  modelFor,
  fault,
  statusFault,
  type Connection,
} from "./models.ts";
import { errorCodes, presets } from "../../shared/companion.ts";
const active = new Map<string | number, AbortController>();

const send = (message: object) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
import { hostCall, receiveHost } from "./host.ts";
import { speak, validVoice, type Speech } from "./speech/speech.ts";
let hostClock = false;
let meter = false;
let initialized = false;
// The reply being spoken now, if any (plan/10 §9).
let speaking: Speech | undefined;
let connection: Connection | undefined;

async function dispatch(line: string) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    send({ id: null, error: { code: -32700, message: "无效 JSON" } });
    return;
  }
  const id = request?.id;
  if (
    request?.jsonrpc === "2.0" &&
    request.method === undefined &&
    (Object.hasOwn(request, "result") || Object.hasOwn(request, "error"))
  ) {
    receiveHost(id, request.result, request.error?.message);
    return;
  }
  if (
    request?.jsonrpc !== "2.0" ||
    typeof request.method !== "string" ||
    (id !== undefined &&
      id !== null &&
      typeof id !== "string" &&
      typeof id !== "number")
  ) {
    send({ id: null, error: { code: -32600, message: "无效请求" } });
    return;
  }
  const reply = (payload: object) => {
    if (id !== undefined) send({ id, ...payload });
  };
  const fail = (code: number, message: string) =>
    reply({ error: { code, message } });
  const params = request.params ?? {};
  if (request.method === "initialize" || request.method === "configure") {
    if (!initialized && request.method === "configure")
      return fail(-32001, "请先初始化");
    if (initialized && request.method === "initialize")
      return fail(-32001, "已经初始化");
    if (
      typeof params.apiKey !== "string" ||
      (params.model !== undefined && typeof params.model !== "string") ||
      (params.baseUrl !== undefined && typeof params.baseUrl !== "string")
    )
      return fail(-32602, "无效配置");
    if (params.service !== undefined && !Object.hasOwn(presets, params.service))
      return fail(-32602, "未知服务");
    if (params.baseUrl && !/^https?:\/\//.test(params.baseUrl))
      return fail(-32602, "无效地址");
    connection = {
      ...params,
      model: params.model ?? "",
      baseUrl: params.baseUrl ?? "",
      canSee: params.canSee ?? params.service === undefined,
    };
    if (
      connection &&
      !params.search &&
      params.followSearch &&
      hasDirectSearch(params.service, params.baseUrl ?? "")
    ) {
      connection.search = {
        provider: params.service,
        baseUrl: "",
        apiKey: connection.apiKey,
      };
    }
    meter = params.meterUsage === true;
    setLocale(params.locale);
    hostClock = params.hostClock === true;
    initialized = true;
    return reply({ result: { ready: true } });
  }
  if (!initialized) return fail(-32001, "请先初始化");
  if (request.method === "disconnect_mcp") {
    await disconnectMcp(params.name);
    return reply({ result: true });
  }
  if (request.method === "ping") return reply({ result: "pong" });
  if (request.method === "speech_stop") {
    speaking?.cancel();
    speaking = undefined;
    return reply({ result: true });
  }
  // A line said on its own: a reminder, or 试听 in settings.
  if (request.method === "speak") {
    if (!validVoice(params.speak) || typeof params.text !== "string")
      return fail(-32602, "无效语音");
    speaking?.cancel();
    speaking = speak(params.speak, (method, data) =>
      send({ method, params: data }),
    );
    speaking.push(params.text);
    speaking.end();
    return reply({ result: true });
  }
  if (request.method === "voice_catalog") {
    try {
      return reply({ result: await voiceCatalog(params) });
    } catch (e) {
      return fail(
        -32003,
        e instanceof VoiceCatalogError ? e.message : t("voice.noCatalog"),
      );
    }
  }
  if (!connection) return fail(-32002, t("brain.configureFirst"));
  if (request.method === "answer_question")
    return reply({
      result: answerQuestion(params.token, params.id, params.answer),
    });
  if (request.method === "cancel") {
    active.get(params.id)?.abort();
    return reply({ result: true });
  }
  if (request.method === "models")
    return reply({ result: await listModels({ ...connection, ...params }) });
  if (request.method === "search_test") {
    if (!connection.search) return fail(-32602, "search");
    try {
      await fetchSearch(
        connection.search,
        "随伴连接测试",
        undefined,
        async (input, init) => {
          const response = await fetch(input, init);
          if (!response.ok) throw Error(statusFault(response.status));
          return response;
        },
      );
      return reply({ result: { ok: true } });
    } catch (e) {
      const code = fault(String(e));
      return fail(-32003, code === "model" ? "search" : code);
    }
  }
  if (request.method === "visionInfo")
    return reply({
      result: { canSee: modelFor(connection, true).input.includes("image") },
    });
  const probe = request.method === "test_tools";
  const test = request.method === "test" || probe;
  const currentConnection = test
    ? { ...connection, fallbacks: [], search: undefined }
    : connection;
  const review = request.method === "review";
  const translating = request.method === "translate";
  if (
    !test &&
    !review &&
    !translating &&
    request.method !== "preview" &&
    request.method !== "vision" &&
    request.method !== "chat"
  )
    return fail(-32601, "未知方法");
  if (request.method === "vision" && !params.image)
    return fail(-32602, "缺少图片");
  if (test)
    params.text = probe ? "调用 read_badge 后只回复读到的编号。" : "只回复好";
  if (probe) params.probeTool = true;
  if (
    typeof params.text !== "string" ||
    (params.probeTool !== undefined && typeof params.probeTool !== "boolean") ||
    (params.image !== undefined &&
      !(
        params.image?.type === "image" &&
        typeof params.image.data === "string" &&
        ["image/png", "image/jpeg", "image/webp"].includes(
          params.image.mimeType,
        )
      ))
  )
    return fail(-32602, "无效消息");
  let speech: Speech | undefined;
  try {
    const controller = new AbortController();
    active.set(params.token ?? id, controller);
    const started = performance.now();
    let firstMs: number | undefined;
    if (hostClock && (request.method === "chat" || review))
      params.now = await hostCall<number>("host.time", {});
    if (review) params.review = true;
    const run = translating ? translate : respond;
    const post = (method: string, data: object) =>
      send({ method, params: { requestId: id, token: params.token, ...data } });
    // A chat with a voice speaks its reply as it streams; a new one stops
    // whatever was still being said.
    if (request.method === "chat" && validVoice(params.speak)) {
      speaking?.cancel();
      speaking = speech = speak(params.speak, post);
    } else delete params.speak; // Ignore incomplete voice configurations.
    const notify = (method: string, data: object) => {
      if (method === "chat.delta")
        firstMs ??= Math.round(performance.now() - started);
      if (method === "chat.delta")
        speech?.push((data as { delta: string }).delta);
      if (method === "chat.rewind")
        speech?.rewind((data as { text: string }).text);
      if (!test && !review) post(method, data);
    };
    const purpose = params.scheduled
      ? "scheduled"
      : review
        ? "review"
        : translating
          ? "translate"
          : request.method === "vision"
            ? "vision"
            : "chat";
    const result = await requests.run(
      {
        connection: currentConnection,
        purpose,
        meter: meter && !test,
        selected: 0,
        notify,
      },
      () => run(currentConnection, params, notify, controller.signal),
    );
    if (
      meter &&
      ["chat", "translate", "vision"].includes(request.method) &&
      (await hostCall<{ warn: boolean }>("host.budget", { warn: true })).warn
    )
      notify("usage.limit", {});
    speech?.end();
    reply({
      result: test
        ? {
            ...(probe
              ? {
                  toolStatus:
                    "badgeRead" in result &&
                    result.badgeRead &&
                    result.text.includes("LZ-27")
                      ? "yes"
                      : "no",
                }
              : {}),
            firstMs,
            model: currentConnection.model,
            canSee: modelFor(currentConnection).input.includes("image"),
          }
        : result,
    });
  } catch (e) {
    speech?.cancel();
    const reason =
      e instanceof Error &&
      (errorCodes as readonly string[]).includes(e.message)
        ? e.message
        : "model";
    fail(-32003, reason);
  } finally {
    active.delete(params.token ?? id);
  }
}

async function main() {
  for await (const line of createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  })) {
    void dispatch(line).catch(() =>
      send({ id: null, error: { code: -32603, message: "model" } }),
    );
  }
}
void main().catch(() => {
  process.exitCode = 1;
});
