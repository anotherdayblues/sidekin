export interface WebPage {
  title: string;
  url: string;
}
export interface ToolStep {
  /** UTF-16 position in the visible reply when this call began. Absent in older records. */
  textOffset?: number;
  name: string;
  label: string;
  argument?: string;
  status: "running" | "ok" | "failed" | "skipped";
  reason?: string;
  pages?: WebPage[];
  count?: number;
}
