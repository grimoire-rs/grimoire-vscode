import * as assert from 'assert';
import { installedScope, sidebarState } from './fixtures/vms';
import {
  applyCardMeta,
  cardVersion,
  addRegistryPrompt,
  artifactName,
  authenticatedHosts,
  buildCards,
  buildTree,
  buildDetailsVM,
  AVATAR_TINTS,
  avatarTint,
  buildInstalledCards,
  buildShareLink,
  buildSkeletonVM,
  cardKey,
  cardMenuEntries,
  clientDriftTooltip,
  collectNodeIds,
  computeUpdateAvailable,
  concreteVersion,
  cycleGroup,
  DEFAULT_FILTER,
  NATURAL,
  DEFAULT_VIEW,
  effectiveInstall,
  filterCards,
  findAssetPath,
  groupCards,
  groupKeyFor,
  installedCards,
  monogram,
  hasClientDrift,
  hasOutputsPending,
  outputsPendingTooltip,
  hasUpdate,
  INTERACTIVE_SELECTOR,
  isInteractiveTarget,
  isOpenableUrl,
  isValidRepo,
  contactUrl,
  readSupport,
  normalizeKind,
  parseAddRegistryLink,
  parseBundleMembers,
  parseFrontmatter,
  parseShareLink,
  parseViaBundles,
  defaultScope,
  refRepo,
  refTag,
  resolveCompanionAssets,
  resolveMemberRepo,
  registriesOf,
  registryFor,
  registryHost,
  registryLabel,
  registryUrlHost,
  relativeTime,
  rowState,
  scopeRowMenuEntries,
  topLevelIds,
  type TreeNode,
  footerTickRenders,
  keepPaintedOnLoading,
  shouldResetUi,
  toggleKinds,
  updateCount,
  viewForTab,
  type MenuEntry,
  sortCards,
  type CardFilter,
  type MenuItem,
  type ScopeStatus,
  type WireSearchItem,
  type WireStatusItem,
} from '../webview/model';
import type { CardVM, InstallVM, RegistryVM, RowState, ScopesVM } from '../webview/protocol';

/** The index two configured entries in these tests both browse. */
const INDEX = 'https://index.grimoire.rs';

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

suite('computeUpdateAvailable', () => {
  test('authoritative --check result wins over the lock-state proxy', () => {
    // true → update offered regardless of state.
    assert.strictEqual(
      computeUpdateAvailable({ update_available: true, state: 'installed' }),
      true,
    );
    // false suppresses the update even when the local lock reads outdated/stale
    // (the network check is the authority; stale is still handled on Update click).
    assert.strictEqual(
      computeUpdateAvailable({ update_available: false, state: 'outdated' }),
      false,
    );
    assert.strictEqual(computeUpdateAvailable({ update_available: false, state: 'stale' }), false);
  });

  test('a stale lock is NOT an update — editing grimoire.toml marks every row stale', () => {
    // grim derives `stale` from config-vs-lock declaration hash, so one edit to
    // grimoire.toml stales all 12 declared artifacts at once; counting it as an
    // update lit an Update button on every one of them.
    assert.strictEqual(computeUpdateAvailable({ update_available: null, state: 'stale' }), false);
    assert.strictEqual(computeUpdateAvailable({ state: 'stale' }), false);
    // …but grim's own check still wins in both directions.
    assert.strictEqual(computeUpdateAvailable({ update_available: true, state: 'stale' }), true);
  });

  test('null/absent (unchecked) falls back to the outdated proxy', () => {
    assert.strictEqual(computeUpdateAvailable({ update_available: null, state: 'outdated' }), true);

    assert.strictEqual(
      computeUpdateAvailable({ update_available: null, state: 'installed' }),
      false,
    );
    // Field omitted entirely (a fixture / older wire item) behaves like null.

    assert.strictEqual(computeUpdateAvailable({ state: 'installed' }), false);
  });

  test('a checked false on a stale install clears the card update badge', () => {
    // Ends up in buildCards via installIndex — proves the shared helper wins
    // over the state proxy end-to-end, not just in isolation.
    const scope: ScopeStatus = {
      scope: 'project',
      status: [statusItem({ state: 'stale', update_available: false })],
      declared: { 'skill:grim-usage': 'ghcr.io/grimoire-rs/skills/grim-usage:1.4.2' },
    };
    const card = buildCards([searchItem()], [scope])[0];
    assert.ok(card);
    assert.strictEqual(card.installs[0]?.updateAvailable, false);
    assert.strictEqual(card.state, 'installed', 'no update badge when the check says none');
  });
});

suite('card building', () => {
  const projectScope: ScopeStatus = {
    scope: 'project',
    status: [statusItem()],
    declared: { 'skill:grim-usage': 'ghcr.io/grimoire-rs/skills/grim-usage:1.4.2' },
  };
  const globalScope: ScopeStatus = {
    scope: 'global',
    status: [statusItem({ state: 'outdated' })],
    declared: { 'skill:grim-usage': 'ghcr.io/grimoire-rs/skills/grim-usage:latest' },
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

  // grim flattens its per-source groups, so one repo listed by two configured
  // entries arrives once per entry — and each is its own row under its own
  // registry root, exactly as grim's TUI lists it (S-022b). Collapsing them
  // emptied a whole registry out of Browse whenever its filtered rows were a
  // subset of an unfiltered entry's.
  test('a repo listed by two registries yields one card per registry', () => {
    const cards = buildCards(
      [
        searchItem({ description: 'from the full entry', source: { alias: 'full', locator: INDEX } }),
        searchItem({ description: 'from the filtered entry', source: { alias: 'mine', locator: INDEX } }),
      ],
      [],
    );
    assert.deepStrictEqual(
      cards.map((c) => c.source?.alias),
      ['full', 'mine'],
    );
    assert.deepStrictEqual(
      cards.map((c) => cardKey(c)),
      [`full\u0000${cards[0]?.repo}`, `mine\u0000${cards[1]?.repo}`],
      'the repeat() key separates them',
    );
  });

  // Two entries with the same locator and no alias are indistinguishable in
  // every view, so there is nothing to render twice.
  test('a repo listed twice by ONE source yields one card, the first', () => {
    const source = { alias: 'hub', locator: INDEX };
    const cards = buildCards(
      [
        searchItem({ description: 'from the index', source }),
        searchItem({ description: 'from _catalog', source }),
      ],
      [],
    );
    assert.strictEqual(cards.length, 1);
    assert.strictEqual(cards[0]?.description, 'from the index');
  });

  test('an unattributed repo listed twice still yields one card', () => {
    const cards = buildCards(
      [searchItem({ description: 'first' }), searchItem({ description: 'second' })],
      [],
    );
    assert.strictEqual(cards.length, 1);
    assert.strictEqual(cards[0]?.description, 'first');
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
      declared: { 'skill:grim-usage': 'ghcr.io/grimoire-rs/skills/grim-usage:1' },
    };
    const cards = buildInstalledCards([], [declaredUnlocked]);
    assert.strictEqual(cards.length, 1);
    assert.strictEqual(cards[0]?.installs[0]?.version, '1');
  });

  test('one name declared as two kinds resolves to two repos, both counted', () => {
    // grim identifies by (kind, name). Keyed by name alone, both status rows
    // read the same declared ref — the skill wore the agent's repo, the two
    // collapsed into one card and the outdated one left the update count.
    const scope: ScopeStatus = {
      scope: 'global',
      status: [
        statusItem({
          kind: 'skill',
          name: 'code-review',
          pinned: 'ghcr.io/acme/skills/code-review@sha256:aaa',
          state: 'outdated',
          update_available: true,
        }),
        statusItem({
          kind: 'agent',
          name: 'code-review',
          pinned: 'ghcr.io/acme/agents/code-review@sha256:bbb',
        }),
      ],
      declared: {
        'skill:code-review': 'ghcr.io/acme/skills/code-review:1.0',
        'agent:code-review': 'ghcr.io/acme/agents/code-review:2.0',
      },
    };
    assert.deepStrictEqual(
      buildInstalledCards([], [scope]).map((c) => c.repo),
      ['ghcr.io/acme/skills/code-review', 'ghcr.io/acme/agents/code-review'],
    );
    assert.strictEqual(updateCount([scope]), 1, 'the outdated skill still counts');
  });

  test('two installs at one repo in one scope both survive', () => {
    // Legal: `grim add <repo> --name other` declares the same repo twice. The
    // card is repo-keyed, so they share one — but the later install used to
    // REPLACE the earlier, dropping it out of the list and the count.
    const scope: ScopeStatus = {
      scope: 'global',
      status: [
        statusItem({ name: 'a', pinned: 'ghcr.io/acme/x/shared@sha256:aaa', state: 'outdated' }),
        statusItem({ kind: 'rule', name: 'b', pinned: 'ghcr.io/acme/x/shared@sha256:bbb' }),
      ],
      declared: {},
    };
    const cards = buildInstalledCards([], [scope]);
    assert.strictEqual(cards.length, 1, 'one repo, one card');
    assert.deepStrictEqual(
      cards[0]?.installs.map((i) => i.name),
      ['a', 'b'],
    );
    assert.strictEqual(updateCount([scope]), 1);
  });

  test('install is flagged floating when pinned is null, pinned otherwise (item 18)', () => {
    const floating = buildCards(
      [searchItem()],
      [
        {
          scope: 'project',
          status: [statusItem({ pinned: null, state: 'outdated' })],
          declared: { 'skill:grim-usage': 'ghcr.io/grimoire-rs/skills/grim-usage:1' },
        },
      ],
    );
    assert.strictEqual(floating[0]?.installs[0]?.floating, true);
    const pinned = buildCards(
      [searchItem()],
      [
        {
          scope: 'project',
          status: [statusItem({ state: 'outdated' })],
          declared: { 'skill:grim-usage': 'ghcr.io/grimoire-rs/skills/grim-usage:1.4.2' },
        },
      ],
    );
    assert.strictEqual(pinned[0]?.installs[0]?.floating, false);
  });

  test('buildInstalledCards prefers the catalog item over the status item for deprecated/replacedBy', () => {
    const scope: ScopeStatus = {
      scope: 'project',
      status: [
        statusItem({
          deprecated: 'status-sourced notice',
          replaced_by: 'ghcr.io/x/skills/status-replacement',
        }),
      ],
      declared: { 'skill:grim-usage': 'ghcr.io/grimoire-rs/skills/grim-usage:1.4.2' },
    };
    const withCatalog = buildInstalledCards(
      [
        searchItem({
          deprecated: 'catalog-sourced notice',
          replaced_by: 'ghcr.io/x/skills/catalog-replacement',
        }),
      ],
      [scope],
    );
    assert.strictEqual(withCatalog[0]?.deprecated, 'catalog-sourced notice');
    assert.strictEqual(withCatalog[0]?.replacedBy, 'ghcr.io/x/skills/catalog-replacement');

    // Artifact installed but absent from the browse catalog snapshot (e.g. a
    // registry the current search didn't cover) falls back to the status
    // item's own --check-populated fields.
    const withoutCatalog = buildInstalledCards([], [scope]);
    assert.strictEqual(withoutCatalog[0]?.deprecated, 'status-sourced notice');
    assert.strictEqual(withoutCatalog[0]?.replacedBy, 'ghcr.io/x/skills/status-replacement');
    assert.strictEqual(
      withoutCatalog[0]?.state,
      'deprecated',
      'rowState is recomputed off the fallback deprecated',
    );
  });
});

