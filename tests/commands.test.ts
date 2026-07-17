import { expect, test } from 'bun:test';
import { Account } from '../src/account.ts';
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

async function connected(): Promise<{ account: Account; socket: MockSocket }> {
  const { factory, sockets } = mockFactory();
  const account = new Account({ url: 'ws://m', webSocketFactory: factory, seedState: false });
  const cp = account.connect();
  const socket = requireValue(sockets[0], 'expected socket to be created synchronously');
  socket.serverSend({ type: 'welcome', payload: welcomePayload() });
  await cp;
  return { account, socket };
}

test('commands facade dispatches a query with the right tool/action', async () => {
  const { account, socket } = await connected();
  socket.onClientSend = (frame, s) => {
    if (frame.tool === 'spacemolt' && frame.action === 'get_status') {
      s.serverSend({
        type: 'result',
        request_id: frame.request_id,
        payload: { result: 'ok', structuredContent: { credits: 5000 } },
      });
    }
  };
  const res = await account.commands.spacemolt.get_status();
  expect(res.structuredContent?.credits).toBe(5000);
  expect(socket.sent.at(-1)).toMatchObject({ tool: 'spacemolt', action: 'get_status' });
});

test('commands facade dispatches a mutation and forwards typed params', async () => {
  const { account, socket } = await connected();
  socket.onClientSend = (frame, s) => {
    if (frame.action === 'jump') {
      s.serverSend({
        type: 'result',
        request_id: frame.request_id,
        payload: { result: 'p', structuredContent: { pending: true } },
      });
      s.serverSend({
        type: 'action_result',
        request_id: frame.request_id,
        payload: {
          command: 'jump',
          tick: 9,
          result: {
            location: { system_id: 'sol' },
            details: { action: 'jumped', from_system: 'alpha', system: 'Sol', system_id: 'sol', navigation_xp: 5 },
          },
        },
      });
    }
  };
  const res = await account.commands.spacemolt.jump({ id: 'sol' });
  expect(res.tick).toBe(9);
  expect(res.delta.location?.system_id).toBe('sol');
  // `res.delta.details` is typed as `JumpResponse` (a union of the two jump
  // shapes: a direct system jump vs. a Pathfinder-Drive bearing jump) — not
  // `unknown`/generic. Narrowing on `system_id` (only present on the direct-
  // jump variant) only typechecks because MutationResult<JumpResponse>
  // actually flows through account.commands.spacemolt.jump()'s return type.
  const details = res.delta.details;
  // 'jumped' is the literal the server actually emits (JumpResponse.Action);
  // the old fixture said 'jump', which the pre-enum `string` type let slip.
  expect(details?.action).toBe('jumped');
  if (details && 'system_id' in details) {
    expect(details.system_id).toBe('sol');
    expect(details.navigation_xp).toBe(5);
  } else {
    throw new Error('expected the direct-jump JumpResponse variant');
  }
  expect(socket.sent.at(-1)).toMatchObject({ tool: 'spacemolt', action: 'jump', payload: { id: 'sol' } });
});

test('commands facade is grouped by tool', async () => {
  const { account } = await connected();
  expect(typeof account.commands.spacemolt_market.view_market).toBe('function');
  expect(typeof account.commands.spacemolt.mine).toBe('function');
});
