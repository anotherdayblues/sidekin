import { tn } from "../i18n.ts";
/** Size as the system shows it: Finder counts in 1000s, Windows in 1024s.
 *  One decimal below 10. */
export function formatSize(bytes: number | null | undefined, mac: boolean) {
  if (bytes == null) return "—";
  const step = mac ? 1000 : 1024;
  if (bytes < step) return tn("files.bytes", bytes);
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / step,
    unit = 0;
  while (value >= step && unit < units.length - 1) {
    value /= step;
    unit++;
  }
  return (
    (value < 10 ? value.toFixed(1) : Math.round(value)) + " " + units[unit]
  );
}
