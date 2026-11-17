// grim 0.16.0 output, recorded from the released binary in a sandbox (fake HOME,
// private GRIM_HOME, loopback registry; paths sanitized to /home/u, the registry
// to ghcr.io/acme). Covers declared dependencies (`requires`), the settings kind
// and the refusal paths the extension can reach. exits.json holds each exit code.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { gatePromptText, hookPromptFor } from '../gatePrompt';
import {
  installArgs,
  hookAllowArgs,
  configSetArgs,
  isForceable,
  isRetryable,
  parseReport,
  refusedNames,
  refusedPieces,
  uninstallNotice,
  updateSummary,
  withRefusedPieces,
} from '../grim';
import type { ActionReport, StatusItem } from '../grim';
import {
  armingLabel,
  buildDetailsVM,
  buildInstalledCards,
  computeUpdateAvailable,
  declaredKey,
  driftTitle,
  heldHint,
  heldTitle,
  installHolders,
  isHeld,
  isUnarmed,
  uninstallTitle,
  unarmedTooltip,
  type DetailsSources,
  type ScopeStatus,
  type WireStatusItem,
} from '../webview/model';
import type { InstallVM, ScopesVM } from '../webview/protocol';

const dir = path.join(__dirname, '..', '..', 'src', 'test', 'fixtures', 'grim', '0.16.0');
const raw = (name: string): string => fs.readFileSync(path.join(dir, `${name}.json`), 'utf8');
const load = <T = unknown>(name: string): T => JSON.parse(raw(name)) as T;
const exits = load<Record<string, number>>('exits');
const rows = (name: string): WireStatusItem[] => load<{ items: WireStatusItem[] }>(name).items;
const scopesVM: ScopesVM = { projectOpen: true, projectConfigured: true, projectName: 'my-app' };

/** The scope the sidebar builds from a status document: declared refs are the
 *  direct rows' pins, as `grim context` + grimoire.toml give them. */
const scopeOf = (name: string, more: Record<string, string> = {}): ScopeStatus => {
  const status = rows(name);
  const declared: Record<string, string> = {};
  for (const r of status) {
    if (r.direct === true && r.pinned) {
      declared[declaredKey(r.kind, r.name)] = r.pinned.split('@')[0] ?? r.pinned;
    }
  }
  // A declared bundle's row reads `pinned: null`; its ref only comes from grimoire.toml.
  return { scope: 'project', status, declared: { ...declared, ...more } };
};

const installsOf = (name: string, more: Record<string, string> = {}): Map<string, InstallVM> => {
  const out = new Map<string, InstallVM>();
  for (const card of buildInstalledCards([], [scopeOf(name, more)])) {
    for (const i of card.installs) {
      out.set(`${card.kind}/${card.name}`, i);
    }
  }
  return out;
};

// The documents that are an error envelope; every other file is a normal report
// (a refused update exits 65 with a report, not an error document).
const errorDocs = new Set([
  'err-install-modified',
  'err-major-downgrade',
  'err-stale-lock-update',
  'err-stale-lock-install',
  'err-no-lock-install',
  'err-dev-install-collision',
  'settings-install-refused',
]);

suite('grim 0.16.0 recordings', () => {
  test('every recording has its exit code, and parses as the right variant', () => {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json') && f !== 'exits.json')
      .map((f) => f.replace(/\.json$/, ''))
      .sort();
    assert.deepStrictEqual(Object.keys(exits).sort(), files);
    for (const [file, exit] of Object.entries(exits)) {
      const r = parseReport<unknown>(raw(file), exit, '');
      assert.strictEqual(r.ok, !errorDocs.has(file), file);
    }
  });
});

