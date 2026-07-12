import * as assert from 'assert';
import { Prefetcher, type PrefetchDeps } from '../prefetch';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function make(overrides: Partial<PrefetchDeps> = {}): { p: Prefetcher; worked: string[] } {
  const worked: string[] = [];
  const p = new Prefetcher({
    work: async (repo) => {
      worked.push(repo);
      return { hadLogo: false };
    },
    isCached: async () => false,
    onLogosLanded: () => {},
    enabled: () => true,
    ...overrides,
  });
  return { p, worked };
}

suite('Prefetcher', () => {
  test('prefetches only uncached repos, deduped', async () => {
    const cached = new Set(['b']);
    const { p, worked } = make({ isCached: async (r) => cached.has(r) });
    await p.enqueue(['a', 'b', 'c', 'a']); // b cached, a duplicated
    await flush();
    await flush();
    assert.deepStrictEqual(worked.slice().sort(), ['a', 'c']);
  });

  test('no-op when disabled', async () => {
    const { p, worked } = make({ enabled: () => false });
    await p.enqueue(['a', 'b']);
    await flush();
    assert.deepStrictEqual(worked, []);
  });

  test('respects the concurrency cap (never more than 6 in flight)', async () => {
    let inFlight = 0;
    let max = 0;
    const release: Array<() => void> = [];
    const { p, worked } = make({
      work: (repo) =>
        new Promise((resolve) => {
          inFlight += 1;
          max = Math.max(max, inFlight);
          release.push(() => {
            inFlight -= 1;
            resolve({ hadLogo: false });
          });
        }).then(() => {
          worked.push(repo);
          return { hadLogo: false };
        }),
    });
    await p.enqueue(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    assert.strictEqual(max, 6, 'exactly the cap started');
    while (release.length > 0) {
      release.shift()?.();
      await flush();
    }
    assert.strictEqual(max, 6, 'never exceeded the cap while draining');
    assert.strictEqual(worked.length, 10, 'all ran once the in-flight drained');
  });

  test('new results clear the pending queue; in-flight finish', async () => {
    const gate: Array<() => void> = [];
    const { p, worked } = make({
      work: (repo) =>
        new Promise((resolve) => {
          worked.push(repo);
          gate.push(() => resolve({ hadLogo: false }));
        }),
    });
    await p.enqueue(['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8']); // 6 start, a7/a8 pending
    assert.strictEqual(worked.length, 6);
    await p.enqueue(['b1', 'b2']); // replaces the pending a7/a8
    while (gate.length > 0) {
      gate.shift()?.();
      await flush();
    }
    await flush();
    assert.ok(worked.includes('b1') && worked.includes('b2'), 'new results ran');
    assert.ok(!worked.includes('a7') && !worked.includes('a8'), 'stale pending was cleared');
  });

  test('a landed logo triggers a single debounced repost per burst', async () => {
    let reposts = 0;
    const { p } = make({
      work: async () => ({ hadLogo: true }),
      onLogosLanded: () => {
        reposts += 1;
      },
    });
    await p.enqueue(['a', 'b', 'c']);
    await new Promise((r) => setTimeout(r, 700)); // past the 500ms debounce
    assert.strictEqual(reposts, 1, 'the burst coalesced to one repost');
    p.dispose();
  });

  test('dispose stops pumping', async () => {
    const gate: Array<() => void> = [];
    const { p, worked } = make({
      work: (repo) =>
        new Promise((resolve) => {
          worked.push(repo);
          gate.push(() => resolve({ hadLogo: false }));
        }),
    });
    await p.enqueue(['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8']); // 6 in flight, 2 pending
    p.dispose();
    while (gate.length > 0) {
      gate.shift()?.();
      await flush();
    }
    assert.strictEqual(worked.length, 6, 'pending was dropped on dispose');
  });
});
