/**
 * redshift-web
 *
 * A zero-dependency WebSocket frame codec for Node.js (ESM).
 *
 * Exports:
 *   - encodeFrame(frame: Frame): Uint8Array
 *   - decodeFrame(buffer: Uint8Array): DecodedFrame
 *   - applyMask(payload: Uint8Array, mask: Uint8Array): Uint8Array
 *   - constants: { OPCODES, OPCODE_NAMES }
 */

export { encodeFrame, decodeFrame, applyMask, constants } from './core.js';
