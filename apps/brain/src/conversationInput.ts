import type { ImageContent } from "@earendil-works/pi-ai";
import type { PetContext, PastTurn, ContextSections } from "./prompt.ts";
import type { McpServer } from "./mcp.ts";
import type { ActionChoice } from "./petAction.ts";
import type { AttachedFile } from "./attachments.ts";
export interface Prompt {
  scheduled?: boolean;
  taskZone?: string;
  topic?: number;
  timeNote?: string;
  sections?: ContextSections;
  libraryEnabled?: boolean;
  webUrls?: string[];
  mcpServers?: McpServer[];
  remindersEnabled?: boolean;
  token?: string;
  memoryEnabled?: boolean;
  memorySnapshot?: string;
  review?: boolean;
  now?: number;
  pet?: PetContext;
  history?: PastTurn[];
  text: string;
  /** Files sent with this message; the text stays the user's own words. */
  files?: AttachedFile[];
  image?: ImageContent;
  /** "upload" for a picture sent in the chat window; a screen snip otherwise. */
  imageSource?: "snip" | "upload";
  forceSearch?: boolean;
  probeTool?: boolean;
  /** What the pet on the desktop can do; empty or missing means no pet_action. */
  petActions?: ActionChoice[];
  /** The voice that will speak the reply (plan/10 §9). */
  speak?: unknown;
}
