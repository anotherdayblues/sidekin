import { t } from "./locale.ts";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { hostCall } from "./host.ts";
import { text } from "./texts.ts";
export function libraryTools(token: string): AgentTool[] {
  return (["library_search", "library_read"] as const).map((name) => ({
    name,
    label:
      name === "library_search"
        ? t("step.librarySearch")
        : t("step.libraryRead"),
    description: text("tool-library"),
    parameters:
      name === "library_search"
        ? {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
            additionalProperties: false,
          }
        : {
            type: "object",
            properties: {
              file: { type: "integer", minimum: 1 },
              section: { type: "integer", minimum: 1 },
              count: { type: "integer", minimum: 1, maximum: 5 },
            },
            required: ["file", "section"],
            additionalProperties: false,
          },
    execute: async (_id, args) => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            await hostCall("host." + name, { ...(args as object), token }),
          ),
        },
      ],
      details: {},
    }),
  }));
}
