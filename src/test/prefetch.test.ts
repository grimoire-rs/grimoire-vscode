import * as assert from 'assert';
import { Prefetcher, type PrefetchDeps } from '../prefetch';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function make(overrides: Partial<PrefetchDeps> = {}): { p: Prefetcher; worked: string[] } {
  const worked: string[] = [];
  const p = new Prefetcher({
    work: async (repo) => {
      worked.push(repo);
    },
    isFresh: async () => false,
    onCardMetaLanded: () => {},
    enabled: () => true,
    ...overrides,
  });
  return { p, worked };
}

suite('Prefetcher', () => {
  test('prefetches only stale/uncached repos, deduped', async () => {
    const fresh = new Set(['b']);
    const { p, worked } = make({ isFresh: async (r) => fresh.has(r) });
    await p.enqueue(['a', 'b', 'c', 'a']); // b fresh, a duplicated
    await flush();
    await flush();
    assert.deepStrictEqual(worked.slice().sort(), ['a', 'c']);
  });

  test('force re-fetches even a cache-fresh repo (explicit refresh)', async () => {
    // The 6h TTL is right for background rounds and wrong for a user who just
    // asked; behind an index registry that entry IS the row's version.
    const { p, worked } = make({ isFresh: async () => true });
    await p.enqueue(['a', 'b'], { force: true });
    await flush();
    await flush();
    assert.deepStrictEqual(worked.slice().sort(), ['a', 'b']);
  });

  test('no-op when disabled', async () => {
    const { p, worked } = make({ enabled: () => false });
    await p.enqueue(['a', 'b']);
    await flush();
    assert.deepStrictEqual(worked, []);
  });

  test('respects the concurrency cap (never more than 10 in flight)', async () => {
    let inFlight = 0;
    let max = 0;
    const release: Array<() => void> = [];
    const { p, worked } = make({
      work: (repo) =>
        new Promise<void>((resolve) => {
          inFlight += 1;
          max = Math.max(max, inFlight);
          release.push(() => {
            inFlight -= 1;
            resolve();
          });
        }).then(() => {
          worked.push(repo);
        }),
    });
    const repos = Array.from({ length: 14 }, (_, i) => `r${i + 1}`);
    await p.enqueue(repos);
    assert.strictEqual(max, 10, 'exactly the cap started');
    while (release.length > 0) {
      release.shift()?.();
      await flush();
    }
    assert.strictEqual(max, 10, 'never exceeded the cap while draining');
    assert.strictEqual(worked.length, 14, 'all ran once the in-flight drained');
  });

  test('new results clear the pending queue; in-flight finish', async () => {
    const gate: Array<() => void> = [];
    const { p, worked } = make({
      work: (repo) =>
        new Promise<void>((resolve) => {
          worked.push(repo);
          gate.push(resolve);
        }),
    });
    // 10 start, a11/a12 stay pending
    await p.enqueue(Array.from({ length: 12 }, (_, i) => `a${i + 1}`));
    assert.strictEqual(worked.length, 10);
    await p.enqueue(['b1', 'b2']); // replaces the pending a11/a12
    while (gate.length > 0) {
      gate.shift()?.();
      await flush();
    }
    await flush();
    assert.ok(worked.includes('b1') && worked.includes('b2'), 'new results ran');
    assert.ok(!worked.includes('a11') && !worked.includes('a12'), 'stale pending was cleared');
  });

  test('a slow enqueue never installs its queue over a newer one', async () => {
    // enqueue awaits a freshness probe per repo, and the sidebar calls it once
    // per search — so rounds overlap. The older round finishing last used to
    // assign its own list, sending the prefetch after results already replaced.
    const gate: Array<() => void> = [];
    const { p, worked } = make({
      isFresh: (repo) =>
        repo.startsWith('old')
          ? new Promise<boolean>((resolve) => gate.push(() => resolve(false)))
          : Promise.resolve(false),
    });
    const slow = p.enqueue(['old1', 'old2']); // parks on the gate
    await p.enqueue(['new1']); // completes first — the current results
    // Drained in a loop: the probes are sequential, so releasing one produces
    // the next.
    while (gate.length > 0) {
      gate.shift()?.();
      await flush();
    }
    await slow;
    await flush();
    await flush();
    assert.deepStrictEqual(worked, ['new1'], 'only the newest round pumped');
  });

  test('landed logos trigger a single debounced repost per burst', async () => {
    let reposts = 0;
    const { p } = make({
      onCardMetaLanded: () => {
        reposts += 1;
      },
    });
    // Any cache write with a logo notifies — prefetch or a details panel open.
    p.notifyCardMeta();
    p.notifyCardMeta();
    p.notifyCardMeta();
    await new Promise((r) => setTimeout(r, 700)); // past the 500ms debounce
    assert.strictEqual(reposts, 1, 'the burst coalesced to one repost');
    p.dispose();
  });

  test('notifyCardMeta after dispose never reposts', async () => {
    let reposts = 0;
    const { p } = make({
      onCardMetaLanded: () => {
        reposts += 1;
      },
    });
    p.dispose();
    p.notifyCardMeta();
    await new Promise((r) => setTimeout(r, 700));
    assert.strictEqual(reposts, 0, 'a disposed prefetcher stays quiet');
  });

  test('dispose stops pumping', async () => {
    const gate: Array<() => void> = [];
    const { p, worked } = make({
      work: (repo) =>
        new Promise<void>((resolve) => {
          worked.push(repo);
          gate.push(resolve);
        }),
    });
    // 10 in flight, 2 pending
    await p.enqueue(Array.from({ length: 12 }, (_, i) => `a${i + 1}`));
    p.dispose();
    while (gate.length > 0) {
      gate.shift()?.();
      await flush();
    }
    assert.strictEqual(worked.length, 10, 'pending was dropped on dispose');
  });
});
