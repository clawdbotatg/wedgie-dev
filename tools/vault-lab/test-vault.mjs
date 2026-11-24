import assert from 'node:assert/strict';
import { createECDH, createHmac, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, flashFromUf2 } from '../../src/chip/sim.ts';
import { newTrustM, trustM } from '../../src/chip/trustm.ts';
import { firmware, image } from '../rp2040/image.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const core = join(here, '..', '..');
const [receiptPath] = process.argv.slice(2);
assert(receiptPath, 'Supply a new result JSON path');
globalThis.fetch = () => { throw new Error('Vault fixture network disabled'); };
const peer = createECDH('prime256v1');
const peerPub = peer.generateKeys();
const seed = offset => Buffer.concat([Buffer.from('wedgie-keepassxc-keyfile-v1\0'),
  Buffer.from(Array.from({ length: 32 }, (_, index) => index + offset))]);
function reference(publicKey, context) {
  const x = peer.computeSecret(publicKey);
  const a = createHmac('sha256', x).update(context).digest();
  return createHmac('sha256', x).update(a).update(context).digest();
}

const source = readFileSync(join(here, 'vault_probe.py'), 'utf8');
assert.equal(source.split('__FIXTURE_PEER__').length, 2);
const app = { mod: 'vault_probe', name: 'Vault Probe', entry: 'run', files: ['vault_probe.py'], usb: true, chipuse: true, version: '1' };
const F = firmware();
F.app(app, { 'vault_probe.py': Buffer.from(source.replace('__FIXTURE_PEER__', peerPub.toString('hex'))) });
const fileSystem = image(F, app.mod);
const flash = flashFromUf2(readFileSync(join(core, 'public/mp/RPI_PICO.uf2')));
flash.set(fileSystem, 0xa0000);
const state = newTrustM();
const persistentSnapshot = JSON.stringify({ keys: state.keys, data: state.data, meta: state.meta });
let sim, pending = '', receipt, changes = 0;
sim = boot({ rom: readFileSync(join(core, 'tools/rp2040/bootrom-b1.bin')), flash,
  uid: Uint8Array.of(0xee, 0xe0, 0, 0, 0, 0, 0, 0x21),
  i2c: trustM(state, () => sim?.ms ?? 0, () => { changes += 1; }),
  onData(bytes) {
    pending += Buffer.from(bytes).toString('latin1');
    let index;
    while ((index = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, index).trim();
      pending = pending.slice(index + 1);
      if (!line.startsWith('{')) continue;
      try {
        const value = JSON.parse(line);
        if (value.type === 'vault-fixture-result') receipt = value;
      } catch {}
    }
  },
});
while (!receipt && sim.ms < 25000) sim.run(25);
assert(receipt, 'The virtual cartridge did not finish the derivation');
assert(receipt.repeated && receipt.reset_erased_secret, 'The volatile session lifetime check failed');
assert(!changes && JSON.stringify({ keys: state.keys, data: state.data, meta: state.meta }) === persistentSnapshot,
  'The virtual cartridge changed persistent Trust M state');
const bytes = key => Buffer.from(receipt[key], 'hex');
const model = reference(bytes('public'), seed(0));
const derived = bytes('derived');
const wrongVault = bytes('wrong_vault');
const wrongDevice = bytes('wrong_device');
assert(timingSafeEqual(model, derived), 'Independent OpenSSL ECDH and host PRF reference disagreed');
assert(timingSafeEqual(reference(bytes('public'), seed(1)), wrongVault), 'The other vault context reference disagreed');
assert(timingSafeEqual(reference(bytes('new_public'), seed(0)), wrongDevice), 'The replacement virtual key reference disagreed');
assert(!timingSafeEqual(derived, wrongVault) && !timingSafeEqual(derived, wrongDevice), 'Derivation did not separate vaults or device keys');
console.log('Stock MicroPython Trust M ECDH and TLS 1.2 PRF matched an independent OpenSSL and HMAC-SHA256 reference.');
const verified = execFileSync('python3', ['-B', join(here, 'verify-keepassxc.py')], {
  input: Buffer.concat([model, derived, wrongVault, wrongDevice]), encoding: 'utf8', timeout: 150000,
});
console.log(verified.trim());
writeFileSync(receiptPath, JSON.stringify({ core: '0.3.91', virtualRP2040: true,
  stockMicroPython: true, virtualTrustM: true, ecdhKeySlot: 'E102', sharedSecretSlot: 'E103',
  agreementSecretExported: false, tlsPrfSha256: true, independentHostReferenceMatches: true,
  sameSessionDeterministic: true, closeAndResetClearedSharedSecret: true, persistentStateUnchanged: true,
  keepassxcUnlockedDummyVault: true, wrongContextRefused: true, wrongDeviceRefused: true,
  disposableRecoveryKeyUnlocked: true, noNamedUnlockKeyRetained: true, physicalHardwareTest: false }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
