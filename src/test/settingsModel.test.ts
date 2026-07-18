import * as assert from 'assert';
import {
  addRegistryDraftValid,
  allRows,
  buildGroups,
  buildRegistryRow,
  buildSettingsRow,
  buildSettingsVM,
  chipHasComma,
  consumeAwaitingConfirm,
  defaultHint,
  draftToLocator,
  EMPTY_REGISTRY_DRAFT,
  enumSelectedValue,
  isModified,
  isValidChip,
  isValidInteger,
  joinList,
  LOCATOR_PLACEHOLDER,
  reloadedKeys,
  resolveScopeSwitch,
  resolveSettingsPhase,
  shouldBlockNumberWheel,
  splitList,
  toggleRegistryHelp,
} from '../webview/settings/model';
import { scopesVM, settingsSource, settingsState, wireConfigEntries, wireConfigEntry, wireRegistryEntry } from './fixtures/settingsVms';

suite('buildSettingsRow', () => {
  test('narrows each of the 6 known types', () => {
    for (const type of ['string', 'boolean', 'enum', 'string-list', 'string-set', 'integer']) {
      assert.strictEqual(buildSettingsRow(wireConfigEntry({ type })).type, type);
    }
  });

  test('an unrecognized future type degrades to unknown (read-only), never throws', () => {
    const row = buildSettingsRow(wireConfigEntry({ type: 'color' }));
    assert.strictEqual(row.type, 'unknown');
  });

  // Regression (verifier-flagged): an UNSET row (value null, default
  // non-null) previously showed the modified accent + bg tint just because
  // null !== the default — modified must require the row to actually be SET.
  test('modified requires the row to be SET — an unset row never shows modified, even if value differs from default', () => {
    assert.strictEqual(buildSettingsRow(wireConfigEntry({ value: 'flat', default: 'flat', set: true })).modified, false);
    assert.strictEqual(buildSettingsRow(wireConfigEntry({ value: 'tree', default: 'flat', set: false })).modified, false);
    assert.strictEqual(buildSettingsRow(wireConfigEntry({ value: 'tree', default: 'flat', set: true })).modified, true);
  });

  test('every row starts idle with no error message', () => {
    const row = buildSettingsRow(wireConfigEntry());
    assert.strictEqual(row.status, 'idle');
    assert.strictEqual(row.errorMessage, undefined);
  });

  test('constraints: null on the wire stays null on the row', () => {
    const row = buildSettingsRow(wireConfigEntry({ constraints: null }));
    assert.strictEqual(row.constraints, null);
  });

  test('constraints: wire snake_case (item_pattern/item_width) maps to the VM camelCase shape', () => {
    const row = buildSettingsRow(
      wireConfigEntry({ constraints: { item_pattern: '^[^\\s]$', item_width: 1 } }),
    );
    assert.deepStrictEqual(row.constraints, { itemPattern: '^[^\\s]$', itemWidth: 1 });
  });
});

suite('isModified', () => {
  test('unset row never shows modified, even when its value differs from a non-null default', () => {
    assert.strictEqual(isModified(false, null, 'tree'), false);
    assert.strictEqual(isModified(false, 'tree', 'flat'), false);
  });

  test('a set row is modified only when value differs from default', () => {
    assert.strictEqual(isModified(true, 'flat', 'tree'), true);
    assert.strictEqual(isModified(true, 'tree', 'tree'), false);
  });
});

suite('enumSelectedValue', () => {
  test('a SET row selects its own value', () => {
    assert.strictEqual(
      enumSelectedValue({ value: 'flat', default: 'tree', values: ['flat', 'tree'] }),
      'flat',
    );
  });

  // Regression: an unset "Default view" row rendered "flat" (values[0])
  // selected even though the effective default is "tree" — the dropdown
  // must select the row's DEFAULT for an unset row, never just the first
  // enum option.
  test('an UNSET row (value null) selects the DEFAULT, never the first values[] entry', () => {
    assert.strictEqual(
      enumSelectedValue({ value: null, default: 'tree', values: ['flat', 'tree'] }),
      'tree',
    );
  });

  test('unset with no fixed default falls back to the first values[] entry', () => {
    assert.strictEqual(
      enumSelectedValue({ value: null, default: null, values: ['flat', 'tree'] }),
      'flat',
    );
  });
});