suite('grim 0.16.0 dependency rows', () => {
  test('skill requiring a rule and an MCP server: parents resolve to the skill', () => {
    const installs = installsOf('deps-status-skill-rule-mcp');
    const drive = installs.get('skill/drive');
    assert.ok(drive);
    assert.strictEqual(isHeld(drive), false);
    for (const key of ['rule/style', 'mcp/gdrive']) {
      const dep = installs.get(key);
      assert.ok(dep, key);
      assert.strictEqual(isHeld(dep), true, key);
      assert.deepStrictEqual(dep.requiredBy, [
        { kind: 'skill', name: 'drive', repo: 'ghcr.io/acme/drive' },
      ]);
      assert.strictEqual(
        heldTitle(dep),
        'Installed as a dependency of skill/drive — uninstall that to remove it',
      );
      assert.strictEqual(heldHint(dep), 'required by drive');
    }
  });

  test('chain: each link is held by its immediate parent', () => {
    const installs = installsOf('deps-status-chain');
    assert.deepStrictEqual(
      installs.get('skill/b')?.requiredBy?.map((p) => p.name),
      ['a'],
    );
    assert.deepStrictEqual(
      installs.get('rule/c-rule')?.requiredBy?.map((p) => p.name),
      ['b'],
    );
  });

  test('diamond: the shared leaf lists both parents', () => {
    const leaf = installsOf('deps-status-diamond').get('rule/leaf');
    assert.deepStrictEqual(
      leaf?.requiredBy?.map((p) => p.name),
      ['l', 'r'],
    );
    assert.strictEqual(heldHint(leaf as InstallVM), 'required by l, r');
  });

  test('bundle member with a dependency: member is via the bundle, its dependency is required by the member', () => {
    const installs = installsOf('deps-status-bundle-member-dep', {
      'bundle:pack': 'ghcr.io/acme/pack:1',
    });
    const member = installs.get('skill/m1');
    assert.deepStrictEqual(member?.viaBundles, ['ghcr.io/acme/pack']);
    assert.deepStrictEqual(member?.requiredBy, []);
    assert.deepStrictEqual(
      installs.get('rule/style')?.requiredBy?.map((p) => p.name),
      ['m1'],
    );
  });

  test('a direct row that something also requires keeps its Uninstall and names the parent', () => {
    const style = installsOf('deps-status-direct-and-required').get('rule/style');
    assert.ok(style);
    assert.strictEqual(isHeld(style), false);
    assert.deepStrictEqual(style.alsoRequiredBy, ['skill/drive']);
    assert.ok(uninstallTitle(style));
  });

  test('--check rows: update_available is read off the dependency rows too', () => {
    const items = rows('deps-status-check');
    assert.deepStrictEqual(
      items.map((i) => [i.name, computeUpdateAvailable(i)]),
      [
        ['drive', true],
        ['style', true],
        ['gdrive', false],
      ],
    );
    for (const row of items) {
      assert.ok(installHolders(row, scopeOf('deps-status-check')));
    }
  });

  test('a dev-install row (no pin, no declaration) builds without throwing and leaves the declared row alone', () => {
    const dev = rows('status-dev-install').find((i) => i.name === 'other');
    assert.strictEqual(dev?.pinned, null);
    assert.strictEqual(dev?.direct, false);
    assert.deepStrictEqual(dev?.required_by, []);
    assert.ok(installsOf('status-dev-install').has('skill/plain'));
  });

  test('a stale lock reads as stale rows with null pins and no update badge', () => {
    for (const row of rows('status-stale')) {
      assert.strictEqual(row.state, 'stale');
      assert.strictEqual(computeUpdateAvailable(row), false, row.name);
    }
    assert.ok(buildInstalledCards([], [scopeOf('status-stale')]).length > 0);
  });

  test('a member of a nested bundle is held by the bundle that lists it, though that bundle has no row', () => {
    // `pack` is declared by nothing: only `outer` is, so grim gives `pack` no
    // status row, and m1's required_by names a row that does not exist.
    const installs = installsOf('bundle-nested-status', { 'bundle:outer': 'ghcr.io/acme/outer:1' });
    const m1 = installs.get('skill/m1');
    assert.ok(m1);
    assert.deepStrictEqual(m1.viaBundles, ['ghcr.io/acme/pack']);
    assert.strictEqual(isHeld(m1), true);
    assert.deepStrictEqual(installs.get('skill/plain')?.viaBundles, ['ghcr.io/acme/outer']);
    assert.deepStrictEqual(
      installs.get('rule/style')?.requiredBy?.map((p) => p.name),
      ['m1'],
    );
  });

  test("--check on a nested bundle that moved: the row reads no update, the list is grim's alone", () => {
    const outer = rows('bundle-nested-status-check').find((i) => i.name === 'outer');
    assert.strictEqual(outer?.update_available, false);
    assert.deepStrictEqual((outer as { moved_nested_bundles?: unknown }).moved_nested_bundles, [
      { name: 'pack', reference: 'ghcr.io/acme/pack:1' },
    ]);
  });

  test('describe lists the declared dependencies, relative ids kept as published', () => {
    const describe = load<DetailsSources['describe']>('deps-describe-requires');
    const vm = buildDetailsVM({
      repo: 'ghcr.io/acme/drive',
      searchItem: null,
      describe,
      fetch: null,
      installs: [],
      scopes: scopesVM,
      logoUri: null,
    });
    assert.deepStrictEqual(
      vm.dependencies?.map((d) => [d.kind, d.name]),
      [
        ['rule', 'style'],
        ['mcp', 'gdrive'],
      ],
    );
    assert.deepStrictEqual(
      vm.dependencies?.map((d) => d.version),
      ['1', '1'],
    );
  });
});

