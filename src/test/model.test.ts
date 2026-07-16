import * as assert from 'assert';
import { sidebarState } from './fixtures/vms';
import {
  artifactName,
  authenticatedHosts,
  buildCards,
  buildDetailsVM,
  buildInstalledCards,
  buildShareLink,
  buildSkeletonVM,
  cardMenuEntries,
  concreteVersion,
  DEFAULT_FILTER,
  effectiveInstall,
  filterCards,
  findAssetPath,
  INTERACTIVE_SELECTOR,
  isInteractiveTarget,
  isValidRepo,
  normalizeKind,
  parseBundleMembers,
  parseFrontmatter,
  parseShareLink,
  parseViaBundles,
  defaultScope,
  refRepo,
  refTag,
  resolveCompanionAssets,
  resolveInstalledScope,
  resolveMemberRepo,
  registriesOf,
  registryHost,
  registryLabel,
  registryUrlHost,
  relativeTime,
  rowState,
  scopeRowMenuEntries,
  footerTickRenders,
  keepPaintedOnLoading,
  shouldResetUi,
  toggleKinds,
  viewForTab,
  type MenuEntry,
  type MenuItem,
  type ScopeStatus,
  type WireSearchItem,
  type WireStatusItem,
} from '../webview/model';
import type { CardVM, InstallVM, ScopesVM } from '../webview/protocol';

function searchItem(overrides: Partial<WireSearchItem> = {}): WireSearchItem {
  return {
    kind: 'skill',
    repo: 'ghcr.io/grimoire-rs/skills/grim-usage',
    summary: null,
    description: 'Drive the grim CLI.',
    version: null,
    latest_tag: null,
    repository: 'https://github.com/grimoire-rs/grimoire',
    revision: null,
    created: null,
    deprecated: null,
    status: 'not-installed',
    ...overrides,
  };
}

function statusItem(overrides: Partial<WireStatusItem> = {}): WireStatusItem {
  return {
    kind: 'skill',
    name: 'grim-usage',
    source: 'direct',
    pinned: 'ghcr.io/grimoire-rs/skills/grim-usage@sha256:abc',
    state: 'installed',
    outputs: [{ client: 'claude', path: '/x/.claude/skills/grim-usage' }],
    ...overrides,
  };
}

const scopesVM: ScopesVM = { projectOpen: true, projectConfigured: true, projectName: 'my-app' };

suite('ref helpers', () => {
  test('registryHost / artifactName', () => {
    assert.strictEqual(registryHost('ghcr.io/a/b'), 'ghcr.io');
    assert.strictEqual(artifactName('ghcr.io/a/skills/x'), 'x');
  });

  test('refRepo strips tag and digest', () => {
    assert.strictEqual(refRepo('ghcr.io/a/b:1.0'), 'ghcr.io/a/b');
    assert.strictEqual(refRepo('ghcr.io/a/b@sha256:xyz'), 'ghcr.io/a/b');
    assert.strictEqual(refRepo('localhost:5050/a/b:latest'), 'localhost:5050/a/b');
    assert.strictEqual(refRepo('localhost:5050/a/b'), 'localhost:5050/a/b');
  });

  test('refTag handles registry ports', () => {
    assert.strictEqual(refTag('ghcr.io/a/b:1.0'), '1.0');
    assert.strictEqual(refTag('localhost:5050/a/b'), null);
    assert.strictEqual(refTag('localhost:5050/a/b:2'), '2');
  });

  test('normalizeKind', () => {
    assert.strictEqual(normalizeKind('SKILL'), 'skill');
    assert.strictEqual(normalizeKind('unknown'), null);
    assert.strictEqual(normalizeKind(null), null);
  });
});

