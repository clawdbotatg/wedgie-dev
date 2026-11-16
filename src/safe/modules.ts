// Which of a Safe's modules /safe calls by a calm name (audit 11-13, PAGE-7). A module can move everything without the
// owners, and anything can answer getGuardians() or avatar(): one that did was shown as "Recovery" or "Delay". So a
// module gets a calm name only by address: one of these, or a Zodiac clone (EIP-1167, 45 bytes) of one of these
// mastercopies. Anything else is "Unknown module", in red. Code read on mainnet and Base 11-15.
export type Known = "recovery" | "4337" | "allowance" | "roles" | "delay";
export const FIXED: Record<string, Known> = {
  "0x088f6cfd8bb1ddb1bb069ccb3fc1a98927d233f2": "recovery",   // Candide social recovery, 7 days
  "0x9bacd92f4687db306d7ded5d4513a51ea05df25b": "recovery",   // 14 days
  "0x6aa9a8ad0582db61a97a6e30eba22ba143d1e960": "recovery",   // 60 days
  "0xa581c4a4db7175302464ff3c06380bc3270b4037": "4337",       // Safe4337Module 0.2.0
  "0x75cf11467937ce3f2f357ce24ffc3dbf8fd5c226": "4337",       // Safe4337Module 0.3.0
  "0xcfbfac74c26f8647cbdb8c5caf80bb5b32e43134": "allowance",  // Safe's Allowance Module 0.1.0
  "0xaa46724893dedd72658219405185fb0fc91e091c": "allowance",  // 0.1.1
};
export const MASTERS: Record<string, Known> = {
  "0xf2964ce6161ce0e75964fe7927ce114cb0b283d5": "roles",      // Zodiac Roles 2.1.1 (Instant Wallet's)
  "0x9646fdad06d3e24444381f44362a3b0eb343d337": "roles",      // Zodiac Roles 2.0
  "0xd54895b1121a2ee3f37b502f507631fa1331bed6": "delay",      // Zodiac Delay 1.0
};
const CLONE = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/;
/** What a module is, by its address or (a clone) the mastercopy in its code. null: not one we know. Never throws. */
export function knownModule(addr: unknown, code?: unknown): Known | null {
  if (typeof addr !== "string") return null;
  const a = addr.toLowerCase();
  if (Object.hasOwn(FIXED, a)) return FIXED[a];
  const m = typeof code === "string" ? CLONE.exec(code.toLowerCase()) : null;
  return m && Object.hasOwn(MASTERS, "0x" + m[1]) ? MASTERS["0x" + m[1]] : null;
}
/** One page of getModulesPaginated's answer: the modules and where the next page starts ("" = the end or unreadable). */
export function modulePage(data: string): { mods: string[]; next: string } | null {
  try {
    if (typeof data !== "string" || data.length < 194) return null;
    const w = (i: number) => data.slice(2 + 64 * i, 66 + 64 * i), o = Number(BigInt("0x" + w(0))) / 32, n = Number(BigInt("0x" + w(o)));
    if (o !== 2 || n > 200 || data.length < 2 + 64 * (o + 1 + n)) return null;
    return { mods: Array.from({ length: n }, (_, k) => "0x" + w(o + 1 + k).slice(24)), next: "0x" + w(1).slice(24) };
  } catch { return null; }
}