suite('grim 0.16.0 details sources', () => {
  const sources = (repo: string, describe: string, fetch: string) => ({
    repo,
    searchItem: null,
    describe: load<DetailsSources['describe']>(describe),
    fetch: load<DetailsSources['fetch']>(fetch),
    installs: [],
    scopes: scopesVM,
    logoUri: null,
  });

  test('a bundle with a nested bundle lists both members, the nested one as a bundle', () => {
    const vm = buildDetailsVM(
      sources('ghcr.io/acme/outer', 'bundle-nested-describe', 'bundle-nested-fetch'),
    );
    assert.strictEqual(vm.kind, 'bundle');
    assert.deepStrictEqual(
      vm.members.map((m) => [m.kind, m.name, m.repo]),
      [
        ['skill', 'plain', 'ghcr.io/acme/plain'],
        ['bundle', 'pack', 'ghcr.io/acme/pack'],
      ],
    );
    // A bundle's members are not its `requires`.
    assert.deepStrictEqual(vm.dependencies, []);
  });

  test('a skill that requires others shows the requirements, relative ids resolved against its repo', () => {
    const vm = buildDetailsVM(
      sources('ghcr.io/acme/drive', 'deps-describe-requires', 'skill-requires-fetch'),
    );
    assert.deepStrictEqual(
      vm.dependencies?.map((d) => [d.kind, d.name, d.repo]),
      [
        ['rule', 'style', 'ghcr.io/acme/style'],
        ['mcp', 'gdrive', 'ghcr.io/acme/gdrive'],
      ],
    );
  });

  test('an MCP descriptor fetch is shown as JSON contents', () => {
    const vm = buildDetailsVM({
      ...sources('ghcr.io/acme/gdrive', 'deps-describe-requires', 'mcp-fetch'),
      describe: null,
    });
    assert.strictEqual(vm.kind, 'mcp');
    assert.ok((vm.contentJson ?? '').length > 0);
  });
});

