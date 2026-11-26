import { describe, expect, it } from 'vitest';
import { OutboundScheduler } from '../src/midi/scheduler';
import { FakeClock } from './fake-clock';

const bytes = (n: number, tag = 0) => new Uint8Array(n).fill(tag);

function setup(opts: { bytesPerSecond?: number; burstBytes?: number } = {}) {
  const clock = new FakeClock();
  const sent: { t: number; data: Uint8Array }[] = [];
  const s = new OutboundScheduler((data) => sent.push({ t: clock.now(), data }), { clock, ...opts });
  return { clock, sent, s };
}

describe('OutboundScheduler', () => {
  it('holds the average rate to the byte budget', () => {
    const { clock, sent, s } = setup({ bytesPerSecond: 2500, burstBytes: 96 });
    // 3600 bytes queued: more than one second's budget.
    for (let i = 0; i < 300; i++) s.enqueue({ lane: 'bulk', build: () => bytes(12) });
    clock.advance(1000);
    const total = sent.reduce((n, x) => n + x.data.length, 0);
    // 96 burst + 2500 per second, give or take one message.
    expect(total).toBeGreaterThan(2500);
    expect(total).toBeLessThanOrEqual(96 + 2500 + 12);
    clock.advance(1000);
    expect(sent).toHaveLength(300);
  });

  it('sends a message larger than the bucket and pays the debt before the next one', () => {
    const { clock, sent, s } = setup({ bytesPerSecond: 2500, burstBytes: 96 });
    s.enqueue({ lane: 'bulk', build: () => bytes(235) });
    s.enqueue({ lane: 'bulk', build: () => bytes(3) });
    expect(sent).toHaveLength(1);
    clock.advance(40); // debt of 139 bytes needs ~56 ms
    expect(sent).toHaveLength(1);
    clock.advance(30);
    expect(sent).toHaveLength(2);
  });

  it('serves realtime before requests before bulk', () => {
    const { clock, sent, s } = setup({ bytesPerSecond: 1000, burstBytes: 1 });
    s.enqueue({ lane: 'bulk', build: () => bytes(3, 1) }); // goes out at once (bucket not empty)
    s.enqueue({ lane: 'bulk', build: () => bytes(3, 2) });
    s.enqueue({ lane: 'request', build: () => bytes(3, 3) });
    s.enqueue({ lane: 'realtime', build: () => bytes(3, 4) });
    clock.advance(100);
    expect(sent.map((x) => x.data[0])).toEqual([1, 4, 3, 2]);
  });

  it('coalesces queued items by key (latest wins, position kept) and builds lazily', () => {
    const { clock, sent, s } = setup({ bytesPerSecond: 1000, burstBytes: 1 });
    let value = 0;
    s.enqueue({ lane: 'realtime', build: () => bytes(3, 9) });
    for (let i = 1; i <= 10; i++) {
      value = i;
      s.enqueue({ lane: 'realtime', key: 'cutoff', build: () => bytes(3, value) });
    }
    clock.advance(100);
    expect(sent.map((x) => x.data[0])).toEqual([9, 10]);
  });

  it('rate-limits each key to its minimum interval without delaying other keys', () => {
    const { clock, sent, s } = setup({ bytesPerSecond: 100000, burstBytes: 1000 });
    const send = (key: string, v: number) => s.enqueue({ lane: 'realtime', key, minIntervalMs: 25, build: () => bytes(3, v) });
    send('a', 1);
    clock.advance(5);
    send('a', 2);
    send('b', 3);
    expect(sent.map((x) => [x.t, x.data[0]])).toEqual([
      [0, 1],
      [5, 3],
    ]);
    clock.advance(30);
    expect(sent.map((x) => [x.t, x.data[0]])).toEqual([
      [0, 1],
      [5, 3],
      [25, 2],
    ]);
  });

  it('keeps a silent gap after an item that asks for one', () => {
    const { clock, sent, s } = setup({ bytesPerSecond: 100000, burstBytes: 1000 });
    s.enqueue({ lane: 'bulk', gapAfterMs: 40, build: () => bytes(3, 1) });
    s.enqueue({ lane: 'realtime', build: () => bytes(3, 2) });
    expect(sent).toHaveLength(1);
    clock.advance(39);
    expect(sent).toHaveLength(1);
    clock.advance(2);
    expect(sent.map((x) => x.t)).toEqual([0, 40]);
  });

  it('reports pending items and calls onSent', () => {
    const { clock, s } = setup({ bytesPerSecond: 100, burstBytes: 1 });
    const done: number[] = [];
    s.enqueue({ lane: 'request', build: () => bytes(3), onSent: () => done.push(1) });
    s.enqueue({ lane: 'request', build: () => bytes(3), onSent: () => done.push(2) });
    expect(s.pending()).toBe(1);
    clock.advance(1000);
    expect(done).toEqual([1, 2]);
    expect(s.pending()).toBe(0);
    s.enqueue({ lane: 'bulk', build: () => bytes(300) });
    s.enqueue({ lane: 'bulk', build: () => bytes(3) });
    s.clear();
    expect(s.pending()).toBe(0);
  });
});
