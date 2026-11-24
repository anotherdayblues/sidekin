type Reply = (value: unknown, error?: string) => void;
const pending = new Map<string, Reply>();
let sequence = 0;
export function receiveHost(id: string, value: unknown, error?: string) {
  pending.get(id)?.(value, error);
}
export function hostCall<T>(
  method: string,
  params: object,
  timeout = 5000,
): Promise<T> {
  const id = "brain:" + ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("crash"));
    }, timeout);
    pending.set(id, (value, error) => {
      clearTimeout(timer);
      pending.delete(id);
      if (error) reject(new Error(error));
      else resolve(value as T);
    });
    process.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", method, params, id }) + "\n",
    );
  });
}
