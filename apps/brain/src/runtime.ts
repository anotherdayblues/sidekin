import { reportedUsage } from "./reportedUsage.ts";
import { presets, type Service } from "../../shared/companion.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import {
  type AssistantMessage,
  type Api,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { hostCall } from "./host.ts";
import { fault, modelFor, rawStream, type Connection } from "./models.ts";

type Scope = {
  connection: Connection;
  purpose: string;
  meter: boolean;
  selected: number;
  notify: (method: string, data: object) => void;
  rewind?: (count: number) => void;
};
export const requests = new AsyncLocalStorage<Scope>();
export function background(purpose: string) {
  return (
    purpose === "scheduled" || purpose === "review" || purpose === "proactive"
  );
}
async function account(
  scope: Scope | undefined,
  model: Model<Api>,
  msg: AssistantMessage,
  report: ReturnType<typeof reportedUsage>,
) {
  if (!scope?.meter) return;
  const official =
    presets[model.provider as Service]?.[1]?.replace(/\/+$/, "") ===
    model.baseUrl.replace(/\/+$/, "");
  const priced = Object.values(model.cost).some(
    (n) =>
      (typeof n === "number" && n > 0) || (Array.isArray(n) && n.length > 0),
  );
  await hostCall("host.usage", {
    purpose: scope.purpose,
    tokens: report.tokens,
    cacheRead: report.cacheRead,
    cost:
      msg.usage.cost.totalFromProvider ||
      (priced && official && report.itemized)
        ? msg.usage.cost.total
        : null,
  });
  scope.notify("usage.changed", {});
}
export function streamRequest(
  model: Model<Api>,
  ctx: TranscriptContext,
  options: SimpleStreamOptions,
) {
  const output = createAssistantMessageEventStream(),
    scope = requests.getStore();
  const stop = options.signal;
  async function produce() {
    const candidates = [
      scope?.connection,
      ...(scope?.connection.fallbacks ?? []).slice(0, 2),
    ];
    const needsVision =
      scope?.purpose === "vision" ||
      ctx.messages.some(
        (message) =>
          Array.isArray(message.content) &&
          message.content.some((part) => part.type === "image"),
      );
    for (let i = scope?.selected ?? 0; i < candidates.length; i++) {
      const config = candidates[i],
        next = i && config ? modelFor(config, needsVision) : model;
      if (i && needsVision && !next.input.includes("image")) continue;
      if (stop?.aborted) throw Error("stopped");
      if (
        scope?.meter &&
        background(scope.purpose) &&
        (await hostCall<{ reached: boolean }>("host.budget", {})).reached
      )
        throw Error("budget");
      const controller = new AbortController(),
        abort = () => controller.abort();
      let timeout = false,
        count = 0;
      const timed = () => {
        timeout = true;
        controller.abort();
      };
      let clock = setTimeout(timed, 60000);
      stop?.addEventListener("abort", abort, { once: true });
      let failure = "model";
      const report = reportedUsage(next.api);
      try {
        const source = await rawStream(next, ctx, {
          ...options,
          onProviderStreamEvent: (event, model) => {
            report.observe(event);
            return options.onProviderStreamEvent?.(event, model);
          },
          signal: controller.signal,
          apiKey: i ? config!.apiKey || "local" : options.apiKey,
          maxRetries: 0,
        });
        for await (const e of source) {
          clearTimeout(clock);
          clock = setTimeout(timed, 60000);
          if (e.type === "error") {
            await account(scope, next, e.error, report);
            failure = stop?.aborted
              ? "stopped"
              : timeout
                ? "timeout"
                : fault(e.error.errorMessage ?? "");
            if (
              !["network", "busy", "timeout", "server"].includes(failure) ||
              i === candidates.length - 1
            ) {
              const error = {
                ...e.error,
                errorMessage: failure,
                stopReason: stop?.aborted
                  ? ("aborted" as const)
                  : ("error" as const),
              };
              output.push({ ...e, reason: error.stopReason, error });
              return;
            }
            break;
          }
          if (e.type === "done") {
            await account(scope, next, e.message, report);
            output.push(e);
            return;
          }
          if (e.type === "text_delta") count += [...e.delta].length;
          output.push(e);
        }
      } catch (err) {
        failure = stop?.aborted
          ? "stopped"
          : timeout
            ? "timeout"
            : fault(String(err));
        if (!["network", "busy", "timeout", "server"].includes(failure))
          throw Error(failure);
      } finally {
        clearTimeout(clock);
        stop?.removeEventListener("abort", abort);
      }
      const nextIndex = candidates.findIndex(
        (b, idx) =>
          idx > i &&
          b &&
          (scope?.purpose !== "vision" ||
            modelFor(b, true).input.includes("image")),
      );
      if (nextIndex < 0) throw Error(failure);
      if (scope) {
        if (count) scope.rewind?.(count);
        scope.selected = nextIndex;
        scope.notify("model.fallback", { model: candidates[nextIndex]!.model });
      }
      i = nextIndex - 1;
    }
    throw Error("model");
  }
  void produce().catch((e) => {
    const aborted = stop?.aborted,
      reason = aborted ? ("aborted" as const) : ("error" as const);
    output.push({
      type: "error",
      reason,
      error: {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        stopReason: reason,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        timestamp: Date.now(),
        errorMessage: e instanceof Error ? e.message : "model",
      },
    });
  });
  return output;
}
