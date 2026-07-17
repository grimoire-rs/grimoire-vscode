import * as assert from 'assert';
import {
  addRegistryDraftValid,
  allRows,
  buildGroups,
  buildRegistryRow,
  buildSettingsRow,
  buildSettingsVM,
  chipHasComma,
  defaultHint,
  EMPTY_REGISTRY_DRAFT,
  isValidChip,
  isValidInteger,
  joinList,
  reloadedKeys,
  resolveSettingsPhase,
  splitList,
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

  test('modified is value !== default, independent of `set`', () => {
    assert.strictEqual(buildSettingsRow(wireConfigEntry({ value: 'flat', default: 'flat', set: true })).modified, false);
    assert.strictEqual(buildSettingsRow(wireConfigEntry({ value: 'tree', default: 'flat', set: false })).modified, true);
  });

  test('every row starts idle with no error message', () => {
    const row = buildSettingsRow(wireConfigEntry());
    assert.strictEqual(row.status, 'idle');
    assert.strictEqual(row.errorMessage, undefined);
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
      'Not set — clients are auto-detected, falling back to claude.',
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

  test('global scope has no empty state — always ready, even with no workspace open', () => {
    const vm = buildSettingsVM(
      settingsSource({ scope: 'global', scopes: scopesVM({ projectOpen: false, projectConfigured: false }) }),
    );
    assert.strictEqual(vm.phase, 'ready');
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
  test('isValidChip: exactly one character', () => {
    assert.strictEqual(isValidChip('/'), true);
    assert.strictEqual(isValidChip('--'), false);
    assert.strictEqual(isValidChip(''), false);
  });

  test('chipHasComma', () => {
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