suite('client drift', () => {
  test('hasClientDrift is false with no drift (absent or empty arrays), true when either side is non-empty', () => {
    assert.strictEqual(hasClientDrift(install({})), false, 'absent fields default to no drift');
    assert.strictEqual(hasClientDrift(install({ clientsMissing: [], clientsExtra: [] })), false);
    assert.strictEqual(hasClientDrift(install({ clientsMissing: ['opencode'] })), true);
    assert.strictEqual(hasClientDrift(install({ clientsExtra: ['copilot'] })), true);
  });

  test('clientDriftTooltip lists missing/extra client names, omitting an empty side', () => {
    assert.strictEqual(
      clientDriftTooltip(install({ clientsMissing: ['opencode'], clientsExtra: ['copilot'] })),
      'Missing: opencode · Extra: copilot',
    );
    assert.strictEqual(
      clientDriftTooltip(install({ clientsMissing: ['opencode', 'copilot'] })),
      'Missing: opencode, copilot',
    );
    assert.strictEqual(
      clientDriftTooltip(install({ clientsExtra: ['copilot'] })),
      'Extra: copilot',
    );
    assert.strictEqual(clientDriftTooltip(install({})), '');
  });

  test('installIndex threads clients_missing/clients_extra from the status item onto the InstallVM', () => {
    const scope: ScopeStatus = {
      scope: 'project',
      status: [statusItem({ clients_missing: ['opencode'], clients_extra: ['copilot'] })],
      declared: { 'skill:grim-usage': 'ghcr.io/grimoire-rs/skills/grim-usage:1.4.2' },
    };
    const cards = buildCards([searchItem()], [scope]);
    assert.deepStrictEqual(cards[0]?.installs[0]?.clientsMissing, ['opencode']);
    assert.deepStrictEqual(cards[0]?.installs[0]?.clientsExtra, ['copilot']);
  });

  test('a status item with no explicit-clients drift threads empty arrays (autodetect carve-out)', () => {
    const scope: ScopeStatus = {
      scope: 'project',
      status: [statusItem()],
      declared: { 'skill:grim-usage': 'ghcr.io/grimoire-rs/skills/grim-usage:1.4.2' },
    };
    const cards = buildCards([searchItem()], [scope]);
    assert.deepStrictEqual(cards[0]?.installs[0]?.clientsMissing, []);
    assert.deepStrictEqual(cards[0]?.installs[0]?.clientsExtra, []);
    assert.strictEqual(hasClientDrift(cards[0]?.installs[0] as InstallVM), false);
  });
});

