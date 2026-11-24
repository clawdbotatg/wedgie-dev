// A disposable, sealed RP2040 cartridge for the host WebAuthn fixture.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

globalThis.fetch = () => { throw new Error('The WebAuthn virtual token runs offline'); };
const [repo, cartridge] = process.argv.slice(2);
const { newTrustM, trustM } = await import(pathToFileURL(join(repo, 'src/chip/trustm.ts')));
const { firmware, image } = await import(pathToFileURL(join(repo, 'tools/rp2040/image.mjs')));
const { boot, flashFromUf2 } = await import(pathToFileURL(join(repo, 'src/chip/sim.ts')));
const app = { mod: 'fido_bench', name: 'FIDO Trust M Bench', files: ['fido_bench.mpy'], entry: 'run', usb: true, chipuse: true };
const fw = firmware();
fw.app(app, { 'fido_bench.mpy': readFileSync(cartridge) });
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

assert.equal(until(() => messages.find(item => item.type === 'ready' && item.running === app.mod), 35000, 'startup').sealed, true);
sim.run(800);
console.log(JSON.stringify({type: 'ready'}));
let sequence = 10;
let approvals = 0;
let denials = 0;
let signatures = 0;
const lines = createInterface({input: process.stdin});
for await (const line of lines) {
  const { button = 'A', ...request } = JSON.parse(line);
  assert(['fido_key', 'fido_sign', 'fido_close'].includes(request.type));
  assert(['A', 'Y'].includes(button));
  const id = ++sequence;
  sim.write(Buffer.from(JSON.stringify({...request, id}) + '\n'));
  const initial = until(() => messages.find(item => item.id === id), 18000, request.type);
  const response = () => messages.find(item => item.id === id && item.type !== 'fido_prompt');
  if (initial.type === 'fido_prompt') {
    sim.run(1250);
    assert.equal(response(), undefined, 'The cartridge answered before its physical GPIO input');
    sim.key(button, true);
    sim.run(180);
    sim.key(button, false);
    sim.run(180);
    if (button === 'A') approvals++;
    else denials++;
  }
  const result = until(response, 18000, 'terminal approval');
  if (result.type === 'fido_sig') signatures++;
  assert.deepEqual(state.keys, persistentKeys, 'A persistent Trust M key changed');
  console.log(JSON.stringify(result));
}
console.log(JSON.stringify({type:'receipt',approvals,denials,signatures,persistentKeysUnchanged:true}));
