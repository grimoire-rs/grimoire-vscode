import * as assert from 'assert';
import type { WireRegistryEntry } from '../webview/settings/model';
import {
  addRegistryDraftValid,
  allRows,
  appendPattern,
  buildGroups,
  buildRegistryRow,
  buildSettingsRow,
  buildSettingsVM,
  chipHasComma,
  CLOSED_ADD_REGISTRY,
  consumeAwaitingConfirm,
  defaultHint,
  draftFromRegistry,
  draftToLocator,
  DUPLICATE_PATTERN_ERROR,
  editRegistryUI,
  EMPTY_REGISTRY_DRAFT,
  enumSelectedValue,
  isModified,
  isPatternField,
  isValidChip,
  isValidInteger,
  joinList,
  LOCATOR_PLACEHOLDER,
  reloadedKeys,
  registrySubmitMessage,
  removePattern,
  replacePattern,
  resolveScopeSwitch,
  resolveSettingsPhase,
  revealScrollDelta,
  shouldBlockNumberWheel,
  splitList,
  toggleRegistryHelp,
} from '../webview/settings/model';
import {
  registryFieldVMs,
  scopesVM,
  settingsSource,
  settingsState,
  wireConfigEntries,
  wireConfigEntry,
  wireRegistryEntry,
} from './fixtures/settingsVms';

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
    assert.strictEqual(
      buildSettingsRow(wireConfigEntry({ value: 'flat', default: 'flat', set: true })).modified,
      false,
    );
    assert.strictEqual(
      buildSettingsRow(wireConfigEntry({ value: 'tree', default: 'flat', set: false })).modified,
      false,
    );
    assert.strictEqual(
      buildSettingsRow(wireConfigEntry({ value: 'tree', default: 'flat', set: true })).modified,
      true,
    );
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
      [
        'options.default_view',
        'options.group_by_type',
        'options.tree_separators',
        'options.expand_levels',
      ],
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

  test('drops the per-registry rows `config list --all` emits', () => {
    // grim lists `registry.<alias>.<field>` alongside the fixed keys. Left in,
    // shortKey strips the prefix and every one lands in Options as an
    // unlabelled duplicate of the Registries table — and the two `string-list`
    // filter rows would get the COMMA-JOINING chip editor, which splits
    // `{tools,libs}/**` into two fragments that no longer compile.
    const groups = buildGroups([
      wireConfigEntry({ key: 'options.expand_levels' }),
      wireConfigEntry({ key: 'registry.acme.oci' }),
      wireConfigEntry({ key: 'registry.acme.default' }),
      wireConfigEntry({ key: 'registry.acme.include', type: 'string-list' }),
      wireConfigEntry({ key: 'registry.acme.exclude', type: 'string-list' }),
    ]);
    assert.deepStrictEqual(
      groups.flatMap((g) => g.rows.map((r) => r.key)),
      ['options.expand_levels'],
    );
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

  test('browse filters carry through in declaration order', () => {
    const row = buildRegistryRow(
      wireRegistryEntry({ include: ['acme/platform/**', 'acme/tools/**'], exclude: ['acme/x/**'] }),
    );
    assert.deepStrictEqual(row.include, ['acme/platform/**', 'acme/tools/**']);
    assert.deepStrictEqual(row.exclude, ['acme/x/**']);
  });

  test('a grim that omits the filter fields reads as unfiltered, never undefined', () => {
    // Additive JSON fields: absent means "this binary does not report them",
    // which is the same view as "no filter" — never a crash at the render site.
    const row = buildRegistryRow(wireRegistryEntry());
    assert.deepStrictEqual(row.include, []);
    assert.deepStrictEqual(row.exclude, []);
  });

  test('a non-array filter field reads as unfiltered rather than reaching .join()', () => {
    // A hand-edited config can make grim report a bare string here. `?? []`
    // guarded only null/undefined, so the value flowed straight to
    // renderFilterMark's row.include.join() and blanked the whole panel with a
    // TypeError. Normalizing at the boundary keeps every reader honest.
    const row = buildRegistryRow({
      alias: 'x',
      oci: 'ghcr.io/x',
      index: null,
      default: false,
      include: 'acme/**',
      exclude: 7,
    } as unknown as WireRegistryEntry);
    assert.deepStrictEqual(row.include, []);
    assert.deepStrictEqual(row.exclude, []);
  });
});