suite('defaultHint', () => {
  test('null-default behavioral captions for default_registry/clients', () => {
    assert.strictEqual(
      defaultHint('options.default_registry', null),
      'Not set — the registry precedence chain decides.',
    );
    assert.strictEqual(
      defaultHint('options.clients', null),
      'Not set — clients are auto-detected, falling back to all clients when none are detected.',
    );
  });

  test('any other null default falls back to a generic caption', () => {
    assert.strictEqual(defaultHint('options.mystery_key', null), 'Not set.');
  });

  test('a concrete default renders "Default: <value>"', () => {
    assert.strictEqual(defaultHint('options.expand_levels', '1'), 'Default: 1');
    assert.strictEqual(defaultHint('options.group_by_type', 'false'), 'Default: false');
    assert.strictEqual(defaultHint('options.default_view', 'tree'), 'Default: tree');
  });
});

suite('buildGroups', () => {
  test('groups the 7 fixed keys into Options (3) / TUI (4), stable order, no empty groups', () => {
    const groups = buildGroups(wireConfigEntries());
    assert.deepStrictEqual(
      groups.map((g) => g.title),
      ['Options', 'TUI'],
    );
    assert.deepStrictEqual(
      groups[0]?.rows.map((r) => r.key),
      ['options.default_registry', 'options.clients', 'options.show_deprecated'],
    );
    assert.deepStrictEqual(
      groups[1]?.rows.map((r) => r.key),
      ['options.default_view', 'options.group_by_type', 'options.tree_separators', 'options.expand_levels'],
    );
  });

  test('an unrecognized future key falls into Options rather than being dropped', () => {
    const groups = buildGroups([wireConfigEntry({ key: 'options.future_thing' })]);
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0]?.title, 'Options');
  });

  test('empty input yields no groups (empty panels omitted)', () => {
    assert.deepStrictEqual(buildGroups([]), []);
  });
});

suite('buildRegistryRow', () => {
  test('oci row', () => {
    const row = buildRegistryRow(wireRegistryEntry());
    assert.strictEqual(row.type, 'oci');
    assert.strictEqual(row.locator, 'ghcr.io/grimoire-rs');
    assert.strictEqual(row.legacy, false);
  });

  test('index row', () => {
    const row = buildRegistryRow(wireRegistryEntry({ oci: null, index: 'https://x/index.json' }));
    assert.strictEqual(row.type, 'index');
    assert.strictEqual(row.locator, 'https://x/index.json');
  });

  test('legacy alias-less row is read-only', () => {
    const row = buildRegistryRow(wireRegistryEntry({ alias: null }));
    assert.strictEqual(row.legacy, true);
    assert.strictEqual(row.alias, null);
  });
});

suite('resolveSettingsPhase / buildSettingsVM: empty and init states', () => {
  test('grim missing wins over everything else', () => {
    assert.strictEqual(
      resolveSettingsPhase({ scope: 'project', scopes: scopesVM(), grimMissing: true, configExists: true }),
      'no-grim',
    );
  });

  test('project scope with no workspace folder open', () => {
    const source = settingsSource({
      scope: 'project',
      scopes: scopesVM({ projectOpen: false, projectConfigured: false }),
    });
    const vm = buildSettingsVM(source);
    assert.strictEqual(vm.phase, 'no-folder');
    assert.deepStrictEqual(vm.groups, []);
    assert.deepStrictEqual(vm.registries, []);
  });

  test('project scope open but no grimoire.toml yet', () => {
    const vm = buildSettingsVM(settingsSource({ scope: 'project', configExists: false }));
    assert.strictEqual(vm.phase, 'project-no-toml');
    assert.strictEqual(vm.configPath, null); // not shown when it doesn't exist (design item 1)
  });

  test('project scope, folder open + toml present -> ready', () => {
    const vm = buildSettingsVM(settingsSource({ scope: 'project' }));
    assert.strictEqual(vm.phase, 'ready');
    assert.ok(vm.groups.length > 0);
  });

  // Global's readiness depends only on ITS OWN config existing — never on
  // whether a project workspace happens to be open (the two scopes are
  // independent; a Global tab visited with no folder open must still work).
  test('global scope, config exists: ready regardless of project workspace state', () => {
    const vm = buildSettingsVM(
      settingsSource({ scope: 'global', scopes: scopesVM({ projectOpen: false, projectConfigured: false }) }),
    );
    assert.strictEqual(vm.phase, 'ready');
  });

  // Regression (user-reported bug, spec §2 — user-decided 2026-07-17): Global
  // used to render as unconditionally 'ready' even with no global
  // grimoire.toml, so the always-visible form's first control edit silently
  // materialized the file with no explicit Initialize step. Global now gates
  // on configExists exactly like Project.
  test('global scope with no grimoire.toml yet -> global-no-toml, mirroring project-no-toml', () => {
    const vm = buildSettingsVM(settingsSource({ scope: 'global', configExists: false }));
    assert.strictEqual(vm.phase, 'global-no-toml');
    assert.strictEqual(vm.groups.length, 0);
    assert.strictEqual(vm.registries.length, 0);
    // Tab-bar path label stays hidden (design item 1) — same rule as project.
    assert.strictEqual(vm.configPath, null);
    // But the empty-state COPY needs the real, unhardcoded path (unlike
    // project's fixed `grimoire.toml` text) — rawConfigPath carries
    // it through regardless of existence.
    assert.strictEqual(vm.rawConfigPath, settingsSource().configPath);
  });

  test('rawConfigPath carries the resolved path through even once ready (not just the empty states)', () => {
    const vm = buildSettingsVM(settingsSource({ scope: 'global' }));
    assert.strictEqual(vm.phase, 'ready');
    assert.strictEqual(vm.rawConfigPath, settingsSource().configPath);
    assert.strictEqual(vm.configPath, settingsSource().configPath);
  });
});

