/** Local disposable Trust M fixture. The mailbox exchanges only request digests and signatures. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

globalThis.fetch = () => { throw new Error('The OpenPGP virtual token runs offline'); };
const [repo, cartridge, mailbox] = process.argv.slice(2);
const { p256 } = createRequire(join(repo, 'package.json'))('@noble/curves/nist');
const { newTrustM, trustM } = await import(pathToFileURL(join(repo, 'src/chip/trustm.ts')));
const { firmware, image } = await import(pathToFileURL(join(repo, 'tools/rp2040/image.mjs')));
const { boot, flashFromUf2 } = await import(pathToFileURL(join(repo, 'src/chip/sim.ts')));
const app = { mod: 'pgp_bench', name: 'OpenPGP Bench', files: ['pgp_bench.mpy'], entry: 'run', usb: true, chipuse: true };
const fw = firmware();
fw.app(app, { 'pgp_bench.mpy': readFileSync(cartridge) });
const flash = flashFromUf2(readFileSync(join(repo, 'public/mp/RPI_PICO.uf2')));
flash.set(image(fw, app.mod), 0xa0000);
const state = newTrustM();
const persistentKeys = structuredClone(state.keys);
const messages = [];
let sim;
let serial = '';
sim = boot({
  rom: readFileSync(join(repo, 'tools/rp2040/bootrom-b1.bin')),
  flash,
  uid: Uint8Array.of(0xee, 0xe0, 0x50, 0x47, 0x50, 0, 0, 1),
  i2c: trustM(state, () => sim?.ms ?? 0, () => {}),
  onData(data) {
    serial += Buffer.from(data).toString('latin1');
    let end;
    while ((end = serial.indexOf('\n')) >= 0) {
      const line = serial.slice(0, end).trim();
      serial = serial.slice(end + 1);
      if (line.startsWith('{')) {
        try { messages.push(JSON.parse(line)); } catch {}
      } else if (/Error|failed|^Traceback/.test(line)) {
        console.error(line.slice(0, 220));
      }
    }
  },
});

function until(check, budget, label) {
  const timeout = sim.ms + budget;
  while (sim.ms < timeout) {
    const found = check();
    if (found) return found;
    sim.run(25);
  }
  throw new Error(`Virtual RP2040 timed out during ${label}`);
}

function publish(name, value) {
  const file = join(mailbox, name);
  writeFileSync(file + '.tmp', JSON.stringify(value), { mode: 0o600 });
  renameSync(file + '.tmp', file);
}

assert.equal(until(() => messages.find((item) => item.type === 'ready' && item.running === app.mod), 35000, 'startup').sealed, true);
sim.run(800);
publish('ready', { sealed: true });
let id = 100;
let publicKey;
let signatures = 0;
let approvals = 0;

while (!existsSync(join(mailbox, 'stop'))) {
  const pending = join(mailbox, 'request');
  if (!existsSync(pending)) {
    await setTimeout(15);
    continue;
  }
  const request = JSON.parse(readFileSync(pending, 'utf8'));
  unlinkSync(pending);
  assert(['pgp_key', 'pgp_sign'].includes(request.type));
  if (request.type === 'pgp_sign') assert.match(request.digest, /^[0-9A-Fa-f]{64}$/);
  const current = ++id;
  sim.write(Buffer.from(JSON.stringify({ ...request, id: current }) + '\n'));
  const initial = until(() => messages.find((item) => item.id === current), 18000, request.type);
  const terminal = () => messages.find((item) => item.id === current && item.type !== 'pgp_prompt');
  if (initial.type === 'pgp_prompt') {
    sim.run(800);
    assert.equal(terminal(), undefined, 'The cartridge answered before physical approval');
    sim.key('A', true);
    sim.run(180);
    sim.key('A', false);
    sim.run(180);
    approvals++;
  }
  const reply = until(terminal, 18000, 'terminal reply');
  if (reply.type === 'pgp_key') {
    publicKey = Buffer.from(reply.public, 'hex');
    assert(publicKey.length === 65 && publicKey[0] === 4);
  }
  if (reply.type === 'pgp_sig') {
    const signature = Buffer.from(reply.signature, 'hex');
    assert(p256.verify(signature, Buffer.from(request.digest, 'hex'), publicKey, { prehash: false, lowS: false }));
    signatures++;
  }
  assert.deepEqual(state.keys, persistentKeys, 'An unexpected persistent Trust M slot changed');
  publish('reply', reply);
}

assert.equal(approvals, 4);
assert.equal(signatures, 3);
console.log('PASS: Virtual RP2040 physical inputs authorized a volatile key and three independently verified Trust M signatures.');