suite('card building', () => {
  const projectScope: ScopeStatus = {
    scope: 'project',
    status: [statusItem()],
    declared: { 'grim-usage': 'ghcr.io/grimoire-rs/skills/grim-usage:1.4.2' },
  };
  const globalScope: ScopeStatus = {
    scope: 'global',
    status: [statusItem({ state: 'outdated' })],
    declared: { 'grim-usage': 'ghcr.io/grimoire-rs/skills/grim-usage:latest' },
  };

  test('merges installs from both scopes (project shadows global)', () => {
    const cards = buildCards([searchItem()], [projectScope, globalScope]);
    assert.strictEqual(cards.length, 1);
    const card = cards[0];
    assert.ok(card);
    assert.strictEqual(card.installs.length, 2);
    assert.deepStrictEqual(
      card.installs.map((i) => i.scope),
      ['project', 'global'],
    );
    assert.strictEqual(card.installs[0]?.version, '1.4.2');
    assert.strictEqual(card.installs[1]?.version, 'latest');
    assert.strictEqual(card.state, 'outdated');
  });

  test('not-installed card', () => {
    const cards = buildCards([searchItem()], []);
    assert.strictEqual(cards[0]?.state, 'not-installed');
    assert.deepStrictEqual(cards[0]?.installs, []);
  });

  test('deprecated wins over installed', () => {
    const cards = buildCards([searchItem({ deprecated: 'use x instead' })], [projectScope]);
    assert.strictEqual(cards[0]?.state, 'deprecated');
  });

  test('rowState precedence', () => {
    const install = (updateAvailable: boolean): InstallVM => ({
      scope: 'project',
      version: '1',
      updateAvailable,
      clients: [],
      state: updateAvailable ? 'outdated' : 'installed',
      kind: 'skill',
      name: 'x',
      viaBundles: [],
    });
    assert.strictEqual(rowState('msg', [install(true)]), 'deprecated');
    assert.strictEqual(rowState(null, [install(true)]), 'outdated');
    assert.strictEqual(rowState(null, [install(false)]), 'installed');
    assert.strictEqual(rowState(null, []), 'not-installed');
  });

  test('buildInstalledCards includes artifacts missing from catalog', () => {
    const cards = buildInstalledCards([], [projectScope]);
    assert.strictEqual(cards.length, 1);
    assert.strictEqual(cards[0]?.name, 'grim-usage');
    assert.strictEqual(cards[0]?.kind, 'skill');
    assert.strictEqual(cards[0]?.state, 'installed');
  });

  test('buildInstalledCards merges scopes into one card', () => {
    const cards = buildInstalledCards([searchItem()], [projectScope, globalScope]);
    assert.strictEqual(cards.length, 1);
    assert.strictEqual(cards[0]?.installs.length, 2);
    assert.strictEqual(cards[0]?.state, 'outdated');
  });

  test('unlocked (pinned:null) undeclared status item is skipped, not deref-crashed (item 1)', () => {
    // grim serializes `pinned: null` for unlocked artifacts; with no declared
    // ref there is no repo to key on, so the item drops out rather than
    // throwing on refRepo(null).
    const unlocked: ScopeStatus = {
      scope: 'global',
      status: [statusItem({ pinned: null, source: 'direct' })],
      declared: {},
    };
    assert.deepStrictEqual(buildInstalledCards([], [unlocked]), []);
    const browse = buildCards([searchItem()], [unlocked]);
    assert.strictEqual(browse[0]?.installs.length, 0);
  });

  test('unlocked (pinned:null) but declared status item still resolves via the declared ref', () => {
    const declaredUnlocked: ScopeStatus = {
      scope: 'project',
      status: [statusItem({ pinned: null })],
      declared: { 'grim-usage': 'ghcr.io/grimoire-rs/skills/grim-usage:1' },
    };
    const cards = buildInstalledCards([], [declaredUnlocked]);
    assert.strictEqual(cards.length, 1);
    assert.strictEqual(cards[0]?.installs[0]?.version, '1');
  });

  test('install is flagged floating when pinned is null, pinned otherwise (item 18)', () => {
    const floating = buildCards([searchItem()], [
      {
        scope: 'project',
        status: [statusItem({ pinned: null, state: 'outdated' })],
        declared: { 'grim-usage': 'ghcr.io/grimoire-rs/skills/grim-usage:1' },
      },
    ]);
    assert.strictEqual(floating[0]?.installs[0]?.floating, true);
    const pinned = buildCards([searchItem()], [
      {
        scope: 'project',
        status: [statusItem({ state: 'outdated' })],
        declared: { 'grim-usage': 'ghcr.io/grimoire-rs/skills/grim-usage:1.4.2' },
      },
    ]);
    assert.strictEqual(pinned[0]?.installs[0]?.floating, false);
  });
});

suite('private registries (item 8)', () => {
  test('registryLabel is host + first org segment', () => {
    assert.strictEqual(registryLabel('ghcr.io/grimoire-rs/skills/x'), 'ghcr.io/grimoire-rs');
    assert.strictEqual(registryLabel('ghcr.io/only'), 'ghcr.io/only');
    assert.strictEqual(registryLabel('host'), 'host');
  });

  test('registryUrlHost strips scheme and path', () => {
    assert.strictEqual(
      registryUrlHost('https://harbor.internal.acme.io/v2'),
      'harbor.internal.acme.io',
    );
    assert.strictEqual(registryUrlHost('ghcr.io'), 'ghcr.io');
  });

  test('authenticatedHosts includes only authenticated:true entries', () => {
    const hosts = authenticatedHosts([
      { url: 'https://harbor.internal.acme.io', authenticated: true },
      { url: 'https://ghcr.io', authenticated: false },
      { url: 'https://index.grimoire.rs' }, // field absent (older binary) -> false
    ]);
    assert.ok(hosts.has('harbor.internal.acme.io'));
    assert.ok(!hosts.has('ghcr.io'));
    assert.strictEqual(hosts.size, 1);
  });

  test('buildCards marks the card private only when its host is authenticated', () => {
    const authed = authenticatedHosts([
      { url: 'https://harbor.internal.acme.io', authenticated: true },
    ]);
    const priv = buildCards(
      [searchItem({ repo: 'harbor.internal.acme.io/acme/agents/pr-reviewer' })],
      [],
      authed,
    );
    assert.strictEqual(priv[0]?.privateRegistry, true);
    const pub = buildCards([searchItem()], [], authed);
    assert.strictEqual(pub[0]?.privateRegistry, false);
  });

  test('buildCards does not lock-mark an authenticated default registry (item: lock heuristic)', () => {
    // ghcr.io is the default marketplace registry — many users are
    // docker-logged-in to it, so a stored credential there must not
    // lock-mark every card.
    const authed = authenticatedHosts([{ url: 'https://ghcr.io', authenticated: true }]);
    const defaultHost = 'ghcr.io';
    const onDefault = buildCards([searchItem()], [], authed, defaultHost);
    assert.strictEqual(onDefault[0]?.privateRegistry, false);
    const onOther = buildCards(
      [searchItem({ repo: 'harbor.internal.acme.io/acme/agents/pr-reviewer' })],
      [],
      authenticatedHosts([
        { url: 'https://ghcr.io', authenticated: true },
        { url: 'https://harbor.internal.acme.io', authenticated: true },
      ]),
      defaultHost,
    );
    assert.strictEqual(onOther[0]?.privateRegistry, true);
  });
});