suite('shouldBlockNumberWheel', () => {
  test('blocks only a wheel event over a FOCUSED number input', () => {
    assert.strictEqual(shouldBlockNumberWheel(true, true), true);
  });

  test('never blocks page scroll everywhere else', () => {
    assert.strictEqual(shouldBlockNumberWheel(true, false), false, 'unfocused number input');
    assert.strictEqual(shouldBlockNumberWheel(false, true), false, 'a different, focused element');
    assert.strictEqual(shouldBlockNumberWheel(false, false), false);
  });
});

suite('buildSettingsVM: registries', () => {
  test('maps registries, including a legacy row', () => {
    const vm = buildSettingsVM(
      settingsSource({
        registries: [wireRegistryEntry(), wireRegistryEntry({ alias: null, default: false })],
      }),
    );
    assert.strictEqual(vm.registries.length, 2);
    assert.strictEqual(vm.registries[1]?.legacy, true);
  });

  test('empty registries list', () => {
    const vm = buildSettingsVM(settingsSource({ registries: [] }));
    assert.deepStrictEqual(vm.registries, []);
  });
});

suite('reloadedKeys', () => {
  test('flags rows whose value changed between two same-scope ready VMs', () => {
    const prev = settingsState({
      groups: [{ title: 'Options', rows: [buildSettingsRow(wireConfigEntry({ key: 'a', value: '1' }))] }],
    });
    const next = settingsState({
      groups: [{ title: 'Options', rows: [buildSettingsRow(wireConfigEntry({ key: 'a', value: '2' }))] }],
    });
    assert.deepStrictEqual(reloadedKeys(prev, next), ['a']);
  });

  test('no diff -> no reloaded keys', () => {
    const state = settingsState({
      groups: [{ title: 'Options', rows: [buildSettingsRow(wireConfigEntry({ key: 'a', value: '1' }))] }],
    });
    assert.deepStrictEqual(reloadedKeys(state, state), []);
  });

  test('a scope switch never flags reloaded (different scope entirely)', () => {
    const prev = settingsState({
      scope: 'project',
      groups: [{ title: 'Options', rows: [buildSettingsRow(wireConfigEntry({ key: 'a', value: '1' }))] }],
    });
    const next = settingsState({
      scope: 'global',
      groups: [{ title: 'Options', rows: [buildSettingsRow(wireConfigEntry({ key: 'a', value: '2' }))] }],
    });
    assert.deepStrictEqual(reloadedKeys(prev, next), []);
  });
});

suite('allRows', () => {
  test('flattens every group', () => {
    const state = settingsState({
      groups: [
        { title: 'Options', rows: [buildSettingsRow(wireConfigEntry({ key: 'a' }))] },
        { title: 'TUI', rows: [buildSettingsRow(wireConfigEntry({ key: 'b' }))] },
      ],
    });
    assert.deepStrictEqual(allRows(state).map((r) => r.key), ['a', 'b']);
  });
});

