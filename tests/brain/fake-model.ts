// A loopback OpenAI-compatible endpoint for stage tests. Each request consumes one step.
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

type Step =
  | { chunks: string[]; tokens?: number; cachedTokens?: number }
  | { tool: string; intro?: string; args?: object; tokens?: number; cachedTokens?: number }
  | { error: number }
  | { stall: true };
export async function fakeModel(steps: Step[]) {
  const requests: { path?: string; body: any }[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, body: JSON.parse(body) });
    const step = steps.shift();
    if (!step || "error" in step) {
      res.writeHead(step && "error" in step ? step.error : 500, {
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify({ error: { message: "scripted error" } }));
      return;
    }
    if ("stall" in step) return;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const emit = (delta: object, finish_reason: string | null = null) =>
      res.write(
        "data: " +
          JSON.stringify({
            id: "chatcmpl-stage0",
            object: "chat.completion.chunk",
            created: 1,
            model: "fixture",
            choices: [{ index: 0, delta, finish_reason }],
          }) +
          "\n\n",
      );
    emit({ role: "assistant" });
    if ("tool" in step) {
      if (step.intro) emit({ content: step.intro });
      emit({
        tool_calls: [
          {
            index: 0,
            id: "call_pet",
            type: "function",
            function: {
              name: step.tool,
              arguments: JSON.stringify(step.args ?? {}),
            },
          },
        ],
      });
      emit({}, "tool_calls");
    } else {
      for (const content of step.chunks) {
        emit({ content });
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      emit({}, "stop");
    }
    if (step.tokens)
      res.write(
        "data: " +
          JSON.stringify({
            id: "qa",
            choices: [],
            usage: {
              prompt_tokens: step.tokens - 1,
              ...(step.cachedTokens !== undefined && {
                prompt_tokens_details: { cached_tokens: step.cachedTokens },
              }),
              completion_tokens: 1,
              total_tokens: step.tokens,
            },
          }) +
          "\n\n",
      );
    res.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    requests,
    baseUrl:
      "http://127.0.0.1:" + (server.address() as AddressInfo).port + "/v1",
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}