suite('via-bundle source', () => {
  test('direct and missing sources yield no bundles', () => {
    assert.deepStrictEqual(parseViaBundles('direct'), []);
    assert.deepStrictEqual(parseViaBundles(''), []);
    assert.deepStrictEqual(parseViaBundles(null), []);
    assert.deepStrictEqual(parseViaBundles(undefined), []);
  });

  test('single and comma-joined multi-provider forms', () => {
    assert.deepStrictEqual(parseViaBundles('bundle: ghcr.io/rs/bundles/essentials'), [
      'ghcr.io/rs/bundles/essentials',
    ]);
    assert.deepStrictEqual(parseViaBundles('bundle: ghcr.io/rs/bundles/a, ghcr.io/rs/bundles/b'), [
      'ghcr.io/rs/bundles/a',
      'ghcr.io/rs/bundles/b',
    ]);
  });

  test('tolerates garbage and stray separators', () => {
    assert.deepStrictEqual(parseViaBundles('not a source'), []);
    assert.deepStrictEqual(parseViaBundles('bundle:'), []);
    assert.deepStrictEqual(parseViaBundles('bundle: a, , b,'), ['a', 'b']);
  });

  test('buildCards carries the providing bundles onto the install', () => {
    const scope: ScopeStatus = {
      scope: 'global',
      status: [statusItem({ source: 'bundle: ghcr.io/grimoire-rs/bundles/essentials' })],
      declared: {},
    };
    const cards = buildCards([searchItem()], [scope]);
    assert.deepStrictEqual(cards[0]?.installs[0]?.viaBundles, [
      'ghcr.io/grimoire-rs/bundles/essentials',
    ]);
  });
});

suite('filters', () => {
  const cards = buildCards(
    [
      searchItem(),
      searchItem({
        kind: 'rule',
        repo: 'harbor.acme.io/platform/rules/commits',
        deprecated: 'old',
      }),
      searchItem({ kind: 'bundle', repo: 'ghcr.io/grimoire-rs/bundles/essentials' }),
    ],
    [
      {
        scope: 'global',
        status: [statusItem()],
        declared: { 'grim-usage': 'ghcr.io/grimoire-rs/skills/grim-usage:1' },
      },
    ],
  );

  test('kind filter', () => {
    assert.strictEqual(filterCards(cards, { ...DEFAULT_FILTER, kinds: ['bundle'] }).length, 1);
    // Multi-kind: union across selected kinds; empty = all.
    assert.strictEqual(filterCards(cards, { ...DEFAULT_FILTER, kinds: ['rule', 'bundle'] }).length, 2);
    assert.strictEqual(filterCards(cards, DEFAULT_FILTER).length, cards.length);
  });

  test('DEFAULT_FILTER kinds is empty (All)', () => {
    assert.deepStrictEqual(DEFAULT_FILTER.kinds, [], 'empty kinds means All');
  });

  test('showDeprecated=false hides deprecated', () => {
    const filtered = filterCards(cards, { ...DEFAULT_FILTER, showDeprecated: false });
    assert.strictEqual(filtered.length, 2);
  });

  test('registriesOf is sorted and unique', () => {
    assert.deepStrictEqual(registriesOf(cards), ['ghcr.io', 'harbor.acme.io']);
  });
});

suite('relativeTime', () => {
  test('ranges', () => {
    const now = 1_000_000_000_000;
    assert.strictEqual(relativeTime(now - 30_000, now), 'just now');
    assert.strictEqual(relativeTime(now - 12 * 60_000, now), '12 min ago');
    assert.strictEqual(relativeTime(now - 3 * 3_600_000, now), '3 h ago');
    assert.strictEqual(relativeTime(now - 48 * 3_600_000, now), '2 d ago');
  });
});

suite('frontmatter', () => {
  test('extracts fields and strips block', () => {
    const content = [
      '---',
      'name: grim-usage',
      'description: Drive the grim CLI',
      'license: Apache-2.0',
      'metadata:',
      '  summary: Summary here',
      '  keywords: grim,cli, oci',
      '  repository: https://github.com/grimoire-rs/grimoire',
      '---',
      '',
      '# Body',
    ].join('\n');
    const { frontmatter, body } = parseFrontmatter(content);
    assert.strictEqual(frontmatter.description, 'Drive the grim CLI');
    assert.strictEqual(frontmatter.license, 'Apache-2.0');
    assert.strictEqual(frontmatter.summary, 'Summary here');
    assert.deepStrictEqual(frontmatter.keywords, ['grim', 'cli', 'oci']);
    assert.strictEqual(frontmatter.repository, 'https://github.com/grimoire-rs/grimoire');
    assert.strictEqual(body.trim(), '# Body');
  });

  test('no frontmatter returns content unchanged', () => {
    const { frontmatter, body } = parseFrontmatter('# Just markdown');
    assert.strictEqual(frontmatter.license, null);
    assert.strictEqual(body, '# Just markdown');
  });
});

