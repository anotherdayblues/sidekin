import { t } from "./locale.ts";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { hostCall } from "./host.ts";
import { parseSchedule } from "./scheduleString.ts";
const schedule = {
  type: "string",
  description:
    "REQUIRED for create. Schedule forms: (1) recurring interval — '30m', 'every 2h', 'every hour' (forever by default); (2) explicit one-shot by duration — 'in 20s', 'in 30m', 'in 2h' (fires ONCE that far from now; use this for 'remind me in N minutes' — do NOT hand-compute an absolute timestamp); (3) natural day/time — 'every monday 9am', 'weekdays at 9am', 'every day at 9am' (recurring weekly/daily); (4) fixed-time daily/weekly cron — '0 9 * * *' (daily 9am); (5) absolute one-shot — ISO timestamp '2026-06-01T09:00:00'. For a daily/weekly schedule in a specific timezone, append its IANA name, e.g. 'every day at 9am Asia/Shanghai'.",
};
const name = { type: "string", description: "可选，给人看的任务名称。" };
const prompt = {
  type: "string",
  description:
    "创建或更新时，填写完整、可独立执行的任务指令。运行时间放在 schedule；“自昨天以来”这样的资料时间范围保留在这里。",
};
const mode = {
  type: "string",
  enum: ["notify", "agent"],
  description: "默认 agent，到点执行任务。用户指定原文播报时可用 notify。",
};
export function reminderTools(
  token: string,
  changed: (action: string, data: unknown) => void,
  choices: () => { question: string; answer: string }[] = () => [],
): AgentTool[] {
  const actions = [
    "create",
    "list",
    "update",
    "pause",
    "resume",
    "remove",
    "run",
  ];
  return [
    {
      name: "cronjob_manage",
      label: t("step.cron"),
      description: `Schedule recurring or one-off agent tasks (cron jobs): create, list, edit, run. action='create' schedules a job from a prompt; 'list' inspects jobs; 'update'/'pause'/'resume'/'remove' manage one by job_id (always list first — never guess job IDs); 'run' fires a job immediately in the background. The result returns to the conversation when done.

Jobs run in a fresh session with no current-chat context, so prompts must be self-contained, and the agent's FINAL RESPONSE is what gets delivered — cron runs are autonomous and cannot ask questions. Prefer updating an existing job over creating near-duplicates.

Only for work the agent itself must do at that time. A plain reminder for something the user will do themselves ("remind me at 3pm to call Mom", "drink water every day at 4") is a to-do: use the todo tool with a time instead.`,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["action"],
        properties: {
          action: {
            type: "string",
            enum: actions,
            description:
              "When action=create, the schedule and prompt fields are required.",
          },
          job_id: {
            type: "integer",
            minimum: 1,
            description: "Required for update, pause, resume, remove, and run.",
          },
          name,
          prompt,
          schedule,
          mode,
        },
      },
      execute: async (callId, args) => {
        const {
          action,
          job_id,
          prompt: instruction,
          name: label,
          schedule: timing,
          mode: kind,
        } = args as Record<string, unknown>;
        if (!actions.includes(String(action))) throw Error("未知任务操作");
        if (
          action !== "list" &&
          action !== "create" &&
          !(Number.isSafeInteger(job_id) && Number(job_id) > 0)
        )
          throw Error("需要有效任务编号");
        const payload: Record<string, unknown> = { token };
        if (job_id !== undefined) payload.id = job_id;
        let method: string;
        switch (action) {
          case "create":
          case "update": {
            if (action === "create" && (!timing || !instruction))
              throw Error("创建任务需要指令和日程");
            if (
              action === "update" &&
              [instruction, label, timing, kind].every((v) => v === undefined)
            )
              throw Error("请提供要更新的内容");
            if (instruction !== undefined) {
              if (typeof instruction !== "string" || !instruction.trim())
                throw Error("任务指令不能为空");
              const notes = choices()
                .filter((a) => !instruction.includes(a.answer))
                .map((a) => a.question + " " + a.answer);
              payload.message = [instruction, ...notes].join("\n");
            }
            if (label !== undefined) payload.name = label;
            if (timing !== undefined) payload.schedule = parseSchedule(timing);
            if (kind !== undefined) payload.mode = kind;
            if (action === "create") {
              payload.callId = callId;
              payload.mode ??= "agent";
            }
            method =
              action === "create"
                ? "host.reminder_create"
                : "host.reminder_edit";
            break;
          }
          case "list":
            method = "host.reminder_list";
            break;
          default:
            method = "host.reminder_manage";
            payload.action = action;
            break;
        }
        const data = await hostCall(method, payload);
        changed(String(action), data);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data) }],
          details: {},
        };
      },
    },
  ];
}
