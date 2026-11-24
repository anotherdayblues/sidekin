// The one way to fill a text from apps/shared/locales (plan/15): `{name}` is
// replaced by `vars.name`. Used by the windows and the brain alike.
export type Vars = Record<string, string | number>;
export function fillText(text: string, vars: Vars = {}) {
  return text.replace(/\{(\w+)\}/g, (whole, name) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : whole,
  );
}