suite('bundle members', () => {
  test('parses the members document', () => {
    const content = JSON.stringify({
      members: [
        { kind: 'skill', name: 'grim-usage', id: '../skills/grim-usage:0' },
        { kind: 'skill', name: 'ai-config-authoring', id: '../skills/ai-config-authoring:0' },
      ],
    });
    const members = parseBundleMembers(content);
    assert.strictEqual(members.length, 2);
    assert.strictEqual(members[0]?.name, 'grim-usage');
    assert.strictEqual(members[0]?.version, '0');
  });

  test('tolerates garbage', () => {
    assert.deepStrictEqual(parseBundleMembers('not json'), []);
    assert.deepStrictEqual(parseBundleMembers('{"members": "nope"}'), []);
  });

  test('resolveMemberRepo handles relative, absolute and hostless ids', () => {
    const bundle = 'ghcr.io/grimoire-rs/bundles/grim-essentials';
    assert.strictEqual(
      resolveMemberRepo(bundle, '../skills/grim-usage:1.5.0'),
      'ghcr.io/grimoire-rs/skills/grim-usage',
    );
    assert.strictEqual(
      resolveMemberRepo(bundle, 'ghcr.io/other/skills/x:2'),
      'ghcr.io/other/skills/x',
    );
    assert.strictEqual(resolveMemberRepo(bundle, ''), null);
    assert.strictEqual(resolveMemberRepo(bundle, '../../../../nope'), null);
  });
});

suite('assets', () => {
  test('findAssetPath finds well-known logo names', () => {
    const files = [{ path: 'grim-usage/SKILL.md' }, { path: 'grim-usage/logo.png' }];
    assert.strictEqual(findAssetPath(files, ['logo.png', 'logo.svg']), 'grim-usage/logo.png');
    assert.strictEqual(findAssetPath(files, ['icon.png']), null);
    assert.strictEqual(findAssetPath(undefined, ['logo.png']), null);
  });
});

