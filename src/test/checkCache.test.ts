// The remembered `grim status --check` verdicts. grim populates
// update_available/deprecated/replaced_by only under `--check` (no --check ⇒ no
// network ⇒ all three null), so without this memory every watcher- or
// action-driven refresh recomputed the update count from the local lock proxy
// and the badge changed meaning between rounds. These tests pin the merge rule
// and, above all, its invalidation: the lock pin is part of the key.
import * as assert from 'assert';
import { ScopeService, mergeCheckedFields, memoryCheckStore } from '../scopes';
import type { CheckStore, CheckedFields } from '../scopes';
import type { ContextInfo, GrimResult, Scope, StatusEnvelope, StatusItem } from '../grim';
import { computeUpdateAvailable } from '../webview/model';

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
  mergeCheckedFields(items, {}, true).remember as Record<string, never>;

suite('mergeCheckedFields', () => {
  test('a plain round inherits the last check instead of falling back to the lock proxy', () => {
    const remembered = checked([statusItem({ update_available: true, deprecated: 'moved on' })]);
    // What a watcher-driven `grim status` (no --check) returns: all three null.
    const { items } = mergeCheckedFields([statusItem({ state: 'installed' })], remembered, false);
    assert.strictEqual(items[0]?.update_available, true, 'the verdict survives a plain refresh');
    assert.strictEqual(items[0]?.deprecated, 'moved on', 'so does the deprecation notice');
  });

  test('a fresh false wins over a remembered true', () => {
    const remembered = checked([statusItem({ update_available: true })]);
    // grim re-resolved and found nothing newer — the authority, not the memory.
    const { items, remember } = mergeCheckedFields(
      [statusItem({ update_available: false })],
      remembered,
      true,
    );
    assert.strictEqual(items[0]?.update_available, false);
    assert.deepStrictEqual(
      mergeCheckedFields([statusItem()], remember, false).items[0]?.update_available,
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
      false,
    );
    assert.strictEqual(items[0]?.update_available, null);
  });

  test('a failed per-artifact re-resolution keeps the last good verdict', () => {
    const remembered = checked([statusItem({ update_available: true })]);
    // `checked: true` but this row's re-resolve failed — grim reports null, and
    // absence must never read as false (nor flip the count for one bad round).
    const { items } = mergeCheckedFields(
      [statusItem({ update_available: null })],
      remembered,
      true,
    );
    assert.strictEqual(items[0]?.update_available, true);
  });

  test('rows that vanished are pruned from what gets remembered', () => {
    const remembered = checked([
      statusItem({ name: 'kept', update_available: true }),
      statusItem({ name: 'uninstalled', update_available: true }),
    ]);
    assert.strictEqual(Object.keys(remembered).length, 2);
    const { remember } = mergeCheckedFields([statusItem({ name: 'kept' })], remembered, false);
    assert.deepStrictEqual(
      Object.keys(remember).map((k) => k.split('|')[1]),
      ['kept'],
      'the record stays bounded by the installed set',
    );
  });

  test('a remembered "no update" does not suppress fresh local drift', () => {
    // The registry said "nothing newer" at some point; the lock now says the
    // installed bits are behind it. That is a local question the memory cannot
    // answer, so it steps aside and the proxy decides.
    const remembered = checked([statusItem({ update_available: false })]);
    const { items } = mergeCheckedFields([statusItem({ state: 'outdated' })], remembered, false);
    assert.ok(items[0]);
    assert.strictEqual(
      computeUpdateAvailable(items[0]),
      true,
      'an outdated lock still surfaces an update, remembered "false" or not',
    );
  });

  test('a stale row KEEPS its remembered verdict — the scope-wide edit case', () => {
    // One grimoire.toml edit stales every declared row. The proxy says nothing
    // about stale, so if the memory also stepped aside the artifact that really
    // does have an update would go quiet along with everything else.
    const remembered = checked([statusItem({ update_available: true })]);
    const { items } = mergeCheckedFields([statusItem({ state: 'stale' })], remembered, false);
    assert.ok(items[0]);
    assert.strictEqual(computeUpdateAvailable(items[0]), true, 'the known update survives');

    const quiet = mergeCheckedFields(
      [statusItem({ state: 'stale' })],
      checked([statusItem({ update_available: false })]),
      false,
    );
    assert.ok(quiet.items[0]);
    assert.strictEqual(
      computeUpdateAvailable(quiet.items[0]),
      false,
      'while the other rows stay quiet instead of all claiming an update',
    );
  });

  test('a drifted row displays null but keeps the registry verdict in the record', () => {
    // Stepping aside is a DISPLAY rule: the record still carries the registry's
    // last word, so the next non-drifted round can show it again without waiting
    // for another check.
    const remembered = checked([statusItem({ update_available: true })]);
    const { items, remember } = mergeCheckedFields(
      [statusItem({ state: 'outdated' })],
      remembered,
      false,
    );
    assert.strictEqual(items[0]?.update_available, null, 'the row falls back to the local proxy');
    assert.deepStrictEqual(
      Object.values(remember).map((f) => f.update_available),
      [true],
      'while the registry verdict survives in the record',
    );
    assert.strictEqual(
      mergeCheckedFields([statusItem({ state: 'installed' })], remember, false).items[0]
        ?.update_available,
      true,
      'so the moment the drift clears, the last check answers again',
    );
  });

  test('an outdated row displays null and still persists the carried verdict', () => {
    // The drift rule reads `outdated || stale`, and only `stale` was ever
    // exercised — the `outdated` half could be deleted with the suite green.
    // Both sides of the rule are pinned here: the row falls back to the local
    // proxy, and the record keeps the registry's last word regardless.
    const remembered = checked([statusItem({ update_available: true })]);
    const { items, remember } = mergeCheckedFields(
      [statusItem({ state: 'outdated' })],
      remembered,
      false,
    );
    assert.strictEqual(items[0]?.update_available, null, 'the row falls back to the local proxy');
    assert.deepStrictEqual(
      Object.values(remember).map((f) => f.update_available),
      [true],
      'while the carried verdict is what a drifted row persists',
    );
    assert.strictEqual(
      mergeCheckedFields([statusItem({ state: 'installed' })], remember, false).items[0]
        ?.update_available,
      true,
      'so the last check answers again the moment the drift clears',
    );
  });

  test('a remembered "no update" still applies to a row with no local drift', () => {
    // The other side of the same rule: the step-aside is scoped to
    // outdated/stale rows, or the memory would do nothing at all and every
    // plain refresh would be back on the lock proxy.
    const remembered = checked([statusItem({ update_available: false })]);
    const { items } = mergeCheckedFields([statusItem({ state: 'installed' })], remembered, false);
    assert.ok(items[0]);
    assert.strictEqual(items[0].update_available, false, 'the remembered verdict still holds');
    assert.strictEqual(computeUpdateAvailable(items[0]), false);
  });

  test('a definitive check clears a remembered deprecation notice', () => {
    // Under `checked: true` grim DID re-resolve, so its null means "not
    // deprecated" — a clear, not "did not look". Falling back to memory here
    // pins a deprecation notice on an artifact forever, past the day upstream
    // un-deprecates it.
    const remembered = checked([
      statusItem({ deprecated: 'moved on', replaced_by: 'ghcr.io/grimoire-rs/skills/next' }),
    ]);
    const { items, remember } = mergeCheckedFields([statusItem()], remembered, true);
    assert.strictEqual(items[0]?.deprecated, null, 'the notice is cleared, not remembered');
    assert.strictEqual(items[0]?.replaced_by, null, 'and so is the replacement pointer');
    assert.strictEqual(
      mergeCheckedFields([statusItem()], remember, false).items[0]?.deprecated,
      null,
      'the clear is what gets remembered for the next plain round',
    );
  });

  test('a round that did not check retains a remembered deprecation notice', () => {
    // Plain `grim status` leaves all three null because it never looked. The
    // notice must survive that, or it would blink out on every watcher event.
    const remembered = checked([
      statusItem({ deprecated: 'moved on', replaced_by: 'ghcr.io/grimoire-rs/skills/next' }),
    ]);
    const { items } = mergeCheckedFields([statusItem()], remembered, false);
    assert.strictEqual(items[0]?.deprecated, 'moved on');
    assert.strictEqual(items[0]?.replaced_by, 'ghcr.io/grimoire-rs/skills/next');
  });

  test('same name in two kinds keeps separate verdicts', () => {
    const remembered = checked([
      statusItem({ kind: 'skill', name: 'demo', update_available: true }),
      statusItem({ kind: 'rule', name: 'demo', update_available: false }),
    ]);
    const { items } = mergeCheckedFields(
      [statusItem({ kind: 'skill', name: 'demo' }), statusItem({ kind: 'rule', name: 'demo' })],
      remembered,
      false,
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

  /** A ScopeService with BOTH scopes live, whose status envelope is chosen per
   *  scope and per `--check` — so a test can give one artifact opposite verdicts
   *  in the two scopes, and can answer a plain round differently from a checked
   *  one. */
  function serviceOverBothScopes(options: {
    store: CheckStore;
    envelope: (scope: Scope, check: boolean) => StatusEnvelope;
    /** Collects the output channel's lines. */
    log?: string[];
  }): ScopeService {
    const scopes = new ScopeService({ fsPath: '/tmp/unused' } as never, {
      appendLine: (line: string) => options.log?.push(line),
    } as never);
    scopes.checkStore = options.store;
    scopes.projectFolder = () => '/work/app';
    scopes.run = (async <T>(args: string[], scope: Scope): Promise<GrimResult<T>> => {
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
          } as unknown as ContextInfo,
        } as GrimResult<T>;
      }
      return {
        ok: true,
        value: options.envelope(scope, args.includes('--check')),
      } as GrimResult<T>;
    }) as ScopeService['run'];
    return scopes;
  }

  /** A CheckStore that answers `read` from whatever the test hands it and
   *  discards writes — for feeding the merge a corrupt persisted record. */
  function readOnlyStore(record: unknown): CheckStore {
    return {
      read: () => record as Record<string, CheckedFields>,
      write: async () => {},
    };
  }

  test('both scopes keep their own verdict for the same artifact', async () => {
    // Same kind|name|pin installed in both scopes, opposite answers from the two
    // registries. One shared record would let whichever scope wrote last decide
    // for both — and the self-prune would delete the other scope's entry.
    const store = memoryCheckStore();
    const scopes = serviceOverBothScopes({
      store,
      envelope: (scope, check) => ({
        items: [statusItem({ update_available: check ? scope === 'project' : null })],
        ...(check ? { checked: true } : {}),
      }),
    });
    await scopes.snapshot({ check: true });

    assert.deepStrictEqual(
      Object.values(store.read('project')).map((f) => f.update_available),
      [true],
      'the project verdict is persisted as the project registry answered it',
    );
    assert.deepStrictEqual(
      Object.values(store.read('global')).map((f) => f.update_available),
      [false],
      'and the global one as the global registry answered it',
    );

    // The plain round that follows returns all-null for both scopes, so what it
    // reports comes entirely from the two records.
    const plain = await scopes.snapshot();
    assert.strictEqual(plain.project?.status?.[0]?.update_available, true);
    assert.strictEqual(plain.global?.status?.[0]?.update_available, false);
  });

  test('a plain snapshot running alongside a checked one does not clobber its verdict', async () => {
    // A disk-backed store: a write is readable only once it lands, not the
    // moment the round that wrote it returns.
    const landed = new Map<Scope, Record<string, CheckedFields>>();
    const store: CheckStore = {
      read: (scope) => landed.get(scope) ?? {},
      write: (scope, record) =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            landed.set(scope, record);
            resolve();
          }, 0);
        }),
    };
    const scopes = serviceOverBothScopes({
      store,
      envelope: (_scope, check) => ({
        items: [statusItem({ update_available: check ? true : null })],
        ...(check ? { checked: true } : {}),
      }),
    });
    scopes.projectFolder = () => undefined; // one scope, one record in play

    // Overlapping rounds are routine: the details panel takes six snapshots
    // outside the refresh coalescer, any of which can straddle the daily check.
    const [, plainSnap] = await Promise.all([scopes.snapshot({ check: true }), scopes.snapshot()]);
    assert.strictEqual(
      plainSnap.global?.status?.[0]?.update_available,
      true,
      "the overlapping round's OWN rows already carry the verdict — that is the half a user sees",
    );
    await new Promise((resolve) => setTimeout(resolve, 0)); // let both writes land

    const after = await scopes.snapshot();
    assert.strictEqual(
      after.global?.status?.[0]?.update_available,
      true,
      'the plain round read a record the checked round had not persisted yet, then wrote its own nulls over it',
    );
  });

  test('an in-flight write is awaited, not overtaken — a late write cannot revert a newer record', async () => {
    // The chain advances on the WRITE, never on anything racing it. A 5s
    // timeout raced this write once: the race only lets the chain advance, the
    // abandoned write keeps running, so the round that overtook it persisted
    // newer verdicts and then had the old write land on top — a revert the next
    // plain refresh trusts for a day. Writes here land only when the test says
    // so, which is the "write that takes arbitrarily long" case.
    const landed = new Map<Scope, Record<string, CheckedFields>>();
    const pending: Array<() => void> = [];
    const store: CheckStore = {
      read: (scope) => landed.get(scope) ?? {},
      write: (scope, record) =>
        new Promise<void>((resolve) => {
          pending.push(() => {
            landed.set(scope, record);
            resolve();
          });
        }),
    };
    let verdict = true;
    const scopes = serviceOverBothScopes({
      store,
      envelope: (_scope, check) =>
        check
          ? { items: [statusItem({ update_available: verdict })], checked: true }
          : { items: [statusItem()] },
    });
    scopes.projectFolder = () => undefined; // one scope, one record in play

    // Round 1 says "update available" and its write stalls. The round itself
    // returns regardless — persistence is off the round's path.
    await scopes.snapshot({ check: true });
    assert.strictEqual(pending.length, 1, 'round 1 issued its write');

    // Round 2 is the registry's newer word: no update after all.
    verdict = false;
    const secondRound = scopes.snapshot({ check: true });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.strictEqual(
      pending.length,
      1,
      'round 2 waits behind the in-flight write instead of reading around it',
    );

    pending[0]?.(); // round 1's write lands, releasing round 2
    const second = await secondRound;
    assert.strictEqual(second.global?.status?.[0]?.update_available, false);
    assert.strictEqual(pending.length, 2, 'round 2 read the landed record and wrote its own');
    pending[1]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepStrictEqual(
      Object.values(landed.get('global') ?? {}).map((f) => f.update_available),
      [false],
      'the newest verdict is what stayed persisted — no older write reverted it',
    );
    const plain = await scopes.snapshot();
    assert.strictEqual(
      plain.global?.status?.[0]?.update_available,
      false,
      'and the plain refresh that follows reports it, not the reverted one',
    );
  });

  test('an offline --check logs the degrade and keeps the remembered verdicts', async () => {
    const store = memoryCheckStore();
    const log: string[] = [];
    let online = true;
    const scopes = serviceOverBothScopes({
      store,
      log,
      envelope: (_scope, check) =>
        online
          ? { items: [statusItem({ update_available: check })], checked: check }
          : // grim was asked to check, could not reach the registry, and says so.
            { items: [statusItem()], checked: false },
    });
    scopes.projectFolder = () => undefined;
    await scopes.snapshot({ check: true });

    online = false;
    const degraded = await scopes.snapshot({ check: true });
    assert.strictEqual(
      degraded.global?.status?.[0]?.update_available,
      true,
      'last-known beats no answer at all — an unreachable registry is not "no update"',
    );
    assert.ok(
      log.some((line) => line.includes('did not run online')),
      `the degrade is named in the log, not silent: ${log.join(' | ')}`,
    );
  });

  test('an offline --check must not clear a remembered deprecation notice', async () => {
    // The merge's `checked` argument is the ENVELOPE's `checked`, never "a check
    // was requested". Passing the request instead reads every degraded round as
    // a definitive clear: grim never got online, the notice is erased anyway,
    // and the clear is PERSISTED — so it stays gone until the registry is
    // reachable again and re-deprecates the artifact.
    const store = memoryCheckStore();
    let online = true;
    const scopes = serviceOverBothScopes({
      store,
      envelope: (_scope, check) =>
        online
          ? {
              items: [
                statusItem({
                  deprecated: 'moved on',
                  replaced_by: 'ghcr.io/grimoire-rs/skills/next',
                }),
              ],
              checked: check,
            }
          : // Asked to check, could not reach the registry, and says so.
            { items: [statusItem()], checked: false },
    });
    scopes.projectFolder = () => undefined;
    await scopes.snapshot({ check: true });

    online = false;
    const degraded = await scopes.snapshot({ check: true });
    assert.strictEqual(
      degraded.global?.status?.[0]?.deprecated,
      'moved on',
      'an unreachable registry is not the same claim as "no longer deprecated"',
    );
    assert.strictEqual(
      degraded.global?.status?.[0]?.replaced_by,
      'ghcr.io/grimoire-rs/skills/next',
      'and neither is it "no replacement"',
    );
    assert.deepStrictEqual(
      Object.values(store.read('global')).map((f) => f.deprecated),
      ['moved on'],
      'the notice is still remembered, so the next plain round has it too',
    );
  });

  test("a store whose write rejects still returns this round's rows", async () => {
    // The persist is deliberately off the round's path: a failed one costs the
    // NEXT round its memory, and must not cost this one the rows it already
    // merged. It is logged rather than propagated — but it IS logged.
    const log: string[] = [];
    const scopes = serviceOverBothScopes({
      store: { read: () => ({}), write: () => Promise.reject(new Error('disk is full')) },
      log,
      envelope: () => ({ items: [statusItem({ update_available: true })], checked: true }),
    });
    scopes.projectFolder = () => undefined;

    const snapshot = await scopes.snapshot({ check: true });
    assert.strictEqual(
      snapshot.global?.status?.[0]?.update_available,
      true,
      'the merged rows are handed back whether or not they could be persisted',
    );
    await new Promise((resolve) => setTimeout(resolve, 0)); // the write is off the round's path
    assert.ok(
      log.some((line) => line.includes('disk is full')),
      `the failed persist is named in the log, not swallowed: ${log.join(' | ')}`,
    );
  });

  test('a store whose read throws once does not wedge the scope for the session', async () => {
    let reads = 0;
    const scopes = serviceOverBothScopes({
      store: {
        read: () => {
          if (++reads === 1) {
            throw new Error('storage went away');
          }
          return {};
        },
        write: async () => {},
      },
      envelope: () => ({ items: [statusItem({ update_available: true })], checked: true }),
    });
    scopes.projectFolder = () => undefined;

    // The bad round itself is lost. What must not happen is its rejection
    // staying on the scope's read→merge→write chain, where every later
    // snapshot() for that scope would queue behind it and inherit it.
    await assert.rejects(scopes.snapshot({ check: true }), /storage went away/);
    const second = await scopes.snapshot({ check: true });
    assert.strictEqual(
      second.global?.status?.[0]?.update_available,
      true,
      'the next round still merges and returns its rows',
    );
  });

  test('a status envelope with no usable items degrades to an empty round', async () => {
    // Boundary guard: grim's JSON is additive and nullable, and a parsed
    // envelope is not a guarantee that `items` is an array.
    const missing = serviceOverBothScopes({
      store: memoryCheckStore(),
      envelope: () => ({}) as StatusEnvelope,
    });
    assert.deepStrictEqual((await missing.snapshot()).global?.status, []);

    const wrongType = serviceOverBothScopes({
      store: memoryCheckStore(),
      envelope: () => ({ items: 'nope' }) as unknown as StatusEnvelope,
    });
    assert.deepStrictEqual((await wrongType.snapshot()).global?.status, []);
  });

  test('a persisted record of null degrades instead of throwing', async () => {
    // `get<T>(key, {})` is an unchecked cast over JSON that round-tripped
    // through disk; a stored null took the whole snapshot down with it.
    const scopes = serviceOverBothScopes({
      store: readOnlyStore(null),
      envelope: () => ({ items: [statusItem()] }),
    });
    const snapshot = await scopes.snapshot();
    assert.strictEqual(snapshot.global?.status?.length, 1, 'the round still produces its rows');
    assert.strictEqual(snapshot.global?.status?.[0]?.update_available, null);
  });

  test('a persisted record that is not an object at all degrades', async () => {
    const scopes = serviceOverBothScopes({
      store: readOnlyStore('garbage'),
      envelope: () => ({ items: [statusItem()] }),
    });
    const snapshot = await scopes.snapshot();
    assert.strictEqual(snapshot.global?.status?.length, 1);
    assert.strictEqual(snapshot.global?.status?.[0]?.update_available, null);
  });

  test('a malformed entry whose artifact is gone is pruned from the store, not just skipped', async () => {
    // The write-skip guard compares against the RAW record. Against the
    // VALIDATED one both sides read as the single live key — the malformed entry
    // is dropped from `previous` and absent from `remember` — so no write ever
    // happens and the garbage outlives every round, the opposite of pruning it.
    const stored: Record<string, unknown> = {
      ...mergeCheckedFields([statusItem()], {}, true).remember,
      'skill|uninstalled|ghcr.io/grimoire-rs/skills/uninstalled:1.0.0': { update_available: 'yes' },
    };
    const written = new Map<Scope, Record<string, CheckedFields>>();
    const scopes = serviceOverBothScopes({
      store: {
        read: () => stored as Record<string, CheckedFields>,
        write: async (scope, record) => {
          written.set(scope, record);
        },
      },
      envelope: () => ({ items: [statusItem()] }),
    });
    scopes.projectFolder = () => undefined;
    await scopes.snapshot();
    await new Promise((resolve) => setTimeout(resolve, 0)); // the write is off the round's path

    assert.deepStrictEqual(
      Object.keys(written.get('global') ?? {}),
      Object.keys(mergeCheckedFields([statusItem()], {}, true).remember),
      'the round rewrites the record down to the installed set',
    );
  });

  test('a write that never settles does not wedge the round that made it', async () => {
    // `vscode.Memento.update` has no cancellation. Awaiting it inside the
    // per-scope chain made a stalled write hang that scope's snapshot() for the
    // session — and refreshAll's drain promise with it, so nothing refreshed
    // again at all.
    const scopes = serviceOverBothScopes({
      store: {
        read: () => ({}),
        write: () => new Promise<void>(() => {}), // never settles
      },
      envelope: () => ({ items: [statusItem({ update_available: true })], checked: true }),
    });
    scopes.projectFolder = () => undefined;

    const snapshot = await scopes.snapshot({ check: true });
    assert.strictEqual(
      snapshot.global?.status?.[0]?.update_available,
      true,
      'the rows are already correct — they never needed the write to land',
    );
  });

  /** This round's single global row, merged over the persisted record `stored`. */
  async function rowOver(stored: unknown): Promise<StatusItem | undefined> {
    const scopes = serviceOverBothScopes({
      store: readOnlyStore(stored),
      envelope: () => ({ items: [statusItem()] }),
    });
    return (await scopes.snapshot()).global?.status?.[0];
  }

  /** A REAL record for one fully-populated row — so the key format stays private
   *  to scopes.ts — with one field replaced by a value of the wrong type, the
   *  way a hand-edited or half-migrated store reads. The other two stay valid,
   *  so the entry is only rejectable by the guard being tested. */
  function poisoned(field: keyof CheckedFields, value: unknown): Record<string, unknown> {
    const record = mergeCheckedFields(
      [
        statusItem({
          update_available: true,
          deprecated: 'moved on',
          replaced_by: 'ghcr.io/grimoire-rs/skills/next',
        }),
      ],
      {},
      true,
    ).remember as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      record[key] = { ...(record[key] as object), [field]: value };
    }
    return record;
  }

  /** The three fields of an entry that WAS accepted, as the row shows them. */
  const shown = (item: StatusItem | undefined): unknown[] => [
    item?.update_available,
    item?.deprecated,
    item?.replaced_by,
  ];

  // One test per field: a single dropped guard cannot hide behind its
  // neighbours. Each poisons only its own field and asserts the whole entry is
  // rejected — dropping is per ENTRY, never per field, so a record we cannot
  // account for contributes nothing at all.
  test('a non-boolean update_available drops the whole entry', async () => {
    const item = await rowOver(poisoned('update_available', 'yes'));
    assert.ok(item, 'the round still produces its rows');
    assert.deepStrictEqual(shown(item), [null, null, null], '"yes" is not a verdict');
  });

  test('a non-string deprecated drops the whole entry', async () => {
    const item = await rowOver(poisoned('deprecated', 42));
    assert.ok(item);
    assert.deepStrictEqual(shown(item), [null, null, null], '42 is not a deprecation message');
  });

  test('a non-string replaced_by drops the whole entry', async () => {
    const item = await rowOver(poisoned('replaced_by', []));
    assert.ok(item);
    assert.deepStrictEqual(shown(item), [null, null, null], '[] is not a replacement reference');
  });

  test('a persisted entry that is null is dropped, not dereferenced', async () => {
    // `typeof null === 'object'` passes the object check, so without the
    // explicit null guard the field reads throw and take the whole snapshot
    // down — exactly what a persisted top-level null used to do.
    const key = Object.keys(mergeCheckedFields([statusItem()], {}, true).remember)[0];
    assert.ok(key);
    const item = await rowOver({ [key]: null });
    assert.ok(item, 'the round still produces its rows');
    assert.deepStrictEqual(shown(item), [null, null, null]);
  });

  test('a persisted entry missing a field is dropped, not coerced', async () => {
    // mergeCheckedFields always writes all three, so an entry carrying only some
    // of them was not written by us: it is half-migrated, hand-edited, or from a
    // version that means something else by what it did write. The one field
    // present is not evidence about the two that are absent.
    const key = Object.keys(mergeCheckedFields([statusItem()], {}, true).remember)[0];
    assert.ok(key);
    const item = await rowOver({ [key]: { update_available: true } });
    assert.ok(item);
    assert.deepStrictEqual(
      shown(item),
      [null, null, null],
      'an absent field is not a null one — the entry goes whole',
    );
  });
});
