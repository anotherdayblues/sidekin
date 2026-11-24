// Files attached in the chat window (plan/14), as the model sees them: each
// inside markers that its own text cannot fake, with the rule that it is
// material, not orders.
import { fill, text } from "./texts.ts";

export interface AttachedFile {
  name: string;
  /** Empty when the file was left out because the turn was full. */
  text: string;
}

/** The markers use 【】, so a file's own brackets become plain ones and it
 * cannot write a marker of its own. */
const defang = (s: string) => s.replace(/【/g, "[").replace(/】/g, "]");

export function attachedText(files: AttachedFile[] = []) {
  return files.map((f) => {
    const name = defang(f.name).replace(/[《》]/g, "");
    return f.text
      ? fill(text("attached-file"), {
          文件名: name,
          内容: defang(f.text),
        })
      : fill(text("attached-file-omitted"), { 文件名: name });
  });
}