suite('details view model', () => {
  test('merges describe > search > frontmatter with null fallbacks', () => {
    const vm = buildDetailsVM({
      repo: 'ghcr.io/grimoire-rs/skills/grim-usage',
      searchItem: searchItem(),
      describe: {
        ref: 'ghcr.io/grimoire-rs/skills/grim-usage:latest',
        digest: 'sha256:c6ed',
        kind: 'skill',
        name: 'grim-usage',
        title: 'grim-usage',
        description: 'From describe',
        summary: 'S',
        version: '1.5.0',
        license: 'Apache-2.0',
        repository: 'https://github.com/grimoire-rs/grimoire',
        revision: '9f3c1e2abcdef',
        created: '2026-06-28T00:00:00Z',
        keywords: ['cli', 'oci'],
        deprecated: null,
        replaced_by: null,
        tags: ['latest', '1', '1.5.0', '1.4.2'],
      },
      fetch: {
        ref: 'ghcr.io/grimoire-rs/skills/grim-usage:latest',
        digest: 'sha256:c6ed',
        kind: 'skill',
        name: 'grim-usage',
        content: '---\nlicense: MIT\n---\n# Grim Usage\nBody.',
        files: [{ path: 'grim-usage/SKILL.md', size: 100 }],
      },
      installs: [],
      scopes: scopesVM,
      logoUri: null,
    });
    assert.strictEqual(vm.description, 'From describe');
    assert.strictEqual(vm.latestVersion, '1.5.0');
    assert.strictEqual(vm.license, 'Apache-2.0'); // describe wins over frontmatter
    assert.deepStrictEqual(vm.tags, ['latest', '1', '1.5.0', '1.4.2']);
    assert.strictEqual(vm.revision, '9f3c1e2abcdef');
    assert.match(vm.contentMarkdown ?? '', /^# Grim Usage/);
    assert.strictEqual(vm.state, 'not-installed');
  });

  test('fetch-only fallback (no describe) uses frontmatter', () => {
    const vm = buildDetailsVM({
      repo: 'ghcr.io/x/skills/y',
      searchItem: null,
      describe: null,
      fetch: {
        ref: 'ghcr.io/x/skills/y:latest',
        digest: 'sha256:1',
        kind: 'skill',
        name: 'y',
        content: '---\ndescription: FM desc\nlicense: MIT\n---\nBody',
      },
      installs: [],
      scopes: scopesVM,
      logoUri: null,
    });
    assert.strictEqual(vm.description, 'FM desc');
    assert.strictEqual(vm.license, 'MIT');
    assert.strictEqual(vm.tags, null); // no describe -> no tag list
    assert.strictEqual(vm.published, null);
  });

  test('bundle parses members instead of markdown', () => {
    const vm = buildDetailsVM({
      repo: 'ghcr.io/x/bundles/b',
      searchItem: searchItem({ kind: 'bundle', repo: 'ghcr.io/x/bundles/b' }),
      describe: null,
      fetch: {
        ref: 'ghcr.io/x/bundles/b:latest',
        digest: 'sha256:2',
        kind: 'bundle',
        name: 'b',
        content: '{"members":[{"kind":"skill","name":"m","id":"../skills/m:1"}]}',
      },
      installs: [],
      scopes: scopesVM,
      logoUri: null,
    });
    assert.strictEqual(vm.members.length, 1);
    assert.strictEqual(vm.contentMarkdown, null);
    // The raw manifest is kept for the CONTENTS tab (item 5).
    assert.ok(vm.contentJson?.includes('"members"'));
  });

  test('bundle members are enriched from the catalog', () => {
    const vm = buildDetailsVM({
      repo: 'ghcr.io/grimoire-rs/bundles/b',
      searchItem: null,
      describe: null,
      fetch: {
        ref: 'ghcr.io/grimoire-rs/bundles/b:latest',
        digest: 'sha256:2',
        kind: 'bundle',
        name: 'b',
        content: '{"members":[{"kind":"skill","name":"grim-usage","id":"../skills/grim-usage:1"}]}',
      },
      installs: [],
      scopes: scopesVM,
      logoUri: null,
      catalog: [searchItem()],
    });
    assert.strictEqual(vm.members[0]?.repo, 'ghcr.io/grimoire-rs/skills/grim-usage');
    assert.strictEqual(vm.members[0]?.description, 'Drive the grim CLI.');
  });

  test('readme and changelog land on the VM verbatim', () => {
    const vm = buildDetailsVM({
      repo: 'ghcr.io/x/skills/y',
      searchItem: null,
      describe: null,
      fetch: {
        ref: 'ghcr.io/x/skills/y:latest',
        digest: 'sha256:1',
        kind: 'skill',
        name: 'y',
        content: 'Body',
      },
      installs: [],
      scopes: scopesVM,
      logoUri: null,
      readme: '# Readme',
      changelog: '# 1.0',
    });
    assert.strictEqual(vm.readmeMarkdown, '# Readme');
    assert.strictEqual(vm.changelogMarkdown, '# 1.0');
  });

  test('mcp JSON content lands on contentJson, pretty-printed, not markdown (item 5)', () => {
    const vm = buildDetailsVM({
      repo: 'ghcr.io/x/mcp/y',
      searchItem: null,
      describe: null,
      fetch: {
        ref: 'ghcr.io/x/mcp/y:latest',
        digest: 'sha256:1',
        kind: 'mcp',
        name: 'y',
        content: '{"command":"grim","args":["mcp"]}',
      },
      installs: [],
      scopes: scopesVM,
      logoUri: null,
    });
    assert.strictEqual(vm.contentMarkdown, null, 'JSON does not route through markdown');
    assert.ok(!vm.contentJson?.includes('```'), 'no fenced-block wrapping');
    assert.match(vm.contentJson ?? '', /"command": "grim"/, 'pretty-printed with spacing');
  });

  test('deprecated + installed state', () => {
    const installs: InstallVM[] = [
      {
        scope: 'project',
        version: '1.4.2',
        updateAvailable: true,
        clients: ['claude'],
        state: 'outdated',
        kind: 'skill',
        name: 'y',
        viaBundles: [],
      },
    ];
    const vm = buildDetailsVM({
      repo: 'ghcr.io/x/skills/y',
      searchItem: searchItem({ deprecated: 'use z', replaced_by: 'ghcr.io/x/skills/z' }),
      describe: null,
      fetch: null,
      installs,
      scopes: scopesVM,
      logoUri: null,
    });
    assert.strictEqual(vm.state, 'deprecated');
    assert.strictEqual(vm.replacedBy, 'ghcr.io/x/skills/z');
    assert.strictEqual(vm.installs.length, 1);
  });
});

function menuCard(overrides: Partial<CardVM> = {}): CardVM {
  return {
    repo: 'ghcr.io/grimoire-rs/skills/grim-usage',
    name: 'grim-usage',
    kind: 'skill',
    description: null,
    registryHost: 'ghcr.io',
    latestVersion: '1.5.0',
    state: 'not-installed',
    deprecated: null,
    replacedBy: null,
    installs: [],
    ...overrides,
  };
}

function install(overrides: Partial<InstallVM> = {}): InstallVM {
  return {
    scope: 'global',
    version: '1.5.0',
    updateAvailable: false,
    clients: [],
    state: 'installed',
    kind: 'skill',
    name: 'grim-usage',
    viaBundles: [],
    ...overrides,
  };
}

function labels(card: CardVM, opts: { projectOpen: boolean; context: boolean }): string[] {
  return cardMenuEntries(card, opts)
    .filter((e): e is MenuItem => e !== 'separator')
    .map((e) => e.label);
}

suite('card menu entries', () => {
  test('not-installed gear menu: both install scopes, pick version, pin, copy, no extras', () => {
    const entries = cardMenuEntries(menuCard(), { projectOpen: true, context: false });
    assert.deepStrictEqual(labels(menuCard(), { projectOpen: true, context: false }), [
      'Install in Project',
      'Install Globally',
      'Install Version',
      'Pin Version',
      'Copy repo path',
    ]);
    assert.ok(entries.includes('separator'));
    assert.ok(!labels(menuCard(), { projectOpen: true, context: false }).includes('Open Details'));
  });

  test('Install Version entry carries a pick-version action + repo', () => {
    const entry = cardMenuEntries(menuCard(), { projectOpen: true, context: false }).find(
      (e): e is MenuItem => e !== 'separator' && e.label === 'Install Version',
    );
    assert.ok(entry);
    assert.strictEqual(entry.action, 'pick-version');
    assert.strictEqual(entry.data?.['repo'], 'ghcr.io/grimoire-rs/skills/grim-usage');
  });

  test('free-scope install: project entry drops when no project is open', () => {
    const gear = labels(menuCard(), { projectOpen: false, context: false });
    assert.ok(!gear.includes('Install in Project'));
    assert.ok(gear.includes('Install Globally'));
  });

  test('installed (global) hides Install Globally, offers Uninstall (Global)', () => {
    const card = menuCard({ state: 'installed', installs: [install()] });
    const gear = labels(card, { projectOpen: true, context: false });
    assert.ok(!gear.includes('Install Globally'));
    assert.ok(gear.includes('Install in Project'));
    assert.ok(gear.includes('Uninstall (Global)'));
  });

  test('outdated install carries an Update entry in both the context and gear menus (item 7)', () => {
    const card = menuCard({
      state: 'outdated',
      installs: [install({ scope: 'project', updateAvailable: true, state: 'outdated' })],
    });
    const update = cardMenuEntries(card, { projectOpen: true, context: false }).find(
      (e): e is MenuItem => e !== 'separator' && e.label === 'Update',
    );
    assert.ok(update, 'gear menu offers Update');
    assert.strictEqual(update.action, 'update');
    assert.deepStrictEqual(update.data, { kind: 'skill', name: 'grim-usage', scope: 'project' });
    assert.ok(labels(card, { projectOpen: true, context: true }).includes('Update'));
  });

  test('up-to-date install has no Update entry in either menu (item 7 guard)', () => {
    const card = menuCard({ state: 'installed', installs: [install()] });
    assert.ok(!labels(card, { projectOpen: true, context: false }).includes('Update'));
    assert.ok(!labels(card, { projectOpen: true, context: true }).includes('Update'));
  });

  test('via-bundle install yields a disabled uninstall entry with a hint', () => {
    const card = menuCard({
      state: 'installed',
      installs: [install({ viaBundles: ['ghcr.io/grimoire-rs/bundles/grim-essentials'] })],
    });
    const entry = cardMenuEntries(card, { projectOpen: true, context: true }).find(
      (e): e is MenuItem => e !== 'separator' && e.label === 'Uninstall (Global)',
    );
    assert.ok(entry);
    assert.strictEqual(entry.action, undefined); // disabled: no action wiring
    assert.strictEqual(entry.hint, 'via grim-essentials');
    assert.ok(entry.title?.includes('ghcr.io/grimoire-rs/bundles/grim-essentials'));
  });

  test('context menu adds Open Details and Copy share link', () => {
    const ctx = labels(menuCard(), { projectOpen: true, context: true });
    assert.strictEqual(ctx[0], 'Open Details');
    assert.ok(ctx.includes('Copy share link'));
  });
});

suite('scope row menu entries (item 7: Copy repo path dropped)', () => {
  const names = (entries: MenuEntry[]) =>
    entries.filter((e): e is MenuItem => e !== 'separator').map((e) => e.label);

  test('outdated direct install: empty (Update leads the split button)', () => {
    assert.deepStrictEqual(
      names(scopeRowMenuEntries(install({ updateAvailable: true, state: 'outdated' }))),
      [],
    );
  });

  test('up-to-date install: empty', () => {
    assert.deepStrictEqual(names(scopeRowMenuEntries(install())), []);
  });

  test('not-installed row (install: null): empty', () => {
    assert.deepStrictEqual(names(scopeRowMenuEntries(null)), []);
  });

  test('outdated via-bundle install keeps only Update (its button is Bundle, not Update)', () => {
    const entries = scopeRowMenuEntries(
      install({ updateAvailable: true, viaBundles: ['ghcr.io/grimoire-rs/bundles/grim-essentials'] }),
    );
    assert.deepStrictEqual(names(entries), ['Update']);
    const update = entries.find((e): e is MenuItem => e !== 'separator');
    assert.strictEqual(update?.action, 'update');
  });
});

suite('effective install (design-2b chip)', () => {
  test('project install shadows global; else the sole install', () => {
    const project = install({ scope: 'project', version: '1.4.2' });
    const global = install({ scope: 'global', version: '1.5.0' });
    assert.strictEqual(effectiveInstall([global, project]), project);
    assert.strictEqual(effectiveInstall([global]), global);
    assert.strictEqual(effectiveInstall([]), undefined);
  });
});

suite('concreteVersion (header badge prefers a resolved version over floating "latest")', () => {
  test('a concrete candidate wins outright', () => {
    assert.strictEqual(concreteVersion('1.4.2', '1.5.0'), '1.4.2');
  });

  test('"latest" is skipped in favor of a later concrete candidate', () => {
    assert.strictEqual(concreteVersion('latest', '1.4.2'), '1.4.2');
  });

  test('falls back to "latest" when nothing concrete is known', () => {
    assert.strictEqual(concreteVersion('latest', 'latest'), 'latest');
    assert.strictEqual(concreteVersion('latest'), 'latest');
  });

  test('all null/undefined yields null', () => {
    assert.strictEqual(concreteVersion(null, undefined), null);
    assert.strictEqual(concreteVersion(), null);
  });
});

suite('skeleton view model', () => {
  test('catalog hit fills header fields, flags loading', () => {
    const vm = buildSkeletonVM(
      'ghcr.io/grimoire-rs/skills/grim-usage',
      searchItem({ version: '1.5.0' }),
      scopesVM,
    );
    assert.strictEqual(vm.loading, true);
    assert.strictEqual(vm.name, 'grim-usage');
    assert.strictEqual(vm.kind, 'skill');
    assert.strictEqual(vm.registryHost, 'ghcr.io');
    assert.strictEqual(vm.description, 'Drive the grim CLI.');
    assert.strictEqual(vm.latestVersion, '1.5.0');
    assert.deepStrictEqual(vm.installs, []);
    assert.strictEqual(vm.members.length, 0);
    // No installs passed -> scope boxes render as pending shells (item 2).
    assert.strictEqual(vm.scopesPending, true);
  });

  test('threads real install state when a snapshot is cached (item 2)', () => {
    const installs = [
      {
        scope: 'global' as const,
        version: '1.5.0',
        updateAvailable: false,
        clients: ['claude'],
        state: 'installed',
        kind: 'skill',
        name: 'grim-usage',
        viaBundles: [],
      },
    ];
    const vm = buildSkeletonVM(
      'ghcr.io/grimoire-rs/skills/grim-usage',
      searchItem(),
      scopesVM,
      installs,
    );
    assert.strictEqual(vm.loading, true);
    assert.strictEqual(vm.scopesPending, false, 'known installs -> not pending');
    assert.deepStrictEqual(vm.installs, installs);
    assert.strictEqual(vm.state, 'installed');
  });

  test('deep-link fallback: repo-derived name, unknown kind, no catalog', () => {
    const vm = buildSkeletonVM('ghcr.io/x/skills/mystery', null, scopesVM);
    assert.strictEqual(vm.loading, true);
    assert.strictEqual(vm.name, 'mystery');
    assert.strictEqual(vm.kind, null);
    assert.strictEqual(vm.description, null);
    assert.strictEqual(vm.latestVersion, null);
    assert.strictEqual(vm.scopesPending, true);
  });
});

suite('share links', () => {
  const repo = 'ghcr.io/grimoire-rs/skills/grim-usage';

  test('build/parse round-trips through urlencoding', () => {
    const link = buildShareLink('vscode', repo);
    assert.strictEqual(link, `vscode://grimoire-rs.grimoire-vscode/open?repo=${encodeURIComponent(repo)}`);
    assert.strictEqual(parseShareLink(new URL(link).search.slice(1)), repo);
  });

  test('parseShareLink tolerates already-decoded queries (vscode.Uri.query)', () => {
    assert.strictEqual(parseShareLink(`repo=${repo}`), repo);
    assert.strictEqual(parseShareLink('repo=ghcr.io%2Fgrimoire-rs%2Fskills%2Fgrim-usage'), repo);
    assert.strictEqual(parseShareLink(''), null);
    assert.strictEqual(parseShareLink('repo='), null);
  });

  test('hostile repo stays urlencoded (no live markup in the link)', () => {
    const link = buildShareLink('vscode-insiders', '"><script>alert(1)</script>');
    assert.ok(!link.includes('<script>'));
    assert.ok(link.startsWith('vscode-insiders://grimoire-rs.grimoire-vscode/open?repo='));
  });

  test('isValidRepo accepts real repos, rejects junk and hostile input', () => {
    assert.ok(isValidRepo(repo));
    assert.ok(isValidRepo('ghcr.io/grimoire-rs/skills/grim-usage:1.4.2'));
    assert.ok(!isValidRepo('nohostpath'));
    assert.ok(!isValidRepo(''));
    assert.ok(!isValidRepo('"><script>x</script>'));
    assert.ok(!isValidRepo('has space/x'));
  });
});

suite('toggleKinds', () => {
  test('toggles a kind on and off', () => {
    assert.deepStrictEqual(toggleKinds([], 'skill'), ['skill']);
    assert.deepStrictEqual(toggleKinds(['skill'], 'skill'), []);
    assert.deepStrictEqual(toggleKinds(['skill'], 'rule'), ['skill', 'rule']);
  });

  test("clicking 'all' clears the selection", () => {
    assert.deepStrictEqual(toggleKinds(['skill', 'rule'], 'all'), []);
    assert.deepStrictEqual(toggleKinds([], 'all'), []);
  });

  test('deselecting the last kind returns [] (All)', () => {
    assert.deepStrictEqual(toggleKinds(['bundle'], 'bundle'), []);
  });

  test('selecting all five kinds collapses to [] (All)', () => {
    assert.deepStrictEqual(toggleKinds(['skill', 'rule', 'agent', 'mcp'], 'bundle'), []);
  });

  test('unknown kinds toggle like any other (inert in filtering)', () => {
    assert.deepStrictEqual(toggleKinds([], 'nope'), ['nope']);
    assert.deepStrictEqual(toggleKinds(['nope'], 'nope'), []);
  });
});

suite('shouldResetUi', () => {
  test('never resets on the first paint (no prior repo)', () => {
    assert.strictEqual(shouldResetUi(null, 'ghcr.io/x/skills/a'), false);
  });

  test('does not reset a re-render of the same artifact', () => {
    assert.strictEqual(shouldResetUi('ghcr.io/x/skills/a', 'ghcr.io/x/skills/a'), false);
  });

  test('resets when the incoming artifact differs (preview retarget)', () => {
    assert.strictEqual(shouldResetUi('ghcr.io/x/skills/a', 'ghcr.io/x/skills/b'), true);
  });
});

suite('keepPaintedOnLoading', () => {
  const p = (phase: 'loading' | 'ready' | 'error' | 'no-grim') => ({ phase }) as const;

  test('a refresh over painted results keeps them (no skeleton flash)', () => {
    assert.strictEqual(keepPaintedOnLoading(p('ready'), p('loading')), true);
    assert.strictEqual(keepPaintedOnLoading(p('error'), p('loading')), true);
  });

  test('the initial load and non-loading states render in full', () => {
    assert.strictEqual(keepPaintedOnLoading(null, p('loading')), false);
    assert.strictEqual(keepPaintedOnLoading(p('loading'), p('loading')), false);
    assert.strictEqual(keepPaintedOnLoading(p('no-grim'), p('loading')), false);
    assert.strictEqual(keepPaintedOnLoading(p('ready'), p('ready')), false);
    assert.strictEqual(keepPaintedOnLoading(p('ready'), p('no-grim')), false);
  });
});

suite('footerTickRenders', () => {
  test('ticks repaint only with a painted state and no refresh in flight', () => {
    assert.strictEqual(footerTickRenders(sidebarState(), false), true);
    assert.strictEqual(footerTickRenders(sidebarState(), true), false, 'refresh in flight');
    assert.strictEqual(footerTickRenders(null, false), false, 'nothing painted yet');
    assert.strictEqual(footerTickRenders(null, true), false);
  });
});

suite('viewForTab', () => {
  const browseCard = (repo: string): CardVM => ({
    repo,
    name: repo,
    kind: 'skill',
    description: null,
    registryHost: 'ghcr.io',
    latestVersion: null,
    state: 'not-installed',
    deprecated: null,
    replacedBy: null,
    installs: [],
  });
  const combined = sidebarState({
    query: 'host-query',
    items: [browseCard('ghcr.io/a/browse-item')],
    installedItems: [
      { ...browseCard('ghcr.io/a/fresh'), state: 'installed' },
      { ...browseCard('ghcr.io/a/stale'), state: 'outdated' },
    ],
  });

  test('browse keeps the host items and the host-owned query', () => {
    const view = viewForTab(combined, 'browse', 'client-query');
    assert.strictEqual(view.mode, 'browse');
    assert.deepStrictEqual(view.items, combined.items);
    assert.strictEqual(view.query, 'host-query');
  });

  test('updates is the outdated slice of installedItems, no query', () => {
    const view = viewForTab(combined, 'updates', 'client-query');
    assert.strictEqual(view.mode, 'updates');
    assert.deepStrictEqual(
      view.items.map((c) => c.repo),
      ['ghcr.io/a/stale'],
    );
    assert.strictEqual(view.query, '');
  });

  test('installed carries the full installed set and the client-side query', () => {
    const view = viewForTab(combined, 'installed', 'client-query');
    assert.strictEqual(view.mode, 'installed');
    assert.deepStrictEqual(
      view.items.map((c) => c.repo),
      ['ghcr.io/a/fresh', 'ghcr.io/a/stale'],
    );
    assert.strictEqual(view.query, 'client-query');
  });
});

suite('defaultScope', () => {
  const scopes = (projectOpen: boolean, projectConfigured: boolean) => ({
    projectOpen,
    projectConfigured,
  });
  test('project when a configured workspace is open, else global', () => {
    assert.strictEqual(defaultScope(scopes(true, true)), 'project');
    assert.strictEqual(defaultScope(scopes(true, false)), 'global');
    assert.strictEqual(defaultScope(scopes(false, false)), 'global');
  });
});

suite('resolveInstalledScope', () => {
  const scopes = (projectOpen: boolean, projectConfigured: boolean) => ({
    projectOpen,
    projectConfigured,
  });
  test('unset → heuristic default (project when configured, else global)', () => {
    assert.strictEqual(resolveInstalledScope(undefined, scopes(true, true)), 'project');
    assert.strictEqual(resolveInstalledScope(undefined, scopes(true, false)), 'global');
  });
  test('explicit project needs only a workspace open (unconfigured is fine)', () => {
    assert.strictEqual(resolveInstalledScope('project', scopes(true, false)), 'project');
    assert.strictEqual(resolveInstalledScope('project', scopes(false, false)), 'global');
  });
  test('explicit global always global', () => {
    assert.strictEqual(resolveInstalledScope('global', scopes(true, true)), 'global');
  });
});

suite('isInteractiveTarget', () => {
  const fake = (matches: boolean) => ({
    closest: (sel: string) => (matches && sel === INTERACTIVE_SELECTOR ? {} : null),
  });
  test('true when the target sits on an interactive control (button/link/tab/data-action)', () => {
    assert.strictEqual(isInteractiveTarget(fake(true)), true);
  });
  test('false on plain body content — body double-click may promote', () => {
    assert.strictEqual(isInteractiveTarget(fake(false)), false);
  });
  test('false for a null target', () => {
    assert.strictEqual(isInteractiveTarget(null), false);
  });
});

suite('resolveCompanionAssets', () => {
  const pngB64 = (content: string) => ({ path: 'pic.png', size: content.length, content, encoding: 'base64' });

  test('rewrites a matching image ref to a data: URI (base64 passthrough)', () => {
    const out = resolveCompanionAssets('![shot](pic.png)', [pngB64('QUJD')]);
    assert.strictEqual(out, '![shot](data:image/png;base64,QUJD)');
  });

  test('strips a leading ./ before matching', () => {
    const files = [{ path: 'assets/pic.png', size: 3, content: 'QUJD', encoding: 'base64' }];
    assert.strictEqual(
      resolveCompanionAssets('![a](./assets/pic.png)', files),
      '![a](data:image/png;base64,QUJD)',
    );
  });

  test('leaves an unknown path untouched', () => {
    assert.strictEqual(resolveCompanionAssets('![a](nope.png)', [pngB64('QUJD')]), '![a](nope.png)');
  });

  test('a utf8 svg is base64-encoded (no encoding field)', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
    const out = resolveCompanionAssets('![d](d.svg)', [{ path: 'd.svg', size: svg.length, content: svg }]);
    assert.strictEqual(
      out,
      `![d](data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')})`,
    );
  });

  test('a non-image extension is left as a plain ref', () => {
    const files = [{ path: 'notes.txt', size: 2, content: 'hi' }];
    assert.strictEqual(resolveCompanionAssets('![n](notes.txt)', files), '![n](notes.txt)');
  });

  test('hostile content stays inert — the emitted data body is base64 only', () => {
    const hostile = '"><img src=x onerror=alert(1)>';
    const out = resolveCompanionAssets('![e](evil.svg)', [
      { path: 'evil.svg', size: hostile.length, content: hostile },
    ]);
    assert.match(out, /^!\[e\]\(data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+\)$/);
    assert.ok(!out.includes('<img'), 'raw markup does not survive into the ref');
  });
});
