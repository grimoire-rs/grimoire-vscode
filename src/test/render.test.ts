import * as assert from 'assert';
import { buildCards, DEFAULT_FILTER, type ScopeStatus } from '../webview/model';
import { createMarkdown } from '../webview/markdown';
import {
  esc,
  formatDate,
  highlightJson,
  kindIcon,
  renderCard,
  renderCardContextMenu,
  renderCardMenu,
  renderDetails,
  renderRefreshingFooter,
  renderSidebar,
  renderSidebarFilters,
  renderSidebarFooter,
  renderSidebarNotice,
  renderSidebarResults,
  renderSidebarSearch,
  renderSidebarTabs,
  revalidateIndicator,
} from '../webview/render';
import { litString } from './litString';
import { normalizeHtml } from './normalizeHtml';
import { bothInstalled, card, detailsVM, installedScope, searchItem, sidebarState } from './fixtures/vms';

/** Renders a lit template (or the `nothing` sentinel) to its normalized-HTML
 *  string form so the `.includes`/regex/indexOf assertions below can run
 *  against it exactly like they did against the old string-render output
 *  (spec Addendum item 8) — normalizeHtml strips lit's part-marker comments,
 *  collapses whitespace, and sorts each tag's attributes alphabetically. */
async function litHtml(out: unknown): Promise<string> {
  return normalizeHtml(await litString(out));
}

suite('escaping', () => {
  test('esc neutralizes HTML', () => {
    assert.strictEqual(
      esc('<img src=x onerror="alert(1)">&\''),
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;',
    );
  });

  test('hostile artifact name stays inert in card HTML', async () => {
    const html = await litHtml(
      renderCard(card({ name: '<script>alert(1)</script>', description: '<b>x</b>' })),
    );
    assert.ok(!html.includes('<script>alert(1)'));
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'));
  });

  test('hostile repo stays inert in attributes', async () => {
    const html = await litHtml(renderCard(card({ repo: '"><script>x</script>' })));
    assert.ok(!html.includes('"><script>'));
  });

  test('a hostile registry-sourced replacedBy ref stays escaped in the card switch-to-replacement link', async () => {
    const hostile = '"><script>alert(1)</script>';
    const html = await litHtml(
      renderCard(card({ state: 'deprecated', deprecated: 'use x instead', replacedBy: hostile })),
    );
    assert.ok(!html.includes('"><script>'));
    const escaped = '&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;';
    assert.ok(html.includes(`data-repo="${escaped}"`), 'attribute position stays escaped');
    assert.ok(html.includes(`>${escaped}</a>`), 'text-content position stays escaped');
  });

  test('a hostile replacedBy stays escaped in the card-menu Switch entry (label + data)', async () => {
    const hostile = '"><script>alert(1)</script>';
    const html = await litHtml(
      renderCardMenu(
        card({
          state: 'deprecated',
          deprecated: 'gone',
          replacedBy: hostile,
          installs: [
            {
              scope: 'global',
              version: '1',
              updateAvailable: false,
              clients: [],
              state: 'installed',
              kind: 'skill',
              name: 'grim-usage',
              viaBundles: [],
            },
          ],
        }),
        true,
      ),
    );
    assert.ok(!html.includes('"><script>'));
    const escaped = '&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;';
    assert.ok(html.includes(`data-replaced-by="${escaped}"`), 'attribute position stays escaped');
    assert.ok(html.includes(`Switch to ${escaped}`), 'label position stays escaped');
  });
});

