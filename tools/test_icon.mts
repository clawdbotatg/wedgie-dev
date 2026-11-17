// /api/icon (audit 11-13, SHOP-19): a redirect to a private address is refused, a redirect loop stops. No network.  npx tsx tools/test_icon.mts
const real = globalThis.fetch;
const asked: string[] = [];
globalThis.fetch = (async (u: any) => {
  asked.push(String(u));
  if (String(u).includes("hop")) return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/x" } });
  if (String(u).includes("loop")) return new Response(null, { status: 302, headers: { location: "https://loop.example.com/again" } });
  return real(u);
}) as any;
const { GET } = await import(process.cwd() + "/api/icon.ts");
const st = async (u: string) => (await GET(new Request("https://wedgie.dev/api/icon?u=" + encodeURIComponent(u)))).status;
const a = await st("https://hop.example.com/a.png"), b = await st("https://loop.example.com/a.png");
const ok = a === 400 && !asked.some((x) => x.includes("169.254")) && b === 508;
console.log(ok ? "PASS" : "FAIL", "redirect to a private address refused; redirect loop stops", a, b);
process.exit(ok ? 0 : 1);
