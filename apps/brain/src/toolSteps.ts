import { t } from "./locale.ts";
import type { ToolStep, WebPage } from "../../shared/toolSteps.ts";

// Why a step failed, as the brain and its tools say it in Chinese, shown to
// the user in their language.
const REASONS = {
  没有找到可读的网页正文: "reason.noText",
  这个地址没有可读的网页正文: "reason.noTextHere",
  对方拒绝访问: "reason.refused",
  网页读取超时: "reason.timeout",
  用户没有同意读取这个地址: "reason.notAllowedUrl",
  网页重定向过多: "reason.redirects",
  只能读取公网网页: "reason.publicOnly",
  网页过大: "reason.tooBig",
  工具已停用: "reason.toolOff",
  "用户未同意这次调用。": "reason.denied",
  网页请求失败: "reason.webFailed",
  工具调用失败: "reason.toolFailed",
  "这次没查到。": "reason.nothingFound",
  "今天的搜索次数用完了。": "reason.quota",
  "搜索服务暂时连不上。": "reason.searchDown",
} as const;
const shown = (reason: string) =>
  Object.hasOwn(REASONS, reason)
    ? t(REASONS[reason as keyof typeof REASONS])
    : reason;
export function toolSteps(notify: (method: string, data: object) => void) {
  const calls = new Map<string, ToolStep>();
  const ordered: ToolStep[] = [];
  const snapshot = () => ordered.map((step) => ({ ...step }));
  const publish = () => notify("chat.steps", { steps: snapshot() });
  return {
    snapshot,
    adjustOffsets(adjust: (offset: number) => number) {
      let changed = false;
      for (const step of ordered) {
        if (step.textOffset === undefined) continue;
        const next = adjust(step.textOffset);
        if (next !== step.textOffset) {
          step.textOffset = next;
          changed = true;
        }
      }
      if (changed) publish();
    },
    skippedSearch() {
      ordered.push({
        name: "web_search",
        label: t("steps.noSearch"),
        status: "skipped",
      });
      publish();
    },
    start(
      id: string,
      name: string,
      label: string,
      args: Record<string, unknown>,
      textOffset?: number,
    ) {
      const argument =
        name === "web_search"
          ? args?.query
          : name === "web_read"
            ? args?.url
            : undefined;
      const step: ToolStep = {
        name,
        label,
        ...(textOffset !== undefined && { textOffset }),
        status: "running",
        ...(typeof argument === "string" && {
          argument: argument.slice(0, 2048),
        }),
      };
      ordered.push(step);
      calls.set(id, step);
      publish();
    },
    finish(
      id: string,
      result: {
        details?: { pages?: WebPage[]; reason?: string };
        content?: { text?: string }[];
      },
      error: boolean,
    ) {
      const step = calls.get(id);
      if (!step) return;
      const web = step.name === "web_search" || step.name === "web_read";
      const reason = web && result.details?.reason;
      step.status = error || reason ? "failed" : "ok";
      if (step.status === "failed") {
        const msg = result.content?.[0]?.text;
        const known = [
          "没有找到可读的网页正文",
          "这个地址没有可读的网页正文",
          "对方拒绝访问",
          "网页读取超时",
          "用户没有同意读取这个地址",
          "网页重定向过多",
          "只能读取公网网页",
          "网页过大",
          "工具已停用",
          "用户未同意这次调用。",
        ];
        step.reason = shown(
          reason ||
            (msg && known.includes(msg)
              ? msg
              : web
                ? "网页请求失败"
                : "工具调用失败"),
        );
      }
      if (web) {
        step.pages = result.details?.pages ?? [];
        step.count = step.pages.length;
      }
      publish();
    },
  };
}