suite('grim 0.16.0 action reports', () => {
  test('uninstall: a needed dependency is kept, the dependent and a direct+required row go', () => {
    assert.match(
      uninstallNotice(load<ActionReport>('deps-uninstall-kept-by-dependency')) ?? '',
      /required by another installed artifact/,
    );
    assert.match(
      uninstallNotice(load<ActionReport>('deps-uninstall-kept-by-bundle')) ?? '',
      /installed via a bundle/,
    );
    assert.strictEqual(uninstallNotice(load<ActionReport>('deps-uninstall-dependent')), null);
    assert.strictEqual(
      uninstallNotice(load<ActionReport>('deps-uninstall-direct-and-required')),
      null,
    );
  });

  test('update: closure and whole runs summarize every action', () => {
    const closure = load<{ items: { action: string }[] }>('deps-update-closure');
    assert.strictEqual(
      updateSummary(closure.items),
      '1 updated, 2 unchanged, 0 removed, 0 kept-modified, 0 restored',
    );
    const whole = load<{ items: { action: string }[] }>('deps-update-whole');
    assert.match(updateSummary(whole.items), /^2 updated, 1 unchanged/);
  });

  test('a refused dependency update names the dependency, not the skill that pulled it in', () => {
    const report = load('deps-update-refused');
    assert.deepStrictEqual(refusedNames(report), ['style']);
    assert.deepStrictEqual(refusedPieces(report), []);
  });

  test('add/uninstall reports carry no field the extension reads as an error', () => {
    for (const file of ['deps-add-pulled-in', 'deps-uninstall-kept-by-dependency', 'lock-report']) {
      const r = parseReport<unknown>(raw(file), 0, '');
      assert.strictEqual(r.ok, true, file);
    }
  });
});

suite('grim 0.16.0 error documents', () => {
  const err = (file: string) => {
    const r = parseReport<unknown>(raw(file), exits[file] ?? 1, '');
    assert.strictEqual(r.ok, false, file);
    return r as Extract<typeof r, { kind: 'error' }>;
  };

  test('a named update on a stale lock carries reason stale-lock (the recovery offer keys on it)', () => {
    const r = err('err-stale-lock-update');
    assert.strictEqual(r.exitCode, 65);
    assert.strictEqual(r.reason, 'stale-lock');
    assert.strictEqual(isForceable(r), false);
  });

  test('install on a stale lock is a plain 65 with no reason', () => {
    const r = err('err-stale-lock-install');
    assert.strictEqual(r.exitCode, 65);
    assert.strictEqual(r.reason, undefined);
    assert.match(r.message, /run `grim lock`/);
  });

  test('no lock is exit 79 reason no-lock', () => {
    const r = err('err-no-lock-install');
    assert.strictEqual(r.exitCode, 79);
    assert.strictEqual(r.reason, 'no-lock');
  });

  test('major-downgrade is exit 78, not retryable, not forceable, message intact', () => {
    const r = err('err-major-downgrade');
    assert.strictEqual(r.exitCode, 78);
    assert.strictEqual(r.reason, 'major-downgrade');
    assert.strictEqual(isRetryable(r), false);
    assert.strictEqual(isForceable(r), false);
    assert.match(r.message, /--allow-downgrade/);
  });

  test("a dev-install collision is exit 64 with grim's own words", () => {
    const r = err('err-dev-install-collision');
    assert.strictEqual(r.exitCode, 64);
    assert.match(r.message, /already declared/);
  });

  test('a modified file refusal is forceable', () => {
    const r = err('err-install-modified');
    assert.strictEqual(r.reason, 'modified');
    assert.strictEqual(isForceable(r), true);
  });
});

