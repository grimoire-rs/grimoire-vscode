// Golden-case matrix for the Settings panel renderers, same role as
// vms.ts's goldenCases() for the sidebar/details migration goldens — except
// there is no pre-existing string renderer to diff against here (this is a
// brand-new bundle, not a migration), so these are plain frozen regression
// snapshots: a strictEqual failure names a real markup delta. INTENTIONAL UI
// changes regenerate via UPDATE_GOLDENS=1 (see settingsRender.test.ts).
import {
  buildGroups,
  buildRegistryRow,
  buildSettingsRow,
  CLOSED_ADD_REGISTRY,
  editRegistryUI,
  EMPTY_REGISTRY_DRAFT,
  type AddRegistryUI,
} from '../../webview/settings/model';
import type { SettingsRegistryVM } from '../../webview/protocol';
import type * as render from '../../webview/settings/render';
import {
  settingsState,
  wireConfigEntries,
  wireConfigEntry,
  wireRegistryEntry,
} from './settingsVms';

export interface GoldenCase {
  name: string;
  out: unknown;
}

export function settingsGoldenCases(r: typeof render): GoldenCase[] {
  const cases: GoldenCase[] = [];
  const add = (name: string, out: unknown): void => {
    cases.push({ name, out });
  };

  // A fully populated "ready" state exercising every control type, the
  // idle/modified state bar, every trailing-slot badge (discard/saving/
  // reloaded), a rejected free-chip row, the unknown-type read-only degrade,
  // and a registries table with a default + non-default + legacy row.
  const rows = buildGroups(wireConfigEntries()).flatMap((g) => g.rows);
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const clients = byKey.get('options.clients');
  if (clients) {
    clients.status = 'saving';
  }
  const treeSeparators = byKey.get('options.tree_separators');
  if (treeSeparators) {
    treeSeparators.status = 'error';
    treeSeparators.errorMessage =
      'Rejected by grim: separator must be a single character — "--" was not applied. Restored last saved value.';
  }
  const expandLevels = byKey.get('options.expand_levels');
  if (expandLevels) {
    expandLevels.status = 'reloaded';
  }
  const unknownRow = buildSettingsRow(
    wireConfigEntry({
      key: 'options.mystery',
      type: 'color',
      title: 'Mystery setting',
      description: 'A future config key this build does not know how to render a control for yet.',
      value: '#ff0000',
      default: null,
    }),
  );
  const readyGroups = [
    {
      title: 'Options',
      rows: rows.filter((r) =>
        ['options.default_registry', 'options.clients', 'options.show_deprecated'].includes(r.key),
      ),
    },
    {
      title: 'TUI',
      rows: [
        ...rows.filter(
          (r) =>
            !['options.default_registry', 'options.clients', 'options.show_deprecated'].includes(
              r.key,
            ),
        ),
        unknownRow,
      ],
    },
  ];
  const readyRegistries = [
    buildRegistryRow(wireRegistryEntry()),
    buildRegistryRow(
      wireRegistryEntry({
        alias: 'internal',
        oci: null,
        index: 'https://index.acme.io/index.json',
        default: false,
      }),
    ),
    buildRegistryRow(wireRegistryEntry({ alias: null, oci: 'ghcr.io/legacy-org', default: false })),
    buildRegistryRow(
      wireRegistryEntry({
        alias: 'acme',
        oci: null,
        index: 'https://index.acme.internal',
        include: ['acme/platform/**', 'acme/tools/**'],
        exclude: ['acme/platform/legacy/**'],
        default: false,
      }),
    ),
  ];
  // registryEditSupported is explicit in every case that renders an edit
  // affordance: the fixture default is the shipping `false` (settingsVms.ts).
  const readyState = settingsState({
    groups: readyGroups,
    registries: readyRegistries,
    registryEditSupported: true,
  });

  add('settings-ready-full', r.renderSettings(readyState));
  add(
    'settings-ready-empty-registries',
    r.renderSettings(settingsState({ groups: readyGroups, registries: [] })),
  );
  // grim-polyfill<0.13.0: the SAME populated table on a grim that has no
  // `registry set` — every row's edit button gone, and the line that says which
  // grim brings them back. This is what most installs render today, so it is
  // frozen rather than left to the two form-level cases. Delete with the gate.
  add(
    'settings-ready-registries-no-edit',
    r.renderSettings(
      settingsState({
        groups: readyGroups,
        registries: readyRegistries,
        registryEditSupported: false,
      }),
    ),
  );
  add(
    'settings-ready-add-registry-open',
    r.renderSettings(readyState, { ...CLOSED_ADD_REGISTRY, open: true, draft: EMPTY_REGISTRY_DRAFT, helpOpen: null }),
  );
  add(
    'settings-ready-add-registry-help-open',
    r.renderSettings(readyState, { ...CLOSED_ADD_REGISTRY, open: true, draft: EMPTY_REGISTRY_DRAFT, helpOpen: 'index' }),
  );
  // grim-polyfill<0.13.0: the form with the version line in place of its
  // pattern repeaters, which is what an older grim gets. Delete with the gate.
  add(
    'settings-ready-add-registry-no-filters',
    r.renderSettings(settingsState({ groups: readyGroups, registryEditSupported: false }), {
      ...CLOSED_ADD_REGISTRY,
      open: true,
      draft: EMPTY_REGISTRY_DRAFT,
      helpOpen: null,
    }),
  );
  add(
    'settings-ready-add-registry-patterns',
    r.renderSettings(readyState, {
      ...CLOSED_ADD_REGISTRY,
      open: true,
      draft: {
        alias: 'acme',
        kind: 'index',
        locator: 'https://index.acme.internal',
        include: ['acme/platform/**', 'acme/{tools,libs}/**'],
        exclude: ['acme/platform/legacy/**'],
        default: false,
      },
      helpOpen: null,
    } satisfies AddRegistryUI),
  );
  // The same form in edit mode: readonly alias, "Edit registry" title, "Save"
  // button, and the draft seeded from the filtered `acme` row above — the
  // whole point being that a multi-pattern list arrives editable. Opened
  // through the app's own opener, so the frozen markup is what a pencil click
  // actually produces. The `??` never fires (that row has an alias); it is
  // there because editRegistryUI answers null for a legacy row.
  const editAcme = editRegistryUI(readyRegistries[3] as SettingsRegistryVM) ?? CLOSED_ADD_REGISTRY;
  add('settings-ready-edit-registry-open', r.renderSettings(readyState, editAcme));
  // Mid-save: the whole form inert, the submit a spinner, Cancel disabled.
  add(
    'settings-ready-edit-registry-saving',
    r.renderSettings(readyState, { ...editAcme, saving: true } satisfies AddRegistryUI),
  );
  add(
    'settings-ready-add-registry-error',
    r.renderSettings(readyState, {
      ...CLOSED_ADD_REGISTRY,
      open: true,
      draft: {
        alias: 'ghcr',
        kind: 'oci',
        locator: 'ghcr.io/dup',
        include: [],
        exclude: [],
        default: false,
      },
      helpOpen: null,
      error: 'Registry alias "ghcr" already exists.',
    } satisfies AddRegistryUI),
  );

  add(
    'settings-no-folder',
    r.renderSettings(
      settingsState({
        phase: 'no-folder',
        projectOpen: false,
        configPath: null,
        groups: [],
        registries: [],
      }),
    ),
  );
  add(
    'settings-project-no-toml',
    r.renderSettings(
      settingsState({ phase: 'project-no-toml', configPath: null, groups: [], registries: [] }),
    ),
  );
  add(
    'settings-global-no-toml',
    r.renderSettings(
      settingsState({
        scope: 'global',
        phase: 'global-no-toml',
        configPath: null,
        rawConfigPath: '/home/user/grimoire.toml',
        groups: [],
        registries: [],
      }),
    ),
  );
  add(
    'settings-no-grim',
    r.renderSettings(
      settingsState({ phase: 'no-grim', configPath: null, groups: [], registries: [] }),
    ),
  );
  add(
    'settings-loading',
    r.renderSettings(
      settingsState({ phase: 'loading', configPath: null, groups: [], registries: [] }),
    ),
  );
  add(
    'settings-error',
    r.renderSettings(
      settingsState({
        phase: 'error',
        groups: [],
        registries: [],
        error: 'grim exited with status 1',
      }),
    ),
  );

  add('settings-tabs-project-with-path', r.renderSettingsTabs(settingsState({ scope: 'project' })));
  add(
    'settings-tabs-global-no-path',
    r.renderSettingsTabs(settingsState({ scope: 'global', configPath: null })),
  );

  add('settings-footer', r.renderSettingsFooter());

  return cases;
}
