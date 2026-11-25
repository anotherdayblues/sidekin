import services from "./modelServices.json" with { type: "json" };
import type { LanguageChoice } from "./locales/index.ts";
export { services };
export type Service = keyof typeof services;
export type Protocol =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai";
export const presets = Object.fromEntries(
  Object.entries(services).map(([id, s]) => [id, [s.label, s.baseUrl]]),
) as unknown as Record<Service, readonly [string, string]>;
export interface ModelDraft {
  service: Service;
  baseUrl: string;
  model: string;
  visionModel: string;
  canSee: boolean;
  contextWindow: number;
  protocol: Protocol;
}
export interface CompanionSettings {
  protocol?:
    | "openai-completions"
    | "openai-responses"
    | "anthropic-messages"
    | "google-generative-ai";
  credentialRef?: string;
  modelVerified?: boolean;
  toolCheck?: {
    baseUrl: string;
    protocol: string;
    model: string;
    status: string;
  };
  enabled: boolean;
  fallbacks: {
    service: Service;
    model: string;
    baseUrl: string;
    canSee: boolean;
    credentialRef?: string;
  }[];
  followSearch?: boolean;
  searchDailyLimit?: number;
  dailyLimit: number;
  search: { provider: string; baseUrl: string; credentialRef?: string } | null;
  service: Service;
  baseUrl: string;
  model: string;
  visionModel: string;
  canSee: boolean;
  contextWindow: number;
  reminders: boolean;
  memory: boolean;
  vision: boolean;
  visionShortcut: string;
  /** Optional global shortcut to snip a screen area straight into the chat sidebar. */
  chatSnipShortcut: string;
  translation: boolean;
  copyTwice: boolean;
  clipboardShortcut: string;
  /** plan/41: translates the selection, or opens the bubble to type in. */
  translationShortcut: string;
  /** 对方语言: the language of the person on the other side. */
  translationTarget: string;
  personality: string;
  chatShortcut: string;
  panelShortcut: string;
  /** plan/15: "system" follows the computer's language. */
  language: LanguageChoice;
}
export const defaults: CompanionSettings = {
  enabled: false,
  fallbacks: [],
  dailyLimit: 0,
  search: null,
  service: "openai",
  baseUrl: presets.openai[1],
  model: "gpt-5.4-mini",
  visionModel: "",
  canSee: false,
  contextWindow: 32768,
  reminders: true,
  memory: true,
  vision: true,
  // The host picks the shortcuts per system (shortcuts.rs).
  visionShortcut: "Control+Shift+4",
  chatSnipShortcut: "",
  translation: true,
  copyTwice: true,
  clipboardShortcut: "Control+Shift+2",
  translationShortcut: "Control+Shift+3",
  translationTarget: "auto",
  personality: "",
  chatShortcut: "",
  panelShortcut: "Control+Shift+1",
  language: "system",
};
/** Error codes the brain and host report; the text is error.<code> in
 * apps/shared/locales. */
export const errorCodes = [
  "unsupportedTools",
  "search",
  "missingKey",
  "redirect",
  "insecure",
  "endpoint",
  "catalog",
  "forbidden",
  "notFound",
  "balance",
  "tls",
  "server",
  "budget",
  "screenPermission",
  "screenPermissionOff",
  "permission",
  "permissionOff",
  "clipboard",
  "auth",
  "busy",
  "network",
  "vision",
  "timeout",
  "crash",
  "model",
  "stopped",
  "disabled",
] as const;
