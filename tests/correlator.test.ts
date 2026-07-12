import { expect, test } from 'bun:test';
import type { RawFrame } from '../src/protocol.ts';
import { Correlator, type RequestKind } from '../src/transport/correlator.ts';

const malformedFrames: Array<{ kind: RequestKind; frame: RawFrame }> = [
  {
    kind: 'query',
    frame: { type: 'result', request_id: 'request-1', payload: { result: 'bad', structuredContent: 'not-an-object' } },
  },
  {
    kind: 'mutation',
    frame: { type: 'action_result', request_id: 'request-1', payload: { command: 'mine', result: {} } },
  },
  {
    kind: 'mutation',
    frame: { type: 'action_error', request_id: 'request-1', payload: { command: 'mine', tick: 1, message: 'bad' } },
  },
  {
    kind: 'query',
    frame: { type: 'error', request_id: 'request-1', payload: { code: 'bad' } },
  },
];

for (const { kind, frame } of malformedFrames) {
  test(`a malformed correlated ${frame.type} rejects the pending ${kind} immediately`, async () => {
    const correlator = new Correlator();
    const pending = kind === 'query' ? correlator.awaitQuery('request-1') : correlator.awaitMutation('request-1');
    const outcome = pending.then(
      () => ({ resolved: true as const, error: undefined }),
      (error: unknown) => ({ resolved: false as const, error }),
    );

    expect(correlator.handle(frame)).toBe(true);
    expect(await outcome).toEqual({
      resolved: false,
      error: expect.objectContaining({
        code: 'invalid_response',
        message: `Malformed ${frame.type} frame for request request-1`,
      }),
    });
    expect(correlator.has('request-1')).toBe(false);
  });
}
