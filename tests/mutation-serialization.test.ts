import { expect, test } from 'bun:test';
import { Account } from '../src/account.ts';
import { SpacemoltClient } from '../src/client.ts';
import type { WelcomeFrame } from '../src/protocol.ts';
import { mockFactory, type MockSocket } from './mock-socket.ts';
import { requireValue } from './require-value.ts';

function welcomePayload(): WelcomeFrame['payload'] {
  return {
    version: '0.452.0',
    release_date: '2026-06-20',
    release_notes: [],
    tick_rate: 5,
    current_tick: 1,
    server_time: 1,
    game_info: '',
    website: '',
    help_text: '',
    terms: '',
  };
}

function acknowledge(socket: MockSocket, requestId: string): void {
  socket.serverSend({
    type: 'result',
    request_id: requestId,
    payload: { result: 'queued', structuredContent: { pending: true, command: 'mine' } },
  });
}

function complete(socket: MockSocket, requestId: string, command = 'mine'): void {
  socket.serverSend({
    type: 'action_result',
    request_id: requestId,
    payload: { command, tick: 2, result: {} },
  });
}

for (const serializeMutations of [undefined, true, false]) {
  test(`Account serializeMutations=${serializeMutations}: controls sending, not final outcome promises`, async () => {
    const { factory, sockets } = mockFactory();
    const account = new Account({ webSocketFactory: factory, seedState: false, serializeMutations });
    const connected = account.connect();
    const socket = requireValue(sockets[0]);
    socket.serverSend({ type: 'welcome', payload: welcomePayload() });
    await connected;
    try {
      let firstDone = false;
      const first = account.mutate('spacemolt', 'mine', undefined, undefined, 'first').then((value) => {
        firstDone = true;
        return value;
      });
      const second = account.send('spacemolt', 'undock', undefined, 'second');
      await Bun.sleep(0);
      expect(socket.sent.map((frame) => frame.request_id)).toEqual(
        serializeMutations === false ? ['first', 'second'] : ['first'],
      );
      acknowledge(socket, 'first');
      await Bun.sleep(0);
      expect(firstDone).toBe(false);
      expect(socket.sent).toHaveLength(serializeMutations === false ? 2 : 1);

      // Read-only queries bypass serialization in either mode.
      const query = account.query('spacemolt', 'get_status', undefined, 'query');
      socket.serverSend({ type: 'result', request_id: 'query', payload: { result: 'ok' } });
      await query;

      if (serializeMutations === false) {
        // Out-of-order outcomes must resolve the correct caller.
        complete(socket, 'second', 'undock');
        expect(await second).toMatchObject({ command: 'undock' });
        expect(firstDone).toBe(false);
      }
      complete(socket, 'first');
      expect((await first).command).toBe('mine');
      if (serializeMutations !== false) {
        await Bun.sleep(0);
        expect(socket.sent.map((frame) => frame.request_id)).toEqual(['first', 'query', 'second']);
        complete(socket, 'second', 'undock');
        expect(await second).toMatchObject({ command: 'undock' });
      }
    } finally {
      account.close();
    }
  });

  test(`SpacemoltClient forwards serializeMutations=${serializeMutations} to managed accounts`, async () => {
    const { factory, sockets } = mockFactory();
    const client = new SpacemoltClient({
      webSocketFactory: factory,
      seedState: false,
      reconnect: false,
      connectRetry: false,
      serializeMutations,
    });
    await client.addLogin('pilot', 'fixture');
    const connected = client.connect('pilot');
    await Bun.sleep(0);
    const socket = requireValue(sockets[0]);
    socket.onClientSend = (frame, s) => {
      if (frame.action === 'login') s.serverSend({ type: 'logged_in', payload: {} });
    };
    socket.serverSend({ type: 'welcome', payload: welcomePayload() });
    const account = await connected;
    try {
      const first = account.mutate('spacemolt', 'mine', undefined, undefined, 'first');
      const second = account.mutate('spacemolt', 'mine', undefined, undefined, 'second');
      await Bun.sleep(0);
      expect(socket.sent.filter((frame) => frame.action === 'mine')).toHaveLength(serializeMutations === false ? 2 : 1);
      complete(socket, 'first');
      await first;
      await Bun.sleep(0);
      complete(socket, 'second');
      await second;
    } finally {
      client.closeAll();
    }
  });
}

test('concurrent mutation rejection does not settle or block another request', async () => {
  const { factory, sockets } = mockFactory();
  const account = new Account({ webSocketFactory: factory, seedState: false, serializeMutations: false });
  const connected = account.connect();
  const socket = requireValue(sockets[0]);
  socket.serverSend({ type: 'welcome', payload: welcomePayload() });
  await connected;
  try {
    const first = account.mutate('spacemolt', 'mine', undefined, undefined, 'first');
    const rejected = account
      .mutate('spacemolt', 'mine', undefined, undefined, 'second')
      .catch((error: unknown) => error);
    socket.serverSend({
      type: 'action_error',
      request_id: 'second',
      payload: { command: 'mine', tick: 2, code: 'action_pending', message: 'An action is pending' },
    });
    expect(await rejected).toMatchObject({ code: 'action_pending', requestId: 'second' });
    complete(socket, 'first');
    expect((await first).command).toBe('mine');
  } finally {
    account.close();
  }
});
