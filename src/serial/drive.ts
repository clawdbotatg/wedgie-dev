// A wedgie through its WEDGIE drive, for a page inside the iPhone app (ios/WedgieDrive): an iPhone has no
// serial port, so the app gives the page window.wedgieDrive (send = a new REQ-<n>.TXT, read = a file).
// request() sends one JSON line and reads ANSWER.TXT until an answer with its id is there. Same requests,
// same answers as Repl.request over USB (public/skill.md, "No serial port?").
const D = () => (window as any).wedgieDrive as undefined | {
  status(): Promise<{ state: "unpicked" | "away" | "here"; name: string }>;
  send(line: string): Promise<string>;
  read(name: string): Promise<string | null>;
  panel(): Promise<boolean>;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** In the iPhone app? */
export const inApp = () => !!D();
export const status = async () => (await D()?.status())?.state ?? "unpicked";
export const panel = () => D()?.panel();

let nextId = (Date.now() % 1e6) * 100;
let lock: Promise<unknown> = Promise.resolve();

export type Asker = { request(o: Record<string, unknown>, ms: number): Promise<any> };
const asker: Asker = {
  async request(o, ms) {
    const id = ++nextId;
    await D()!.send(JSON.stringify({ ...o, id }));
    for (const end = Date.now() + ms; Date.now() < end; ) {
      await sleep(700);
      const t = await D()!.read("ANSWER.TXT").catch(() => null);
      for (const line of (t || "").split("\n")) {
        if (!line.startsWith("{")) continue;
        try { const a = JSON.parse(line); if (a.id === id) return a; } catch {}
      }
    }
    throw new Error("The wedgie didn't answer. Is it plugged in?");
  },
};

/** One conversation at a time, like wedgies.withRepl. */
export function withDrive<T>(fn: (r: Asker) => Promise<T>): Promise<T> {
  const run = lock.catch(() => {}).then(() => fn(asker));
  lock = run;
  return run;
}
