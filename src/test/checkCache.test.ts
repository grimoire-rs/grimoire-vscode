// The remembered `grim status --check` verdicts. grim populates
// update_available/deprecated/replaced_by only under `--check` (no --check ⇒ no
// network ⇒ all three null), so without this memory every watcher- or
// action-driven refresh recomputed the update count from the local lock proxy
// and the badge changed meaning between rounds. These tests pin the merge rule
// and, above all, its invalidation: the lock pin is part of the key.
import * as assert from 'assert';
import { ScopeService, mergeCheckedFields, memoryCheckStore } from '../scopes';
import type { CheckStore } from '../scopes';
import type { GrimResult, StatusEnvelope, StatusItem } from '../grim';

function statusItem(overrides: Partial<StatusItem> = {}): StatusItem {
  return {
    kind: 'skill',
    name: 'demo',
    source: 'direct',
    pinned: 'ghcr.io/grimoire-rs/skills/demo:1.0.0',
    state: 'installed',
    outputs: [],
    clients_missing: [],
    clients_extra: [],
    deprecated: null,
    replaced_by: null,
    update_available: null,
    ...overrides,
  };
}

/** One `--check` round's worth of verdicts, as the store holds them. */
const checked = (items: StatusItem[]): Record<string, never> =>
  mergeCheckedFields(items, {}).remember as Record<string, never>;

suite('mergeCheckedFields', () => {
  test('a plain round inherits the last check instead of falling back to the lock proxy', () => {
    const remembered = checked([statusItem({ update_available: true, deprecated: 'moved on' })]);
    // What a watcher-driven `grim status` (no --check) returns: all three null.
    const { items } = mergeCheckedFields([statusItem({ state: 'installed' })], remembered);
    assert.strictEqual(items[0]?.update_available, true, 'the verdict survives a plain refresh');
    assert.strictEqual(items[0]?.deprecated, 'moved on', 'so does the deprecation notice');
  });

  test('a fresh false wins over a remembered true', () => {
    const remembered = checked([statusItem({ update_available: true })]);
    // grim re-resolved and found nothing newer — the authority, not the memory.
    const { items, remember } = mergeCheckedFields(
      [statusItem({ update_available: false })],
      remembered,
    );
    assert.strictEqual(items[0]?.update_available, false);
    assert.deepStrictEqual(
      mergeCheckedFields([statusItem()], remember).items[0]?.update_available,
      false,
      'and the false is what gets remembered for the next plain round',
    );
  });

  test('a re-pinned artifact drops its remembered verdict', () => {
    const remembered = checked([statusItem({ update_available: true })]);
    // What `grim update` leaves behind: same artifact, new pin. The key changes,
    // so the stale "update available" can never be looked up again — this is the
    // whole invalidation strategy, in place of a TTL.
    const { items } = mergeCheckedFields(
      [statusItem({ pinned: 'ghcr.io/grimoire-rs/skills/demo:2.0.0' })],
      remembered,
    );
    assert.strictEqual(items[0]?.update_available, null);
  });

  test('a failed per-artifact re-resolution keeps the last good verdict', () => {
    const remembered = checked([statusItem({ update_available: true })]);
    // `checked: true` but this row's re-resolve failed — grim reports null, and
    // absence must never read as false (nor flip the count for one bad round).
    const { items } = mergeCheckedFields([statusItem({ update_available: null })], remembered);
    assert.strictEqual(items[0]?.update_available, true);
  });

  test('rows that vanished are pruned from what gets remembered', () => {
    const remembered = checked([
      statusItem({ name: 'kept', update_available: true }),
      statusItem({ name: 'uninstalled', update_available: true }),
    ]);
    assert.strictEqual(Object.keys(remembered).length, 2);
    const { remember } = mergeCheckedFields([statusItem({ name: 'kept' })], remembered);
    assert.deepStrictEqual(
      Object.keys(remember).map((k) => k.split('|')[1]),
      ['kept'],
      'the record stays bounded by the installed set',
    );
  });

  test('same name in two kinds keeps separate verdicts', () => {
    const remembered = checked([
      statusItem({ kind: 'skill', name: 'demo', update_available: true }),
      statusItem({ kind: 'rule', name: 'demo', update_available: false }),
    ]);
    const { items } = mergeCheckedFields(
      [statusItem({ kind: 'skill', name: 'demo' }), statusItem({ kind: 'rule', name: 'demo' })],
      remembered,
    );
    assert.deepStrictEqual(
      items.map((i) => i.update_available),
      [true, false],
    );
  });
});

suite('ScopeService check memory', () => {
  /** A ScopeService whose grim returns the given status envelope for every
   *  status call, with project scope unavailable so only global runs. */
  function serviceReturning(
    store: CheckStore,
    envelopes: StatusEnvelope[],
  ): { scopes: ScopeService; remaining: () => number } {
    const queue = [...envelopes];
    const scopes = new ScopeService(
      { fsPath: '/tmp/unused' } as never,
      { appendLine: () => {} } as never,
    );
    scopes.checkStore = store;
    scopes.projectFolder = () => undefined;
    scopes.run = (async <T>(args: string[]): Promise<GrimResult<T>> => {
      if (args[0] === 'context') {
        return {
          ok: true,
          value: {
            version: '99.0.0',
            config_exists: true,
            config_path: '/nonexistent/grimoire.toml',
            grim_home: '/tmp/grim-home',
            default_registry: null,
            registries: [],
          },
        } as GrimResult<T>;
      }
      return { ok: true, value: queue.shift() ?? { items: [] } } as GrimResult<T>;
    }) as ScopeService['run'];
    return { scopes, remaining: () => queue.length };
  }

  test('a checked round is remembered and reused by the next plain round', async () => {
    const store = memoryCheckStore();
    const { scopes } = serviceReturning(store, [
      { items: [statusItem({ update_available: true })], checked: true },
      { items: [statusItem()] },
    ]);
    const first = await scopes.snapshot({ check: true });
    assert.strictEqual(first.global?.status?.[0]?.update_available, true);
    const second = await scopes.snapshot();
    assert.strictEqual(
      second.global?.status?.[0]?.update_available,
      true,
      'the plain refresh must not silently revert to the lock proxy',
    );
  });

  test('the two scopes keep separate records', async () => {
    const store = memoryCheckStore();
    const { scopes } = serviceReturning(store, [
      { items: [statusItem({ update_available: true })], checked: true },
    ]);
    await scopes.snapshot({ check: true });
    assert.deepStrictEqual(
      Object.keys(store.get<Record<string, unknown>>('updateCheck.project', {})),
      [],
      'a global-only round must not write the project record',
    );
    assert.strictEqual(
      Object.keys(store.get<Record<string, unknown>>('updateCheck.global', {})).length,
      1,
    );
  });
});
