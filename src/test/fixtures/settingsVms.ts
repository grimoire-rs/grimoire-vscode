// View-model fixture builders for the Settings panel, mirroring vms.ts's role
// for the sidebar/details goldens. Descriptions use the exact runtime copy
// grim's next release ships for the 7 fixed `options.*` keys, not a
// placeholder — a real string exercises the same markdown-it inline-render
// path (backtick spans, etc.) production actually hits.
import type {
  WireConfigEntry,
  WireRegistryEntry,
  SettingsSource,
} from '../../webview/settings/model';
import type { ScopesVM, SettingsState } from '../../webview/protocol';

export function wireConfigEntry(overrides: Partial<WireConfigEntry> = {}): WireConfigEntry {
  return {
    key: 'options.default_view',
    value: null,
    set: false,
    type: 'enum',
    title: 'Default view',
    description:
      'Sets the view the browser opens in. Defaults to `tree`, grouping items by path segments; `flat` lists them ungrouped.',
    default: 'tree',
    values: ['flat', 'tree'],
    constraints: null,
    ...overrides,
  };
}

/** The 7 fixed `options.*` keys grim returns, in stable order. */
export function wireConfigEntries(): WireConfigEntry[] {
  return [
    wireConfigEntry({
      key: 'options.default_registry',
      value: null,
      set: false,
      type: 'string',
      title: 'Default registry',
      description:
        'Registry used when an artifact reference names no registry. Overridden by the `--registry` flag or `GRIM_DEFAULT_REGISTRY` environment variable when set. Falls back to `ghcr.io/grimoire-rs` when this key, `--registry`, and `GRIM_DEFAULT_REGISTRY` are all unset.',
      default: null,
      values: null,
    }),
    wireConfigEntry({
      key: 'options.clients',
      value: 'claude,copilot',
      set: true,
      type: 'string-set',
      title: 'Clients',
      description:
        'Determines which clients receive installs and updates when `--client` is absent. Auto-detects clients when left empty, falling back to all clients when none are detected.',
      default: null,
      values: ['claude', 'copilot', 'cursor'],
    }),
    wireConfigEntry({
      key: 'options.show_deprecated',
      value: 'true',
      set: true,
      type: 'boolean',
      title: 'Show deprecated',
      description:
        'Controls whether deprecated artifacts appear in `grim search` and the TUI catalog. Hidden by default unless already installed.',
      default: 'false',
      values: null,
    }),
    wireConfigEntry({
      key: 'options.default_view',
      value: null,
      set: false,
      type: 'enum',
      title: 'Default view',
      description:
        'Sets the view the browser opens in. Defaults to `tree`, grouping items by path segments; `flat` lists them ungrouped.',
      default: 'tree',
      values: ['flat', 'tree'],
    }),
    wireConfigEntry({
      key: 'options.group_by_type',
      value: 'false',
      set: false,
      type: 'boolean',
      title: 'Group by type',
      description:
        'Controls whether a type-level group (skill, rule, agent, or bundle) appears between the registry root and path segments in tree view. Disabled by default.',
      default: 'false',
      values: null,
    }),
    wireConfigEntry({
      key: 'options.tree_separators',
      value: '/',
      set: false,
      type: 'string-list',
      title: 'Tree separators',
      description:
        'Sets the characters that split the repository path into nested groups in tree view. Defaults to `/`; each entry must be a single character.',
      default: '/',
      values: null,
      // Real grim constraints for this key (TREE_SEPARATOR_ITEM_PATTERN):
      // any single non-whitespace, non-control character.
      constraints: { item_pattern: '^[^\\s\\p{C}]$', item_width: 1 },
    }),
    wireConfigEntry({
      key: 'options.expand_levels',
      value: '2',
      set: true,
      type: 'integer',
      title: 'Expand levels',
      description:
        'Sets how many levels of the grouped tree are expanded when the browser opens. Defaults to `1` (registry roots only); `0` expands the tree fully.',
      default: '1',
      values: null,
    }),
  ];
}

export function wireRegistryEntry(overrides: Partial<WireRegistryEntry> = {}): WireRegistryEntry {
  return {
    alias: 'ghcr',
    oci: 'ghcr.io/grimoire-rs',
    index: null,
    default: true,
    ...overrides,
  };
}

export function scopesVM(overrides: Partial<ScopesVM> = {}): ScopesVM {
  return {
    projectOpen: true,
    projectConfigured: true,
    projectName: 'my-app',
    ...overrides,
  };
}

export function settingsSource(overrides: Partial<SettingsSource> = {}): SettingsSource {
  return {
    scope: 'project',
    scopes: scopesVM(),
    grimMissing: false,
    configPath: '/work/my-app/grimoire.toml',
    configExists: true,
    entries: wireConfigEntries(),
    registries: [
      wireRegistryEntry(),
      wireRegistryEntry({ alias: 'internal', oci: null, index: 'https://index.acme.io/index.json', default: false }),
    ],
    ...overrides,
  };
}

export function settingsState(overrides: Partial<SettingsState> = {}): SettingsState {
  return {
    scope: 'project',
    phase: 'ready',
    projectOpen: true,
    projectName: 'my-app',
    configPath: '/work/my-app/grimoire.toml',
    rawConfigPath: '/work/my-app/grimoire.toml',
    groups: [],
    registries: [],
    ...overrides,
  };
}
