import { expect, test } from 'bun:test';
import { Socket } from '../src/transport/socket.ts';
import type { RawFrame } from '../src/protocol.ts';
import { requireValue } from './require-value.ts';

// Every other transport test injects a mock WebSocket. This one drives the
// default factory — the runtime's own `WebSocket` — against a real server, so
// the path every consumer actually uses is covered.
test('the default factory drives Socket with the runtime WebSocket', async () => {
  const server = Bun.serve({
    port: 0,
    fetch: (req, s) => (s.upgrade(req) ? undefined : new Response('no upgrade')),
    websocket: {
      open(ws) {
        // Both frames in one message, which is how the server batches under load.
        ws.send('{"type":"welcome","payload":{"current_tick":42}}\n{"type":"chat_message","payload":{"text":"hi"}}');
        ws.close(4001, 'session_replaced');
      },
      message() {},
    },
  });

  const frames: RawFrame[] = [];
  const socket = new Socket({ url: `ws://localhost:${server.port}` });
  socket.onFrame = (frame) => frames.push(frame);
  const closed = new Promise<{ code?: number; reason?: string }>((resolve) => {
    socket.onClose = (err) => resolve({ code: err.code, reason: err.reason });
  });

  await socket.connect();
  const close = await closed;
  server.stop(true);

  expect(frames.map((f) => f.type)).toEqual(['welcome', 'chat_message']);
  const welcome = requireValue(frames[0], 'expected a welcome frame').payload as { current_tick: number };
  expect(welcome.current_tick).toBe(42);
  expect(close.code).toBe(4001);
  expect(close.reason).toBe('session_replaced');
});
