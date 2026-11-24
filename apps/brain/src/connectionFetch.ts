import { AsyncLocalStorage } from "node:async_hooks";
// A provider key may only travel to the endpoint the user selected.
export function endpoint(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw Error("endpoint");
  }
  if (url.username || url.password || url.search || url.hash)
    throw Error("endpoint");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const local =
    host === "localhost" ||
    host === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(host);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
    throw Error("insecure");
  return url;
}
function refused(code: string) {
  const marker = "COMPANION_" + code.toUpperCase();
  return new Response(JSON.stringify({ error: { message: marker } }), {
    status: 400,
    statusText: marker,
    headers: { "content-type": "application/json" },
  });
}
const originalFetch = globalThis.fetch;
const requestEndpoint = new AsyncLocalStorage<string>();
async function guarded(
  base: string,
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) {
  const expected = endpoint(base);
  const target = new URL(input instanceof Request ? input.url : String(input));
  if (target.origin !== expected.origin || target.username || target.password)
    return refused("endpoint");
  const response = await originalFetch(input, { ...init, redirect: "manual" });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    return refused("redirect");
  }
  return response;
}
// Pi's Gemini adapter rejects a custom fetch callback. Scope its global fetch
// calls to this request with AsyncLocalStorage, including simultaneous probes.
globalThis.fetch = ((input, init) => {
  const base = requestEndpoint.getStore();
  return base ? guarded(base, input, init) : originalFetch(input, init);
}) as typeof fetch;
export function withProviderEndpoint<T>(base: string, run: () => T): T {
  endpoint(base);
  return requestEndpoint.run(base, run);
}
export function providerFetch(base: string): typeof fetch {
  endpoint(base);
  return (input, init) => guarded(base, input, init);
}
