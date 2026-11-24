import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
export type TestHost = (
  method: string,
  params: any,
) => unknown | Promise<unknown>;
export function launch(
  executable = process.env.BRAIN_TEST_BIN,
  host?: TestHost,
  onEvent?: (msg: any) => void,
) {
  const child = spawn(
    executable ? resolve(executable) : process.execPath,
    executable ? [] : ["--import", "tsx", "apps/brain/src/main.ts"],
    {
      stdio: ["pipe", "pipe", "inherit"],
      cwd: executable ? tmpdir() : undefined,
      env: executable
        ? { ...process.env, PATH: "", NODE_PATH: "", NODE_OPTIONS: "" }
        : process.env,
    },
  );
  let seq = 0;
  const pending = new Map<
    number,
    { finish: (msg: any) => void; fail: (e: Error) => void; events: any[] }
  >();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    if (msg.method && msg.id !== undefined) {
      void Promise.resolve()
        .then(() => {
          if (!host) throw Error("未配置测试后台");
          return host(msg.method, msg.params);
        })
        .then(
          (result) =>
            child.stdin.write(
              JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n",
            ),
          (error) =>
            child.stdin.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id: msg.id,
                error: { code: -32004, message: String(error.message) },
              }) + "\n",
            ),
        );
      return;
    }
    const task = pending.get(msg.id ?? msg.params?.requestId);
    if (!task) return;
    if (msg.id !== undefined) {
      pending.delete(msg.id);
      task.finish({ ...msg, events: task.events });
    } else {
      task.events.push(msg);
      onEvent?.(msg);
    }
  });
  const fail = () => {
    for (const t of pending.values()) t.fail(new Error("大脑提前退出"));
    pending.clear();
  };
  child.on("error", fail);
  child.on("exit", fail);
  child.stdin.on("error", fail);
  return {
    pid: child.pid!,
    close: () => child.kill(),
    request(method: string, params: object = {}): Promise<any> {
      const id = ++seq;
      return new Promise((ok, no) => {
        const timer = setTimeout(() => child.kill(), 70_000);
        pending.set(id, {
          finish: (msg) => {
            clearTimeout(timer);
            ok(msg);
          },
          fail: (e) => {
            clearTimeout(timer);
            no(e);
          },
          events: [],
        });
        child.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
        );
      });
    },
  };
}