suite('client-side guards', () => {
  test('isValidChip: null constraints falls back to the exactly-one-character rule', () => {
    assert.strictEqual(isValidChip('/', null), true);
    assert.strictEqual(isValidChip('--', null), false);
    assert.strictEqual(isValidChip('', null), false);
  });

  test('isValidChip: constraints present — item_pattern is enforced', () => {
    const constraints = { itemPattern: '^[a-z]$', itemWidth: 1 };
    assert.strictEqual(isValidChip('a', constraints), true);
    assert.strictEqual(isValidChip('A', constraints), false);
    assert.strictEqual(isValidChip('1', constraints), false);
  });

  test('isValidChip: constraints present — item_width is enforced independently of the pattern', () => {
    const constraints = { itemPattern: '^[^\\s]+$', itemWidth: 2 };
    assert.strictEqual(isValidChip('ab', constraints), true, 'matches pattern and width');
    assert.strictEqual(isValidChip('a', constraints), false, 'matches pattern but too narrow');
    assert.strictEqual(isValidChip('abc', constraints), false, 'matches pattern but too wide');
  });

  test('isValidChip: real grim tree_separators constraints (advisory pattern + width 1)', () => {
    const constraints = { itemPattern: '^[^\\s\\p{C}]$', itemWidth: 1 };
    assert.strictEqual(isValidChip('/', constraints), true);
    assert.strictEqual(isValidChip(' ', constraints), false, 'whitespace excluded by the pattern');
    assert.strictEqual(isValidChip('--', constraints), false, 'width 1 rejects a 2-char chip');
  });

  test('isValidChip: an unparseable item_pattern fails open (accepts) rather than blocking a value grim might accept', () => {
    const constraints = { itemPattern: '(unterminated', itemWidth: 1 };
    assert.strictEqual(isValidChip('/', constraints), true);
    assert.strictEqual(isValidChip('anything', constraints), true);
  });

  test('chipHasComma: rejected unconditionally, regardless of constraints (wire-format guard)', () => {
    assert.strictEqual(chipHasComma('a,b'), true);
    assert.strictEqual(chipHasComma('/'), false);
  });

  test('isValidInteger: non-negative whole numbers only', () => {
    assert.strictEqual(isValidInteger('0'), true);
    assert.strictEqual(isValidInteger('42'), true);
    assert.strictEqual(isValidInteger('-1'), false);
    assert.strictEqual(isValidInteger('1.5'), false);
    assert.strictEqual(isValidInteger(''), false);
  });

  test('splitList / joinList round-trip the comma-joined wire format', () => {
    assert.deepStrictEqual(splitList('a,b,c'), ['a', 'b', 'c']);
    assert.deepStrictEqual(splitList(null), []);
    assert.deepStrictEqual(splitList(''), []);
    assert.strictEqual(joinList(['a', 'b']), 'a,b');
  });
});

suite('addRegistryDraftValid', () => {
  test('requires both alias and locator', () => {
    assert.strictEqual(addRegistryDraftValid(EMPTY_REGISTRY_DRAFT), false);
    assert.strictEqual(
      addRegistryDraftValid({ ...EMPTY_REGISTRY_DRAFT, alias: 'x', locator: 'ghcr.io/x' }),
      true,
    );
    assert.strictEqual(addRegistryDraftValid({ ...EMPTY_REGISTRY_DRAFT, alias: '  ', locator: 'x' }), false);
  });
});

suite('EMPTY_REGISTRY_DRAFT', () => {
  test('defaults to Index locator — the common case', () => {
    assert.strictEqual(EMPTY_REGISTRY_DRAFT.kind, 'index');
  });
});

suite('draftToLocator', () => {
  test('index kind maps to the {index} RegistryLocator variant', () => {
    assert.deepStrictEqual(
      draftToLocator({ ...EMPTY_REGISTRY_DRAFT, kind: 'index', locator: ' https://x/index.json ' }),
      { index: 'https://x/index.json' },
    );
  });

  test('oci kind maps to the {oci} RegistryLocator variant', () => {
    assert.deepStrictEqual(
      draftToLocator({ ...EMPTY_REGISTRY_DRAFT, kind: 'oci', locator: ' ghcr.io/acme ' }),
      { oci: 'ghcr.io/acme' },
    );
  });
});

