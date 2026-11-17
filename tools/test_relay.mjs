// relay/server.mjs publicIp + who (audit 11-13, RELAY-3): the addresses it must never connect to.  node tools/test_relay.mjs
process.env.PORT = "0";
const { publicIp, who } = await import("../relay/server.mjs");
let f = 0;
const t = (c, m) => { console.log(c ? "PASS" : "FAIL", m); if (!c) f++; };
for (const a of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "::1", "::", "::ffff:127.0.0.1", "::ffff:7f00:1", "::127.0.0.1",
  "::ffff:a9fe:a9fe", "2002:7f00:1::", "2002:a9fe:a9fe::1", "fec0::1", "fe80::1", "fd00::1", "ff02::1", "64:ff9b::7f00:1", "2001:db8::1", "2001::1"])
  t(!publicIp(a), "blocked " + a);
for (const a of ["8.8.8.8", "::ffff:8.8.8.8", "2606:4700::1111", "2002:808:808::1"]) t(publicIp(a), "public " + a);
t(who("2606:4700:1:2:aaaa::1") === who("2606:4700:1:2:bbbb::9"), "one IPv6 /64 is one caller");
t(who("1.2.3.4") === "1.2.3.4", "IPv4 as is");
process.exit(f ? 1 : 0);
