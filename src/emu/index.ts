// The virtual wedgie: the real wedgie firmware (firmware/, served from /fw/) running in MicroPython
// WebAssembly inside a Worker, drawn in the plastic device from src/ui/device.ts.
//
// This file is the one public entry and is tiny on purpose: nothing emulator-related (the UI code,
// the Worker, the ~430 KB wasm, the firmware files) loads until mountVirtualWedgie() is called.
//
//   import { mountVirtualWedgie } from "./emu";
//   const vw = await mountVirtualWedgie(document.querySelector("#virtual")!);
//   await vw.press("down"); await vw.press("A");
//   img.src = vw.screenshotPNG();
//
// Needs cross-origin isolation (COOP same-origin + COEP require-corp) for SharedArrayBuffer keys;
// without it keys fall back to postMessage and only land between Python runs.

export type WedgieKey = "A" | "B" | "X" | "Y" | "up" | "down" | "left" | "right" | "press";

export interface VirtualWedgieOptions {
  /** Where the firmware manifest lives (default "/fw/", from tools/fw.mjs). */
  fwBase?: string;
  /** machine.unique_id() of this virtual board as hex (default a fixed id). */
  uid?: string;
  /** Focus the device after mounting so the keyboard drives it right away (default false). */
  autofocus?: boolean;
  /** Every line the board prints on USB, from the first line of boot on (same as vw.onOutput). */
  onOutput?: (line: string) => void;
}

export interface FrameInfo {
  /** Frames pushed to the panel since boot. */
  frames: number;
  /** Frames drawn in the last second. */
  fps: number;
  /** The 240x240 screen canvas. */
  canvas: HTMLCanvasElement;
}

export interface VirtualWedgie {
  /** Press and release a key. Resolves after the release. */
  press(key: WedgieKey | string, ms?: number): Promise<void>;
  /** Hold (true) or release (false) a key until told otherwise. */
  hold(key: WedgieKey | string, down: boolean): void;
  /** The screen as it is now: a 240x240 PNG data URL. */
  screenshotPNG(): string;
  /** Power-cycle: a fresh interpreter, the flash reloaded from the manifest. Resolves when booted. */
  reboot(): Promise<void>;
  /** Run Python in __main__ (a REPL entry: an expression echoes its repr). Resolves with the output. */
  exec(code: string): Promise<string>;
  /** Write to the board's USB stdin (the launcher answers JSON lines, see /skill.md). */
  write(text: string): void;
  /** Every line the board prints on USB. Returns an unsubscribe function. */
  onOutput(cb: (line: string) => void): () => void;
  /** Called after each new screen frame is drawn. Returns an unsubscribe function. */
  onFrame(cb: (f: FrameInfo) => void): () => void;
  /** Frames drawn in the last second. */
  readonly fps: number;
  /** The mounted root element (focusable; keys work while it has focus). */
  readonly el: HTMLElement;
  /** Stop the Worker and remove everything mountVirtualWedgie added to el. */
  destroy(): void;
}

export async function mountVirtualWedgie(el: HTMLElement, opts: VirtualWedgieOptions = {}): Promise<VirtualWedgie> {
  const { mount } = await import("./virtual");
  return mount(el, opts);
}
