# redshift-web

Encodes and decodes WebSocket data frames (RFC 6455) including masking, payload length extension (16- and 64-bit), and the FIN/opcode header bits. Zero dependencies, ESM only.

## Usage

```js
import { encodeFrame, decodeFrame, applyMask, constants } from 'redshift-web';

const { OPCODES } = constants;

// Encode a masked binary frame
const mask = new Uint8Array([1, 2, 3, 4]);
const payload = new TextEncoder().encode('hello');
const bytes = encodeFrame({ fin: true, opcode: OPCODES.BINARY, payload, mask });

// Decode it back
const frame = decodeFrame(bytes);
console.log(frame.fin, frame.opcode, frame.masked);
console.log(new TextDecoder().decode(frame.payload)); // "hello"
```

## Why this exists

Most WebSocket libraries bundle a full client or server: connection lifecycle, HTTP upgrade, ping/pong bookkeeping, and framing all in one. If you only need to turn bytes into frames and frames into bytes — for a proxy, a fuzzer, a test harness, or a custom transport — that is dead weight. This library is just the codec.

The trade-off: it does not validate opcode semantics. Control frames over 125 bytes, fragmented control frames, and opcode sequencing are not rejected here. A higher layer that owns the session should enforce those rules. The codec only promises to faithfully encode and decode the wire format.

## Edge cases you will hit

- **64-bit lengths**: JavaScript numbers cannot represent integers above 2^53 - 1. If a frame declares a payload length with the high 32 bits of the 64-bit field non-zero, `decodeFrame` throws `RangeError` rather than silently truncating.
- **Partial frames**: `decodeFrame` expects the entire frame in one buffer. It does not buffer or resume across calls. If you are reading from a stream, accumulate bytes first.
- **Masking is in-place on a copy**: `applyMask` never mutates its input, but it also does not try to be zero-copy. For very large payloads you may want a streaming masker; this is not it.

## Exports

- `encodeFrame(frame)` — returns `Uint8Array`
- `decodeFrame(buffer)` — returns `{ fin, opcode, masked, payload, mask? }`
- `applyMask(payload, mask)` — returns `Uint8Array`
- `constants.OPCODES` — `{ CONTINUATION, TEXT, BINARY, CLOSE, PING, PONG }`
- `constants.OPCODE_NAMES` — reverse lookup by opcode number
