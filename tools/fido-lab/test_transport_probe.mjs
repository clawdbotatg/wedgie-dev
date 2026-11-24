// Boot the transport-only UF2 on the existing RP2040 simulator and exercise HID endpoints.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const harness = process.env.WEDGIE_RP2040_HARNESS
  ? pathToFileURL(process.env.WEDGIE_RP2040_HARNESS)
  : new URL('../rp2040/chip.mjs', import.meta.url);
const { host } = await import(harness);
const uf2 = process.argv[2];
if (!uf2) throw new Error('Provide the path to the transport probe UF2');

const rig = host({ uf2, drive: true }); // The harness records non-CDC OUT endpoints as they are armed.
assert(rig.until(() => rig.chip.connected && Object.values(rig.chip.mcu.usbCtrl.armed).includes(64), 1000),
  `Probe startup missing: ${rig.out.slice(-250)}`);
assert.doesNotMatch(rig.out, /Traceback|MemoryError|AttributeError/);

const configuration = Buffer.from(rig.chip.cdc.descriptors);
const hidEndpoints = [];
let hid = false;
for (let offset = 0; offset < configuration.length;) {
  const length = configuration[offset];
  assert(length >= 2 && offset + length <= configuration.length);
  const type = configuration[offset + 1];
  if (type === 4) hid = configuration[offset + 5] === 3;
  if (hid && type === 5) {
    assert.equal(configuration[offset + 3] & 3, 3);
    assert.equal(configuration.readUInt16LE(offset + 4), 64);
    hidEndpoints.push(configuration[offset + 2]);
  }
  offset += length;
}
assert.equal(hidEndpoints.length, 2);
const out = hidEndpoints.find((address) => address < 0x80);
const incoming = hidEndpoints.find((address) => address >= 0x80) & 0x0f;
assert(out && incoming && out !== rig.chip.cdc.outEndpoint && incoming !== rig.chip.cdc.inEndpoint);

const usb = rig.chip.mcu.usbCtrl;
const originalWrite = usb.onEndpointWrite;
const replies = [];
usb.onEndpointWrite = (endpoint, data) => {
  if (endpoint === incoming) replies.push(Buffer.from(data));
  else originalWrite(endpoint, data);
};

function exchange(channel, command, payload) {
  const request = Buffer.alloc(64);
  channel.copy(request);
  request[4] = 0x80 | command;
  request.writeUInt16BE(payload.length, 5);
  payload.copy(request, 7);
  assert(rig.until(() => usb.armed[out] === 64, 300), 'No HID OUT arm');
  delete usb.armed[out];
  usb.endpointReadDone(out, request);
  assert(rig.until(() => replies.length === 1, 300), `No HID reply for command ${command}`);
  const reply = replies.shift();
  assert.equal(reply.length, 64);
  assert.deepEqual(reply.subarray(0, 4), channel);
  return { command: reply[4] & 0x7f, body: reply.subarray(7, 7 + reply.readUInt16BE(5)) };
}

const nonce = Buffer.from('0123456789abcdef', 'hex');
const init = exchange(Buffer.alloc(4, 0xff), 0x06, nonce);
assert.equal(init.command, 0x06);
assert.equal(init.body.length, 17);
assert.deepEqual(init.body.subarray(0, 8), nonce);
const channel = init.body.subarray(8, 12);
assert(!channel.equals(Buffer.alloc(4)) && !channel.equals(Buffer.alloc(4, 0xff)));
assert.equal(init.body[16], 0x08, 'The probe must not advertise credential commands');

const message = Buffer.from('Wedgie FIDO transport fixture');
const ping = exchange(channel, 0x01, message);
assert.equal(ping.command, 0x01);
assert.deepEqual(ping.body, message);
const blocked = exchange(channel, 0x10, Buffer.from([0x04]));
assert.equal(blocked.command, 0x3f);
assert.deepEqual(blocked.body, Buffer.from([0x01]));
assert.doesNotMatch(rig.out, /Traceback|MemoryError|AttributeError/);
console.log('PASS: exact UF2 booted on the RP2040 simulator with CDC and FIDO HID interrupt endpoints.');
console.log('PASS: CTAPHID INIT allocated a channel, PING echoed over USB, and CBOR was refused.');
