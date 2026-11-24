// A brain or host error code as the user reads it, in their language.
import { errorCodes } from "../../shared/companion.ts";
import { t, type Key } from "./i18n.ts";

export const errorText: Record<string, string> = Object.fromEntries(
  errorCodes.map((code) => [code, t(("error." + code) as Key)]),
);