suite('grim 0.16.0 settings', () => {
  const settingsRow = (file: string): WireStatusItem => {
    const row = rows(file)[0];
    assert.ok(row, file);
    return row;
  };
  const installOf = (file: string, scope: ScopeStatus['scope'] = 'project'): InstallVM => {
    const row = settingsRow(file);
    const cards = buildInstalledCards(
      [],
      [{ scope, status: [row], declared: { [`settings:${row.name}`]: 'ghcr.io/acme/full:1' } }],
    );
    assert.strictEqual(cards.length, 1, file);
    return cards[0]?.installs[0] as InstallVM;
  };

  test('every settings status row builds a card listing each client once', () => {
    const files = Object.keys(exits).filter((f) => f.startsWith('settings-status-'));
    assert.ok(files.length >= 8);
    for (const file of files) {
      const clients = installOf(file).clients;
      assert.deepStrictEqual(clients, [...new Set(clients)], file);
    }
  });

  test("gated rows are unarmed with grim's message and label", () => {
    for (const file of ['settings-status-flag-off', 'settings-status-not-consented']) {
      const vm = installOf(file);
      assert.strictEqual(isUnarmed(vm), true, file);
      assert.ok(unarmedTooltip(vm).includes(settingsRow(file).arming?.[0]?.message ?? '\0'), file);
      assert.strictEqual(armingLabel(vm), 'not applied', file);
    }
  });

  test('root-fence refusals are not applied and name the --global remedy', () => {
    for (const [file, cause] of [
      ['settings-status-root-relative', 'settings-root-relative'],
      ['settings-status-root-in-workspace', 'settings-root-in-workspace'],
    ] as const) {
      assert.strictEqual(settingsRow(file).state, 'not-armed', file);
      assert.strictEqual(settingsRow(file).arming?.[0]?.cause, cause, file);
      const vm = installOf(file, 'global');
      assert.strictEqual(isUnarmed(vm), true, file);
      assert.ok(unarmedTooltip(vm).includes(settingsRow(file).arming?.[0]?.message ?? '\0'), file);
      // The values grim wrote earlier stay in place, so the row reads held back.
      assert.strictEqual(armingLabel(vm), 'held back', file);
    }
  });

  test('a tracked local file needs attention; an applied row is not unarmed, a no-applicable one is held', () => {
    const tracked = installOf('settings-status-local-tracked');
    assert.strictEqual(isUnarmed(tracked), true);
    assert.strictEqual(armingLabel(tracked), 'needs attention');
    assert.strictEqual(isUnarmed(installOf('settings-status-consented')), false);
    // Nothing of the package applies to the selected client: the row is held, not applied.
    const none = installOf('settings-status-no-applicable');
    assert.strictEqual(isUnarmed(none), true);
    assert.strictEqual(armingLabel(none), 'not applied');
  });

  test('a modified row words its drift for values', () => {
    const vm = installOf('settings-status-modified');
    assert.strictEqual(driftTitle(vm), 'Settings values were changed locally');
  });

  test('gate prompts: flag off enables then installs, no consent allows then installs', () => {
    const off = hookPromptFor(rows('settings-status-flag-off') as unknown as StatusItem[]);
    assert.deepStrictEqual(off, { gate: 'enable-settings', kinds: ['settings'], names: ['full'] });
    assert.deepStrictEqual(gatePromptText(off as NonNullable<typeof off>).steps, [
      configSetArgs('options.experimental.settings', 'true'),
      installArgs(),
    ]);
    const consent = hookPromptFor(rows('settings-status-not-consented') as unknown as StatusItem[]);
    assert.deepStrictEqual(consent, {
      gate: 'consent',
      kinds: ['settings'],
      names: ['full'],
      held: ['settings'],
    });
    assert.deepStrictEqual(gatePromptText(consent as NonNullable<typeof consent>).steps, [
      hookAllowArgs(),
      installArgs(),
    ]);
    for (const file of [
      'settings-status-consented',
      'settings-status-modified',
      'settings-status-local-tracked',
      'settings-status-root-relative',
      'settings-status-root-in-workspace',
    ]) {
      assert.strictEqual(hookPromptFor(rows(file) as unknown as StatusItem[]), null, file);
    }
  });

  test('a refused update and a refused install name the value and never the user value', () => {
    const report = load('settings-update-refused');
    assert.deepStrictEqual(refusedNames(report), ['full']);
    const detail = withRefusedPieces('detail', refusedPieces(report));
    assert.ok(detail.includes('claude .claude/settings.local.json /model'));
    assert.ok(!detail.includes('mine') && !detail.includes('haiku'));
    const r = parseReport<unknown>(raw('settings-install-refused'), 65, '');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(isForceable(r as { forceable?: boolean }), true);
    const pieces = (r as { pieces?: never }).pieces ?? [];
    assert.ok(withRefusedPieces('d', pieces).includes('/model'));
  });

  test('a version bump reports changed values and refuses nothing', () => {
    const report = load<{ items: { action: string }[] }>('settings-update-bump');
    assert.strictEqual(
      updateSummary(report.items),
      '1 updated, 0 unchanged, 0 removed, 0 kept-modified, 0 restored',
    );
    assert.deepStrictEqual(refusedNames(report), []);
    assert.deepStrictEqual(refusedPieces(report), []);
  });
});