suite('LOCATOR_PLACEHOLDER', () => {
  test('one placeholder per registry type', () => {
    assert.strictEqual(
      LOCATOR_PLACEHOLDER.index,
      'https://example.com/index.json — or — git repository URL',
    );
    assert.strictEqual(LOCATOR_PLACEHOLDER.oci, 'ghcr.io/org');
  });
});

suite('toggleRegistryHelp', () => {
  test('closed -> clicking an icon opens its tooltip', () => {
    assert.strictEqual(toggleRegistryHelp(null, 'index'), 'index');
    assert.strictEqual(toggleRegistryHelp(null, 'oci'), 'oci');
  });

  test('clicking the OPEN icon again closes it', () => {
    assert.strictEqual(toggleRegistryHelp('index', 'index'), null);
    assert.strictEqual(toggleRegistryHelp('oci', 'oci'), null);
  });

  test('clicking the OTHER icon switches to it — only one open at a time', () => {
    assert.strictEqual(toggleRegistryHelp('index', 'oci'), 'oci');
    assert.strictEqual(toggleRegistryHelp('oci', 'index'), 'index');
  });
});

suite('consumeAwaitingConfirm', () => {
  test('no credits outstanding -> not self-triggered, stays at 0', () => {
    assert.deepStrictEqual(consumeAwaitingConfirm(0), { selfTriggered: false, next: 0 });
  });

  test('one credit outstanding -> self-triggered, consumed down to 0', () => {
    assert.deepStrictEqual(consumeAwaitingConfirm(1), { selfTriggered: true, next: 0 });
  });

  // Regression: two overlapping self-writes in the same scope (B queues
  // behind A's grim round trip) used to zero the whole counter on A's own
  // confirmation, leaving B's later confirmation looking external. A repost
  // must consume at most ONE credit so B's own credit survives A's.
  test('two credits outstanding -> the first repost stays self-triggered and leaves one credit for the second', () => {
    const first = consumeAwaitingConfirm(2);
    assert.deepStrictEqual(first, { selfTriggered: true, next: 1 });
    const second = consumeAwaitingConfirm(first.next);
    assert.deepStrictEqual(second, { selfTriggered: true, next: 0 });
  });

  test('never goes negative', () => {
    assert.deepStrictEqual(consumeAwaitingConfirm(0).next, 0);
  });
});

// Item 3 regression: pins the scope-switch decision logic main.ts's
// 'set-scope' handler defers to. The bug (every switch forcing the
// structurally different 'loading' template, tearing the form down and
// rebuilding it twice) lived in main.ts, which only runs in a webview DOM
// and isn't unit-tested directly anywhere in this suite (no jsdom dependency,
// same as sidebar/details' main.ts files) — the settingsRender goldens are a
// string-render rig (@lit-labs/ssr) that can't observe node identity/patch-
// vs-replace either. Pinning resolveScopeSwitch's pure decision is the
// strongest feasible regression: it proves a cache hit reuses the SAME VM
// reference (so lit-html's keyed repeat() patches rows instead of the
// subtree being torn down) and that only a true first-visit (no cache) still
// falls back to the loading placeholder.
suite('resolveScopeSwitch', () => {
  test('cache hit: shows the cached VM immediately (same reference — no clone) and flags a non-structural refresh', () => {
    const cached = settingsState({ scope: 'global' });
    const current = settingsState({ scope: 'project' });
    const result = resolveScopeSwitch('global', cached, current);
    assert.strictEqual(result.vm, cached);
    assert.strictEqual(result.refreshing, true);
  });

  test('no cache, but a VM already showing: falls back to the loading placeholder for the target scope', () => {
    const current = settingsState({ scope: 'project' });
    const result = resolveScopeSwitch('global', undefined, current);
    assert.strictEqual(result.refreshing, false);
    assert.strictEqual(result.vm?.scope, 'global');
    assert.strictEqual(result.vm?.phase, 'loading');
  });

  test('no cache and nothing showing yet: nothing to render', () => {
    assert.deepStrictEqual(resolveScopeSwitch('global', undefined, null), { vm: null, refreshing: false });
  });
});
