/**
 * Core codec logic for WebSocket data frames (RFC 6455).
 *
 * Design decisions:
 * - We operate on Uint8Array exclusively. Node Buffers are Uint8Arrays,
 *   so callers can pass Buffer directly. Returning Uint8Array keeps the
 *   library runtime-agnostic.
 * - We do NOT validate opcode semantics (e.g., control frames must be
 *   < 126 bytes, fragmentation rules). That is the job of a higher-level
 *   framer/session. This library is strictly bytes-in, bytes-out.
 * - Masking is applied in-place on a copy to avoid mutating caller memory.
 */

export const constants = Object.freeze({
  OPCODES: Object.freeze({
    CONTINUATION: 0x0,
    TEXT: 0x1,
    BINARY: 0x2,
    CLOSE: 0x8,
    PING: 0x9,
    PONG: 0xa,
  }),
  OPCODE_NAMES: Object.freeze({
    0x0: 'continuation',
    0x1: 'text',
    0x2: 'binary',
    0x8: 'close',
    0x9: 'ping',
    0xa: 'pong',
  }),
});

/**
 * Apply or remove the WebSocket masking transformation.
 *
 * Masking is its own inverse: XORing twice with the same key restores the
 * original. We always operate on a fresh copy so the caller's buffer is
 * never mutated, which matters because a decoder may need the original
 * bytes for error reporting.
 *
 * @param {Uint8Array} payload
 * @param {Uint8Array} mask - exactly 4 bytes
 * @returns {Uint8Array} a new Uint8Array with the mask applied
 */
export function applyMask(payload, mask) {
  if (!(mask instanceof Uint8Array) || mask.length !== 4) {
    throw new TypeError('mask must be a Uint8Array of length 4');
  }
  const out = new Uint8Array(payload.length);
  for (let i = 0; i < payload.length; i++) {
    out[i] = payload[i] ^ mask[i & 3];
  }
  return out;
}

/**
 * Encode a WebSocket frame.
 *
 * @param {object} frame
 * @param {boolean} frame.fin - final fragment flag
 * @param {number} frame.opcode - 4-bit opcode (0x0-0xf)
 * @param {Uint8Array} [frame.payload] - payload bytes (default empty)
 * @param {Uint8Array} [frame.mask] - 4-byte mask; if present, the frame is masked
 * @returns {Uint8Array} the encoded frame bytes
 */
export function encodeFrame(frame) {
  if (frame == null || typeof frame !== 'object') {
    throw new TypeError('frame must be an object');
  }
  const fin = frame.fin === undefined ? true : !!frame.fin;
  const opcode = frame.opcode;
  if (typeof opcode !== 'number' || opcode < 0 || opcode > 0xf) {
    throw new RangeError('opcode must be an integer in [0, 15]');
  }
  const payload = frame.payload instanceof Uint8Array ? frame.payload : new Uint8Array(0);
  const mask = frame.mask;
  const masked = mask !== undefined;
  if (masked && (!(mask instanceof Uint8Array) || mask.length !== 4)) {
    throw new TypeError('mask must be a Uint8Array of length 4');
  }

  const len = payload.length;
  let headerLen = 2;
  let ext16 = 0;
  let ext64 = 0;
  if (len > 0xffff) {
    headerLen += 8;
    ext64 = 1;
  } else if (len > 125) {
    headerLen += 2;
    ext16 = 1;
  }
  if (masked) headerLen += 4;

  const out = new Uint8Array(headerLen + len);
  const dv = new DataView(out.buffer);

  // Byte 0: FIN | RSV1-3 | opcode
  out[0] = (fin ? 0x80 : 0) | (opcode & 0xf);

  // Byte 1: MASK | payload-len (7 bits) or 126/127 sentinel
  let lenByte = masked ? 0x80 : 0;
  if (ext64) {
    lenByte |= 127;
  } else if (ext16) {
    lenByte |= 126;
  } else {
    lenByte |= len & 0x7f;
  }
  out[1] = lenByte;

  let offset = 2;
  if (ext16) {
    dv.setUint16(offset, len);
    offset += 2;
  } else if (ext64) {
    // High 32 bits must be zero for any realistic payload; we still write
    // the full 64-bit field per spec.
    dv.setUint32(offset, 0);
    dv.setUint32(offset + 4, len);
    offset += 8;
  }

  if (masked) {
    out[offset++] = mask[0];
    out[offset++] = mask[1];
    out[offset++] = mask[2];
    out[offset++] = mask[3];
    const maskedPayload = applyMask(payload, mask);
    out.set(maskedPayload, offset);
  } else {
    out.set(payload, offset);
  }

  return out;
}

/**
 * Decode a WebSocket frame from a complete buffer.
 *
 * This function expects the ENTIRE frame to be present. It does not handle
 * partial reads; a streaming decoder belongs in a higher layer.
 *
 * @param {Uint8Array} buffer
 * @returns {{fin: boolean, opcode: number, masked: boolean, payload: Uint8Array, mask?: Uint8Array}}
 * @throws {RangeError} if the buffer is too short for the declared length
 */
export function decodeFrame(buffer) {
  if (!(buffer instanceof Uint8Array)) {
    throw new TypeError('buffer must be a Uint8Array');
  }
  if (buffer.length < 2) {
    throw new RangeError('buffer too short for a WebSocket frame header');
  }

  const dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const b0 = buffer[0];
  const b1 = buffer[1];

  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  const len7 = b1 & 0x7f;

  let offset = 2;
  let payloadLen;
  if (len7 < 126) {
    payloadLen = len7;
  } else if (len7 === 126) {
    if (buffer.length < offset + 2) {
      throw new RangeError('buffer too short for 16-bit length field');
    }
    payloadLen = dv.getUint16(offset);
    offset += 2;
  } else {
    // len7 === 127
    if (buffer.length < offset + 8) {
      throw new RangeError('buffer too short for 64-bit length field');
    }
    const high = dv.getUint32(offset);
    const low = dv.getUint32(offset + 4);
    offset += 8;
    if (high !== 0) {
      // We cannot represent payloads > 2^53 - 1 as a JS number safely.
      throw new RangeError('payload length exceeds 2^53 - 1');
    }
    payloadLen = low;
  }

  let maskBytes = null;
  if (masked) {
    if (buffer.length < offset + 4) {
      throw new RangeError('buffer too short for masking key');
    }
    maskBytes = buffer.slice(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + payloadLen) {
    throw new RangeError('buffer too short for declared payload length');
  }

  let payload = buffer.slice(offset, offset + payloadLen);
  if (masked) {
    payload = applyMask(payload, maskBytes);
  }

  const result = { fin, opcode, masked, payload };
  if (masked) {
    result.mask = maskBytes;
  }
  return result;
}
