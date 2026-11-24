import type { Api, Model } from "@earendil-works/pi-ai";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import { MOONSHOTAI_CN_MODELS } from "@earendil-works/pi-ai/providers/moonshotai-cn.models";
import { MOONSHOTAI_MODELS } from "@earendil-works/pi-ai/providers/moonshotai.models";
import { MINIMAX_MODELS } from "@earendil-works/pi-ai/providers/minimax.models";
import { MINIMAX_CN_MODELS } from "@earendil-works/pi-ai/providers/minimax-cn.models";
import { QWEN_TOKEN_PLAN_CN_MODELS } from "@earendil-works/pi-ai/providers/qwen-token-plan-cn.models";
import { ZAI_MODELS } from "@earendil-works/pi-ai/providers/zai.models";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { GOOGLE_MODELS } from "@earendil-works/pi-ai/providers/google.models";
import { OPENROUTER_MODELS } from "@earendil-works/pi-ai/providers/openrouter.models";
import { type Service } from "./companion.ts";

export const lists: Partial<Record<Service, Record<string, Model<Api>>>> = {
  deepseek: DEEPSEEK_MODELS,
  "moonshotai-cn": MOONSHOTAI_CN_MODELS,
  moonshotai: MOONSHOTAI_MODELS,
  minimax: MINIMAX_MODELS,
  "minimax-cn": MINIMAX_CN_MODELS,
  glm: ZAI_MODELS,
  "qwen-cn": QWEN_TOKEN_PLAN_CN_MODELS,
  "qwen-intl": QWEN_TOKEN_PLAN_CN_MODELS,
  openai: OPENAI_MODELS,
  anthropic: ANTHROPIC_MODELS,
  google: GOOGLE_MODELS,
  openrouter: OPENROUTER_MODELS,
};
