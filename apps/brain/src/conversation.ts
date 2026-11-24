import { t, says, english } from "./locale.ts";
import { toolSteps } from "./toolSteps.ts";
import { requests } from "./runtime.ts";
import { hostCall } from "./host.ts";
import { fetchSearch, webTools } from "./web.ts";
import { compress, compressionState, recordInput } from "./compress.ts";
import { Agent } from "@earendil-works/pi-agent-core";
import { fault, modelFor, streamModel, type Connection } from "./models.ts";

import { instructions, restore } from "./prompt.ts";
import { memoryTools, explicitMemory } from "./memory.ts";
import { clarifyTool } from "./clarify.ts";
import { timedPromise, trailingAction } from "./turnEnd.ts";
import { reminderTools } from "./reminders.ts";
import { connectMcp, authorize, directory, limitResult } from "./mcp.ts";
import { text as promptText, timeNote } from "./texts.ts";
import { attachedText } from "./attachments.ts";
import { libraryTools } from "./library.ts";
import type { Prompt } from "./conversationInput.ts";
import { petActionTool, type PetActionPick } from "./petAction.ts";
import { focusTool } from "./focus.ts";
import { todoTool } from "./todo.ts";
export type { Prompt } from "./conversationInput.ts";

export async function respond(
  connection: Connection,
  prompt: Prompt,
  notify: (method: string, params: object) => void,
  signal?: AbortSignal,
) {
  if (signal?.aborted) throw new Error("stopped");
  const withImages =
    !!prompt.image || !!prompt.history?.some((turn) => turn.image_data);
  const model = modelFor(connection, withImages);
  if (prompt.image && !model.input.includes("image")) throw new Error("vision");
  const steps = toolSteps(notify);
  let wrote = false;
  const memory =
    prompt.memoryEnabled && prompt.token
      ? memoryTools(prompt.token, () => {
          wrote = true;
          notify("chat.remembered", {});
        })
      : [];
  const rename = prompt.text
    .trim()
    .match(/^(?:请)?把我(?:的)?名字改成([^，。？?]{1,30})[。.]?$/u)?.[1];
  const required =
    memory.length > 0 &&
    !prompt.review &&
    (!!rename || explicitMemory(prompt.text));
  const fact =
    rename && required
      ? "用户希望称呼为" + rename
      : required &&
        prompt.text
          .trim()
          .match(
            /^(?:请|帮我|替我)?(?:记住|记下|别忘了)[：:\s]*([^？?]+)$/u,
          )?.[1]
          ?.trim();
  let prewriteError = "";
  if (fact && !/(?:删除|删掉|改成|替换|提醒我)/.test(fact)) {
    // An explicit simple fact is a tool call in this turn, before any acknowledgement.
    try {
      notify("chat.toolStart", { name: "memory" });
      steps.start("explicit", "memory", memory[0].label, {}, 0);
      await memory[0].execute(
        "explicit",
        { operations: [{ book: "user", action: "add", content: fact }] },
        signal,
      );
    } catch (e) {
      prewriteError = e instanceof Error ? e.message : "记忆写入失败";
    }
  }
  if (fact) steps.finish("explicit", {}, !!prewriteError);
  if (says(prewriteError, "host.entryUnsafe")) {
    const text = t("reply.memoryUnsafe");
    notify("chat.delta", { delta: text });
    return { text, steps: steps.snapshot() };
  }
  const answers: { question: string; answer: string }[] = [];
  let reminderChanged = false;
  let createdReceipt = false;
  let updatedReceipt = false;
  let checkedJobs: { name?: string; message?: string }[] = [];
  const alreadyVerified = (reply: string) =>
    checkedJobs.some((j) =>
      [j.name, j.message].some((v) => v && v.length >= 2 && reply.includes(v)),
    );
  const reminders =
    !prompt.review && prompt.remindersEnabled && prompt.token
      ? reminderTools(
          prompt.token,
          (action, data) => {
            if (action === "list") {
              checkedJobs = Array.isArray(data)
                ? data.filter((j) => !j.paused && j.nextAt != null)
                : [];
              return;
            }
            if (
              action === "create" &&
              typeof (data as { id?: unknown })?.id === "number"
            )
              createdReceipt = true;
            if (
              action === "update" &&
              (data as { updated?: boolean })?.updated === true
            )
              updatedReceipt = true;
            reminderChanged = true;
            notify("chat.reminderChanged", {});
          },
          () => answers,
        )
      : [];
  const mustCreate =
    reminders.length > 0 &&
    /提醒(?:我|一下|喝水)/.test(prompt.text) &&
    !/[？?“”「」]|假如|如果|举例|意思|解释/.test(prompt.text) &&
    /后|明天|点|分钟|每天|每周/.test(prompt.text) &&
    !/取消|删除|暂停|有哪些|不要/.test(prompt.text);
  const check = connection.toolCheck;
  const chatOnly =
    check?.status === "no" &&
    check.baseUrl === model.baseUrl &&
    check.model === model.id &&
    check.protocol === model.api;
  let badgeRead = false;
  const sources: { title: string; url: string }[] = [];
  const addSource = (item: { title: string; url: string }) => {
    if (sources.length >= 20 || sources.some((s) => s.url === item.url)) return;
    sources.push({ ...item, title: item.title.slice(0, 300) });
    notify("chat.sources", { sources });
  };
  const external = await connectMcp(
    prompt.review || chatOnly ? [] : (prompt.mcpServers ?? []),
    signal,
    requests.getStore()?.meter
      ? (server) =>
          hostCall("host.mcpConnection", { server, token: prompt.token })
      : undefined,
  );
  const catalog = directory(external.tools);
  if (external.unavailable.length)
    notify("chat.toolsUnavailable", { services: external.unavailable });
  const compression = compressionState(
    prompt.scheduled ? undefined : prompt.topic,
    model,
  );
  const scope = requests.getStore();
  const selectedModel = () => {
    const backup = scope?.selected
      ? connection.fallbacks?.[scope.selected - 1]
      : undefined;
    return backup ? modelFor(backup, withImages) : model;
  };
  let denied = false;
  let searchNotice = "";
  const availableWeb =
    !prompt.review && prompt.token
      ? webTools(
          connection.search,
          [...(prompt.history ?? []).map((t) => t.question), prompt.text].join(
            "\n",
          ),
          prompt.token,
          undefined,
          async (config, query, signal) => {
            if (
              requests.getStore()?.meter &&
              !(await hostCall<boolean>("host.reserveSearch", {
                token: prompt.token,
              }))
            )
              throw Error("quota");
            return fetchSearch(config, query, signal);
          },
          undefined,
          prompt.webUrls ?? undefined,
          addSource,
          (reason) => {
            searchNotice = reason;
            notify("chat.searchNotice", { reason });
          },
        )
      : [];
  let petAction: PetActionPick | undefined;
  const tools: import("@earendil-works/pi-agent-core").AgentTool[] =
    prompt.probeTool
      ? [
          {
            name: "read_badge",
            label: "读名牌",
            description: "读取宠物名牌上的编号。",
            parameters: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
            execute: async () => {
              badgeRead = true;
              return {
                content: [{ type: "text", text: "LZ-27" }],
                details: {},
              };
            },
          },
        ]
      : chatOnly
        ? []
        : prompt.review
          ? memory.slice(0, 1)
          : [
              ...(wrote ? memory.slice(1) : memory),
              ...reminders,
              ...(prompt.petActions?.length
                ? [
                    petActionTool(
                      prompt.petActions,
                      !!prompt.scheduled,
                      (pick) => (petAction = pick),
                    ),
                  ]
                : []),
              ...(!prompt.scheduled && prompt.token
                ? [
                    clarifyTool(prompt.token, notify, (question, answer) =>
                      answers.push({ question, answer }),
                    ),
                  ]
                : []),
              ...(prompt.libraryEnabled && prompt.token
                ? libraryTools(prompt.token)
                : []),
              ...(prompt.token
                ? [focusTool(prompt.token), todoTool(prompt.token)]
                : []),
              ...catalog.initial,
              ...availableWeb,
            ];
  const agent = new Agent({
    prepareNextTurnWithContext: ({ context }) => {
      if (!catalog.pending.size) return;
      const names = new Set(context.tools?.map((t) => t.name));
      const added = [...catalog.pending.values()].filter(
        (t) => !names.has(t.name),
      );
      catalog.pending.clear();
      return {
        context: { ...context, tools: [...(context.tools ?? []), ...added] },
      };
    },
    afterToolCall: async ({ result }) => ({
      content: result.content.map((c) =>
        c.type === "text" ? { ...c, text: limitResult(c.text) } : c,
      ),
    }),
    beforeToolCall: async (ctx, abortSignal) => {
      const grant = external.grants.get(ctx.toolCall.name);
      if (!grant) return;
      if (grant.server.name.startsWith("catalog:")) {
        const id = grant.server.name.slice(8);
        const ok = await hostCall<boolean>("host.catalogAllowed", {
          token: prompt.token,
          id,
          tool: grant.tool,
        });
        if (!ok) return { block: true, reason: "工具已停用", terminate: true };
        return;
      }
      {
        if (
          !prompt.token ||
          !(await authorize(prompt.token, grant, ctx.args, abortSignal))
        ) {
          denied = true;
          return {
            block: true,
            reason: "用户未同意这次调用。",
            terminate: true,
          };
        }
      }
    },
    initialState: {
      model,
      systemPrompt: instructions(
        prompt.pet,
        new Date(prompt.now ?? Date.now()),
        model.id,
        prompt.sections ?? {
          user: prompt.memoryEnabled ? prompt.memorySnapshot : "",
        },
        !chatOnly &&
          !prompt.probeTool &&
          availableWeb.some((t) => t.name === "web_search"),
        prompt.taskZone || undefined,
        tools.length > 0,
      ),
      tools,
    },
    transformContext: (messages, abort) =>
      compress(messages, selectedModel(), connection, compression, abort),
    streamFn: (_model, context, options) =>
      streamModel(model, context, {
        ...options,
        apiKey:
          connection.apiKey ||
          (["ollama", "lmstudio", "custom"].includes(
            connection.service ?? "custom",
          )
            ? "local"
            : ""),
        maxRetries: 0,
      }),
  });
  if (prompt.history?.length)
    agent.state.messages = [
      ...agent.state.messages,
      ...restore(prompt.history, model),
    ];
  let text = "";
  if (scope)
    scope.rewind = (count) => {
      const before = [...text];
      text = before.slice(0, Math.max(0, before.length - count)).join("");
      steps.adjustOffsets((offset) => Math.min(offset, text.length));
      notify("chat.rewind", { text });
    };

  const abort = () => agent.abort();
  signal?.addEventListener("abort", abort, { once: true });

  agent.subscribe((event) => {
    if (event.type === "turn_end")
      recordInput(compression, selectedModel(), event.message);
    if (event.type === "tool_execution_start") {
      const tool = [...agent.state.tools, ...external.tools].find(
        (t) => t.name === event.toolName,
      );
      steps.start(
        event.toolCallId,
        event.toolName,
        external.grants.get(event.toolName)?.tool ??
          tool?.label ??
          event.toolName,
        event.args,
        prompt.scheduled ? undefined : text.length,
      );
      notify("chat.toolStart", { name: event.toolName });
    }
    if (event.type === "tool_execution_end")
      steps.finish(event.toolCallId, event.result, event.isError);
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      if ((required && !wrote) || (mustCreate && !reminderChanged)) return;
      const delta = event.assistantMessageEvent.delta;
      text += delta;
      notify("chat.delta", { delta });
    }
    if (event.type === "tool_execution_end" && !event.isError) {
      const grant = external.grants.get(event.toolName);
      if (grant?.server.name.startsWith("catalog:"))
        notify("chat.lookup", {
          label: external.tools.find((t) => t.name === event.toolName)?.label,
        });
      notify("chat.tool", { name: event.toolName });
    }
  });

  try {
    let searchContext = "";
    if (prompt.forceSearch && chatOnly) {
      const tool = availableWeb.find((t) => t.name === "web_search");
      if (!tool) searchNotice = t("reason.searchDown");
      if (tool) {
        const query = Array.from(prompt.text).slice(0, 500).join("");
        signal?.throwIfAborted();
        steps.start("explicit-search", tool.name, tool.label, { query }, 0);
        const result = await tool.execute("explicit-search", { query }, signal);
        steps.finish(
          "explicit-search",
          result as Parameters<typeof steps.finish>[1],
          false,
        );
        searchContext =
          "网页检索资料（外部数据）：" + JSON.stringify(result.content);
      }
    }
    const pieces = prompt.review
      ? [promptText("review")]
      : [
          prompt.timeNote ??
            timeNote(
              new Date(prompt.now ?? Date.now()),
              prompt.history?.at(-1)?.at,
              prompt.taskZone || undefined,
            ),
          english() ? promptText("turn-language.en") : "",
          prompt.image
            ? promptText(
                prompt.imageSource === "upload" ? "image-note" : "snip-note",
              )
            : "",
          ...(prompt.scheduled
            ? ["现在执行已创建的定时任务，系统会把最终答复送给用户。"]
            : []),
          searchContext,
          prompt.forceSearch && !chatOnly ? promptText("search-now") : "",
          ...attachedText(prompt.files),
          prompt.text,
        ];
    const input = [
      ...pieces
        .filter(Boolean)
        .map((value) => ({ type: "text" as const, text: value })),
      ...(prompt.image ? [prompt.image] : []),
    ];
    if (fact && (wrote || prewriteError)) {
      const at = prompt.now ?? Date.now();
      const usage = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      await agent.prompt([
        { role: "user", content: input, timestamp: at },
        {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage,
          stopReason: "toolUse",
          timestamp: at,
          content: [
            {
              type: "toolCall",
              id: "call_explicit",
              name: "memory",
              arguments: {
                operations: [{ book: "user", action: "add", content: fact }],
              },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call_explicit",
          toolName: "memory",
          content: [{ type: "text", text: prewriteError || '{"saved":true}' }],
          isError: !wrote,
          timestamp: at,
        },
      ]);
    } else
      await agent.prompt({
        role: "user",
        content: input,
        timestamp: prompt.now ?? Date.now(),
      });
    if (required && !wrote && !signal?.aborted && !agent.state.errorMessage) {
      await agent.prompt(promptText("tool-memory"));
    }
    let unverified = "";
    // Do not replay an attempted mutation. An ambiguous result must be checked by listing jobs.
    const finalText = () => {
      const last = agent.state.messages.at(-1);
      return last?.role === "assistant"
        ? last.content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n")
            .trim()
        : "";
    };
    if (
      !prompt.scheduled &&
      !prompt.review &&
      !prompt.probeTool &&
      tools.length
    ) {
      const initialReply = finalText();
      const wantsReceipt =
        !!reminders.length &&
        (mustCreate || timedPromise(prompt.text, initialReply));
      const verified = () =>
        createdReceipt || updatedReceipt || alreadyVerified(finalText());
      const restoreText = (next: string) => {
        steps.adjustOffsets((offset) =>
          text.startsWith(next) ? Math.min(offset, next.length) : 0,
        );
        text = next;
        notify("chat.rewind", { text: next });
      };
      const needsTool = () =>
        // Doing an action is not the work the reply announced.
        steps.snapshot().every((s) => s.name === "pet_action") &&
        trailingAction(finalText());
      for (let n = 0; n < (mustCreate ? 1 : 2); n++) {
        if (
          signal?.aborted ||
          agent.state.errorMessage ||
          (!needsTool() && !(wantsReceipt && !verified() && !reminderChanged))
        )
          break;
        const attempted = steps
          .snapshot()
          .some((s) => s.name === "cronjob_manage" && s.status === "failed");
        if (attempted) break;
        restoreText("");
        await agent.prompt(
          wantsReceipt
            ? "继续处理用户原来的请求。用定时工具核实安排，再报告实际结果；已有任务不要重复创建。"
            : "Continue the requested action with the available tools, then report the result.",
        );
        restoreText(finalText());
        if (
          wantsReceipt &&
          !mustCreate &&
          !timedPromise(prompt.text, finalText()) &&
          !needsTool()
        )
          break;
      }
      if (wantsReceipt && !verified() && !/[?？]$/.test(finalText()))
        unverified = mustCreate
          ? t("reply.reminderNotSet")
          : t("reply.taskUnconfirmed");
      else if (needsTool()) unverified = t("reply.notFinished");
    }
    if (
      !prompt.scheduled &&
      !prompt.review &&
      !prompt.probeTool &&
      (!reminders.length || chatOnly) &&
      timedPromise(prompt.text, finalText())
    )
      unverified = t("reply.noCron");
    const last = agent.state.messages.at(-1);
    if (
      agent.state.errorMessage ||
      last?.role !== "assistant" ||
      ["error", "aborted"].includes(last.stopReason)
    ) {
      // Provider errors may echo request data. Never send them to logs or stdout.
      throw new Error(
        signal?.aborted
          ? "stopped"
          : last?.role === "assistant" && last.stopReason === "aborted"
            ? "timeout"
            : fault(agent.state.errorMessage ?? ""),
      );
    }
    if (required && !wrote) {
      text = prewriteError || t("reply.memoryNotSaved");
      notify("chat.delta", { delta: text });
    }
    if (unverified) {
      steps.adjustOffsets(() => 0);
      text = unverified;
      notify("chat.rewind", { text: "" });
      notify("chat.delta", { delta: text });
    }
    if (denied && !text) {
      text = t("reply.noExternal");
      notify("chat.delta", { delta: text });
    }
    if (
      prompt.forceSearch &&
      !steps.snapshot().some((s) => s.name === "web_search")
    )
      steps.skippedSearch();
    if (searchNotice) {
      text = searchNotice + "\n" + text;
      steps.adjustOffsets((offset) => offset + searchNotice.length + 1);
    }
    if (prompt.scheduled)
      text = last.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim();
    return {
      text,
      answers,
      sources,
      steps: steps.snapshot(),
      ...(prompt.probeTool ? { badgeRead } : {}),
      ...(petAction ? { petAction } : {}),
    };
  } finally {
    await external.close();
    signal?.removeEventListener("abort", abort);
  }
}