suite('materialization drift (outputs_pending)', () => {
  const pending = [{ client: 'cursor', path: '/repo/.cursor/skills/grim-usage' }];

  test('installIndex threads outputs_pending onto the InstallVM', () => {
    const scope: ScopeStatus = {
      scope: 'project',
      status: [statusItem({ outputs_pending: pending })],
      declared: { 'skill:grim-usage': 'ghcr.io/grimoire-rs/skills/grim-usage:1.4.2' },
    };
    const cards = buildCards([searchItem()], [scope]);
    assert.deepStrictEqual(cards[0]?.installs[0]?.outputsPending, pending);
    assert.strictEqual(hasOutputsPending(cards[0]?.installs[0] as InstallVM), true);
    // It is drift in materialization, not in state: the row is still installed.
    assert.strictEqual(cards[0]?.installs[0]?.state, 'installed');
  });

  test('an absent outputs_pending threads an empty array and reads as nothing pending', () => {
    // A grim predating the field omits the key entirely — absence must never
    // read as "something is pending".
    const scope: ScopeStatus = {
      scope: 'project',
      status: [statusItem()],
      declared: { 'skill:grim-usage': 'ghcr.io/grimoire-rs/skills/grim-usage:1.4.2' },
    };
    const cards = buildCards([searchItem()], [scope]);
    assert.deepStrictEqual(cards[0]?.installs[0]?.outputsPending, []);
    assert.strictEqual(hasOutputsPending(cards[0]?.installs[0] as InstallVM), false);
  });

  test('the tooltip names every client and path an install would write', () => {
    assert.strictEqual(
      outputsPendingTooltip({
        outputsPending: [
          { client: 'cursor', path: '/repo/.cursor/skills/x' },
          { client: 'codex', path: '/repo/.codex/skills/x' },
        ],
      }),
      'An install would also write:\ncursor → /repo/.cursor/skills/x\ncodex → /repo/.codex/skills/x',
    );
  });

  test('cardMenuEntries offers Complete Install per drifted scope, named by scope', () => {
    const card = menuCard({
      state: 'installed',
      installs: [
        install({ scope: 'project', outputsPending: pending }),
        install({ scope: 'global' }),
      ],
    });
    const entries = cardMenuEntries(card, { projectOpen: true, context: false });
    const complete = entries.filter(
      (e) => e !== 'separator' && e.action === 'complete-install',
    ) as MenuItem[];
    assert.strictEqual(complete.length, 1, 'only the drifted scope offers it');
    assert.strictEqual(complete[0]?.label, 'Complete Install (Project)');
    assert.deepStrictEqual(complete[0]?.data, { scope: 'project' });
  });

  test('a via-bundle row gets Complete Install in the gear, where its button cannot go', () => {
    // The split button on a via-bundle row is the Bundle nav, so every other
    // action for that row lives in the gear menu.
    const entries = scopeRowMenuEntries(
      install({ scope: 'global', viaBundles: ['ghcr.io/o/bundles/b'], outputsPending: pending }),
    );
    assert.deepStrictEqual(entries, [
      { label: 'Complete Install', action: 'complete-install', data: { scope: 'global' } },
    ]);
  });

  test('a direct row keeps an empty gear — its button carries the action', () => {
    assert.deepStrictEqual(scopeRowMenuEntries(install({ outputsPending: pending })), []);
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
        declared: { 'skill:grim-usage': 'ghcr.io/grimoire-rs/skills/grim-usage:1' },
      },
    ],
  );

  test('kind filter', () => {
    assert.strictEqual(filterCards(cards, { ...DEFAULT_FILTER, kinds: ['bundle'] }).length, 1);
    // Multi-kind: union across selected kinds; empty = all.
    assert.strictEqual(
      filterCards(cards, { ...DEFAULT_FILTER, kinds: ['rule', 'bundle'] }).length,
      2,
    );
    assert.strictEqual(filterCards(cards, DEFAULT_FILTER).length, cards.length);
  });

  test('DEFAULT_FILTER kinds is empty (All)', () => {
    assert.deepStrictEqual(DEFAULT_FILTER.kinds, [], 'empty kinds means All');
  });

  test('deprecated cards are never filtered client-side', () => {
    // grim's own `options.show_deprecated` decides which deprecated rows are
    // returned at all (see catalog.ts) — a second, client-side visibility
    // filter would only ever hide rows the user asked grim to show.
    assert.ok(cards.some((c) => c.deprecated));
    assert.strictEqual(filterCards(cards, DEFAULT_FILTER).length, cards.length);
  });

  // One card each, deliberately DAMP: the sort under test is about the buckets
  // (unrated, undated) as much as the order, and a shared fixture hides them.
  const sortCard = (
    name: string,
    updated: string | null,
    up: number | null,
  ): CardVM => ({
    repo: `ghcr.io/acme/skills/${name}`,
    name,
    kind: 'skill',
    description: null,
    registryHost: 'ghcr.io',
    latestVersion: '1.0.0',
    state: 'not-installed',
    deprecated: null,
    replacedBy: null,
    installs: [],
    updated,
    ...(up === null ? {} : { rating: { up, url: 'https://example.test/1', vote: 'unknown' as const } }),
  });

  test("relevance keeps grim's own order, and reverses it whole", () => {
    const rows = [sortCard('c', null, null), sortCard('a', null, null), sortCard('b', null, null)];
    assert.deepStrictEqual(
      sortCards(rows, 'relevance', 'asc').map((c) => c.name),
      ['c', 'a', 'b'],
      'relevance / registry order survives untouched',
    );
    assert.deepStrictEqual(
      sortCards(rows, 'relevance', 'desc').map((c) => c.name),
      ['b', 'a', 'c'],
    );
  });

  test('name sorts case-insensitively, both ways', () => {
    const rows = [sortCard('Zebra', null, null), sortCard('apple', null, null)];
    assert.deepStrictEqual(
      sortCards(rows, 'name', 'asc').map((c) => c.name),
      ['apple', 'Zebra'],
    );
    assert.deepStrictEqual(
      sortCards(rows, 'name', 'desc').map((c) => c.name),
      ['Zebra', 'apple'],
    );
  });

  test('undated rows are their own bucket, never epoch 0', () => {
    const rows = [
      sortCard('undated', null, null),
      sortCard('old', '2020-01-01T00:00:00Z', null),
      sortCard('new', '2026-01-01T00:00:00Z', null),
      sortCard('garbage', 'not-a-date', null),
    ];
    assert.deepStrictEqual(
      sortCards(rows, 'updated', 'desc').map((c) => c.name),
      ['new', 'old', 'garbage', 'undated'],
      'newest first; both dateless rows land after every dated one, name-tied',
    );
  });

  test('unrated rows are their own bucket, never zero upvotes', () => {
    const rows = [
      sortCard('unrated', '2026-01-01T00:00:00Z', null),
      sortCard('zero', '2026-01-01T00:00:00Z', 0),
      sortCard('popular', '2020-01-01T00:00:00Z', 9),
    ];
    assert.deepStrictEqual(
      sortCards(rows, 'rating', 'desc').map((c) => c.name),
      ['popular', 'zero', 'unrated'],
      'a 0-upvote row still outranks an unrated one',
    );
  });

  test('every mode is total — no pair compares equal', () => {
    // Two rows identical in every ranked key: the ref tiebreak has to decide,
    // or the order reshuffles on repaint.
    const rows = [sortCard('same', '2026-01-01T00:00:00Z', 3), sortCard('same', '2026-01-01T00:00:00Z', 3)];
    rows[1]!.repo = 'ghcr.io/other/skills/same';
    for (const mode of ['name', 'updated', 'rating'] as const) {
      const forward = sortCards(rows, mode, NATURAL[mode]).map((c) => c.repo);
      const back = sortCards(rows, mode, NATURAL[mode] === 'asc' ? 'desc' : 'asc').map((c) => c.repo);
      assert.deepStrictEqual(back, [...forward].reverse(), `${mode} reverses whole`);
    }
  });

  test('filterCards filters, then orders by the same filter', () => {
    const ordered = filterCards(cards, { ...DEFAULT_FILTER, sort: 'name', dir: 'asc' });
    assert.deepStrictEqual(
      ordered.map((c) => c.name),
      [...ordered.map((c) => c.name)].sort((a, b) => a.localeCompare(b)),
    );
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

  // The payloads below are VERBATIM captures from a real grim (0.13.0, duo) run
  // against the grimoire manual rig, not hand-written guesses:
  //   grim describe localhost:5050/grimoire/skills/support-desk --format json
  //   grim describe localhost:5050/grimoire/skills/hello-world  --format json
  // support-desk is the rig's annotation showcase (every curated field plus all
  // four support channels, contact as a BARE ADDRESS); hello-world carries only
  // a derived vendor, so both branches are pinned against real data.
  const supportDeskDescribe = {
    ref: 'localhost:5050/grimoire/skills/support-desk:latest',
    digest: 'sha256:aa11',
    kind: 'skill',
    name: 'support-desk',
    title: 'support-desk',
    description: 'Annotation showcase.',
    summary: null,
    version: '1.0.0',
    license: 'Apache-2.0',
    repository: 'https://github.com/grimoire-rs/grimoire',
    revision: 'acfcb09433be9d434dbfbcca1e14088468500f54',
    created: '2026-08-27T00:10:20+02:00',
    keywords: ['support'],
    deprecated: null,
    replaced_by: null,
    tags: ['1.0.0', 'latest'],
    authors: 'Grimoire Platform Team',
    vendor: 'Grimoire Manual Rig',
    url: 'https://grimoire.rs',
    documentation: 'https://grimoire.rs/publishing.html#metadata-descriptive',
    compatibility: 'claude>=2',
    support: {
      issues: 'https://github.com/grimoire-rs/grimoire/issues',
      chat: 'https://teams.microsoft.com/l/channel/manual-rig',
      contact: 'ai-platform@example.invalid',
      security: 'https://example.invalid/security',
    },
  };

  const helloWorldDescribe = {
    ref: 'localhost:5050/grimoire/skills/hello-world:latest',
    digest: 'sha256:bb22',
    kind: 'skill',
    name: 'hello-world',
    title: 'hello-world',
    description: 'Smoke test.',
    summary: null,
    version: '1.0.0',
    license: null,
    repository: null,
    revision: 'acfcb09433be9d434dbfbcca1e14088468500f54',
    created: '2026-08-27T00:10:20+02:00',
    keywords: null,
    deprecated: null,
    replaced_by: null,
    tags: ['1.0.0', 'latest'],
    authors: null,
    vendor: 'grimoire',
    url: null,
    documentation: null,
    compatibility: null,
    support: { issues: null, chat: null, contact: null, security: null },
  };

  test('carries grim\'s curated annotations onto the VM', () => {
    const vm = buildDetailsVM({
      repo: 'localhost:5050/grimoire/skills/support-desk',
      searchItem: null,
      describe: supportDeskDescribe,
      fetch: null,
      installs: [],
      scopes: scopesVM,
      logoUri: null,
    });
    assert.strictEqual(vm.authors, 'Grimoire Platform Team');
    assert.strictEqual(vm.vendor, 'Grimoire Manual Rig');
    // grim's `url` is the project page; `repository` stays the source forge.
    assert.strictEqual(vm.homepage, 'https://grimoire.rs');
    assert.strictEqual(vm.sourceRepository, 'https://github.com/grimoire-rs/grimoire');
    assert.strictEqual(vm.documentation, 'https://grimoire.rs/publishing.html#metadata-descriptive');
    assert.strictEqual(vm.compatibility, 'claude>=2');
    assert.deepStrictEqual(vm.support, {
      issues: 'https://github.com/grimoire-rs/grimoire/issues',
      chat: 'https://teams.microsoft.com/l/channel/manual-rig',
      contact: 'ai-platform@example.invalid',
      security: 'https://example.invalid/security',
    });
  });

  test('a real payload with no annotations reads null, never undefined', () => {
    const vm = buildDetailsVM({
      repo: 'localhost:5050/grimoire/skills/hello-world',
      searchItem: null,
      describe: helloWorldDescribe,
      fetch: null,
      installs: [],
      scopes: scopesVM,
      logoUri: null,
    });
    assert.strictEqual(vm.vendor, 'grimoire', 'grim derives a vendor even here');
    for (const field of ['authors', 'homepage', 'documentation', 'compatibility'] as const) {
      assert.strictEqual(vm[field], null, `${field} must be null, not undefined`);
    }
    assert.deepStrictEqual(vm.support, {
      issues: null,
      chat: null,
      contact: null,
      security: null,
    });
  });

  test('a grim predating the annotations omits the keys entirely — still null', () => {
    // The whole compatibility story for this surface: no version gate, no
    // polyfill marker, `?? null` at the read site. An older grim's payload has
    // no `authors`/`support` key at all, which must not differ from a null one.
    const vm = buildDetailsVM({
      repo: 'ghcr.io/x/skills/y',
      searchItem: null,
      describe: {
        ref: 'ghcr.io/x/skills/y:latest',
        digest: 'sha256:1',
        kind: 'skill',
        name: 'y',
        title: null,
        description: null,
        summary: null,
        version: null,
        license: null,
        repository: null,
        revision: null,
        created: null,
        keywords: null,
        deprecated: null,
        replaced_by: null,
        tags: [],
      },
      fetch: null,
      installs: [],
      scopes: scopesVM,
      logoUri: null,
    });
    assert.strictEqual(vm.authors, null);
    assert.strictEqual(vm.vendor, null);
    assert.strictEqual(vm.homepage, null);
    assert.strictEqual(vm.documentation, null);
    assert.strictEqual(vm.compatibility, null);
    assert.deepStrictEqual(vm.support, {
      issues: null,
      chat: null,
      contact: null,
      security: null,
    });
  });

  test('the skeleton VM carries the same empty shape, never undefined', () => {
    const vm = buildSkeletonVM('ghcr.io/x/skills/y', null, scopesVM);
    assert.strictEqual(vm.authors, null);
    assert.strictEqual(vm.compatibility, null);
    assert.deepStrictEqual(vm.support, {
      issues: null,
      chat: null,
      contact: null,
      security: null,
    });
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
      install({
        updateAvailable: true,
        viaBundles: ['ghcr.io/grimoire-rs/bundles/grim-essentials'],
      }),
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

suite('cardVersion (the browse chip follows what is installed)', () => {
  test('an installed concrete version wins over the catalog latest', () => {
    const cards = buildCards(
      [searchItem({ version: '1.5.0' })],
      [
        {
          scope: 'global',
          status: [statusItem()],
          declared: { 'skill:grim-usage': 'ghcr.io/grimoire-rs/skills/grim-usage:1.2.0' },
        },
      ],
    );
    // Switching version rewrites the declared ref — this is the value that has
    // to move when the user does it.
    assert.strictEqual(cardVersion(cards[0]!), '1.2.0');
  });

  test('a floating "latest" declaration falls through to the resolved latest', () => {
    const cards = buildCards(
      [searchItem({ version: '1.5.0' })],
      [
        {
          scope: 'global',
          status: [statusItem()],
          declared: { 'skill:grim-usage': 'ghcr.io/grimoire-rs/skills/grim-usage:latest' },
        },
      ],
    );
    assert.strictEqual(cardVersion(cards[0]!), '1.5.0');
  });

  test('not installed → the catalog latest, null when unknown', () => {
    assert.strictEqual(cardVersion(buildCards([searchItem({ version: '1.5.0' })], [])[0]!), '1.5.0');
    assert.strictEqual(cardVersion(buildCards([searchItem()], [])[0]!), null);
  });
});

suite('applyCardMeta (cached logo + describe version enrichment)', () => {
  test('fills a null latestVersion from the cached describe — the index-backed case', () => {
    // `grim search` behind an index reports no version at all, so the cached
    // describe is the row's only source of one.
    const cards = buildCards([searchItem({ version: null, latest_tag: null })], []);
    applyCardMeta(
      cards,
      new Map([
        [
          'ghcr.io/grimoire-rs/skills/grim-usage',
          { logoUri: 'data:image/png;base64,AAA', version: '1.4.2' },
        ],
      ]),
    );
    assert.strictEqual(cards[0]?.latestVersion, '1.4.2');
    assert.strictEqual(cards[0]?.logoUri, 'data:image/png;base64,AAA');
  });

  test('a catalog version wins over the cached one, and a miss changes nothing', () => {
    const cards = buildCards([searchItem({ version: '2.0.0' })], []);
    applyCardMeta(
      cards,
      new Map([['ghcr.io/grimoire-rs/skills/grim-usage', { logoUri: null, version: '1.4.2' }]]),
    );
    assert.strictEqual(cards[0]?.latestVersion, '2.0.0');

    const untouched = buildCards([searchItem()], []);
    applyCardMeta(untouched, new Map());
    assert.strictEqual(untouched[0]?.latestVersion, null);
    assert.strictEqual(untouched[0]?.logoUri, undefined);
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
    assert.strictEqual(
      link,
      `vscode://grimoire-rs.grimoire-vscode/open?repo=${encodeURIComponent(repo)}`,
    );
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

suite('add-registry deep link', () => {
  test('accepts an https index with a safe alias, and normalizes the URL', () => {
    assert.deepStrictEqual(parseAddRegistryLink('index=https://index.grimoire.rs&alias=grimoire'), {
      alias: 'grimoire',
      index: 'https://index.grimoire.rs/',
      include: [],
      exclude: [],
      scope: null,
    });
    assert.deepStrictEqual(
      parseAddRegistryLink(
        `index=${encodeURIComponent('https://idx.example.com/v1/')}&alias=my_idx-2`,
      ),
      {
        alias: 'my_idx-2',
        index: 'https://idx.example.com/v1/',
        include: [],
        exclude: [],
        scope: null,
      },
    );
  });

  test('reads browse filters as REPEATED params, keeping a comma inside one pattern', () => {
    // A comma is glob alternation syntax, so the wire format repeats the
    // parameter rather than joining — `acme/{tools,libs}/**` is ONE pattern.
    assert.deepStrictEqual(
      parseAddRegistryLink(
        'index=https://idx.example.com&alias=acme' +
          `&include=${encodeURIComponent('acme/platform/**')}` +
          `&include=${encodeURIComponent('acme/{tools,libs}/**')}` +
          `&exclude=${encodeURIComponent('acme/platform/legacy/**')}`,
      ),
      {
        alias: 'acme',
        index: 'https://idx.example.com/',
        include: ['acme/platform/**', 'acme/{tools,libs}/**'],
        exclude: ['acme/platform/legacy/**'],
        scope: null,
      },
    );
  });

  test('rejects a filter pattern that could forge a line in the confirmation modal', () => {
    // The modal IS the authorization and renders each pattern as a plain line.
    // A newline lets the page write its own "Index:" line under the real one;
    // a bidi override lets it reverse what is displayed. The rule is an
    // ALLOWLIST of printable ASCII, so everything below the two bidi entries is
    // rejected for being outside it — not because anyone enumerated it.
    for (const pattern of [
      'acme/**\nIndex: https://evil.example.com',
      'acme/**\r\nAlias: other',
      'acme/\t**',
      'acme/\x7f**',
      'acme/\u202e**', // RIGHT-TO-LEFT OVERRIDE
      'acme/\u2066**', // LEFT-TO-RIGHT ISOLATE
      'acme/\u2028Index: https://evil.example.com', // LINE SEPARATOR: a break, like \n
      'acme/\u2029Index: https://evil.example.com', // PARAGRAPH SEPARATOR: likewise
      'acme/\u200f**', // RIGHT-TO-LEFT MARK
      'acme/\u00a0**', // NO-BREAK SPACE
      'acme/\ufeff**', // ZERO WIDTH NO-BREAK SPACE
      'acme/\u00e9**', // any non-ASCII: OCI paths and globset syntax are ASCII
      'acme/**    Index: https://evil.example.com', // padding forges a line without a break
      '',
      '   ',
    ]) {
      assert.strictEqual(
        parseAddRegistryLink(
          `index=https://idx.example.com&alias=ok&include=${encodeURIComponent(pattern)}`,
        ),
        null,
        `rejected: ${JSON.stringify(pattern)}`,
      );
    }
  });

  test('rejects an over-budget pattern list outright rather than truncating it', () => {
    // Truncating would show fewer patterns than get written — the one failure
    // this modal exists to prevent.
    const many = Array.from({ length: 11 }, (_, i) => `exclude=acme/p${i}/**`).join('&');
    assert.strictEqual(
      parseAddRegistryLink(`index=https://idx.example.com&alias=ok&${many}`),
      null,
    );
    const long = 'a'.repeat(201);
    assert.strictEqual(
      parseAddRegistryLink(`index=https://idx.example.com&alias=ok&include=${long}`),
      null,
    );
    // The caps are per list, and each documented limit itself is ACCEPTED —
    // asserted on both sides so a `>=`/`>` slip cannot silently reject the
    // number the doc comment promises.
    const ten = Array.from({ length: 10 }, (_, i) => `include=acme/p${i}/**`).join('&');
    assert.ok(parseAddRegistryLink(`index=https://idx.example.com&alias=ok&${ten}`));
    assert.deepStrictEqual(
      parseAddRegistryLink(`index=https://idx.example.com&alias=ok&include=${'a'.repeat(200)}`)
        ?.include,
      ['a'.repeat(200)],
    );
  });

  test('a pattern may start with a dash — the link never makes it a flag', () => {
    // Argument injection is handled where argv is built (the patterns ride
    // behind `--include=`), so the parser has no business rejecting a leading
    // `-` the way the alias rule does.
    assert.deepStrictEqual(
      parseAddRegistryLink('index=https://idx.example.com&alias=ok&include=-x')?.include,
      ['-x'],
    );
  });

  test('the confirmation modal lists every pattern it is about to write', () => {
    const detail = addRegistryPrompt(
      {
        alias: 'acme',
        index: 'https://idx.example.com/',
        include: ['acme/platform/**', 'acme/tools/**'],
        exclude: ['acme/platform/legacy/**'],
        scope: null,
      },
      true,
    ).detail;
    for (const pattern of ['acme/platform/**', 'acme/tools/**', 'acme/platform/legacy/**']) {
      assert.ok(detail.includes(pattern), `modal names ${pattern}`);
    }
    assert.ok(detail.includes('2 include') === false, 'patterns verbatim, not summarized');
    // "excluded" reads like access control and is not — a direct reference to a
    // hidden package still resolves and installs.
    assert.ok(detail.includes('do not stop anything from being installed'));
  });

  test('the trust sentence stays ABOVE the pattern block', () => {
    const detail = addRegistryPrompt(
      {
        alias: 'acme',
        index: 'https://idx.example.com/',
        // The caps allow ~2000 characters per list, and showWarningMessage's
        // detail neither scrolls nor truncates visibly: patterns rendered
        // before the trust sentence push it out of view with plain text alone.
        include: Array.from({ length: 10 }, (_, i) => `acme/p${i}/${'x'.repeat(180)}`),
        exclude: ['acme/legacy/**'],
        scope: null,
      },
      true,
    ).detail;
    assert.ok(
      detail.indexOf('Only continue if you trust that page') < detail.indexOf('acme/p0/'),
      'the sentence that authorizes the write comes first',
    );
    assert.ok(
      detail.indexOf('Alias: acme') < detail.indexOf('Only continue if you trust that page'),
      'index and alias still lead',
    );
    assert.ok(detail.includes('acme/legacy/**'), 'every pattern still rendered verbatim');
  });

  test('a rejected link reports WHY, without echoing anything the page supplied', () => {
    // The reason is for the output channel only — a hostile page must learn
    // nothing from the extension's response — and it quotes no query value, so
    // a pattern cannot forge a line in the log either.
    const reasons: string[] = [];
    const record = (reason: string): void => {
      reasons.push(reason);
    };
    const hostile = 'zzhostilezz';
    for (const query of [
      `index=https://idx.example.com&alias=${hostile}.bad`,
      `index=http://idx.example.com&alias=ok&x=${hostile}`,
      `index=https://idx.example.com&alias=ok&${Array.from(
        { length: 11 },
        (_, i) => `include=${hostile}${i}/**`,
      ).join('&')}`,
      `index=https://idx.example.com&alias=ok&exclude=${hostile}${'a'.repeat(201)}`,
      `index=https://idx.example.com&alias=ok&include=${encodeURIComponent(`${hostile}\n`)}`,
    ]) {
      assert.strictEqual(parseAddRegistryLink(query, record), null, query);
    }
    assert.strictEqual(reasons.length, 5, 'one reason per rejected link');
    assert.ok(
      reasons.every((r) => !r.includes(hostile) && !r.includes('\n')),
      `reasons quote no query value: ${reasons.join(' | ')}`,
    );
    assert.ok(
      reasons[2]?.includes('include') && reasons[3]?.includes('exclude'),
      `the reason names which list failed: ${reasons.join(' | ')}`,
    );
  });

  test('the modal omits a filter clause it has nothing to say about', () => {
    const detail = addRegistryPrompt(
      {
        alias: 'acme',
        index: 'https://idx.example.com/',
        include: ['acme/**'],
        exclude: [],
        scope: null,
      },
      true,
    ).detail;
    assert.ok(detail.includes('Include: acme/**'));
    assert.ok(!detail.includes('Exclude'), 'no empty Exclude line');
  });

  test('rejects every non-https or unparseable index', () => {
    for (const index of [
      'http://index.grimoire.rs',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'vscode://grimoire-rs.grimoire-vscode/open',
      'not a url',
      '',
      // Credentials would be persisted into grimoire.toml verbatim.
      'https://user:token@index.grimoire.rs',
    ]) {
      assert.strictEqual(
        parseAddRegistryLink(`index=${encodeURIComponent(index)}&alias=ok`),
        null,
        `rejected: ${index}`,
      );
    }
    assert.strictEqual(parseAddRegistryLink('alias=ok'), null, 'index missing');
    // Over the length cap, so it never reaches the URL parser or the modal.
    const long = `https://x.example.com/${'a'.repeat(2100)}`;
    assert.strictEqual(parseAddRegistryLink(`index=${long}&alias=ok`), null);
  });

  test('rejects an alias that is not a bare, flag-safe identifier', () => {
    for (const alias of [
      '',
      '-default',
      '--default',
      'has space',
      'dotted.key',
      'quote"key',
      'bracket]key',
      'new\nline',
      '<script>',
      'a'.repeat(33),
    ]) {
      assert.strictEqual(
        parseAddRegistryLink(`index=https://idx.example.com&alias=${encodeURIComponent(alias)}`),
        null,
        `rejected: ${JSON.stringify(alias)}`,
      );
    }
  });

  test('prompt targets project scope, falling back to global with that said out loud', () => {
    const link = {
      alias: 'grimoire',
      index: 'https://index.grimoire.rs/',
      include: [],
      exclude: [],
      scope: null,
    };
    const project = addRegistryPrompt(link, true);
    assert.strictEqual(project.scope, 'project');
    assert.ok(project.detail.includes('https://index.grimoire.rs/'), 'names the exact index');
    assert.ok(project.detail.includes('grimoire'), 'names the alias');
    assert.ok(project.detail.includes("project's grimoire.toml"));

    const global = addRegistryPrompt(link, false);
    assert.strictEqual(global.scope, 'global');
    assert.ok(global.detail.includes('GLOBAL'), 'the fallback is stated, not silent');
  });

  test('reads the scope the page picked, and falls back rather than refusing', () => {
    const base = 'index=https://idx.example.com&alias=ok';
    assert.strictEqual(parseAddRegistryLink(`${base}&scope=global`)?.scope, 'global');
    assert.strictEqual(parseAddRegistryLink(`${base}&scope=project`)?.scope, 'project');
    for (const query of [
      base,
      `${base}&scope=`,
      `${base}&scope=nonsense`,
      // Case-sensitive: the two scope names are the wire format, not prose.
      `${base}&scope=GLOBAL`,
      `${base}&scope=${encodeURIComponent('global ')}`,
    ]) {
      const link = parseAddRegistryLink(query);
      assert.ok(link, `link honoured, not refused: ${query}`);
      assert.strictEqual(link.scope, null, query);
    }
    // Repeated keys: `get` takes the first, the same way `alias` and `index`
    // already behave — a second one cannot override the one shown in the modal.
    assert.strictEqual(parseAddRegistryLink(`${base}&scope=global&scope=project`)?.scope, 'global');
  });

  test('an unreadable scope is not logged as an ignored link', () => {
    // The caller prefixes every reason with "add-registry link ignored" — a
    // link honoured with the derived default must produce no such line.
    const reasons: string[] = [];
    const link = parseAddRegistryLink('index=https://idx.example.com&alias=ok&scope=nonsense', (r) =>
      reasons.push(r),
    );
    assert.ok(link);
    assert.deepStrictEqual(reasons, []);
  });

  test("the link's scope overrides the derived default, and the modal says which", () => {
    const link = {
      alias: 'grimoire',
      index: 'https://index.grimoire.rs/',
      include: [],
      exclude: [],
      scope: 'global' as const,
    };
    // The case this whole feature exists for: a folder IS open, so today's
    // code would have written the project config.
    const chosen = addRegistryPrompt(link, true);
    assert.strictEqual(chosen.scope, 'global');
    assert.ok(chosen.detail.includes('GLOBAL'), 'names the scope it will write');
    assert.ok(
      chosen.detail.includes('the page asked for global scope'),
      'says WHO chose it — a web page steering a machine-wide write',
    );
    assert.ok(
      chosen.detail.includes('every project on this machine'),
      'says what global costs, not just where it lands',
    );
    assert.ok(
      !chosen.detail.includes('no folder is open'),
      'the no-folder fallback wording is a different situation',
    );
    assert.ok(
      chosen.detail.indexOf('Alias: grimoire') <
        chosen.detail.indexOf('Only continue if you trust that page'),
      'index and alias still lead',
    );

    assert.strictEqual(addRegistryPrompt({ ...link, scope: 'project' }, true).scope, 'project');
  });

  test('no folder open still forces global, whatever the link asked for', () => {
    // There is no project config to write, so `scope=project` cannot make one.
    const forced = addRegistryPrompt(
      {
        alias: 'grimoire',
        index: 'https://index.grimoire.rs/',
        include: [],
        exclude: [],
        scope: 'project',
      },
      false,
    );
    assert.strictEqual(forced.scope, 'global');
    assert.ok(forced.detail.includes('no folder is open'), 'the modal explains the override');
  });

  test('a link with no scope produces byte-identical modal text', () => {
    const link = {
      alias: 'grimoire',
      index: 'https://index.grimoire.rs/',
      include: [],
      exclude: [],
      scope: null,
    };
    const lead = 'A web page is asking to add an index registry.\n\n';
    const ids = 'Index: https://index.grimoire.rs/\nAlias: grimoire\n\n';
    assert.deepStrictEqual(addRegistryPrompt(link, true), {
      scope: 'project',
      detail:
        `${lead}${ids}This writes to this project's grimoire.toml. ` +
        'Only continue if you trust that page.',
    });
    assert.deepStrictEqual(addRegistryPrompt(link, false), {
      scope: 'global',
      detail:
        `${lead}${ids}This writes to your GLOBAL grimoire.toml — no folder is open, so there ` +
        'is no project config to write. Only continue if you trust that page.',
    });
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
  // Installed cards carry their installs — rowState returns 'not-installed' for
  // an empty set, so an installed/outdated card without one cannot come out of
  // buildInstalledCards, and the Updates slice reads the installs (hasUpdate),
  // not the row state.
  const combined = sidebarState({
    query: 'host-query',
    items: [browseCard('ghcr.io/a/browse-item')],
    installedItems: [
      {
        ...browseCard('ghcr.io/a/fresh'),
        state: 'installed',
        installs: [install({ updateAvailable: false })],
      },
      {
        ...browseCard('ghcr.io/a/stale'),
        state: 'outdated',
        installs: [install({ updateAvailable: true, state: 'outdated' })],
      },
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

  test('a deprecated artifact with an update stays in the Updates slice', () => {
    // rowState shadows 'outdated' with 'deprecated', and `deprecated` is itself
    // only populated under `--check` — so slicing by row state dropped this
    // card from the list on exactly the rounds that had real update data, while
    // its own card still offered an Update button.
    const state = sidebarState({
      installedItems: [
        {
          ...browseCard('ghcr.io/a/retired'),
          state: 'deprecated',
          deprecated: 'moved to ghcr.io/a/successor',
          installs: [install({ updateAvailable: true, state: 'outdated' })],
        },
      ],
    });
    assert.deepStrictEqual(
      viewForTab(state, 'updates', '').items.map((c) => c.repo),
      ['ghcr.io/a/retired'],
    );
  });
});

suite('hasUpdate', () => {
  test('counts by the install verdict, never by row state', () => {
    const card = (state: RowState, updateAvailable: boolean): CardVM => ({
      repo: 'ghcr.io/a/x',
      name: 'x',
      kind: 'skill',
      description: null,
      registryHost: 'ghcr.io',
      latestVersion: null,
      deprecated: null,
      replacedBy: null,
      state,
      installs: [install({ updateAvailable })],
    });
    assert.strictEqual(hasUpdate(card('deprecated', true)), true, 'deprecated does not shadow it');
    assert.strictEqual(hasUpdate(card('outdated', true)), true);
    assert.strictEqual(hasUpdate(card('installed', false)), false);
    assert.strictEqual(hasUpdate({ installs: [] }), false, 'not installed is not an update');
  });

  test('one updatable scope is enough when the other is current', () => {
    const card: Pick<CardVM, 'installs'> = {
      installs: [
        install({ scope: 'global', updateAvailable: false }),
        install({ scope: 'project', updateAvailable: true, state: 'outdated' }),
      ],
    };
    assert.strictEqual(hasUpdate(card), true);
  });
});

suite('updateCount', () => {
  test('the count is the same with and without catalog items', () => {
    // updateCount builds its cards from an EMPTY catalog on purpose — that is
    // what lets activation publish the badge off the snapshot alone, with no
    // `grim search` in front of it. It only holds while nothing the catalog
    // contributes can reach hasUpdate, so this is the invariant that whole
    // optimization rests on.
    const scopes: ScopeStatus[] = [
      {
        scope: 'project',
        status: [
          statusItem({
            name: 'drifted',
            pinned: 'ghcr.io/a/skills/drifted:1.0.0',
            state: 'outdated',
          }),
          statusItem({ name: 'current', pinned: 'ghcr.io/a/skills/current:1.0.0' }),
        ],
        declared: {},
      },
      {
        scope: 'global',
        status: [
          statusItem({
            name: 'checked',
            pinned: 'ghcr.io/a/skills/checked:1.0.0',
            update_available: true,
          }),
        ],
        declared: {},
      },
    ];
    // A catalog that disagrees with the snapshot everywhere it is allowed to:
    // newer versions than any install, plus a deprecation and a replacement —
    // and they sit on a row that DOES have an update, so any of them leaking
    // into the count would move it.
    const items = [
      searchItem({
        repo: 'ghcr.io/a/skills/drifted',
        version: '9.9.9',
        deprecated: 'moved on',
        replaced_by: 'ghcr.io/a/skills/next',
      }),
      searchItem({ repo: 'ghcr.io/a/skills/current', version: '9.9.9' }),
      searchItem({ repo: 'ghcr.io/a/skills/checked', version: '9.9.9' }),
    ];
    assert.strictEqual(updateCount(scopes), 2, 'the drifted lock and the checked verdict');
    assert.strictEqual(
      buildInstalledCards(items, scopes).filter(hasUpdate).length,
      updateCount(scopes),
      'a catalog cannot move the count — the badge is safe to publish without one',
    );
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

// resolveInstalledScope is gone: the Installed view groups by scope now (both
// scopes at once) instead of toggling between them — see the groupCards suite.

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
  const pngB64 = (content: string) => ({
    path: 'pic.png',
    size: content.length,
    content,
    encoding: 'base64',
  });

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
    assert.strictEqual(
      resolveCompanionAssets('![a](nope.png)', [pngB64('QUJD')]),
      '![a](nope.png)',
    );
  });

  test('a utf8 svg is base64-encoded (no encoding field)', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
    const out = resolveCompanionAssets('![d](d.svg)', [
      { path: 'd.svg', size: svg.length, content: svg },
    ]);
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

// --- View modes: grouping and the tree ------------------------------------

const treeCards = (): CardVM[] =>
  buildCards(
    [
      searchItem(), // ghcr.io/grimoire-rs/skills/grim-usage
      searchItem({ repo: 'ghcr.io/grimoire-rs/skills/ai-config', kind: 'skill' }),
      searchItem({ repo: 'ghcr.io/grimoire-rs/rules/quality-core', kind: 'rule' }),
      // The deep single-child chain: playbooks -> ci -> release -> cut-release.
      searchItem({ repo: 'ghcr.io/grimoire-rs/playbooks/ci/release/cut-release' }),
      searchItem({ repo: 'registry.acme.dev/acme/mcp/postgres-mcp', kind: 'mcp' }),
    ],
    [],
  );

const RIG: RegistryVM[] = [
  { alias: 'primary', oci: 'ghcr.io/grimoire-rs', kind: 'registry', isDefault: true },
  {
    alias: 'acme',
    oci: 'registry.acme.dev/acme',
    kind: 'registry',
    isDefault: false,
    authenticated: true,
  },
];

suite('registryFor', () => {
  test('the longest matching oci prefix wins', () => {
    const registries: RegistryVM[] = [
      { alias: 'host', oci: 'ghcr.io', kind: 'registry', isDefault: false },
      { alias: 'ours', oci: 'ghcr.io/grimoire-rs', kind: 'registry', isDefault: true },
    ];
    assert.strictEqual(registryFor('ghcr.io/grimoire-rs/skills/x', registries)?.alias, 'ours');
    assert.strictEqual(registryFor('ghcr.io/someone-else/x', registries)?.alias, 'host');
  });

  test('a repo no configured registry claims matches nothing', () => {
    assert.strictEqual(registryFor('quay.io/foo/bar', RIG), undefined);
  });

  test('an index entry never claims a repo — its locator prefixes nothing', () => {
    // registryFor is prefix matching alone; an index-served row is tied back to
    // its alias by grim's per-row `source`, not by this (see the source suite).
    const registries: RegistryVM[] = [
      { alias: 'mine', oci: 'https://index.grimoire.rs', kind: 'index', isDefault: true },
      { alias: 'theirs', oci: 'https://index.grimoire.rs', kind: 'index', isDefault: false },
    ];
    assert.strictEqual(registryFor('ghcr.io/michael-herwig/arcana/hex', registries), undefined);
  });

  test('two entries sharing one locator stay distinct groups (keyed by alias)', () => {
    const registries: RegistryVM[] = [
      { alias: 'ours', oci: 'localhost:5050', kind: 'registry', isDefault: true },
      { alias: 'mirror', oci: 'localhost:5050', kind: 'registry', isDefault: false },
    ];
    const cards = buildCards([searchItem({ repo: 'localhost:5050/team/skills/x' })], []);
    const groups = groupCards(cards, 'registry', { registries });
    assert.deepStrictEqual(
      groups.map((g) => g.id),
      ['ours'],
      'first configured match wins, and the id is its alias — not the shared locator',
    );
  });

  test('a prefix only matches on a segment boundary', () => {
    const registries: RegistryVM[] = [
      { alias: 'a', oci: 'ghcr.io/grim', kind: 'registry', isDefault: false },
    ];
    assert.strictEqual(registryFor('ghcr.io/grimoire-rs/skills/x', registries), undefined);
  });
});

suite('groupCards', () => {
  test('registry: groups are the CONFIGURED registries, named by alias', () => {
    const groups = groupCards(treeCards(), 'registry', { registries: RIG });
    assert.deepStrictEqual(
      groups.map((g) => g.label),
      ['primary', 'acme'],
      'default registry first, then by label',
    );
    assert.deepStrictEqual(
      groups.map((g) => g.id),
      ['primary', 'acme'],
      'the id is the alias — unique even when two entries share a locator',
    );
    assert.strictEqual(groups[1]?.private, true, 'authenticated registry renders the lock');
  });

  test('registry: two aliases on ONE host stay two groups', () => {
    const registries: RegistryVM[] = [
      { alias: 'ours', oci: 'ghcr.io/grimoire-rs', kind: 'registry', isDefault: true },
      { alias: 'theirs', oci: 'ghcr.io/other-org', kind: 'registry', isDefault: false },
    ];
    const cards = buildCards(
      [searchItem(), searchItem({ repo: 'ghcr.io/other-org/skills/x' })],
      [],
    );
    assert.deepStrictEqual(
      groupCards(cards, 'registry', { registries }).map((g) => g.label),
      ['ours', 'theirs'],
    );
  });

  test('registry: an unclaimed repo falls back to its bare host', () => {
    const cards = buildCards([searchItem({ repo: 'quay.io/foo/bar' })], []);
    const groups = groupCards(cards, 'registry', { registries: RIG });
    assert.deepStrictEqual(
      groups.map((g) => g.label),
      ['quay.io'],
    );
  });

  test('registry: grim’s per-row source roots an INDEX row under its alias', () => {
    // The whole point of the field: the index's locator prefixes no repo, so
    // prefix matching alone can only reach the bare host (see registryFor).
    const registries: RegistryVM[] = [
      { alias: 'michael-herwig', oci: 'https://index.grimoire.rs', kind: 'index', isDefault: true },
    ];
    const cards = buildCards(
      [
        searchItem({
          repo: 'ghcr.io/michael-herwig/arcana/hex',
          source: { alias: 'michael-herwig', locator: 'https://index.grimoire.rs' },
        }),
      ],
      [],
    );
    const groups = groupCards(cards, 'registry', { registries });
    assert.deepStrictEqual(
      groups.map((g) => g.id),
      ['michael-herwig'],
    );
    assert.strictEqual(groups[0]?.isDefaultRegistry, true, 'flags come off the matched entry');
  });

  test('registry: an UNALIASED source is labelled by its locator, never "default"', () => {
    const cards = buildCards(
      [
        searchItem({
          repo: 'ghcr.io/someone/skills/x',
          source: { alias: null, locator: 'ghcr.io/someone' },
        }),
      ],
      [],
    );
    const groups = groupCards(cards, 'registry', { registries: [] });
    assert.deepStrictEqual(
      groups.map((g) => g.label),
      ['ghcr.io/someone'],
      '"default" is taken — it means the default registry',
    );
  });

  test('registry: source WINS over prefix attribution when the two disagree', () => {
    // A row browsed through the index but whose host also matches a configured
    // oci entry files under the source that actually served it.
    const registries: RegistryVM[] = [
      { alias: 'direct', oci: 'ghcr.io/grimoire-rs', kind: 'registry', isDefault: false },
      { alias: 'hub', oci: 'https://index.grimoire.rs', kind: 'index', isDefault: false },
    ];
    const cards = buildCards(
      [searchItem({ source: { alias: 'hub', locator: 'https://index.grimoire.rs' } })],
      [],
    );
    assert.deepStrictEqual(
      groupCards(cards, 'registry', { registries }).map((g) => g.id),
      ['hub'],
    );
  });

  test('registry: an INSTALLED card inherits the catalog row’s attribution', () => {
    // grim status carries none, so without this an installed row would fall
    // back to its bare host while the same artifact roots on its alias under
    // Browse — the two tabs disagreeing about the same registry.
    const registries: RegistryVM[] = [
      { alias: 'hub', oci: 'https://index.grimoire.rs', kind: 'index', isDefault: true },
    ];
    const cards = buildInstalledCards(
      [searchItem({ source: { alias: 'hub', locator: 'https://index.grimoire.rs' } })],
      [installedScope('project')],
    );
    assert.deepStrictEqual(
      groupCards(cards, 'registry', { registries }).map((g) => g.id),
      ['hub'],
    );
  });

  test('registry: an installed card absent from the catalog keeps the fallback', () => {
    const cards = buildInstalledCards([], [installedScope('project')]);
    assert.strictEqual(cards[0]?.source, undefined);
    assert.deepStrictEqual(
      groupCards(cards, 'registry', { registries: RIG }).map((g) => g.id),
      ['primary'],
    );
  });

  test('registry: a card with no source still attributes by longest prefix', () => {
    // Installed-only cards and any pre-attribution grim land here — grim's own
    // RowSource::Unattributed rule, unchanged.
    const cards = buildCards([searchItem()], []);
    assert.strictEqual(cards[0]?.source, undefined);
    assert.deepStrictEqual(
      groupCards(cards, 'registry', { registries: RIG }).map((g) => g.id),
      ['primary'],
    );
  });

  test('scope: a card installed in both scopes appears under both headers', () => {
    const cards = buildCards([searchItem()], [installedScope('project'), installedScope('global')]);
    const groups = groupCards(cards, 'scope', { projectName: 'demo' });
    assert.deepStrictEqual(
      groups.map((g) => g.label),
      ['Project — demo', 'Global'],
    );
    assert.strictEqual(groups[0]?.cards[0], groups[1]?.cards[0], 'the same card, twice');
  });

  test('scope: a scope with no installs contributes no header', () => {
    const cards = buildCards([searchItem()], [installedScope('project')]);
    assert.deepStrictEqual(
      groupCards(cards, 'scope', {}).map((g) => g.id),
      ['project'],
    );
  });
});

suite('logo placeholder', () => {
  test('monogram takes up to two initials, uppercased', () => {
    assert.strictEqual(monogram('grim-usage'), 'GU');
    assert.strictEqual(monogram('hello_world.thing'), 'HW', 'two at most');
    assert.strictEqual(monogram('hex'), 'H');
    assert.strictEqual(monogram(''), '', 'nothing to stand in for');
  });

  test('avatarTint is stable per repo and inside the class range', () => {
    const repo = 'ghcr.io/grimoire-rs/skills/grim-usage';
    assert.strictEqual(avatarTint(repo), avatarTint(repo), 'same repo, same colour');
    const tints = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const tint = avatarTint(`ghcr.io/org/skills/artifact-${i}`);
      assert.ok(tint >= 0 && tint < AVATAR_TINTS, `${tint} is a defined class`);
      tints.add(tint);
    }
    assert.strictEqual(tints.size, AVATAR_TINTS, 'every tint is reachable');
  });
});

suite('buildTree', () => {
  const labels = (nodes: TreeNode[], depth = 0): string[] =>
    nodes.flatMap((n) => [`${'  '.repeat(depth)}${n.label}`, ...labels(n.children, depth + 1)]);

  test('roots are the configured registries; their oci prefix is stripped below', () => {
    const nodes = buildTree(treeCards(), { registries: RIG });
    // Leaves are in the fixture's own order — the tree no longer re-sorts them
    // (see the sort-control test below); groups are alphabetical.
    assert.deepStrictEqual(labels(nodes), [
      'primary',
      '  playbooks/ci/release',
      '    cut-release',
      '  rules',
      '    quality-core',
      '  skills',
      '    grim-usage',
      '    ai-config',
      'acme',
      '  mcp',
      '    postgres-mcp',
    ]);
  });

  test('leaves follow the sort control; groups stay alphabetical', () => {
    const skills = (filter: CardFilter): string[] => {
      const nodes = buildTree(filterCards(treeCards(), filter), { registries: RIG });
      const roots = nodes.map((n) => n.label);
      assert.deepStrictEqual(roots, ['primary', 'acme'], 'group order is the strategy-free one');
      return nodes[0]?.children.find((n) => n.label === 'skills')?.children.map((n) => n.label) ?? [];
    };
    assert.deepStrictEqual(skills({ ...DEFAULT_FILTER, sort: 'name', dir: 'asc' }), [
      'ai-config',
      'grim-usage',
    ]);
    assert.deepStrictEqual(
      skills({ ...DEFAULT_FILTER, sort: 'name', dir: 'desc' }),
      ['grim-usage', 'ai-config'],
      'a reversed strategy reaches the leaves too — the tree used to swallow it',
    );
  });

  test('the namespace directly above a package is never absorbed', () => {
    const folded = buildTree(treeCards(), { registries: RIG })[0]?.children[0];
    assert.strictEqual(folded?.label, 'playbooks/ci/release');
    assert.strictEqual(folded.children[0]?.label, 'cut-release', 'the leaf keeps its own row');
    assert.strictEqual(folded.children[0]?.card?.repo.endsWith('cut-release'), true);
  });

  test('a single registry elides its root row', () => {
    const single = treeCards().filter((c) => c.registryHost === 'ghcr.io');
    assert.deepStrictEqual(
      buildTree(single, { registries: RIG }).map((n) => n.label),
      ['playbooks/ci/release', 'rules', 'skills'],
    );
  });

  test('without configured registries the bare host is the root', () => {
    assert.deepStrictEqual(
      buildTree(treeCards(), {}).map((n) => n.label),
      ['ghcr.io', 'registry.acme.dev'],
    );
  });

  test('group ids are alias-rooted paths; a leaf keys on its repo', () => {
    const root = buildTree(treeCards(), { registries: RIG })[0];
    assert.strictEqual(root?.id, 'primary', 'the alias is the root id');
    const folded = root?.children[0];
    assert.strictEqual(folded?.id, 'primary/playbooks/ci/release');
    assert.strictEqual(
      folded?.children[0]?.id,
      'ghcr.io/grimoire-rs/playbooks/ci/release/cut-release',
      'the leaf id is the repo itself',
    );
  });

  test('an index root keeps each row’s FULL reference as its path', () => {
    // grim's own split: strip the longest configured locator that prefixes the
    // reference, and when none does, an ATTRIBUTED row keeps the whole thing —
    // one index serves several hosts, so the host is information under it.
    const registries: RegistryVM[] = [
      { alias: 'hub', oci: 'https://index.grimoire.rs', kind: 'index', isDefault: true },
    ];
    const source = { alias: 'hub', locator: 'https://index.grimoire.rs' };
    const cards = buildCards(
      [
        searchItem({ repo: 'ghcr.io/michael-herwig/arcana/hex', source }),
        searchItem({ repo: 'quay.io/other/skills/tidy', source }),
      ],
      [],
    );
    // Single root, so it elides — its children are what render.
    assert.deepStrictEqual(labels(buildTree(cards, { registries })), [
      'ghcr.io/michael-herwig/arcana',
      '  hex',
      'quay.io/other/skills',
      '  tidy',
    ]);
  });

  // The reported bug: adding a browse filter to a second entry on an index that
  // another entry already carries in full made that registry vanish from Browse
  // — every one of its rows was a duplicate repo, and the old per-repo dedupe
  // ate them all. grim's TUI showed both roots the whole time.
  test('a filtered entry keeps its own root when a full entry serves the same repos', () => {
    const registries: RegistryVM[] = [
      { alias: 'full', oci: INDEX, kind: 'index', isDefault: true },
      { alias: 'mine', oci: INDEX, kind: 'index', isDefault: false },
    ];
    const repo = 'ghcr.io/michael-herwig/arcana/hex';
    const cards = buildCards(
      [
        searchItem({ repo, source: { alias: 'full', locator: INDEX } }),
        searchItem({ repo: 'ghcr.io/grimoire-rs/skills/grim-usage', source: { alias: 'full', locator: INDEX } }),
        searchItem({ repo, source: { alias: 'mine', locator: INDEX } }),
      ],
      [],
    );
    assert.deepStrictEqual(labels(buildTree(cards, { registries })), [
      'full',
      '  ghcr.io',
      '    grimoire-rs/skills',
      '      grim-usage',
      '    michael-herwig/arcana',
      '      hex',
      'mine',
      '  ghcr.io/michael-herwig/arcana',
      '    hex',
    ]);
  });

  test('a configured oci prefix is still stripped under a source-rooted node', () => {
    // Attribution names the ROOT; the path below it is the prefix-stripped
    // remainder whenever some configured entry does prefix the reference.
    const registries: RegistryVM[] = [
      { alias: 'primary', oci: 'ghcr.io/grimoire-rs', kind: 'registry', isDefault: true },
      { alias: 'hub', oci: 'https://index.grimoire.rs', kind: 'index', isDefault: false },
    ];
    const cards = buildCards(
      [
        searchItem({ source: { alias: 'hub', locator: 'https://index.grimoire.rs' } }),
        searchItem({
          repo: 'ghcr.io/grimoire-rs/rules/quality-core',
          kind: 'rule',
          source: { alias: 'hub', locator: 'https://index.grimoire.rs' },
        }),
      ],
      [],
    );
    const nodes = buildTree(cards, { registries });
    assert.deepStrictEqual(labels(nodes), ['rules', '  quality-core', 'skills', '  grim-usage']);
  });

  test('counts are leaf counts, and every group id is collectable', () => {
    const nodes = buildTree(treeCards(), { registries: RIG });
    assert.strictEqual(nodes[0]?.count, 4, 'four artifacts under the primary registry');
    assert.deepStrictEqual(topLevelIds(nodes), ['primary', 'acme']);
    assert.strictEqual(
      collectNodeIds(nodes).length,
      6,
      'two registry roots + three namespaces under primary + one under acme',
    );
  });
});

suite('view options', () => {
  test('the group toggle cycles per tab and wraps', () => {
    assert.strictEqual(cycleGroup('browse', 'none'), 'registry');
    assert.strictEqual(cycleGroup('browse', 'registry'), 'none');
    assert.strictEqual(cycleGroup('installed', 'scope'), 'none');
    assert.strictEqual(cycleGroup('installed', 'none'), 'scope');
    assert.strictEqual(cycleGroup('updates', 'none'), 'none', 'Updates never groups');
  });

  test('each tab reads its own key; Updates always reads none', () => {
    const view = { ...DEFAULT_VIEW, browseGroup: 'registry' as const };
    assert.strictEqual(groupKeyFor('browse', view), 'registry');
    assert.strictEqual(groupKeyFor('installed', view), 'scope');
    assert.strictEqual(groupKeyFor('updates', view), 'none');
  });

  test('installedCards keeps both scopes — no slice behind a toggle', () => {
    const items = buildCards([searchItem()], [installedScope('global')]);
    const state = sidebarState({ mode: 'installed', items });
    assert.strictEqual(installedCards(state, DEFAULT_FILTER).length, 1);
  });
});

suite('support channels', () => {
  test('readSupport normalizes an absent object into four nulls', () => {
    assert.deepStrictEqual(readSupport(undefined), {
      issues: null,
      chat: null,
      contact: null,
      security: null,
    });
  });

  test('readSupport passes real channel values straight through', () => {
    assert.deepStrictEqual(
      readSupport({
        issues: 'https://github.com/grimoire-rs/grimoire/issues',
        chat: null,
        contact: 'ai-platform@example.invalid',
        security: null,
      }),
      {
        issues: 'https://github.com/grimoire-rs/grimoire/issues',
        chat: null,
        contact: 'ai-platform@example.invalid',
        security: null,
      },
    );
  });

  test('contactUrl wraps a bare address in mailto:', () => {
    // The rig's real value — grim publishes what the maintainer authored, and
    // an address is the common shape.
    assert.strictEqual(
      contactUrl('ai-platform@example.invalid'),
      'mailto:ai-platform@example.invalid',
    );
    assert.strictEqual(contactUrl('  ai-platform@example.invalid  '), 'mailto:ai-platform@example.invalid');
  });

  test('contactUrl keeps an already-schemed value verbatim', () => {
    assert.strictEqual(contactUrl('https://acme.example/support'), 'https://acme.example/support');
    assert.strictEqual(contactUrl('mailto:team@acme.example'), 'mailto:team@acme.example');
  });

  test('contactUrl refuses to invent a scheme for arbitrary text', () => {
    // The handover's explicit rule: no scheme AND no address shape -> plain
    // text, never a guessed mailto:.
    for (const value of [
      'Ask in #platform',
      'the platform team',
      '',
      '   ',
      'a@b',
      'two@addresses@here.example',
      'spaced address@acme.example',
    ]) {
      assert.strictEqual(contactUrl(value), null, `must not link ${JSON.stringify(value)}`);
    }
  });

  test('isOpenableUrl admits web links and address-shaped mailto only', () => {
    assert.ok(isOpenableUrl('https://acme.example'));
    assert.ok(isOpenableUrl('http://acme.example'));
    assert.ok(isOpenableUrl('mailto:team@acme.example'));
    assert.ok(!isOpenableUrl('mailto:not an address'));
    assert.ok(!isOpenableUrl('mailto:'));
  });

  test('isOpenableUrl refuses script and file schemes at the host boundary', () => {
    // The webview posts these; the host is the gate. A mailto: carrying header
    // injection is refused here even though contactUrl would never have made it.
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'vscode://extension/evil',
      'mailto:a@b.example%0ABcc:victim@example.com',
      // `?` opens the mailto header list — `?bcc=`/`?body=` are a prefilled
      // draft the viewer did not write, so an address carrying one is refused.
      'mailto:a@b.example?subject=x',
      'mailto:a@b.example?bcc=victim',
      'mailto:a@b.example#frag',
    ]) {
      assert.ok(!isOpenableUrl(url), `must refuse ${url}`);
    }
  });
});
