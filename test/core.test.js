import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFrame, decodeFrame, applyMask, constants } from '../src/index.js';

const { OPCODES } = constants;

/**
 * Helper: wrap a Uint8Array so its underlying buffer starts at offset 0.
 * This avoids DataView byte-offset surprises when slicing.
 */
function copy(u8) {
  const c = new Uint8Array(u8.length);
  c.set(u8);
  return c;
}

test('encodeFrame: minimal unmasked text frame (empty payload)', () => {
  const out = encodeFrame({ fin: true, opcode: OPCODES.TEXT });
  assert.equal(out.length, 2);
  assert.equal(out[0], 0x81); // FIN + text
  assert.equal(out[1], 0x00); // no mask, len 0
});

test('encodeFrame: unmasked text frame with payload', () => {
  const payload = new TextEncoder().encode('hi');
  const out = encodeFrame({ fin: true, opcode: OPCODES.TEXT, payload });
  assert.equal(out[0], 0x81);
  assert.equal(out[1], 0x02);
  assert.deepEqual(out.slice(2), payload);
});

test('encodeFrame: masked frame includes 4-byte key and XORs payload', () => {
  const mask = new Uint8Array([1, 2, 3, 4]);
  const payload = new Uint8Array([10, 20, 30, 40, 50]);
  const out = encodeFrame({ fin: true, opcode: OPCODES.BINARY, payload, mask });
  assert.equal(out[1] & 0x80, 0x80); // mask bit set
  assert.equal(out.length, 2 + 4 + 5);
  const maskInFrame = out.slice(2, 6);
  assert.deepEqual(maskInFrame, mask);
  const encodedPayload = out.slice(6);
  const expected = applyMask(payload, mask);
  assert.deepEqual(encodedPayload, expected);
});

test('encodeFrame: 16-bit extended length boundary (126 bytes)', () => {
  const payload = new Uint8Array(126);
  const out = encodeFrame({ fin: true, opcode: OPCODES.BINARY, payload });
  assert.equal(out[1] & 0x7f, 126);
  assert.equal(out.length, 2 + 2 + 126);
  const dv = new DataView(out.buffer);
  assert.equal(dv.getUint16(2), 126);
});

test('encodeFrame: 16-bit extended length just below boundary (125 bytes)', () => {
  const payload = new Uint8Array(125);
  const out = encodeFrame({ fin: true, opcode: OPCODES.BINARY, payload });
  assert.equal(out[1] & 0x7f, 125);
  assert.equal(out.length, 2 + 125);
});

test('encodeFrame: 64-bit extended length (65536 bytes)', () => {
  const payload = new Uint8Array(65536);
  const out = encodeFrame({ fin: true, opcode: OPCODES.BINARY, payload });
  assert.equal(out[1] & 0x7f, 127);
  assert.equal(out.length, 2 + 8 + 65536);
  const dv = new DataView(out.buffer);
  assert.equal(dv.getUint32(2), 0);
  assert.equal(dv.getUint32(6), 65536);
});

test('encodeFrame: fin=false produces a continuation-style frame', () => {
  const out = encodeFrame({ fin: false, opcode: OPCODES.TEXT, payload: new Uint8Array(0) });
  assert.equal(out[0] & 0x80, 0);
});

test('encodeFrame: rejects out-of-range opcode', () => {
  assert.throws(() => encodeFrame({ opcode: 0x10 }), RangeError);
});

test('encodeFrame: rejects bad mask length', () => {
  assert.throws(() => encodeFrame({ opcode: 0x1, mask: new Uint8Array(3) }), TypeError);
});

test('decodeFrame: round-trips an unmasked text frame', () => {
  const payload = new TextEncoder().encode('hello');
  const encoded = encodeFrame({ fin: true, opcode: OPCODES.TEXT, payload });
  const decoded = decodeFrame(copy(encoded));
  assert.equal(decoded.fin, true);
  assert.equal(decoded.opcode, OPCODES.TEXT);
  assert.equal(decoded.masked, false);
  assert.deepEqual(decoded.payload, payload);
});

test('decodeFrame: round-trips a masked binary frame', () => {
  const mask = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  const payload = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
  const encoded = encodeFrame({ fin: true, opcode: OPCODES.BINARY, payload, mask });
  const decoded = decodeFrame(copy(encoded));
  assert.equal(decoded.masked, true);
  assert.deepEqual(decoded.mask, mask);
  assert.deepEqual(decoded.payload, payload);
});

test('decodeFrame: handles 16-bit extended length', () => {
  const payload = new Uint8Array(200).fill(7);
  const encoded = encodeFrame({ fin: true, opcode: OPCODES.BINARY, payload });
  const decoded = decodeFrame(copy(encoded));
  assert.deepEqual(decoded.payload, payload);
});

test('decodeFrame: handles 64-bit extended length', () => {
  const payload = new Uint8Array(70000).fill(9);
  const encoded = encodeFrame({ fin: true, opcode: OPCODES.BINARY, payload });
  const decoded = decodeFrame(copy(encoded));
  assert.deepEqual(decoded.payload, payload);
});

test('decodeFrame: throws on truncated header', () => {
  assert.throws(() => decodeFrame(new Uint8Array(1)), RangeError);
});

test('decodeFrame: throws when payload is shorter than declared', () => {
  // Manually craft a frame claiming 10 bytes but providing 0.
  const buf = new Uint8Array([0x82, 0x0a]);
  assert.throws(() => decodeFrame(buf), RangeError);
});

test('decodeFrame: throws on 64-bit length exceeding 2^53 - 1', () => {
  const buf = new Uint8Array(10);
  buf[0] = 0x82;
  buf[1] = 127;
  const dv = new DataView(buf.buffer);
  dv.setUint32(2, 1); // high 32 bits non-zero
  dv.setUint32(6, 0);
  assert.throws(() => decodeFrame(buf), RangeError);
});

test('applyMask: is its own inverse', () => {
  const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
  const mask = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);
  const once = applyMask(payload, mask);
  const twice = applyMask(once, mask);
  assert.deepEqual(twice, payload);
});

test('applyMask: rejects bad mask', () => {
  assert.throws(() => applyMask(new Uint8Array(0), new Uint8Array(3)), TypeError);
});

test('constants: OPCODES and OPCODE_NAMES are frozen and consistent', () => {
  assert.equal(Object.isFrozen(constants.OPCODES), true);
  assert.equal(constants.OPCODES.TEXT, 0x1);
  assert.equal(constants.OPCODE_NAMES[0x1], 'text');
  assert.equal(constants.OPCODE_NAMES[0x9], 'ping');
});
