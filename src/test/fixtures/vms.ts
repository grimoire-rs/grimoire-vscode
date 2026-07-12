// View-model fixture builders (ported 1:1 from src/test/render.test.ts, see
// the spec's parity-goldens addendum) plus the golden-case matrix that drives
// both stages: the pre-migration capture script runs goldenCases() against
// today's string-based render.ts, and post-migration parity.test.ts runs the
// SAME cases against the lit-html render.ts. Exported so both can import one
// source of truth for "what to render" instead of drifting.
import {
  buildCards,
  DEFAULT_FILTER,
  type ScopeStatus,
  type WireSearchItem,
} from '../../webview/model';
import type { CardVM, DetailsVM, InstallVM, SidebarState } from '../../webview/protocol';

export function searchItem(overrides: Partial<WireSearchItem> = {}): WireSearchItem {
  return {
    kind: 'skill',
    repo: 'ghcr.io/grimoire-rs/skills/grim-usage',
    summary: null,
    description: 'Drive the grim CLI.',
    version: '1.5.0',
    latest_tag: null,
    repository: null,
    revision: null,
    created: null,
    deprecated: null,
    status: 'not-installed',
    ...overrides,
  };
}

export function card(overrides: Partial<CardVM> = {}): CardVM {
  return {
    repo: 'ghcr.io/grimoire-rs/skills/grim-usage',
    name: 'grim-usage',
    kind: 'skill',
    description: 'Drive the grim CLI.',
    registryHost: 'ghcr.io',
    latestVersion: '1.5.0',
    state: 'not-installed',
    deprecated: null,
    replacedBy: null,
    installs: [],
    ...overrides,
  };
}

export function sidebarState(overrides: Partial<SidebarState> = {}): SidebarState {
  const now = Date.now();
  return {
    phase: 'ready',
    mode: 'browse',
    query: '',
    items: [],
    installedItems: [],
    scopes: { projectOpen: true, projectConfigured: true, projectName: 'my-app' },
    registries: [],
    syncedAt: now - 12 * 60_000,
    now,
    ...overrides,
  };
}

export function detailsVM(overrides: Partial<DetailsVM> = {}): DetailsVM {
  return {
    repo: 'ghcr.io/grimoire-rs/skills/grim-usage',
    ref: 'ghcr.io/grimoire-rs/skills/grim-usage:latest',
    name: 'grim-usage',
    kind: 'skill',
    registryHost: 'ghcr.io',
    description: 'Drive the grim CLI.',
    latestVersion: '1.5.0',
    state: 'not-installed',
    deprecated: null,
    replacedBy: null,
    installs: [],
    scopes: { projectOpen: true, projectConfigured: true, projectName: 'my-app' },
    contentMarkdown: '# Body',
    contentJson: null,
    readmeMarkdown: null,
    changelogMarkdown: null,
    members: [],
    tags: ['latest', '1.5.0'],
    published: '2026-06-28T00:00:00Z',
    revision: '9f3c1e2abcdef',
    digest: 'sha256:c6ed',
    sourceRepository: 'https://github.com/grimoire-rs/grimoire',
    license: 'Apache-2.0',
    keywords: ['cli', 'oci'],
    logoUri: null,
    busy: null,
    error: null,
    ...overrides,
  };
}

/** One installed skill in `scope` (render.test.ts's inline `installedScope`). */
export function installedScope(scope: 'project' | 'global'): ScopeStatus {
  return {
    scope,
    status: [
      {
        kind: 'skill',
        name: 'grim-usage',
        source: 'direct',
        pinned: 'ghcr.io/grimoire-rs/skills/grim-usage@sha256:abc',
        state: 'installed',
        outputs: [{ client: 'claude', path: '/x' }],
      },
    ],
    declared: { 'grim-usage': 'ghcr.io/grimoire-rs/skills/grim-usage:1.5.0' },
  };
}

/** One installed-row entry for `scope` (render.test.ts's inline `bothInstalled`),
 *  used to build a details VM with the same artifact installed in both scopes. */