suite('card rendering', () => {
  test('codicon per kind', () => {
    assert.strictEqual(kindIcon('skill'), 'sparkle');
    assert.strictEqual(kindIcon('rule'), 'law');
    assert.strictEqual(kindIcon('agent'), 'hubot');
    assert.strictEqual(kindIcon('mcp'), 'plug');
    assert.strictEqual(kindIcon('bundle'), 'package');
    assert.strictEqual(kindIcon(null), 'question');
  });

  test('not-installed card has Install button and badge', async () => {
    const html = await litHtml(renderCard(card()));
    assert.ok(html.includes('data-action="install"'));
    assert.ok(html.includes('kind-badge'));
    assert.ok(html.includes('SKILL'));
    assert.ok(html.includes('ghcr.io'));
  });

  test('not-installed Install button is a split button with a menu chevron', async () => {
    const html = await litHtml(renderCard(card()));
    assert.ok(html.includes('split-button'));
    assert.ok(html.includes('class="split-main" data-action="install"'));
    assert.ok(html.includes('class="split-arrow" data-action="menu"'));
    assert.ok(html.includes('codicon-chevron-down'));
  });

  test('deprecated card demotes to a single secondary Install (no split chevron)', async () => {
    const html = await litHtml(renderCard(card({ state: 'deprecated', deprecated: 'use x instead' })));
    assert.ok(html.includes('class="card-btn secondary" data-action="install"'), 'native secondary button');
    assert.ok(!html.includes('split-arrow'), 'no split chevron on deprecated cards');
    assert.ok(!html.includes('codicon-chevron-down'));
  });

  test('private-registry card renders a lock before host + org (item 8/9)', async () => {
    const html = await litHtml(
      renderCard(
        card({ privateRegistry: true, repo: 'harbor.internal.acme.io/acme/agents/pr-reviewer' }),
      ),
    );
    assert.ok(html.includes('codicon-lock'), 'lock glyph present');
    assert.ok(html.includes('harbor.internal.acme.io/acme'), 'host + first org segment');
  });

  test('public-registry card has no lock and shows host + org (item 9)', async () => {
    const html = await litHtml(renderCard(card()));
    assert.ok(!html.includes('codicon-lock'), 'no lock on a public registry');
    assert.ok(html.includes('ghcr.io/grimoire-rs'), 'registry meta shows host + first org');
  });

  test('outdated card shows update action and version delta', async () => {
    const html = await litHtml(
      renderCard(
        card({
          state: 'outdated',
          installs: [
            {
              scope: 'project',
              version: '1.4.2',
              updateAvailable: true,
              clients: ['claude'],
              state: 'outdated',
              kind: 'skill',
              name: 'grim-usage',
              viaBundles: [],
            },
          ],
        }),
      ),
    );
    assert.ok(html.includes('class="card-btn" data-action="update"'), 'native card button, not a web component');
    assert.ok(html.includes('→ 1.5.0'));
  });

  test('installed browse card shows the design-2b installed box chip + gear', async () => {
    const html = await litHtml(
      renderCard(
        card({
          state: 'installed',
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
    assert.ok(html.includes('installed-chip'));
    assert.ok(html.includes('installed-chip-check'), 'leading check on the installed chip (item 10)');
    assert.ok(html.includes('codicon-globe')); // global scope icon
    assert.ok(html.includes('Global'));
    assert.ok(!html.includes('installed-chip-version'), 'chip is scope-only, no version (user)');
    assert.ok(html.includes('data-action="menu"')); // gear beside the chip
    assert.ok(!html.includes('client-chip'), 'browse cards carry no chips');
  });

  test('installed chip shows the effective scope (project shadows global)', async () => {
    const html = await litHtml(
      renderCard(
        card({
          state: 'installed',
          installs: [
            {
              scope: 'global',
              version: '1.5.0',
              updateAvailable: false,
              clients: [],
              state: 'installed',
              kind: 'skill',
              name: 'grim-usage',
              viaBundles: [],
            },
            {
              scope: 'project',
              version: '1.4.2',
              updateAvailable: false,
              clients: [],
              state: 'installed',
              kind: 'skill',
              name: 'grim-usage',
              viaBundles: [],
            },
          ],
        }),
      ),
    );
    assert.ok(html.includes('codicon-root-folder')); // project icon wins
    assert.ok(!html.includes('1.4.2'), 'chip carries no version (user)');
    assert.ok(!html.includes('codicon-globe'), 'one chip only — the effective scope');
  });

  test('installed chip never renders the install version, hostile or not', async () => {
    const html = await litHtml(
      renderCard(
        card({
          state: 'installed',
          installs: [
            {
              scope: 'global',
              version: '"><img src=x onerror=alert(1)>',
              updateAvailable: false,
              clients: [],
              state: 'installed',
              kind: 'skill',
              name: 'grim-usage',
              viaBundles: [],
            },
          ],
        }),
      ),
    );
    assert.ok(!html.includes('<img src=x'));
    assert.ok(!html.includes('&lt;img src=x'), 'version is dropped entirely, not just escaped');
  });

  test('kind tint classes on tile and badge', async () => {
    const html = await litHtml(renderCard(card({ kind: 'bundle' })));
    assert.ok(html.includes('kind-tile kind-bundle'));
    assert.ok(html.includes('kind-badge kind-bundle'));
    assert.ok(html.includes('codicon-package'));
  });

  test('card renders the cached logo image instead of the codicon tile', async () => {
    const html = await litHtml(renderCard(card({ logoUri: 'data:image/png;base64,QUJD' })));
    assert.ok(html.includes('class="card-logo"'));
    assert.ok(html.includes('src="data:image/png;base64,QUJD"'));
    assert.ok(html.includes('has-logo'));
    assert.ok(!html.includes('codicon-sparkle'), 'no codicon glyph when a logo shows');
  });

  test('card without a logo falls back to the codicon tile', async () => {
    const html = await litHtml(renderCard(card()));
    assert.ok(!html.includes('card-logo'));
    assert.ok(html.includes('kind-tile'));
    assert.ok(html.includes('codicon-sparkle'));
  });

  test('a hostile logo URI stays inert in the img src', async () => {
    const html = await litHtml(renderCard(card({ logoUri: '"><script>alert(1)</script>' })));
    assert.ok(!html.includes('"><script>'));
    assert.ok(html.includes('&quot;&gt;&lt;script&gt;'), 'the data URI is attr-escaped');
  });

  test('updates-variant card shows version delta and update button', async () => {
    const html = await litHtml(
      renderCard(
        card({
          state: 'outdated',
          installs: [
            {
              scope: 'project',
              version: '1.4.2',
              updateAvailable: true,
              clients: ['claude', 'opencode'],
              state: 'outdated',
              kind: 'skill',
              name: 'grim-usage',
              viaBundles: [],
            },
          ],
        }),
        { variant: 'updates' },
      ),
    );
    assert.ok(html.includes('card-delta'));
    assert.ok(html.includes('1.4.2'));
    assert.ok(html.includes('delta-to'));
    assert.ok(html.includes('Project · claude, opencode'));
    assert.ok(html.includes('data-action="update"'));
    assert.ok(!html.includes('floating-note'), 'pinned install carries no floating note');
  });

  test('updates-variant floating install shows a muted floating-tag note (item 18)', async () => {
    const html = await litHtml(
      renderCard(
        card({
          state: 'outdated',
          installs: [
            {
              scope: 'project',
              version: '1',
              updateAvailable: true,
              clients: [],
              state: 'outdated',
              kind: 'skill',
              name: 'grim-usage',
              viaBundles: [],
              floating: true,
            },
          ],
        }),
        { variant: 'updates' },
      ),
    );
    assert.ok(html.includes('floating-note'), 'floating install is flagged');
    assert.ok(html.includes('floating tag'));
  });

  test('scope-variant card shows client chips + check + gear', async () => {
    const html = await litHtml(
      renderCard(
        card({
          state: 'installed',
          installs: [
            {
              scope: 'project',
              version: '1.4.2',
              updateAvailable: false,
              clients: ['claude'],
              state: 'installed',
              kind: 'skill',
              name: 'grim-usage',
              viaBundles: [],
            },
          ],
        }),
        { variant: 'scope', scope: 'project' },
      ),
    );
    assert.ok(html.includes('client-chip'));
    assert.ok(html.includes('codicon-check'));
    assert.ok(html.includes('data-action="menu"'));
    assert.ok(!html.includes('drift-badge'), 'no drift on an install with no clients_missing/clients_extra');
  });

  test('scope-variant card shows a client-drift badge iff clients_missing/clients_extra is non-empty', async () => {
    const driftingInstall = {
      scope: 'project' as const,
      version: '1.4.2',
      updateAvailable: false,
      clients: ['claude'],
      state: 'installed',
      kind: 'skill',
      name: 'grim-usage',
      viaBundles: [],
      clientsMissing: ['opencode'],
      clientsExtra: ['copilot'],
    };
    const withDrift = await litHtml(
      renderCard(card({ state: 'installed', installs: [driftingInstall] }), {
        variant: 'scope',
        scope: 'project',
      }),
    );
    assert.ok(withDrift.includes('drift-badge'));
    assert.ok(withDrift.includes('Missing: opencode'), 'tooltip lists the missing client');
    assert.ok(withDrift.includes('Extra: copilot'), 'tooltip lists the extra client');

    const missingOnly = await litHtml(
      renderCard(
        card({
          state: 'installed',
          installs: [{ ...driftingInstall, clientsMissing: ['opencode'], clientsExtra: [] }],
        }),
        { variant: 'scope', scope: 'project' },
      ),
    );
    assert.ok(missingOnly.includes('drift-badge'));

    const noDrift = await litHtml(
      renderCard(
        card({
          state: 'installed',
          installs: [{ ...driftingInstall, clientsMissing: [], clientsExtra: [] }],
        }),
        { variant: 'scope', scope: 'project' },
      ),
    );
    assert.ok(!noDrift.includes('drift-badge'), 'empty arrays render no badge');
  });

  test('deprecated card struck through with warning', async () => {
    const html = await litHtml(renderCard(card({ state: 'deprecated', deprecated: 'use x instead' })));
    assert.ok(html.includes('class="card deprecated"'));
    assert.ok(html.includes('codicon-warning'));
    assert.ok(html.includes('use x instead'));
    assert.ok(!html.includes('data-action="open-details"'), 'no replacement link when replacedBy is null');
  });

  test('deprecated card with replacedBy gains a "use <replacedBy>" switch-to-replacement link', async () => {
    const html = await litHtml(
      renderCard(
        card({
          state: 'deprecated',
          deprecated: 'use x instead',
          replacedBy: 'ghcr.io/grimoire-rs/skills/new-skill',
        }),
      ),
    );
    assert.ok(html.includes('data-action="open-details"'));
    assert.ok(html.includes('data-repo="ghcr.io/grimoire-rs/skills/new-skill"'));
    assert.ok(html.includes('>ghcr.io/grimoire-rs/skills/new-skill<'));
    assert.ok(html.includes('use'), 'link copy names the replacement');
  });

  test('gear menu disables uninstall for a via-bundle install', async () => {
    const html = await litHtml(
      renderCardMenu(
        card({
          installs: [
            {
              scope: 'global',
              version: '1',
              updateAvailable: false,
              clients: [],
              state: 'installed',
              kind: 'skill',
              name: 'grim-usage',
              viaBundles: ['ghcr.io/grimoire-rs/bundles/grim-essentials'],
            },
          ],
        }),
        true,
      ),
    );
    assert.ok(html.includes('<button class="menu-item" disabled'));
    assert.ok(!html.includes('data-action="uninstall"'));
    assert.ok(html.includes('via grim-essentials')); // last path segment
    assert.ok(html.includes('ghcr.io/grimoire-rs/bundles/grim-essentials')); // full repo in tooltip
  });

  test('gear menu offers per-scope actions', async () => {
    const html = await litHtml(
      renderCardMenu(
        card({
          installs: [
            {
              scope: 'global',
              version: '1.2.0',
              updateAvailable: false,
              clients: [],
              state: 'installed',
              kind: 'skill',
              name: 'x',
              viaBundles: [],
            },
          ],
        }),
        true,
      ),
    );
    assert.ok(html.includes('Install in Project'));
    assert.ok(html.includes('Uninstall (Global)'));
    assert.ok(html.includes('Pin Version'));
    assert.ok(html.includes('Copy repo path'));
    assert.ok(!html.includes('Install Globally'));
    // No replacement → no Switch entry.
    assert.ok(!html.includes('data-action="switch"'));
  });

  test('gear menu adds a per-scope Switch entry for a deprecated install with a replacement', async () => {
    const html = await litHtml(
      renderCardMenu(
        card({
          state: 'deprecated',
          deprecated: 'Renamed.',
          replacedBy: 'ghcr.io/grimoire-rs/skills/new-skill',
          installs: [
            {
              scope: 'global',
              version: '1',
              updateAvailable: false,
              clients: [],
              state: 'installed',
              kind: 'skill',
              name: 'grim-usage',
              viaBundles: [],
            },
          ],
        }),
        true,
      ),
    );
    assert.ok(html.includes('data-action="switch"'));
    assert.ok(html.includes('Switch to ghcr.io/grimoire-rs/skills/new-skill (Global)'));
    assert.ok(html.includes('data-replaced-by="ghcr.io/grimoire-rs/skills/new-skill"'));
    assert.ok(html.includes('data-name="grim-usage"'));
    assert.ok(html.includes('data-scope="global"'));
  });

  test('gear menu omits Switch for a via-bundle install even with a replacement', async () => {
    const html = await litHtml(
      renderCardMenu(
        card({
          state: 'deprecated',
          deprecated: 'Renamed.',
          replacedBy: 'ghcr.io/grimoire-rs/skills/new-skill',
          installs: [
            {
              scope: 'global',
              version: '1',
              updateAvailable: false,
              clients: [],
              state: 'installed',
              kind: 'skill',
              name: 'grim-usage',
              viaBundles: ['ghcr.io/grimoire-rs/bundles/grim-essentials'],
            },
          ],
        }),
        true,
      ),
    );
    assert.ok(!html.includes('data-action="switch"'), 'a bundle-held row cannot be torn down');
  });

  test('context menu adds Open Details + Copy share link with wired actions', async () => {
    const html = await litHtml(renderCardContextMenu(card(), true));
    assert.ok(html.includes('card-context-menu'));
    assert.ok(html.includes('data-action="open-details"'));
    assert.ok(html.includes('Open Details'));
    assert.ok(html.includes('data-action="copy-share"'));
    assert.ok(html.includes('Copy share link'));
    assert.ok(html.includes('data-action="install" data-repo='));
  });

  test('context menu Update entry targets the outdated install', async () => {
    const html = await litHtml(
      renderCardContextMenu(
        card({
          state: 'outdated',
          installs: [
            {
              scope: 'project',
              version: '1.4.2',
              updateAvailable: true,
              clients: [],
              state: 'outdated',
              kind: 'skill',
              name: 'grim-usage',
              viaBundles: [],
            },
          ],
        }),
        true,
      ),
    );
    assert.ok(html.includes('data-action="update" data-kind="skill" data-name="grim-usage"'));
  });

  test('hostile repo stays inert in the context menu', async () => {
    const html = await litHtml(renderCardContextMenu(card({ repo: '"><script>x</script>' }), true));
    assert.ok(!html.includes('"><script>'));
    assert.ok(html.includes('&quot;&gt;&lt;script&gt;'));
  });
});

suite('sidebar rendering', () => {
  test('loading state renders progress bar and skeleton rows', async () => {
    const html = await litHtml(renderSidebar(sidebarState({ phase: 'loading' }), DEFAULT_FILTER));
    assert.ok(html.includes('vscode-progress-bar'));
    assert.ok(html.includes('skeleton-row'));
  });

  test('skeleton rows use varied line widths (item 12)', async () => {
    const html = await litHtml(renderSidebar(sidebarState({ phase: 'loading' }), DEFAULT_FILTER));
    // Widths differ per row instead of four identical 55/92/70 clones.
    for (const w of ['w55', 'w44', 'w60', 'w50']) {
      assert.ok(html.includes(w), `skeleton width ${w} present`);
    }
  });

  test('loading footer names the default registry (item 13)', async () => {
    const html = await litHtml(
      renderSidebar(
        sidebarState({ phase: 'loading', defaultRegistry: 'ghcr.io' }),
        DEFAULT_FILTER,
      ),
    );
    assert.ok(html.includes('Refreshing from ghcr.io'));
    assert.ok(html.includes('codicon-sync'));
    // Unknown default registry still shows a footer — plain "Refreshing…",
    // never "null" and never an empty swap (#38).
    const noHost = await litHtml(
      renderSidebar(sidebarState({ phase: 'loading' }), DEFAULT_FILTER),
    );
    assert.ok(!noHost.includes('Refreshing from'));
    assert.ok(noHost.includes('Refreshing…'));
  });

  test('loading footer host is escaped (no HTML injection)', async () => {
    const html = await litHtml(
      renderSidebar(
        sidebarState({ phase: 'loading', defaultRegistry: '<img src=x>' }),
        DEFAULT_FILTER,
      ),
    );
    assert.ok(!html.includes('<img src=x>'));
    assert.ok(html.includes('&lt;img src=x&gt;'));
  });

  test('no-grim state offers install', async () => {
    const html = await litHtml(renderSidebar(sidebarState({ phase: 'no-grim' }), DEFAULT_FILTER));
    assert.ok(html.includes('data-action="install-grim"'));
    assert.ok(html.includes('was not found'));
  });

  test('error state shows message', async () => {
    const html = await litHtml(
      renderSidebar(sidebarState({ phase: 'error', error: 'registry down' }), DEFAULT_FILTER),
    );
    assert.ok(html.includes('registry down'));
  });

  test('empty state offers clear + refresh', async () => {
    const html = await litHtml(
      renderSidebar(sidebarState({ query: 'quantum', items: [] }), DEFAULT_FILTER),
    );
    assert.ok(html.includes('No artifacts found'));
    assert.ok(html.includes('quantum'));
    assert.ok(html.includes('data-action="clear-search"'));
    assert.ok(html.includes('data-action="refresh"'));
  });

  test('ready state renders cards, filters, summary and the catalog footer', async () => {
    const items = buildCards([searchItem()], []);
    const html = await litHtml(renderSidebar(sidebarState({ items }), DEFAULT_FILTER));
    assert.ok(html.includes('kind-chips'));
    assert.ok(!html.includes('filter-registry'), 'search spans all registries — no registry filter');
    assert.ok(html.includes('1 result in 1 registry'));
    assert.ok(html.includes('class="footer"'), 'catalog status line pinned below the results');
  });

  test('catalog status line: timestamp in its own span, every tab', async () => {
    const items = buildCards([searchItem()], []);
    const installedItems = items;
    for (const mode of ['browse', 'updates', 'installed'] as const) {
      const html = await litHtml(
        renderSidebarFooter(sidebarState({ mode, items, installedItems })),
      );
      assert.ok(html.includes('class="footer"'), `${mode} footer renders`);
      assert.ok(html.includes('Catalog cache ·'), mode);
      assert.match(html, /<span class="footer-ts">synced 12 min ago<\/span>/);
    }
    // Loading shows the "Refreshing…" line in the SAME pinned region (item 1:
    // it must never be stranded inside the scrollable results instead), never
    // the idle "Catalog cache" line; no-grim has nothing to sync and shows
    // no footer at all.
    const loadingHtml = await litHtml(renderSidebarFooter(sidebarState({ phase: 'loading' })));
    assert.ok(loadingHtml.includes('class="footer loading-footer"'));
    assert.ok(!loadingHtml.includes('Catalog cache ·'));
    assert.strictEqual(await litString(renderSidebarFooter(sidebarState({ phase: 'no-grim' }))), '');
  });

  test('tab bar: three tabs, active underline, updates count, hidden on no-grim', async () => {
    const outdated = { ...card(), state: 'outdated' as const };
    const html = await litHtml(
      renderSidebarTabs(sidebarState({ mode: 'updates', installedItems: [outdated] })),
    );
    assert.ok(html.includes('sidebar-tabs'));
    for (const tab of ['browse', 'updates', 'installed']) {
      assert.ok(html.includes(`data-action="set-tab" data-tab="${tab}"`), tab);
    }
    assert.match(html, /class="tab active"[^>]*data-tab="updates"/);
    assert.ok(html.includes('<span class="tab-count">1</span>'), 'outdated count on the Updates tab');
    // No outdated installs → no count pill.
    const clean = await litHtml(renderSidebarTabs(sidebarState()));
    assert.ok(!clean.includes('tab-count'));
    // No grim → nothing to switch between.
    assert.strictEqual(await litString(renderSidebarTabs(sidebarState({ phase: 'no-grim' }))), '');
  });

  test('init notification when project unconfigured — top notice slot, above the tabs', async () => {
    const unconfigured = sidebarState({
      items: buildCards([searchItem()], []),
      scopes: { projectOpen: true, projectConfigured: false, projectName: 'my-app' },
    });
    const html = await litHtml(renderSidebar(unconfigured, DEFAULT_FILTER));
    assert.ok(html.includes('data-action="init-project"'));
    // Notification component (info icon, notification tokens), rendered BEFORE
    // the tab bar in the composed view — normal flow, never overlaying results.
    assert.ok(html.includes('init-notification'));
    assert.ok(html.indexOf('init-notification') < html.indexOf('sidebar-tabs'));
    // The results regions carry no copy of it — browse or installed alike.
    const browseResults = await litHtml(renderSidebarResults(unconfigured, DEFAULT_FILTER));
    assert.ok(!browseResults.includes('init-'));
    const installedResults = await litHtml(
      renderSidebarResults(
        { ...unconfigured, mode: 'installed' },
        { ...DEFAULT_FILTER, scope: 'project' },
      ),
    );
    assert.ok(!installedResults.includes('init-'));
    // Configured workspace → the notice slot is empty.
    assert.strictEqual(await litString(renderSidebarNotice(sidebarState())), '');
  });

  test('unknown install state banners the reason and keeps browsing, minus every install affordance', async () => {
    const degraded = sidebarState({
      items: buildCards([searchItem()], []),
      installStateUnknown: 'grim 0.9.1 at /usr/bin/grim is too old.',
    });
    const html = await litHtml(renderSidebar(degraded, DEFAULT_FILTER));
    // The banner rides the same notice slot as the init offer, above the tabs.
    assert.ok(html.includes('grim 0.9.1 at /usr/bin/grim is too old.'), html);
    assert.ok(html.includes('Install state is unavailable'));
    assert.ok(html.indexOf('init-notification') < html.indexOf('sidebar-tabs'));
    // Catalog cards still render — the catalog loaded fine.
    assert.ok(html.includes('class="card'), 'browse cards still render');
    // ...but nothing claims to know whether any of them is installed.
    assert.ok(!html.includes('data-action="install"'), 'no Install button');
    assert.ok(!html.includes('data-action="update"'), 'no Update button');
    assert.ok(!html.includes('installed-check'), 'no installed checkmark');
  });

  test('unknown install state stops the installed-side tabs claiming "nothing installed"', async () => {
    for (const mode of ['updates', 'installed'] as const) {
      const html = await litHtml(
        renderSidebarResults(
          sidebarState({ mode, installStateUnknown: 'stale binary' }),
          DEFAULT_FILTER,
        ),
      );
      assert.ok(html.includes('Install state is unavailable'), `${mode}: ${html}`);
      assert.ok(!html.toLowerCase().includes('nothing installed'), mode);
      assert.ok(!html.includes('up to date'), mode);
    }
  });

  test('the unknown-install-state banner escapes its message', async () => {
    const html = await litHtml(
      renderSidebarNotice(sidebarState({ installStateUnknown: '<img src=x onerror=alert(1)>' })),
    );
    assert.ok(!html.includes('<img'), html);
    assert.ok(html.includes('&lt;img'), html);
  });

  test('updates view renders outdated cards as update rows, no section chrome or Update-All button', async () => {
    const scope: ScopeStatus = {
      scope: 'project',
      status: [
        {
          kind: 'skill',
          name: 'grim-usage',
          source: 'direct',
          pinned: 'ghcr.io/grimoire-rs/skills/grim-usage@sha256:abc',
          state: 'outdated',
          outputs: [{ client: 'claude', path: '/x' }],
        },
      ],
      declared: { 'grim-usage': 'ghcr.io/grimoire-rs/skills/grim-usage:1.4.2' },
    };
    const items = buildCards([searchItem()], [scope]);
    const html = await litHtml(renderSidebar(sidebarState({ mode: 'updates', items }), DEFAULT_FILTER));
    assert.ok(html.includes('card-delta'), 'update-row variant');
    assert.ok(!html.includes('section-header'), 'no in-webview sections — the workbench owns them');
    assert.ok(!html.includes('data-action="update-all"'), 'Update All is a native view/title button');
    assert.ok(!html.includes('id="search"'), 'Updates view has no search box');
    assert.strictEqual(
      await litString(renderSidebarFilters(sidebarState({ mode: 'updates', items }), DEFAULT_FILTER)),
      '',
      'Updates has no filters',
    );
  });

  test('installed view: scope cards + Kind chips + SCOPE toggle, no sections (item 8)', async () => {
    const items = buildCards([searchItem()], [installedScope('project')]);
    // Default (configured project) resolves to the project scope.
    const html = await litHtml(renderSidebar(sidebarState({ mode: 'installed', items }), DEFAULT_FILTER));
    assert.ok(html.includes('data-action="menu"'), 'scope-variant card (manage gear)');
    assert.ok(!html.includes('section-header') && !html.includes('data-section-id'), 'no sections');
    assert.ok(html.includes('<span class="chip-group-label">KIND</span>'));
    assert.ok(html.includes('<span class="chip-group-label">SCOPE</span>'), 'SCOPE toggle present');
    assert.ok(html.includes('data-action="set-scope" data-scope="project"'));
    assert.ok(html.includes('data-action="set-scope" data-scope="global"'));
    assert.ok(html.includes('Search installed…'), 'installed view keeps a search box');
  });

  test('installed SCOPE toggle: default active + Project disabled without a workspace (item 8)', async () => {
    const configured = await litHtml(
      renderSidebarFilters(sidebarState({ mode: 'installed' }), DEFAULT_FILTER),
    );
    assert.ok(
      configured.includes('class="kind-chip active" data-action="set-scope" data-scope="project"'),
      'configured project → Project active by default',
    );
    const noProject = await litHtml(
      renderSidebarFilters(
        sidebarState({
          mode: 'installed',
          scopes: { projectOpen: false, projectConfigured: false, projectName: null },
        }),
        DEFAULT_FILTER,
      ),
    );
    assert.ok(noProject.includes('data-scope="project" disabled'), 'Project disabled, no workspace');
    assert.ok(
      noProject.includes('class="kind-chip active" data-action="set-scope" data-scope="global"'),
      'Global forced active',
    );
  });

  test('installed view shows only the selected scope’s installs (item 8)', async () => {
    const items = buildCards([searchItem()], [installedScope('project')]); // project install only
    const proj = await litHtml(renderSidebarResults(sidebarState({ mode: 'installed', items }), DEFAULT_FILTER));
    assert.ok(proj.includes('data-action="menu"'), 'project install shows under Project');
    const glob = await litHtml(
      renderSidebarResults(sidebarState({ mode: 'installed', items }), {
        ...DEFAULT_FILTER,
        scope: 'global',
      }),
    );
    assert.ok(glob.includes('Nothing installed globally.'), 'project-only install hidden under Global');
  });

  test('empty installed view: scope-appropriate message; Updates its own (item 8)', async () => {
    const proj = await litHtml(
      renderSidebarResults(sidebarState({ mode: 'installed', items: [] }), DEFAULT_FILTER),
    );
    assert.ok(proj.includes('Nothing installed in this project.'));
    const glob = await litHtml(
      renderSidebarResults(sidebarState({ mode: 'installed', items: [] }), {
        ...DEFAULT_FILTER,
        scope: 'global',
      }),
    );
    assert.ok(glob.includes('Nothing installed globally.'));
    const upd = await litHtml(
      renderSidebarResults(sidebarState({ mode: 'updates', items: [] }), DEFAULT_FILTER),
    );
    assert.ok(upd.includes('Everything is up to date.'));
  });

  test('browse view keeps Kind, no Installed/Scope/Registry filter', async () => {
    const html = await litHtml(
      renderSidebar(sidebarState({ items: buildCards([searchItem()], []) }), DEFAULT_FILTER),
    );
    assert.ok(html.includes('kind-chips'));
    assert.ok(!html.includes('data-action="toggle-installed"'), 'no Installed filter chip (item 4)');
    assert.ok(!html.includes('data-action="set-scope"'), 'no scope filter in browse');
    assert.ok(!html.includes('filter-registry'), 'search spans all registries');
  });
});

suite('sidebar split rendering (item 3)', () => {
  test('search row carries only the textfield, no filters or cards', async () => {
    const html = await litHtml(renderSidebarSearch(sidebarState({ items: buildCards([searchItem()], []) })));
    assert.ok(html.includes('vscode-textfield id="search"'));
    assert.ok(!html.includes('kind-chips'));
    assert.ok(!html.includes('class="card'));
  });

  test('search row placeholder tracks the mode; withheld in no-grim and Updates', async () => {
    assert.ok(
      (await litHtml(renderSidebarSearch(sidebarState({ mode: 'installed' })))).includes('Search installed…'),
    );
    assert.ok((await litHtml(renderSidebarSearch(sidebarState()))).includes('Search artifacts…'));
    assert.strictEqual(await litString(renderSidebarSearch(sidebarState({ phase: 'no-grim' }))), '');
    assert.strictEqual(
      await litString(renderSidebarSearch(sidebarState({ mode: 'updates' }))),
      '',
      'Updates has no search',
    );
  });

  test('filter row carries the kind chips, not the search textfield or cards', async () => {
    const html = await litHtml(
      renderSidebarFilters(sidebarState({ items: buildCards([searchItem()], []) }), DEFAULT_FILTER),
    );
    assert.ok(html.includes('kind-chips'));
    assert.ok(html.includes('data-action="toggle-kind"'));
    assert.ok(html.includes('<span class="chip-group-label">KIND</span>'), 'kind row is labeled');
    assert.ok(!html.includes('data-action="toggle-installed"'), 'no Installed filter chip (item 4)');
    assert.ok(!html.includes('filter-registry'), 'no registry filter');
    assert.ok(!html.includes('id="search"'));
    assert.ok(!html.includes('class="card'));
  });

  test('kind chips: All active on empty selection; selected kinds fill', async () => {
    const st = sidebarState({ items: buildCards([searchItem()], []) });
    const allActive = await litHtml(renderSidebarFilters(st, DEFAULT_FILTER));
    // All is active exactly when nothing is selected.
    assert.ok(
      allActive.includes('class="kind-chip active" data-action="toggle-kind" data-kind="all"'),
    );
    assert.ok(allActive.includes('codicon-sparkle'), 'skill chip carries its codicon');
    // Two kinds selected → those chips active, All inactive.
    const multi = await litHtml(renderSidebarFilters(st, { ...DEFAULT_FILTER, kinds: ['skill', 'bundle'] }));
    assert.ok(multi.includes('class="kind-chip active" data-action="toggle-kind" data-kind="skill"'));
    assert.ok(multi.includes('class="kind-chip active" data-action="toggle-kind" data-kind="bundle"'));
    assert.ok(multi.includes('class="kind-chip" data-action="toggle-kind" data-kind="all"'));
    assert.ok(multi.includes('class="kind-chip" data-action="toggle-kind" data-kind="rule"'));
  });

  test('filter row is empty unless the phase is ready', async () => {
    assert.strictEqual(
      await litString(renderSidebarFilters(sidebarState({ phase: 'loading' }), DEFAULT_FILTER)),
      '',
    );
    assert.strictEqual(
      await litString(renderSidebarFilters(sidebarState({ phase: 'error' }), DEFAULT_FILTER)),
      '',
    );
    assert.strictEqual(
      await litString(renderSidebarFilters(sidebarState({ phase: 'no-grim' }), DEFAULT_FILTER)),
      '',
    );
  });

  test('results carry cards but not the footer (it lives in its own bottom-pinned region), textfield, or filters', async () => {
    const st = sidebarState({ items: buildCards([searchItem()], []) });
    const html = await litHtml(renderSidebarResults(st, DEFAULT_FILTER));
    assert.ok(html.includes('class="cards"'));
    assert.ok(html.includes('result-summary'));
    assert.ok(!html.includes('class="footer"'), 'footer moved out of results (item 3)');
    assert.ok(!html.includes('id="search"'));
    assert.ok(!html.includes('kind-chips'));
    // The footer region carries the cached-catalog status line instead.
    assert.ok((await litHtml(renderSidebarFooter(st))).includes('class="footer"'));
  });

  test('the six regions compose to exactly renderSidebar', async () => {
    // Composition no longer typechecks as string '+' concatenation (each
    // region now returns a lit TemplateResult, not a string) — normalize each
    // region independently, then compare the concatenation of those six
    // strings to the normalized, fully-composed renderSidebar (spec Addendum
    // item 8 / riskNotes: the canonical "compose and compare" case).
    const st = sidebarState({ items: buildCards([searchItem()], []) });
    const composed =
      (await litHtml(renderSidebarNotice(st))) +
      (await litHtml(renderSidebarTabs(st))) +
      (await litHtml(renderSidebarSearch(st))) +
      (await litHtml(renderSidebarFilters(st, DEFAULT_FILTER))) +
      (await litHtml(renderSidebarResults(st, DEFAULT_FILTER))) +
      (await litHtml(renderSidebarFooter(st)));
    assert.ok(
      (await litHtml(renderSidebarFooter(st))).includes('footer-ts'),
      'footer must render content for this composition to mean anything',
    );
    assert.strictEqual(composed, await litHtml(renderSidebar(st, DEFAULT_FILTER)));
    // Same in Installed mode (the filters region differs there).
    const inst = sidebarState({ mode: 'installed', items: buildCards([searchItem()], []) });
    const composedInstalled =
      (await litHtml(renderSidebarNotice(inst))) +
      (await litHtml(renderSidebarTabs(inst))) +
      (await litHtml(renderSidebarSearch(inst))) +
      (await litHtml(renderSidebarFilters(inst, DEFAULT_FILTER))) +
      (await litHtml(renderSidebarResults(inst, DEFAULT_FILTER))) +
      (await litHtml(renderSidebarFooter(inst)));
    assert.strictEqual(composedInstalled, await litHtml(renderSidebar(inst, DEFAULT_FILTER)));
    // Third case: an unconfigured project, so the notice region actually
    // renders content — exercising the notice in the composition instead of
    // relying on the default fixture's empty (configured) notice above.
    const unconfigured = sidebarState({
      scopes: { projectOpen: true, projectConfigured: false, projectName: 'my-app' },
      items: buildCards([searchItem()], []),
    });
    assert.ok(
      (await litHtml(renderSidebarNotice(unconfigured))).includes('init-notification'),
      'notice must render content for this composition to mean anything',
    );
    const composedUnconfigured =
      (await litHtml(renderSidebarNotice(unconfigured))) +
      (await litHtml(renderSidebarTabs(unconfigured))) +
      (await litHtml(renderSidebarSearch(unconfigured))) +
      (await litHtml(renderSidebarFilters(unconfigured, DEFAULT_FILTER))) +
      (await litHtml(renderSidebarResults(unconfigured, DEFAULT_FILTER))) +
      (await litHtml(renderSidebarFooter(unconfigured)));
    assert.strictEqual(composedUnconfigured, await litHtml(renderSidebar(unconfigured, DEFAULT_FILTER)));
  });

  test('refreshing footer escapes the registry host; plain fallback without one', async () => {
    const html = await litHtml(renderRefreshingFooter('<img src=x onerror=alert(1)>'));
    assert.ok(!html.includes('<img src=x'));
    assert.ok(html.includes('&lt;img src=x'));
    assert.ok(html.includes('loading-footer'));
    // No host known yet -> generic "Refreshing…", never an empty footer (#38).
    const noHost = await litString(renderRefreshingFooter(null));
    assert.ok(noHost.includes('Refreshing…'));
    assert.ok(!noHost.includes('Refreshing from'));
  });

  test('search row carries a clear-search action icon, hidden until there is text (item 4)', async () => {
    const empty = await litHtml(renderSidebarSearch(sidebarState({ query: '' })));
    assert.ok(empty.includes('slot="content-after"'));
    assert.ok(empty.includes('id="search-clear"'));
    assert.ok(empty.includes('data-action="clear-search"'));
    assert.ok(empty.includes('action-icon'));
    assert.ok(empty.includes('class="clear-icon hidden"'), 'hidden when the query is empty');
    const withText = await litHtml(renderSidebarSearch(sidebarState({ query: 'grim' })));
    assert.ok(withText.includes('class="clear-icon"'), 'shown once there is text');
    assert.ok(!withText.includes('clear-icon hidden'));
  });

  test('a hostile query stays escaped in the search row value (item 4)', async () => {
    const html = await litHtml(renderSidebarSearch(sidebarState({ query: '"><img src=x onerror=alert(1)>' })));
    assert.ok(!html.includes('<img src=x'));
    assert.ok(html.includes('&lt;img src=x'));
  });

});

suite('details rendering', () => {
  test('header without stars: name, badge, version, repo path, actions', async () => {
    const html = await litHtml(renderDetails(detailsVM()));
    assert.ok(html.includes('grim-usage'));
    assert.ok(html.includes('SKILL'));
    assert.ok(html.includes('1.5.0'));
    assert.ok(html.includes('ghcr.io/grimoire-rs/skills/grim-usage'));
    assert.ok(html.includes('data-action="install"'));
    assert.ok(html.includes('data-action="scope-menu"'));
    assert.ok(!html.toLowerCase().includes('star'));
  });

  test('header description renders inline markdown (no <p> wrapper)', async () => {
    const html = await litHtml(
      renderDetails(detailsVM({ description: 'Drive the `grim` **CLI** — see [docs](https://grim.rs).' })),
    );
    assert.ok(html.includes('<code>grim</code>'), 'code span renders');
    assert.ok(html.includes('<strong>CLI</strong>'), 'emphasis renders');
    assert.ok(html.includes('href="https://grim.rs"'), 'link renders');
    assert.ok(!/<div class="header-desc"><p>/.test(html), 'inline render has no <p> wrapper');
  });

  test('hostile header description stays inert (markdown-it html:false)', async () => {
    const html = await litHtml(
      renderDetails(detailsVM({ description: '<img src=x onerror=alert(1)> **bold**' })),
    );
    assert.ok(!html.includes('<img src=x'), 'raw HTML not emitted');
    assert.ok(html.includes('&lt;img src=x'), 'raw HTML escaped');
    assert.ok(html.includes('<strong>bold</strong>'), 'markdown still renders');
  });

  test('header badge resolves a floating "latest" install to the concrete latestVersion', async () => {
    const html = await litHtml(
      renderDetails(
        detailsVM({
          latestVersion: '1.4.2',
          installs: [
            {
              scope: 'project',
              version: 'latest',
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
    assert.ok(
      html.includes('<span class="header-version mono">1.4.2</span>'),
      'badge shows the resolved concrete version',
    );
    assert.ok(
      !html.includes('<span class="header-version mono">latest</span>'),
      'badge does not show the floating tag literal',
    );
  });

  test('header badge falls back to "latest" when nothing concrete is known anywhere', async () => {
    const html = await litHtml(
      renderDetails(
        detailsVM({
          latestVersion: 'latest',
          installs: [
            {
              scope: 'project',
              version: 'latest',
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
    assert.ok(
      html.includes('<span class="header-version mono">latest</span>'),
      'fallback to the literal tag is preserved',
    );
  });

  test('header version chip sits last in the badge row, after the registry (item 4)', async () => {
    const html = await litHtml(renderDetails(detailsVM()));
    const registry = html.indexOf('header-registry');
    const version = html.indexOf('header-version');
    assert.ok(registry !== -1 && version !== -1);
    assert.ok(version > registry, 'the version chip renders after the registry chip');
  });

  test('skeleton reserves the version slot when the version is unknown (item 4c)', async () => {
    const known = await litHtml(renderDetails(detailsVM({ loading: true })));
    assert.ok(known.includes('1.5.0'), 'a known version fills the slot directly');
    const unknown = await litHtml(
      renderDetails(detailsVM({ loading: true, latestVersion: null, installs: [] })),
    );
    assert.ok(unknown.includes('header-version-pending'), 'unknown version reserves the slot');
  });

  test('header carries a Copy share link button (codicon link)', async () => {
    const html = await litHtml(renderDetails(detailsVM()));
    assert.ok(html.includes('data-action="copy-share"'));
    assert.ok(html.includes('codicon-link'));
    assert.ok(html.includes('title="Copy share link"'));
    assert.ok(html.includes('header-share'));
  });

  test('not-installed renders both scope rows with per-scope Install split buttons', async () => {
    const html = await litHtml(renderDetails(detailsVM()));
    assert.ok(html.includes('scope-box'));
    assert.ok(html.includes('Project — my-app'));
    assert.ok(html.includes('.grimoire/'));
    assert.ok(html.includes('~/.grimoire'));
    // Each row installs its own scope.
    assert.ok(html.includes('data-action="install" data-scope="project"'));
    assert.ok(html.includes('data-action="install" data-scope="global"'));
    // Muted "Not installed" cells stay in-box; the caption line below is gone.
    assert.ok(html.includes('scope-status-muted'));
    assert.ok(html.includes('Not installed'));
    assert.ok(!html.includes('action-row'), 'the redundant status caption is removed');
    // The killed standalone header split button is gone (item 2).
    assert.ok(!html.includes('data-scope="default"'));
    assert.ok(!html.includes('Install version…'));
    assert.ok(!html.includes('Install in Project'));
    assert.ok(!html.includes('Install Globally'));
  });

  test('project scope row is omitted when no workspace is open', async () => {
    const html = await litHtml(
      renderDetails(
        detailsVM({ scopes: { projectOpen: false, projectConfigured: false, projectName: null } }),
      ),
    );
    assert.ok(!html.includes('.grimoire/'), 'no project row without a workspace');
    assert.ok(html.includes('~/.grimoire'));
    assert.ok(html.includes('data-action="install" data-scope="global"'));
    assert.ok(!html.includes('data-scope="project"'));
  });

  test('scope-row Install chevron carries the preselected scope for pickVersion', async () => {
    const html = await litHtml(renderDetails(detailsVM()));
    assert.ok(
      html.includes(
        'data-action="pick-version" data-repo="ghcr.io/grimoire-rs/skills/grim-usage" data-scope="project"',
      ),
    );
    assert.ok(html.includes('data-scope="global"'));
  });

  test('hostile repo stays inert in the scope-row Install chevron', async () => {
    const html = await litHtml(
      renderDetails(detailsVM({ repo: '"><img src=x onerror=alert(1)>/skills/evil' })),
    );
    assert.ok(!html.includes('<img src=x'));
    assert.ok(html.includes('&lt;img src=x'));
  });

  test('per-scope rows replace action row when installed in both scopes', async () => {
    const html = await litHtml(
      renderDetails(
        detailsVM({
          state: 'outdated',
          installs: [
            {
              scope: 'project',
              version: '1.4.2',
              updateAvailable: true,
              clients: ['claude', 'opencode'],
              state: 'outdated',
              kind: 'skill',
              name: 'grim-usage',
              viaBundles: [],
            },
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
    assert.ok(html.includes('scope-row'));
    assert.ok(html.includes('Project — my-app'));
    assert.ok(html.includes('1.5.0 available'));
    assert.ok(html.includes('up to date'));
    assert.ok(html.includes('data-action="uninstall"'));
    assert.ok(html.includes('INSTALLATIONS (2)'));
  });

  test('scope-version cell has aligned scope-ver/scope-glyph sub-columns in every row state', async () => {
    const notInstalled = await litHtml(renderDetails(detailsVM()));
    assert.ok(
      notInstalled.includes(
        '<span class="mono scope-ver"></span><span class="scope-glyph"><span class="status-dot muted"></span></span>',
      ),
      'not-installed: empty ver span + muted-dot glyph',
    );

    const pending = await litHtml(renderDetails(detailsVM({ loading: true, scopesPending: true })));
    assert.ok(
      pending.includes(
        '<span class="mono scope-ver"></span><span class="scope-glyph"><span class="codicon codicon-loading codicon-modifier-spin"></span></span>',
      ),
      'pending: empty ver span + spinner glyph',
    );

    const installed = await litHtml(
      renderDetails(
        detailsVM({
          state: 'outdated',
          installs: [
            {
              scope: 'project',
              version: '1.4.2',
              updateAvailable: true,
              clients: ['claude'],
              state: 'outdated',
              kind: 'skill',
              name: 'grim-usage',
              viaBundles: [],
            },
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
    assert.ok(
      installed.includes(
        '<span class="mono scope-ver">1.4.2</span><span class="scope-glyph"><span class="status-dot"></span></span>',
      ),
      'outdated: version in scope-ver + status-dot glyph',
    );
    assert.ok(
      installed.includes(
        '<span class="mono scope-ver">1.5.0</span><span class="scope-glyph"><span class="codicon codicon-check ok-check"></span></span>',
      ),
      'up to date: version in scope-ver + check glyph',
    );
  });

  test('deprecation banner with replacement link', async () => {
    const html = await litHtml(
      renderDetails(
        detailsVM({
          state: 'deprecated',
          deprecated: 'superseded',
          replacedBy: 'harbor.internal.acme.io/platform/rules/commit-style',
        }),
      ),
    );
    assert.ok(html.includes('deprecation-banner'));
    assert.ok(html.includes('harbor.internal.acme.io/platform/rules/commit-style'));
    assert.ok(html.includes('header-name struck'));
  });

  test('deprecation banner offers a Switch button only when the artifact is installed', async () => {
    const base = {
      state: 'deprecated' as const,
      deprecated: 'Renamed.',
      replacedBy: 'ghcr.io/grimoire-rs/skills/new-skill',
    };
    const notInstalled = await litHtml(renderDetails(detailsVM(base)));
    assert.ok(
      !notInstalled.includes('data-action="switch"'),
      'no switch affordance when not installed',
    );
    const installed = await litHtml(
      renderDetails(detailsVM({ ...base, installs: [bothInstalled('project')] })),
    );
    assert.ok(installed.includes('data-action="switch"'), 'switch button shows once installed');
    assert.ok(installed.includes('deprecation-switch'));
    assert.ok(installed.includes('Switch to replacement'));
    // The read-only preview link stays alongside the button.
    assert.ok(installed.includes('data-action="open-details"'));
  });

  test('bundle contents panel and tab', async () => {
    const html = await litHtml(
      renderDetails(
        detailsVM({
          kind: 'bundle',
          contentMarkdown: null,
          members: [
            {
              kind: 'skill',
              name: 'grim-usage',
              id: '../skills/grim-usage:0',
              version: '0',
              repo: 'ghcr.io/grimoire-rs/skills/grim-usage',
              description: 'Drive the grim CLI.',
            },
          ],
        }),
      ),
    );
    assert.ok(html.includes('data-tab="contents"'));
    assert.ok(html.includes('CONTENTS'));
    assert.ok(html.includes('member-row'));
  });

  test('null fields render "Not provided"; empty Resources panel is omitted', async () => {
    const html = await litHtml(
      renderDetails(
        detailsVM({
          tags: null,
          published: null,
          revision: null,
          sourceRepository: null,
          license: null,
          keywords: null,
        }),
      ),
    );
    assert.ok(html.includes('Not provided'));
    assert.ok(!html.includes('RESOURCES'));
    assert.ok(html.includes('No keywords')); // TAGS placeholder per design 1d
  });

  test('no VERSIONS tab anywhere (removed — the PACKAGE rail shows the tags)', async () => {
    const html = await litHtml(renderDetails(detailsVM({ latestVersion: '1.5.0', tags: ['1.5.0', '1.4.2'] })));
    assert.ok(!html.includes('data-tab="versions"'));
    assert.ok(!html.includes('panel-versions'));
    assert.ok(!html.toUpperCase().includes('>VERSIONS<'));
  });

  test('loading skeleton renders the full structure so nothing shifts (item 2)', async () => {
    // Pending skeleton: no install snapshot yet -> scope boxes are spinner shells.
    const html = await litHtml(renderDetails(detailsVM({ loading: true, scopesPending: true })));
    assert.ok(html.includes('details-header'));
    assert.ok(html.includes('grim-usage')); // name
    assert.ok(html.includes('SKILL')); // kind badge
    assert.ok(html.includes('ghcr.io/grimoire-rs/skills/grim-usage')); // repo path
    // Scope boxes render immediately (stable geometry) as pending shells.
    assert.ok(html.includes('scope-box'), 'scope boxes present in the skeleton');
    assert.ok(html.includes('Checking…'), 'pending scope rows show a status spinner');
    assert.ok(!html.includes('data-action="install"'), 'no install action while pending');
    // The tab strip pre-renders DETAILS + CONTENTS (active) + CHANGELOG so the
    // strip doesn't reflow once the real VM lands (item 4). DETAILS/CHANGELOG are
    // disabled (presence unknown), CONTENTS active.
    assert.ok(html.includes('data-tab="details" disabled title="No README available"'));
    assert.ok(html.includes('class="tab active" data-tab="contents"'));
    assert.ok(html.includes('data-tab="changelog" disabled title="No changelog available"'));
    assert.ok(html.includes('vscode-progress-ring'));
    assert.ok(html.includes('details-loading'));
    // The 300px rail renders placeholder panels instead of nothing.
    assert.ok(html.includes('right-rail'), 'rail present in the skeleton');
    assert.ok(html.includes('rail-skeleton-line'), 'rail placeholder panels present');
    // The version slot is reserved (item 4c) when the version is unknown.
    const noVersion = await litHtml(
      renderDetails(detailsVM({ loading: true, scopesPending: true, latestVersion: null, installs: [] })),
    );
    assert.ok(noVersion.includes('header-version-pending'), 'version slot reserved');
  });

  test('inline skeleton escapes the repo (server-side first paint)', async () => {
    // The skeleton is inlined into the initial document (details host renderHtml),
    // so its one dynamic value — the repo — must be escaped like every render path.
    const html = await litHtml(
      renderDetails(
        detailsVM({ loading: true, scopesPending: true, repo: '"><img src=x onerror=alert(1)>/skills/evil' }),
      ),
    );
    assert.ok(!html.includes('"><img src=x onerror=alert(1)>'), 'raw payload not injected');
    assert.ok(html.includes('&gt;&lt;img'), 'repo rendered escaped');
  });

  test('skeleton with a cached snapshot renders real scope rows, not shells (item 2)', async () => {
    const html = await litHtml(
      renderDetails(
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
    // scopesPending absent -> real rows: the global install shows in-box.
    assert.ok(html.includes('scope-box'));
    assert.ok(html.includes('data-action="uninstall" data-kind="skill" data-name="grim-usage" data-scope="global"'));
    assert.ok(!html.includes('Checking…'), 'known state is not a pending shell');
  });

  test('install split button offers Install Version', async () => {
    const html = await litHtml(renderDetails(detailsVM()));
    assert.ok(html.includes('data-action="pick-version"'));
    assert.ok(html.includes('Install Version'));
  });

  test('both scopes installed: two Uninstall split buttons, no header picker', async () => {
    const html = await litHtml(
      renderDetails(
        detailsVM({
          state: 'installed',
          installs: [bothInstalled('project'), bothInstalled('global')],
        }),
      ),
    );
    // One Uninstall split button per installed row (design 2a gear-first rework).
    assert.strictEqual((html.match(/class="split-button sm"/g) ?? []).length, 2);
    assert.strictEqual((html.match(/>Uninstall</g) ?? []).length, 2);
    assert.ok(!html.includes('data-action="install"'));
    assert.ok(!html.includes('Install version…'));
    assert.ok(!html.includes('data-scope="default"'));
    // The status caption below the box was removed (item 1).
    assert.ok(!html.includes('Installed in both scopes'));
    assert.ok(!html.includes('action-row'));
  });

  test('an installed scope row shows Uninstall while the free scope keeps Install active', async () => {
    const html = await litHtml(
      renderDetails(
        detailsVM({
          state: 'installed',
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
    assert.ok(html.includes('data-action="uninstall" data-kind="skill" data-name="grim-usage" data-scope="global"'));
    // The project scope (still free) keeps an active Install split button.
    assert.ok(html.includes('data-action="install" data-scope="project"'));
  });

  test('logo data URI is used when present', async () => {
    const html = await litHtml(renderDetails(detailsVM({ logoUri: 'data:image/png;base64,AAAA' })));
    assert.ok(html.includes('header-logo'));
    assert.ok(html.includes('data:image/png;base64,AAAA'));
  });

  test('formatDate falls back to raw string', () => {
    assert.strictEqual(formatDate('not-a-date'), 'not-a-date');
    assert.match(formatDate('2026-06-28T00:00:00Z'), /Jun 2\d, 2026/);
  });

  test('CONTENTS is always present; README always leads, disabled without a README (item 5)', async () => {
    // No README: the README tab still renders, first, but disabled and inert; CONTENTS is active.
    const withoutReadme = await litHtml(renderDetails(detailsVM()));
    assert.ok(
      withoutReadme.includes(
        '<button class="tab" data-tab="details" disabled title="No README available">README</button>',
      ),
    );
    assert.ok(withoutReadme.includes('class="tab active" data-tab="contents"'));
    assert.ok(withoutReadme.includes('id="md-contents"'));
    assert.ok(!withoutReadme.includes('id="md-details"'), 'no README panel emitted when disabled');
    // Disabled DETAILS renders the same way for every kind.
    for (const kind of ['skill', 'rule', 'agent', 'mcp', 'bundle'] as const) {
      const html = await litHtml(renderDetails(detailsVM({ kind })));
      assert.ok(html.includes('data-tab="details" disabled title="No README available"'), kind);
    }
    // With a README: DETAILS leads and is active (enabled), CONTENTS follows.
    const withReadme = await litHtml(renderDetails(detailsVM({ readmeMarkdown: '# Readme' })));
    assert.ok(withReadme.includes('class="tab active" data-tab="details"'));
    assert.ok(!withReadme.includes('data-tab="details" disabled'));
    assert.ok(withReadme.includes('data-tab="contents"'));
    assert.ok(withReadme.includes('id="md-details"'));
    // The old separate CONTENT tab/label is gone (unified into CONTENTS).
    assert.ok(!withReadme.includes('data-tab="content"'));
    assert.ok(!withReadme.includes('>CONTENT<'));
    assert.ok(!withReadme.includes('id="md-content"'));
  });

  test('CHANGELOG tab always renders; disabled without a changelog (mirrors DETAILS)', async () => {
    const withoutChangelog = await litHtml(renderDetails(detailsVM()));
    // Native disabled attribute + title tooltip, exactly like the DETAILS tab —
    // no pointer-events:none (that would kill the tooltip); main.ts guards clicks.
    assert.ok(
      withoutChangelog.includes(
        '<button class="tab" data-tab="changelog" disabled title="No changelog available">CHANGELOG</button>',
      ),
    );
    assert.ok(!withoutChangelog.includes('id="md-changelog"'), 'no changelog panel when disabled');
    // With a changelog: enabled tab + its panel.
    const withChangelog = await litHtml(renderDetails(detailsVM({ changelogMarkdown: '# 1.0' })));
    assert.ok(withChangelog.includes('data-tab="changelog"'));
    assert.ok(!withChangelog.includes('data-tab="changelog" disabled'));
    assert.ok(withChangelog.includes('id="md-changelog"'));
  });

  test('bundle members render as clickable boxes; unresolved members stay plain', async () => {
    const html = await litHtml(
      renderDetails(
        detailsVM({
          kind: 'bundle',
          contentMarkdown: null,
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
    assert.ok(html.includes('member-box'));
    assert.ok(html.includes('kind-tile kind-skill member-tile'));
    assert.ok(
      html.includes('data-action="open-details" data-repo="ghcr.io/grimoire-rs/skills/grim-usage"'),
    );
    assert.ok(html.includes('Drive the grim CLI.'));
    assert.ok(html.includes('<span class="member-name">mystery</span>'));
  });

  test('hostile member name and description stay inert', async () => {
    const html = await litHtml(
      renderDetails(
        detailsVM({
          kind: 'bundle',
          contentMarkdown: null,
          members: [
            {
              kind: 'skill',
              name: '<img src=x onerror=alert(1)>',
              id: 'x',
              version: null,
              repo: '"><script>y</script>',
              description: '<b>d</b>',
            },
          ],
        }),
      ),
    );
    assert.ok(!html.includes('<img src=x'));
    assert.ok(!html.includes('"><script>'));
    assert.ok(html.includes('&lt;b&gt;d&lt;/b&gt;'));
  });

  test('resolved member box is a whole-box button; unresolved box is inert (item 1)', async () => {
    const html = await litHtml(
      renderDetails(
        detailsVM({
          kind: 'bundle',
          contentMarkdown: null,
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
    // The whole resolved box is the click target with button semantics.
    assert.ok(
      html.includes(
        '<div class="member-box" data-action="open-details" data-repo="ghcr.io/grimoire-rs/skills/grim-usage" role="button" tabindex="0">',
      ),
    );
    assert.ok(html.includes('member-name-link'));
    // The unresolved box carries no action / role / tabindex.
    assert.ok(html.includes('<div class="member-box">'), 'unresolved box stays plain');
    assert.ok(!html.includes('<button class="member-link"'), 'no nested member-link button');
  });

  test('rail Contents member row is a whole-row button when resolved (item 1)', async () => {
    const html = await litHtml(
      renderDetails(
        detailsVM({
          kind: 'bundle',
          contentMarkdown: null,
          members: [
            {
              kind: 'skill',
              name: 'grim-usage',
              id: '../skills/grim-usage:1',
              version: '1',
              repo: 'ghcr.io/grimoire-rs/skills/grim-usage',
              description: null,
            },
          ],
        }),
      ),
    );
    assert.ok(
      html.includes(
        '<div class="member-row" data-action="open-details" data-repo="ghcr.io/grimoire-rs/skills/grim-usage" role="button" tabindex="0">',
      ),
    );
  });

  test('keyword chips are clickable search-tag buttons (item 2)', async () => {
    const html = await litHtml(renderDetails(detailsVM({ keywords: ['cli', 'oci'] })));
    assert.ok(html.includes('<button class="keyword-chip" data-action="search-tag" data-tag="cli"'));
    assert.ok(html.includes('>cli</button>'));
    assert.ok(html.includes('data-tag="oci"'));
  });

  test('a hostile keyword stays inert in the tag button and its data attribute (item 2)', async () => {
    const html = await litHtml(renderDetails(detailsVM({ keywords: ['"><img src=x onerror=alert(1)>'] })));
    assert.ok(!html.includes('<img src=x'));
    assert.ok(!html.includes('"><img'));
    assert.ok(html.includes('&lt;img src=x'));
    assert.ok(html.includes('data-action="search-tag"'));
  });

  test('via-bundle scope row renders one Bundle nav button (no split button/scope-menu) and keeps Update in the gear', async () => {
    const html = await litHtml(
      renderDetails(
        detailsVM({
          state: 'outdated',
          latestVersion: '2.0.0',
          installs: [
            {
              scope: 'global',
              version: '1.0.0',
              updateAvailable: true,
              clients: ['claude'],
              state: 'outdated',
              kind: 'skill',
              name: 'grim-usage',
              viaBundles: ['ghcr.io/grimoire-rs/bundles/grim-essentials'],
            },
          ],
        }),
      ),
    );
    assert.ok(html.includes('data-action="update"')); // Update still lives in the gear menu
    assert.ok(!html.includes('data-action="uninstall"'));
    // Gear first, then exactly one Bundle button — no split button in this cell,
    // and the only scope-menu left is the gear's own row-actions dropdown.
    // Bounded to the last scope row's own markup: normalizeHtml collapses all
    // whitespace (no more literal "\n" to anchor on), so the cell is bounded by
    // the next always-present, unconditional block after the header instead.
    const start = html.lastIndexOf('<span class="scope-actions">');
    const end = html.indexOf('<div class="details-body">', start);
    const actionsCell = html.slice(start, end);
    assert.strictEqual((actionsCell.match(/class="via-bundle-btn"/g) ?? []).length, 1);
    assert.ok(!actionsCell.includes('split-button'));
    assert.strictEqual((actionsCell.match(/class="scope-menu hidden"/g) ?? []).length, 1);
    assert.ok(actionsCell.indexOf('data-action="scope-gear"') < actionsCell.indexOf('via-bundle-btn'));
    assert.ok(
      html.includes(
        '<button class="via-bundle-btn" data-action="open-details" data-repo="ghcr.io/grimoire-rs/bundles/grim-essentials"',
      ),
    );
    assert.ok(html.includes('Bundle<span class="codicon codicon-package"></span></button>'));
    assert.ok(html.includes('title="Installed via bundle ghcr.io/grimoire-rs/bundles/grim-essentials — uninstall the bundle to remove it"'));
  });

  test('outdated direct install: Update leads the split button, menu carries Switch + Uninstall, gear drops Update (item 1)', async () => {
    const html = await litHtml(
      renderDetails(
        detailsVM({
          scopes: { projectOpen: false, projectConfigured: false, projectName: null },
          state: 'outdated',
          latestVersion: '2.0.0',
          installs: [
            {
              scope: 'global',
              version: '1.0.0',
              updateAvailable: true,
              clients: ['claude'],
              state: 'outdated',
              kind: 'skill',
              name: 'grim-usage',
              viaBundles: [],
            },
          ],
        }),
      ),
    );
    // The one row button is Update (primary split-main), firing the scope update.
    assert.ok(
      html.includes(
        '<button class="split-main" data-action="update" data-kind="skill" data-name="grim-usage" data-scope="global">Update</button>',
      ),
      'Update is the split-main',
    );
    // Its chevron menu offers Switch Version AND Uninstall.
    assert.ok(html.includes('Switch Version'));
    assert.ok(
      html.includes(
        '<button class="menu-item" data-action="uninstall" data-kind="skill" data-name="grim-usage" data-scope="global"><span class="menu-label">Uninstall</span></button>',
      ),
      'Uninstall lives in the Update menu',
    );
    // Update appears exactly once (the split-main) — no duplicate in the gear.
    assert.strictEqual((html.match(/data-action="update"/g) ?? []).length, 1, 'Update once, not duplicated in the gear');
    assert.strictEqual(html.match(/class="split-button sm"/g)?.length, 1, 'exactly one row button');
  });

  test('multiple providing bundles: button opens the first, tooltip names all', async () => {
    const html = await litHtml(
      renderDetails(
        detailsVM({
          state: 'installed',
          installs: [
            {
              scope: 'global',
              version: '1',
              updateAvailable: false,
              clients: [],
              state: 'installed',
              kind: 'skill',
              name: 'grim-usage',
              viaBundles: [
                'ghcr.io/grimoire-rs/bundles/grim-essentials',
                'ghcr.io/grimoire-rs/bundles/team-pack',
              ],
            },
          ],
        }),
      ),
    );
    assert.strictEqual((html.match(/class="via-bundle-btn"/g) ?? []).length, 1);
    assert.ok(html.includes('data-repo="ghcr.io/grimoire-rs/bundles/grim-essentials"'));
    assert.ok(
      html.includes(
        'title="Installed via bundle ghcr.io/grimoire-rs/bundles/grim-essentials, ghcr.io/grimoire-rs/bundles/team-pack — uninstall the bundle to remove it"',
      ),
    );
  });

  test('hostile via-bundle repo stays inert in the button and tooltip', async () => {
    const html = await litHtml(
      renderDetails(
        detailsVM({
          state: 'installed',
          installs: [
            {
              scope: 'project',
              version: '1',
              updateAvailable: false,
              clients: [],
              state: 'installed',
              kind: 'skill',
              name: 'grim-usage',
              viaBundles: ['"><img src=x onerror=alert(1)>/bundles/evil'],
            },
          ],
        }),
      ),
    );
    assert.ok(!html.includes('<img src=x'));
    assert.ok(!html.includes('"><img'));
    assert.ok(html.includes('&lt;img src=x'));
    assert.ok(html.includes('>Bundle<span class="codicon codicon-package"></span></button>')); // fixed label regardless of hostile repo
  });

  test('the Pin (Keep open) button renders only in preview mode (item 2)', async () => {
    const preview = await litHtml(renderDetails(detailsVM({ isPreview: true })));
    assert.ok(preview.includes('data-action="promote"'), 'promote action present in preview');
    assert.ok(preview.includes('codicon-pin'));
    assert.ok(preview.includes('title="Keep open"'));
    const permanent = await litHtml(renderDetails(detailsVM()));
    assert.ok(!permanent.includes('data-action="promote"'), 'no pin when not a preview');
  });

  test('a running action marks the header busy so actions go inert', async () => {
    const idle = await litHtml(renderDetails(detailsVM({})));
    assert.ok(idle.includes('class="details-header"'));
    const busy = await litHtml(renderDetails(detailsVM({ busy: 'Installing…' })));
    assert.ok(busy.includes('class="details-header busy"'));
    // Progress lives host-side (status bar) now — no in-page busy bar to shift UI.
    assert.ok(!busy.includes('busy-bar'));
  });

  test('a cold fetch failure renders an in-body error block, nothing above the header', async () => {
    const errored = await litHtml(renderDetails(detailsVM({ error: 'grim exited with status 1' })));
    // In the reading column (where the loading spinner sat), not a top banner.
    assert.ok(errored.includes('class="error-state"'));
    assert.ok(errored.includes('grim exited with status 1'));
    assert.ok(!errored.includes('error-banner'));
    // Header stays first — nothing rendered before it.
    assert.ok(
      errored.indexOf('details-header') < errored.indexOf('error-state'),
      'error block sits below the header',
    );
  });

  test('the in-body error message is escaped', async () => {
    const errored = await litHtml(
      renderDetails(detailsVM({ error: '<img src=x onerror=alert(1)>' })),
    );
    assert.ok(!errored.includes('<img src=x'));
    assert.ok(errored.includes('&lt;img src=x'));
  });

  test('the loading skeleton marks the header inert so a cached snapshot cannot be clicked', async () => {
    const loading = await litHtml(renderDetails(detailsVM({ loading: true, scopesPending: true })));
    assert.ok(loading.includes('class="details-header loading"'));
    const loaded = await litHtml(renderDetails(detailsVM({})));
    assert.ok(loaded.includes('class="details-header"'));
  });

  test('up-to-date and not-installed rows show no gear (Copy repo path dropped, item 7)', async () => {
    const upToDate = await litHtml(
      renderDetails(
        detailsVM({
          state: 'installed',
          installs: [
            {
              scope: 'global',
              version: '1',
              updateAvailable: false,
              clients: [],
              state: 'installed',
              kind: 'skill',
              name: 'grim-usage',
              viaBundles: [],
            },
          ],
        }),
      ),
    );
    assert.ok(!upToDate.includes('data-action="scope-gear"'), 'up-to-date direct row: gear hidden');
    assert.ok(!upToDate.includes('>Copy repo path<'), 'Copy repo path gone from scope rows');
    const notInstalled = await litHtml(renderDetails(detailsVM()));
    assert.ok(!notInstalled.includes('data-action="scope-gear"'), 'not-installed row: gear hidden');
    assert.ok(!notInstalled.includes('>Copy repo path<'));
  });

  test('viaBundles no longer trims the gear menu — Uninstall/version-switch never lived there', async () => {
    const viaBundle = await litHtml(
      renderDetails(
        detailsVM({
          state: 'outdated',
          installs: [
            {
              scope: 'global',
              version: '1',
              updateAvailable: true,
              clients: [],
              state: 'outdated',
              kind: 'skill',
              name: 'grim-usage',
              viaBundles: ['ghcr.io/grimoire-rs/bundles/grim-essentials'],
            },
          ],
        }),
      ),
    );
    // The gear still offers Update regardless of viaBundles; the bundle state is
    // carried by the disabled split button beside it, not the gear.
    assert.ok(viaBundle.includes('data-action="update"'));
    assert.ok(!viaBundle.includes('<button class="menu-item" disabled'));
  });

  test('installed row has exactly one split button, labeled Uninstall, with a "Switch Version" menu item carrying data-scope', async () => {
    const html = await litHtml(
      renderDetails(
        detailsVM({
          // No project workspace open, so only the (installed) global row renders —
          // isolates the row's own split-button count from the sibling row's.
          scopes: { projectOpen: false, projectConfigured: false, projectName: null },
          state: 'installed',
          installs: [
            {
              scope: 'global',
              version: '1',
              updateAvailable: false,
              clients: [],
              state: 'installed',
              kind: 'skill',
              name: 'grim-usage',
              viaBundles: [],
            },
          ],
        }),
      ),
    );
    assert.strictEqual(html.match(/class="split-button sm"/g)?.length, 1);
    assert.ok(html.includes('>Uninstall<'));
    assert.ok(
      html.includes(
        'data-action="uninstall" data-kind="skill" data-name="grim-usage" data-scope="global"',
      ),
    );
    assert.ok(html.includes('Switch Version'));
    assert.ok(
      html.includes(
        'data-action="pick-version" data-repo="ghcr.io/grimoire-rs/skills/grim-usage" data-scope="global"',
      ),
    );
  });

  test('a hostile repo stays inert in the scope-row Uninstall chevron', async () => {
    const html = await litHtml(
      renderDetails(
        detailsVM({
          repo: '"><img src=x onerror=alert(1)>/skills/evil',
          state: 'installed',
          installs: [
            {
              scope: 'global',
              version: '1',
              updateAvailable: false,
              clients: [],
              state: 'installed',
              kind: 'skill',
              name: 'grim-usage',
              viaBundles: [],
            },
          ],
        }),
      ),
    );
    assert.ok(!html.includes('<img src=x'));
    assert.ok(html.includes('&lt;img src=x'));
  });

  test('hostile install kind/name stay inert in the scope-row Uninstall button attributes', async () => {
    const html = await litHtml(
      renderDetails(
        detailsVM({
          state: 'installed',
          installs: [
            {
              scope: 'global',
              version: '1',
              updateAvailable: false,
              clients: [],
              state: 'installed',
              kind: '"><img src=x onerror=alert(1)>',
              name: '"><img src=x onerror=alert(1)>',
              viaBundles: [],
            },
          ],
        }),
      ),
    );
    assert.ok(!html.includes('<img src=x'));
    assert.ok(html.includes('&lt;img src=x'));
    assert.ok(html.includes('data-action="uninstall"'));
  });

  test('scope rows carry the project/global icons (design 2a)', async () => {
    const html = await litHtml(
      renderDetails(
        detailsVM({
          state: 'installed',
          installs: [
            {
              scope: 'project',
              version: '1.4.2',
              updateAvailable: false,
              clients: [],
              state: 'installed',
              kind: 'skill',
              name: 'grim-usage',
              viaBundles: [],
            },
            {
              scope: 'global',
              version: '1.5.0',
              updateAvailable: false,
              clients: [],
              state: 'installed',
              kind: 'skill',
              name: 'grim-usage',
              viaBundles: [],
            },
          ],
        }),
      ),
    );
    assert.ok(html.includes('codicon-root-folder scope-icon'));
    assert.ok(html.includes('codicon-globe scope-icon'));
    assert.ok(html.includes('scope-box'));
  });

  test('tag list past six chips collapses behind +N more', async () => {
    const html = await litHtml(renderDetails(detailsVM({ tags: ['1', '2', '3', '4', '5', '6', '7', '8'] })));
    assert.ok(html.includes('tag-overflow'));
    assert.ok(html.includes('data-action="toggle-tags"'));
    assert.ok(html.includes('+2 more'));
  });

  test('mcp CONTENTS renders a full-width highlighted JSON block, no markdown (item 6)', async () => {
    const html = await litHtml(
      renderDetails(detailsVM({ kind: 'mcp', contentMarkdown: null, contentJson: '{"command": "grim"}' })),
    );
    assert.ok(html.includes('class="json-code"'), 'full-width json block present');
    assert.ok(html.includes('json-key'), 'keys are tokenized');
    assert.ok(!html.includes('id="md-contents"'), 'mcp bypasses markdown-it for CONTENTS');
  });
});

suite('json highlighting (item 6)', () => {
  test('tokenizes keys, strings, numbers, booleans and null', () => {
    const html = highlightJson('{"a": "x", "n": 12, "b": true, "z": null}');
    assert.ok(html.includes('<span class="json-key">&quot;a&quot;</span>'));
    assert.ok(html.includes('<span class="json-string">&quot;x&quot;</span>'));
    assert.ok(html.includes('<span class="json-number">12</span>'));
    assert.ok(html.includes('<span class="json-boolean">true</span>'));
    assert.ok(html.includes('<span class="json-null">null</span>'));
    assert.ok(html.includes('<span class="json-punct">{</span>'));
  });

  test('a hostile string value stays escaped inside its span', () => {
    const html = highlightJson('{"x": "</span><script>alert(1)</script>"}');
    assert.ok(!html.includes('<script>'), 'no live script tag');
    assert.ok(!html.includes('</span><script>'), 'cannot break out of the span');
    assert.ok(html.includes('&lt;/span&gt;&lt;script&gt;'), 'content is escaped in place');
  });

  test('malformed JSON is escaped wholesale rather than emitting raw markup', () => {
    const html = highlightJson('{"x": <img src=x onerror=alert(1)>');
    assert.ok(!html.includes('<img src=x'));
    assert.ok(html.includes('&lt;img src=x'));
  });
});

suite('createMarkdown (details webview factory)', () => {
  test('svg data: URIs survive into <img src> (default allowlist blocks svg)', () => {
    const md = createMarkdown();
    const html = md.render('![x](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)');
    assert.match(html, /<img src="data:image\/svg\+xml;base64,PHN2Zz48L3N2Zz4="/);
    // A raster data URI still works (default behavior preserved).
    assert.match(
      md.render('![y](data:image/png;base64,QUJD)'),
      /<img src="data:image\/png;base64,QUJD"/,
    );
  });

  test('javascript: links are still neutralized', () => {
    const html = createMarkdown().render('[click](javascript:alert(1))');
    assert.ok(!html.includes('href="javascript:'), 'javascript: link dropped');
  });

  test('raw HTML stays inert (html:false)', () => {
    const html = createMarkdown().render("# t\n\n<script>alert('x')</script>");
    assert.ok(!html.includes("<script>alert('x')"));
    assert.ok(html.includes('&lt;script&gt;'));
  });
});

suite('revalidate indicator', () => {
  test('checking renders a spinning loader', async () => {
    const html = await litHtml(revalidateIndicator('checking'));
    assert.ok(html.includes('codicon-loading'));
    assert.ok(html.includes('codicon-modifier-spin'));
  });

  test('done renders a check', async () => {
    assert.ok((await litHtml(revalidateIndicator('done'))).includes('codicon-check'));
  });

  test('failed renders a warning with a native title', async () => {
    const html = await litHtml(revalidateIndicator('failed'));
    assert.ok(html.includes('codicon-warning'));
    assert.ok(html.includes('title="Refresh failed'));
  });

  test('failed with a message is an actionable button carrying the escaped message', async () => {
    const html = await litHtml(revalidateIndicator('failed', '401 from registry'));
    assert.ok(html.includes('data-action="revalidate-error"'));
    assert.ok(html.includes('title="401 from registry"'));
    // checking/done never carry the action.
    assert.ok(!(await litHtml(revalidateIndicator('checking'))).includes('data-action'));
    assert.ok(!(await litHtml(revalidateIndicator('done'))).includes('data-action'));
  });

  test('a hostile failed message stays inert in the title attribute', async () => {
    const html = await litHtml(revalidateIndicator('failed', '"><img src=x onerror=alert(1)>'));
    assert.ok(!html.includes('"><img src=x'));
    assert.ok(html.includes('&quot;&gt;&lt;img src=x'), 'the message is attr-escaped');
  });

  test('null clears the indicator', async () => {
    assert.strictEqual(await litString(revalidateIndicator(null)), '');
  });

  test('renderDetails always carries the empty host container (survives re-render)', async () => {
    assert.ok((await litHtml(renderDetails(detailsVM()))).includes('id="revalidate-indicator"'));
    assert.ok((await litHtml(renderDetails(detailsVM({ loading: true })))).includes('id="revalidate-indicator"'));
  });
});