suite('resolveSettingsPhase / buildSettingsVM: empty and init states', () => {
  test('grim missing wins over everything else', () => {
    assert.strictEqual(
      resolveSettingsPhase({
        scope: 'project',
        scopes: scopesVM(),
        grimMissing: true,
        configExists: true,
      }),
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
      settingsSource({
        scope: 'global',
        scopes: scopesVM({ projectOpen: false, projectConfigured: false }),
      }),
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

  // registryFields is context-free host-side data (SettingsManager.
  // ensureRegistryFields) — buildSettingsVM must thread it straight through
  // regardless of phase, not just for 'ready'.
  test('registryFields threads through unchanged in both ready and empty/init phases', () => {
    const fields = registryFieldVMs();
    const ready = buildSettingsVM(settingsSource({ scope: 'project', registryFields: fields }));
    assert.strictEqual(ready.phase, 'ready');
    assert.deepStrictEqual(ready.registryFields, fields);

    const notToml = buildSettingsVM(
      settingsSource({ scope: 'project', configExists: false, registryFields: fields }),
    );
    assert.strictEqual(notToml.phase, 'project-no-toml');
    assert.deepStrictEqual(notToml.registryFields, fields);
  });
});

suite('revealScrollDelta', () => {
  test('does not scroll a form that already fits, margin included', () => {
    // bottom 400 + 24 margin = 424, inside an 800 viewport.
    assert.strictEqual(revealScrollDelta(100, 400, 800), 0);
    // Exactly flush with the margin is still no scroll.
    assert.strictEqual(revealScrollDelta(100, 776, 800), 0);
  });

  test('scrolls by the overshoot when the form runs past the bottom', () => {
    // bottom 900 + 24 - 800 = 124 of overshoot, and top 300 leaves room for it.
    assert.strictEqual(revealScrollDelta(300, 900, 800), 124);
  });

  test('never scrolls further than the form top — the clamp invariant', () => {
    // A form taller than the space below it: raw overshoot is 224, but
    // scrolling that far would push the title 194px off the top of the
    // viewport. Clamped to the top offset, so the title stays reachable.
    assert.strictEqual(revealScrollDelta(30, 1000, 800), 30);
  });

  test('never scrolls up, even when the form starts above the viewport', () => {
    // A negative top means the form already runs off the top; scrolling down
    // by a negative amount would be a scroll UP, away from the Save row.
    assert.strictEqual(revealScrollDelta(-50, 1000, 800), 0);
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

suite('draftFromRegistry', () => {
  test('seeds every editable field from the row', () => {
    const row = buildRegistryRow(
      wireRegistryEntry({
        alias: 'acme',
        oci: null,
        index: 'https://index.acme.internal',
        include: ['acme/platform/**', 'acme/{tools,libs}/**'],
        exclude: ['acme/platform/legacy/**'],
        default: true,
      }),
    );
    assert.deepStrictEqual(draftFromRegistry(row), {
      alias: 'acme',
      kind: 'index',
      locator: 'https://index.acme.internal',
      include: ['acme/platform/**', 'acme/{tools,libs}/**'],
      exclude: ['acme/platform/legacy/**'],
      default: true,
    });
  });

  test('copies the pattern arrays rather than aliasing them', () => {
    // A cancelled edit must not leave the table showing patterns that were
    // never saved — the draft is mutated in place as the user types.
    const row = buildRegistryRow(wireRegistryEntry({ include: ['a/**'] }));
    const draft = draftFromRegistry(row);
    draft.include.push('b/**');
    assert.deepStrictEqual(row.include, ['a/**']);
  });

  test('an entry with neither locator lands on index, the empty draft default', () => {
    const row = buildRegistryRow(wireRegistryEntry({ alias: 'broken', oci: null, index: null }));
    assert.strictEqual(row.type, 'unknown');
    assert.strictEqual(draftFromRegistry(row).kind, 'index');
  });
});

suite('reloadedKeys', () => {
  test('flags rows whose value changed between two same-scope ready VMs', () => {
    const prev = settingsState({
      groups: [
        { title: 'Options', rows: [buildSettingsRow(wireConfigEntry({ key: 'a', value: '1' }))] },
      ],
    });
    const next = settingsState({
      groups: [
        { title: 'Options', rows: [buildSettingsRow(wireConfigEntry({ key: 'a', value: '2' }))] },
      ],
    });
    assert.deepStrictEqual(reloadedKeys(prev, next), ['a']);
  });

  test('no diff -> no reloaded keys', () => {
    const state = settingsState({
      groups: [
        { title: 'Options', rows: [buildSettingsRow(wireConfigEntry({ key: 'a', value: '1' }))] },
      ],
    });
    assert.deepStrictEqual(reloadedKeys(state, state), []);
  });

  test('a scope switch never flags reloaded (different scope entirely)', () => {
    const prev = settingsState({
      scope: 'project',
      groups: [
        { title: 'Options', rows: [buildSettingsRow(wireConfigEntry({ key: 'a', value: '1' }))] },
      ],
    });
    const next = settingsState({
      scope: 'global',
      groups: [
        { title: 'Options', rows: [buildSettingsRow(wireConfigEntry({ key: 'a', value: '2' }))] },
      ],
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
    assert.deepStrictEqual(
      allRows(state).map((r) => r.key),
      ['a', 'b'],
    );
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
    assert.strictEqual(
      addRegistryDraftValid({ ...EMPTY_REGISTRY_DRAFT, alias: '  ', locator: 'x' }),
      false,
    );
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
    assert.deepStrictEqual(resolveScopeSwitch('global', undefined, null), {
      vm: null,
      refreshing: false,
    });
  });
});

suite('replacePattern', () => {
  test('writes back at the same position', () => {
    // Position is what the user pointed at, and the list order is visible in
    // the form — an edit must not reorder the neighbours.
    assert.deepStrictEqual(replacePattern(['a/**', 'b/**', 'c/**'], 1, 'z/**'), {
      ok: true,
      patterns: ['a/**', 'z/**', 'c/**'],
    });
  });

  test('clearing the box removes the entry', () => {
    assert.deepStrictEqual(replacePattern(['a/**', 'b/**'], 0, '   '), {
      ok: true,
      patterns: ['b/**'],
    });
  });

  // Regression: editing a chip into a duplicate used to COLLAPSE it — the
  // chip the user was editing simply vanished, which reads as the form eating
  // input. The list stays untouched and the caller shows the error line.
  test('editing into an existing pattern reports duplicate instead of deleting the chip', () => {
    assert.deepStrictEqual(replacePattern(['a/**', 'b/**'], 0, 'b/**'), {
      ok: false,
      reason: 'duplicate',
    });
  });

  test('re-committing a chip unchanged is not a duplicate of itself', () => {
    assert.deepStrictEqual(replacePattern(['a/**', 'b/**'], 0, 'a/**'), {
      ok: true,
      patterns: ['a/**', 'b/**'],
    });
  });

  test('trims, and keeps a comma as glob alternation', () => {
    assert.deepStrictEqual(replacePattern(['a/**'], 0, '  {x,y}/**  '), {
      ok: true,
      patterns: ['{x,y}/**'],
    });
  });

  test('an out-of-range index is a no-op, never a sparse hole in the list', () => {
    assert.deepStrictEqual(replacePattern(['a/**'], 4, 'z/**'), { ok: true, patterns: ['a/**'] });
    assert.deepStrictEqual(replacePattern(['a/**'], -1, 'z/**'), { ok: true, patterns: ['a/**'] });
    assert.deepStrictEqual(replacePattern([], 0, 'z/**'), { ok: true, patterns: [] });
  });
});

suite('appendPattern', () => {
  test('appends the trimmed value at the end', () => {
    assert.deepStrictEqual(appendPattern(['a/**'], '  b/**  '), {
      ok: true,
      patterns: ['a/**', 'b/**'],
    });
  });

  test('an empty or whitespace-only box adds nothing and is not an error', () => {
    assert.deepStrictEqual(appendPattern(['a/**'], ''), { ok: true, patterns: ['a/**'] });
    assert.deepStrictEqual(appendPattern(['a/**'], '   '), { ok: true, patterns: ['a/**'] });
  });

  // Regression: the add path used to drop a duplicate silently, so the box
  // cleared and nothing appeared — indistinguishable from a broken button.
  test('a duplicate is reported, not silently dropped', () => {
    assert.deepStrictEqual(appendPattern(['a/**', 'b/**'], 'b/**'), {
      ok: false,
      reason: 'duplicate',
    });
    assert.deepStrictEqual(appendPattern(['a/**'], '  a/**  '), { ok: false, reason: 'duplicate' });
  });

  // A comma is glob ALTERNATION here, not a list separator (unlike the
  // comma-joined string-list chip editor) — splitting it produces two
  // fragments that no longer compile.
  test('a comma-bearing glob survives as ONE pattern', () => {
    assert.deepStrictEqual(appendPattern([], 'acme/{a,b}/**'), {
      ok: true,
      patterns: ['acme/{a,b}/**'],
    });
  });

  test('does not mutate the input list', () => {
    const patterns = ['a/**'];
    appendPattern(patterns, 'b/**');
    assert.deepStrictEqual(patterns, ['a/**']);
  });

  test('the duplicate reason carries one shared message for the form error line', () => {
    assert.strictEqual(typeof DUPLICATE_PATTERN_ERROR, 'string');
    assert.ok(DUPLICATE_PATTERN_ERROR.length > 0);
  });
});

suite('removePattern', () => {
  test('removes by index', () => {
    assert.deepStrictEqual(removePattern(['a/**', 'b/**', 'c/**'], 1), ['a/**', 'c/**']);
  });

  // Regression: removal used to address by VALUE while the in-place editor
  // addressed by INDEX, so removing one of two identical globs deleted BOTH.
  test('duplicate values: only the indexed entry goes', () => {
    assert.deepStrictEqual(removePattern(['a/**', 'a/**'], 0), ['a/**']);
  });

  test('an out-of-range index leaves the list alone', () => {
    assert.deepStrictEqual(removePattern(['a/**'], 3), ['a/**']);
    assert.deepStrictEqual(removePattern(['a/**'], -1), ['a/**']);
    assert.deepStrictEqual(removePattern([], 0), []);
  });

  test('does not mutate the input list', () => {
    const patterns = ['a/**', 'b/**'];
    removePattern(patterns, 0);
    assert.deepStrictEqual(patterns, ['a/**', 'b/**']);
  });
});

suite('isPatternField', () => {
  test('accepts exactly the two filter list names', () => {
    assert.strictEqual(isPatternField('include'), true);
    assert.strictEqual(isPatternField('exclude'), true);
  });

  // The value comes off a data-* attribute, so it is `string | undefined` at
  // best and anything at all in principle — the three `as` casts it replaces
  // would have let a typo'd attribute index the draft with garbage.
  test('rejects everything else, including a missing attribute', () => {
    for (const v of [undefined, null, '', 'Include', 'default', 'alias', 0, {}]) {
      assert.strictEqual(isPatternField(v), false, String(v));
    }
  });
});

suite('editRegistryUI', () => {
  const row = () =>
    buildRegistryRow(
      wireRegistryEntry({
        alias: 'acme',
        oci: null,
        index: 'https://index.acme.internal',
        include: ['acme/platform/**'],
        exclude: ['acme/platform/legacy/**'],
        default: true,
      }),
    );

  test('opens the form in edit mode, naming the row and capturing its state', () => {
    assert.deepStrictEqual(editRegistryUI(row()), {
      open: true,
      draft: {
        alias: 'acme',
        kind: 'index',
        locator: 'https://index.acme.internal',
        include: ['acme/platform/**'],
        exclude: ['acme/platform/legacy/**'],
        default: true,
      },
      helpOpen: null,
      saving: false,
      editingPattern: null,
      mode: {
        kind: 'edit',
        alias: 'acme',
        previous: {
          include: ['acme/platform/**'],
          exclude: ['acme/platform/legacy/**'],
          default: true,
        },
      },
    });
  });

  test('the captured previous state is a copy — editing the draft cannot rewrite it', () => {
    const ui = editRegistryUI(row());
    assert.ok(ui !== null);
    ui.draft.include.push('acme/extra/**');
    assert.strictEqual(ui.mode.kind, 'edit');
    if (ui.mode.kind === 'edit') {
      assert.deepStrictEqual(ui.mode.previous.include, ['acme/platform/**']);
    }
  });

  // A legacy (alias-less) row has no name for grim to address, so it carries
  // no edit button — and there is no edit-mode state that could describe it.
  test('a legacy alias-less row yields no edit state at all', () => {
    assert.strictEqual(editRegistryUI(buildRegistryRow(wireRegistryEntry({ alias: null }))), null);
  });
});

suite('registrySubmitMessage', () => {
  const draft = {
    alias: '  acme  ',
    kind: 'oci' as const,
    locator: '  ghcr.io/acme  ',
    include: ['acme/**'],
    exclude: ['acme/legacy/**'],
    default: true,
  };

  test('add mode posts addRegistry with the trimmed draft alias', () => {
    assert.deepStrictEqual(
      registrySubmitMessage('project', { ...CLOSED_ADD_REGISTRY, open: true, draft }),
      {
        type: 'addRegistry',
        scope: 'project',
        alias: 'acme',
        locator: { oci: 'ghcr.io/acme' },
        include: ['acme/**'],
        exclude: ['acme/legacy/**'],
        default: true,
      },
    );
  });

  // The alias comes off the MODE, never the draft: the field is readonly in
  // edit mode and grim has no rename, so a draft alias could only be wrong.
  test('edit mode posts editRegistry named by the mode, with the captured previous state', () => {
    const previous = { include: [], exclude: [], default: false };
    assert.deepStrictEqual(
      registrySubmitMessage('global', {
        ...CLOSED_ADD_REGISTRY,
        open: true,
        draft: { ...draft, alias: 'typed-over' },
        mode: { kind: 'edit', alias: 'acme', previous },
      }),
      {
        type: 'editRegistry',
        scope: 'global',
        alias: 'acme',
        locator: { oci: 'ghcr.io/acme' },
        include: ['acme/**'],
        exclude: ['acme/legacy/**'],
        default: true,
        previous,
      },
    );
  });

  test('an index draft maps to the {index} locator variant', () => {
    const message = registrySubmitMessage('project', {
      ...CLOSED_ADD_REGISTRY,
      open: true,
      draft: { ...draft, kind: 'index', locator: 'https://x/index.json' },
    });
    assert.deepStrictEqual(message.locator, { index: 'https://x/index.json' });
  });

  test('round-trips an edit opened from a row', () => {
    const ui = editRegistryUI(buildRegistryRow(wireRegistryEntry({ alias: 'ghcr' })));
    assert.ok(ui !== null);
    const message = registrySubmitMessage('project', ui);
    assert.strictEqual(message.type, 'editRegistry');
    assert.strictEqual(message.alias, 'ghcr');
  });
});

suite('CLOSED_ADD_REGISTRY', () => {
  // The closed form is the ADD form: there is no alias and no captured
  // previous state to edit against, and the tag is the only thing that says so.
  test('is closed and in add mode', () => {
    assert.strictEqual(CLOSED_ADD_REGISTRY.open, false);
    assert.deepStrictEqual(CLOSED_ADD_REGISTRY.mode, { kind: 'add' });
  });
});