export function bothInstalled(scope: 'project' | 'global'): InstallVM {
  return {
    scope,
    version: '1.5.0',
    updateAvailable: false,
    clients: [],
    state: 'installed',
    kind: 'skill',
    name: 'grim-usage',
    viaBundles: [],
  };
}

export interface GoldenCase {
  name: string;
  out: unknown;
}

/** The parity matrix: every exported render function, across the state/variant
 *  combinations called out in the migration spec. `r` is whichever render
 *  module is under test — today the string-based module (goldenCases feeds the
 *  capture script), later the lit-html module (goldenCases feeds parity.test.ts)
 *  — so this list is the single definition of "what must stay identical". */
export function goldenCases(r: typeof import('../../webview/render')): GoldenCase[] {
  const cases: GoldenCase[] = [];
  const add = (name: string, out: unknown): void => {
    cases.push({ name, out });
  };

  const projectInstall: InstallVM = {
    scope: 'project',
    version: '1.5.0',
    updateAvailable: false,
    clients: ['claude'],
    state: 'installed',
    kind: 'skill',
    name: 'grim-usage',
    viaBundles: [],
  };
  const globalInstall: InstallVM = {
    ...projectInstall,
    scope: 'global',
    clients: ['claude', 'copilot'],
  };
  const outdatedInstall: InstallVM = {
    scope: 'project',
    version: '1.4.0',
    updateAvailable: true,
    clients: ['claude'],
    state: 'outdated',
    kind: 'skill',
    name: 'grim-usage',
    viaBundles: [],
  };

  // --- renderCard: browse/updates/scope variants across the state matrix ---
  add('card-browse-fresh', r.renderCard(card()));
  add(
    'card-browse-installed',
    r.renderCard(card({ state: 'installed', installs: [projectInstall] })),
  );
  add(
    'card-browse-outdated',
    r.renderCard(
      card({ state: 'outdated', installs: [outdatedInstall], latestVersion: '1.5.0' }),
    ),
  );
  add(
    'card-browse-deprecated',
    r.renderCard(card({ state: 'deprecated', deprecated: 'Use new-skill instead.' })),
  );
  add(
    'card-browse-private-registry',
    r.renderCard(card({ privateRegistry: true })),
  );
  add(
    'card-browse-logo-uri',
    r.renderCard(card({ logoUri: 'data:image/png;base64,AAAA' })),
  );
  add(
    'card-updates-basic',
    r.renderCard(
      card({ state: 'outdated', installs: [outdatedInstall], latestVersion: '1.5.0' }),
      { variant: 'updates' },
    ),
  );
  add(
    'card-updates-floating-tag',
    r.renderCard(
      card({
        state: 'outdated',
        installs: [{ ...outdatedInstall, floating: true }],
        latestVersion: '1.5.0',
      }),
      { variant: 'updates' },
    ),
  );
  add(
    'card-scope-project',
    r.renderCard(card({ state: 'installed', installs: [projectInstall] }), {
      variant: 'scope',
      scope: 'project',
    }),
  );
  add(
    'card-scope-global-bundle',
    r.renderCard(
      card({
        kind: 'bundle',
        state: 'deprecated',
        deprecated: 'Use new-bundle instead.',
        installs: [projectInstall, globalInstall],
      }),
      { variant: 'scope', scope: 'global' },
    ),
  );

  // --- card menus: gear (installed) + right-click context menu ---
  add(
    'card-menu-project-open',
    r.renderCardMenu(card({ state: 'installed', installs: [projectInstall] }), true),
  );
  add(
    'card-menu-project-closed',
    r.renderCardMenu(card({ state: 'installed', installs: [globalInstall] }), false),
  );
  add(
    'card-menu-both-scopes',
    r.renderCardMenu(
      card({ state: 'installed', installs: [projectInstall, globalInstall] }),
      true,
    ),
  );
  add(
    'card-context-menu-project-open',
    r.renderCardContextMenu(card({ state: 'installed', installs: [projectInstall] }), true),
  );
  add(
    'card-context-menu-project-closed',
    r.renderCardContextMenu(card({ state: 'installed', installs: [globalInstall] }), false),
  );

  // --- search row: per mode, empty in no-grim/Updates ---
  add('search-row-browse', r.renderSidebarSearch(sidebarState()));
  add('search-row-installed', r.renderSidebarSearch(sidebarState({ mode: 'installed' })));
  add('search-row-updates-empty', r.renderSidebarSearch(sidebarState({ mode: 'updates' })));
  add('search-row-no-grim-empty', r.renderSidebarSearch(sidebarState({ phase: 'no-grim' })));

  // --- filters: browse/installed/updates, scope-chip disabled, phase-gated ---
  add('filters-browse', r.renderSidebarFilters(sidebarState(), DEFAULT_FILTER));
  add(
    'filters-installed',
    r.renderSidebarFilters(sidebarState({ mode: 'installed' }), DEFAULT_FILTER),
  );
  add(
    'filters-installed-scope-disabled',
    r.renderSidebarFilters(
      sidebarState({
        mode: 'installed',
        scopes: { projectOpen: false, projectConfigured: false, projectName: null },
      }),
      DEFAULT_FILTER,
    ),
  );
  add(
    'filters-updates-empty',
    r.renderSidebarFilters(sidebarState({ mode: 'updates' }), DEFAULT_FILTER),
  );
  add(
    'filters-loading-empty',
    r.renderSidebarFilters(sidebarState({ phase: 'loading' }), DEFAULT_FILTER),
  );
  add(
    'filters-error-empty',
    r.renderSidebarFilters(sidebarState({ phase: 'error' }), DEFAULT_FILTER),
  );
  add(
    'filters-no-grim-empty',
    r.renderSidebarFilters(sidebarState({ phase: 'no-grim' }), DEFAULT_FILTER),
  );

  // --- results: every phase, browse empty/full, installed/updates empty, init banner ---
  add(
    'results-loading-with-default-registry',
    r.renderSidebarResults(
      sidebarState({ phase: 'loading', mode: 'installed', defaultRegistry: 'ghcr.io' }),
      DEFAULT_FILTER,
    ),
  );
  add(
    'results-loading-no-default-registry',
    r.renderSidebarResults(sidebarState({ phase: 'loading' }), DEFAULT_FILTER),
  );
  add(
    'results-error',
    r.renderSidebarResults(
      sidebarState({ phase: 'error', error: 'grim exited with status 1' }),
      DEFAULT_FILTER,
    ),
  );
  add(
    'results-no-grim',
    r.renderSidebarResults(sidebarState({ phase: 'no-grim' }), DEFAULT_FILTER),
  );
  add(
    'results-browse-ready-empty',
    r.renderSidebarResults(sidebarState({ items: [] }), DEFAULT_FILTER),
  );
  add(
    'results-browse-ready-with-cards',
    r.renderSidebarResults(
      sidebarState({ items: buildCards([searchItem()], []) }),
      DEFAULT_FILTER,
    ),
  );
  add(
    'results-installed-init-banner',
    r.renderSidebarResults(
      sidebarState({
        mode: 'installed',
        items: buildCards([searchItem()], []),
        scopes: { projectOpen: true, projectConfigured: false, projectName: null },
      }),
      { ...DEFAULT_FILTER, scope: 'project' },
    ),
  );
  add(
    'results-installed-empty-project',
    r.renderSidebarResults(sidebarState({ mode: 'installed', items: [] }), DEFAULT_FILTER),
  );
  add(
    'results-installed-empty-global',
    r.renderSidebarResults(sidebarState({ mode: 'installed', items: [] }), {
      ...DEFAULT_FILTER,
      scope: 'global',
    }),
  );
  add(
    'results-updates-empty',
    r.renderSidebarResults(sidebarState({ mode: 'updates', items: [] }), DEFAULT_FILTER),
  );

  // --- tab bar (merged single view) ---
  add('tabs-browse-active', r.renderSidebarTabs(sidebarState()));
  add(
    'tabs-updates-active-with-count',
    r.renderSidebarTabs(
      sidebarState({
        mode: 'updates',
        installedItems: buildCards([searchItem()], []).map((c) => ({
          ...c,
          state: 'outdated' as const,
        })),
      }),
    ),
  );
  add('tabs-no-grim-empty', r.renderSidebarTabs(sidebarState({ phase: 'no-grim' })));

  // --- footer + standalone refreshing footer ---
  add(
    'footer-ready',
    r.renderSidebarFooter(sidebarState({ items: buildCards([searchItem()], []) })),
  );
  add('footer-error', r.renderSidebarFooter(sidebarState({ phase: 'error', error: 'boom' })));
  add('footer-loading-empty', r.renderSidebarFooter(sidebarState({ phase: 'loading' })));
  add('refreshing-footer-with-host', r.renderRefreshingFooter('ghcr.io'));
  add('refreshing-footer-null', r.renderRefreshingFooter(null));

  // --- renderSidebar: the five regions composed ---
  add(
    'sidebar-composed-browse',
    r.renderSidebar(sidebarState({ items: buildCards([searchItem()], []) }), DEFAULT_FILTER),
  );

  // --- details: full skill, mcp, bundle, deprecated, both-scopes, busy/error,
  //     preview, skeleton/loading, logo ---
  add(
    'details-full-skill',
    r.renderDetails(
      detailsVM({
        state: 'installed',
        readmeMarkdown: '# Readme',
        changelogMarkdown: '# 1.0.0',
        tags: ['latest', '1.5.0', '1.4.0', '1.3.0', '1.2.0', '1.1.0', '1.0.0'],
        installs: [projectInstall],
      }),
    ),
  );
  add(
    'details-mcp-contentjson',
    r.renderDetails(
      detailsVM({
        kind: 'mcp',
        contentMarkdown: null,
        contentJson: JSON.stringify({ command: 'npx', args: ['-y', 'grim-mcp'] }, null, 2),
      }),
    ),
  );
  add(
    'details-bundle-members',
    r.renderDetails(
      detailsVM({
        kind: 'bundle',
        contentMarkdown: null,
        contentJson: JSON.stringify({ members: ['grim-usage', 'mystery'] }, null, 2),
        members: [
          {
            kind: 'skill',
            name: 'grim-usage',
            id: '../skills/grim-usage:1',
            version: '1',
            repo: 'ghcr.io/grimoire-rs/skills/grim-usage',
            description: 'Drive the grim CLI.',
          },
          { kind: 'rule', name: 'mystery', id: '', version: null, repo: null, description: null },
        ],
      }),
    ),
  );
  add(
    'details-deprecated-replacedby',
    r.renderDetails(
      detailsVM({
        state: 'deprecated',
        deprecated: 'Renamed.',
        replacedBy: 'ghcr.io/grimoire-rs/skills/new-skill',
      }),
    ),
  );
  add(
    'details-both-scopes-installed',
    r.renderDetails(
      detailsVM({
        state: 'installed',
        installs: [bothInstalled('project'), bothInstalled('global')],
      }),
    ),
  );
  add('details-busy', r.renderDetails(detailsVM({ busy: 'Installing…' })));
  add('details-error', r.renderDetails(detailsVM({ error: 'grim exited with status 1' })));
  add('details-preview-true', r.renderDetails(detailsVM({ isPreview: true })));
  add('details-preview-false', r.renderDetails(detailsVM({ isPreview: false })));
  add(
    'details-skeleton-loading',
    r.renderDetails(detailsVM({ loading: true, scopesPending: true })),
  );
  add(
    'details-loading-cached-installs',
    r.renderDetails(
      detailsVM({
        loading: true,
        installs: [
          {
            scope: 'global',
            version: '1.5.0',
            updateAvailable: false,
            clients: ['claude'],
            state: 'installed',
            kind: 'skill',
            name: 'grim-usage',
            viaBundles: [],
          },
        ],
      }),
    ),
  );
  add(
    'details-logo-uri',
    r.renderDetails(detailsVM({ logoUri: 'data:image/png;base64,AAAA' })),
  );

  // --- revalidate indicator: every state + null ---
  add('revalidate-checking', r.revalidateIndicator('checking'));
  add('revalidate-done', r.revalidateIndicator('done'));
  add(
    'revalidate-failed',
    r.revalidateIndicator('failed', 'Refresh failed: network error'),
  );
  add('revalidate-null', r.revalidateIndicator(null));

  return cases;
}
