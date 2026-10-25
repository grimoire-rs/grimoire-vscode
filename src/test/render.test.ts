import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  buildCards,
  buildTree,
  collectNodeIds,
  DEFAULT_FILTER,
  DEFAULT_INSTALLED_FILTER,
  DEFAULT_VIEW,
  estimatedRowHeight,
  viewForTab,
  windowRows,
  type FlatRow,
  type ScopeStatus,
} from '../webview/model';
import { createMarkdown } from '../webview/markdown';
import {
  esc,
  formatDate,
  highlightJson,
  kindIcon,
  MAX_TREE_DEPTH,
  prepareResults,
  renderCard,
  renderCardContextMenu,
  renderCompactRow,
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
  type ResultsWindow,
} from '../webview/render';
import type { CardVM, GrimOrigin, SidebarState, ViewOptions } from '../webview/protocol';
import { litString } from './litString';
import { normalizeHtml } from './normalizeHtml';
import {
  bothInstalled,
  card,
  detailsVM,
  installedScope,
  outdatedCard,
  searchItem,
  sidebarState,
} from './fixtures/vms';

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

  test('compact rows and tree nodes escape a hostile repo path', async () => {
    // Namespace rows print segments of the repo, which is registry-sourced —
    // the one place the tree renders text the card never did.
    const repo = 'ghcr.io/"><img src=x onerror=alert(1)>/skills/<script>alert(1)</script>';
    const items = buildCards([searchItem({ repo })], []);
    const state = sidebarState({ items });
    const compact = await litHtml(
      renderSidebarResults(state, DEFAULT_FILTER, { ...DEFAULT_VIEW, density: 'compact' }),
    );
    assert.ok(!compact.includes('<script>alert(1)'), 'no live script in a compact row');
    assert.ok(!compact.includes('<img src=x'), 'no live img in the row attributes');
    const treeView = { ...DEFAULT_VIEW, density: 'compact' as const, mode: 'tree' as const };
    const expanded = new Set(collectNodeIds(buildTree(items, {})));
    const tree = await litHtml(renderSidebarResults(state, DEFAULT_FILTER, treeView, expanded));
    assert.ok(!tree.includes('<script>alert(1)'), 'no live script in a tree node label');
    assert.ok(!tree.includes('<img src=x'), 'no live img in a tree node');
    assert.ok(tree.includes('&lt;script&gt;'), 'it is there, escaped');
  });

  test('publisher markdown bodies render inert in the server-side paint', async () => {
    // renderDetails renders the three markdown slots itself now (the host inlines
    // that same output into webview.html for the first paint), so publisher
    // markdown reaches the initial document instead of only the booted webview.
    // markdown-it runs html:false, which is what keeps it inert — this pins that
    // the new render path did not become an unescaped one.
    const hostile = [
      '# Title',
      '',
      '<script>alert(1)</script>',
      '',
      '<img src=x onerror="alert(1)">',
      '',
      '[click](javascript:alert(1))',
    ].join('\n');
    const html = await litHtml(
      renderDetails(
        detailsVM({
          readmeMarkdown: hostile,
          contentMarkdown: hostile,
          changelogMarkdown: hostile,
        }),
      ),
    );
    assert.ok(!html.includes('<script>alert(1)'), 'no live script from a README');
    assert.ok(html.includes('&lt;script&gt;'), 'it is there, escaped');
    assert.ok(!html.includes('onerror="alert(1)"'), 'no live handler from a README');
    assert.ok(!html.includes('href="javascript:'), 'markdown-it neutralizes javascript: links');
    assert.ok(html.includes('<h1>Title</h1>'), 'and real markdown still renders');
  });

  test('a hostile registry-sourced deprecation message stays escaped in the card name tooltip', async () => {
    const hostile = '"><script>alert(1)</script>';
    const html = await litHtml(renderCard(card({ state: 'deprecated', deprecated: hostile })));
    assert.ok(!html.includes('"><script>'));
    const escaped = '&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;';
    assert.ok(html.includes(`title="${escaped}"`), 'attribute position stays escaped');
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

suite('download counts', () => {
  test('a counted card shows a compact badge and the exact figure in its tooltip', async () => {
    const html = await litHtml(
      renderCard(card({ downloads: { total: 1416, asOf: '2026-09-10T21:48:47Z', versions: [] } })),
    );
    assert.ok(html.includes('downloads-badge'), 'badge rendered');
    // Lucide's arrow-down-to-line, the index site's own glyph — matched by its
    // distinctive baseline path so a codicon swap cannot pass this silently.
    assert.ok(html.includes('M19 21H5'), 'lucide arrow-down-to-line, not a codicon');
    assert.ok(!html.includes('codicon-cloud-download'), 'no codicon fallback left behind');
    assert.ok(html.includes('1.4K'), `compact figure on the badge: ${html}`);
    assert.ok(html.includes('1,416'), 'exact figure survives in the tooltip');
    assert.ok(html.includes('as of'), 'the tooltip dates the count');
  });

  test('an uncounted card renders no badge — absent is unknown, never zero', async () => {
    const html = await litHtml(renderCard(card()));
    assert.ok(!html.includes('downloads-badge'), 'no badge without a count');
    assert.ok(!html.includes('codicon-cloud-download'));
  });

  test('a zero count still renders — the producer measured it', async () => {
    const html = await litHtml(
      renderCard(card({ downloads: { total: 0, asOf: null, versions: [] } })),
    );
    assert.ok(html.includes('downloads-badge'), 'zero is a measurement, not an absence');
  });

  test('the rail panel survives an unrated artifact — the two signals are independent', async () => {
    // Its own panel, not a row inside RATING: renderRatingPanel omits itself
    // entirely on an unrated row, which would take a counted-but-unrated
    // artifact's figure down with it.
    const html = await litHtml(
      renderDetails(
        detailsVM({
          rating: null,
          downloads: { total: 1416, asOf: '2026-09-10T21:48:47Z', versions: [] },
        }),
      ),
    );
    assert.ok(html.includes('DOWNLOADS'), 'the panel is present without a rating');
    assert.ok(html.includes('1,416'), 'the rail shows the exact figure, never the rounded one');
    assert.ok(!html.includes('as of'), 'the stamp stays in the badge tooltip, off the rail');
  });

  test('the displayed release stands beside the total; the rest of the breakdown is not shown', async () => {
    const html = await litHtml(
      renderDetails(
        detailsVM({
          latestVersion: '1.2.0',
          downloads: {
            total: 1416,
            asOf: null,
            versions: [
              { version: '1.2.0', total: 900 },
              { version: '1.1.0', total: 400 },
              { version: '1.0.0', total: 100 },
            ],
          },
        }),
      ),
    );
    assert.ok(html.includes('1,416') && html.includes('900'), 'total and the displayed release');
    assert.ok(
      !html.includes('400') && !html.includes('1.0.0'),
      'older releases stay out of the rail',
    );
  });

  test('a row with no displayed version leads with the highest release', async () => {
    // The index-backed case: an index is a phone book and carries no version
    // data, so nothing matches `latestVersion` and grim orders the breakdown
    // highest first.
    const html = await litHtml(
      renderDetails(
        detailsVM({
          latestVersion: null,
          downloads: {
            total: 1416,
            asOf: null,
            versions: [
              { version: '1.2.0', total: 900 },
              { version: '1.1.0', total: 400 },
            ],
          },
        }),
      ),
    );
    assert.ok(html.includes('1.2.0') && html.includes('900'), 'the highest release leads');
    assert.ok(!html.includes('1.1.0'), 'the older one is not shown');
  });

  test('no breakdown renders the total alone', async () => {
    const html = await litHtml(
      renderDetails(detailsVM({ downloads: { total: 12, asOf: null, versions: [] } })),
    );
    assert.ok(html.includes('DOWNLOADS') && html.includes('12'));
    assert.strictEqual(html.split('dl-count').length - 1, 1, 'the total is the only figure');
  });

  test('an uncounted artifact renders no DOWNLOADS panel rather than an empty one', async () => {
    const html = await litHtml(renderDetails(detailsVM({ downloads: null })));
    assert.ok(!html.includes('DOWNLOADS'), 'uncounted is the common case; an empty panel is noise');
  });
});

suite('card rendering', () => {
  test('codicon per kind', () => {
    assert.strictEqual(kindIcon('skill'), 'sparkle');
    assert.strictEqual(kindIcon('rule'), 'law');
    assert.strictEqual(kindIcon('agent'), 'agent');
    assert.strictEqual(kindIcon('mcp'), 'mcp');
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
    const html = await litHtml(
      renderCard(card({ state: 'deprecated', deprecated: 'use x instead' })),
    );
    assert.ok(
      html.includes('class="card-btn secondary" data-action="install"'),
      'native secondary button',
    );
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
    assert.ok(
      html.includes('class="card-btn" data-action="update"'),
      'native card button, not a web component',
    );
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
    assert.ok(
      html.includes('installed-chip-check'),
      'leading check on the installed chip (item 10)',
    );
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
    assert.ok(!html.includes('codicon-globe'), 'one chip only — the effective scope');
    // The SCOPE chip still carries no version — it says where, not which. The
    // version lives in the title chip, and it is the PROJECT install's (the
    // effective one), so switching that install's version moves the number.
    assert.ok(!html.includes('installed-chip-scope">Project</span><span class="version'));
    assert.ok(html.includes('<span class="version mono">1.4.2</span>'));
  });

  test('a hostile install version is escaped in the title chip', async () => {
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
    assert.ok(!html.includes('<img src=x'), 'never live markup');
    assert.ok(html.includes('&lt;img src=x'), 'rendered as text through lit-html escaping');
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
    assert.ok(
      !html.includes('drift-badge'),
      'no drift on an install with no clients_missing/clients_extra',
    );
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

  test('compact row slot ranks pending below an update and below real drift', async () => {
    const base = {
      scope: 'project' as const,
      version: '1.4.2',
      updateAvailable: false,
      clients: ['claude'],
      state: 'installed',
      kind: 'skill',
      name: 'grim-usage',
      viaBundles: [],
      outputsPending: [{ client: 'cursor', path: '/repo/.cursor/skills/grim-usage' }],
    };
    const slot = async (install: Record<string, unknown>): Promise<string> =>
      litHtml(renderCompactRow(card({ state: 'installed', installs: [install as never] })));

    assert.ok((await slot(base)).includes('row-pending'), 'pending alone shows the info glyph');
    assert.ok(
      (await slot({ ...base, updateAvailable: true })).includes('row-action update'),
      'an update outranks a pending hint',
    );
    assert.ok(
      (await slot({ ...base, state: 'modified' })).includes('row-warn'),
      'real drift outranks a pending hint',
    );
    assert.ok(
      (await slot({ ...base, outputsPending: [] })).includes('row-dot'),
      'nothing pending falls through to the installed dot',
    );
  });

  test('compact row slot warns on an unarmed hook, ignoring clients with no hook surface', async () => {
    const base = {
      scope: 'project' as const,
      version: '1.0.0',
      updateAvailable: false,
      clients: ['claude'],
      state: 'gated',
      kind: 'hook',
      name: 'shell-guard',
      viaBundles: [],
    };
    const slot = async (install: Record<string, unknown>): Promise<string> =>
      litHtml(renderCompactRow(card({ state: 'installed', installs: [install as never] })));

    const gated = await slot({
      ...base,
      arming: [
        { client: 'claude', cause: 'workspace-not-consented', message: 'run grim hook allow' },
        { client: 'zed', cause: 'client-has-no-hook-surface', message: 'zed has no hooks' },
      ],
    });
    assert.ok(gated.includes('row-warn'), 'a gated hook shows the warning glyph');
    assert.ok(gated.includes('claude: run grim hook allow'), 'tooltip carries grim message');
    assert.ok(!gated.includes('zed has no hooks'), 'declined client is not a warning');
    assert.ok(
      (
        await slot({
          ...base,
          arming: [{ client: 'zed', cause: 'client-has-no-hook-surface', message: 'x' }],
        })
      ).includes('row-dot'),
      'only declined clients falls through to the installed dot',
    );
  });

  test('scope-variant card shows a pending badge iff outputs_pending is non-empty', async () => {
    const installed = {
      scope: 'project' as const,
      version: '1.4.2',
      updateAvailable: false,
      clients: ['claude'],
      state: 'installed',
      kind: 'skill',
      name: 'grim-usage',
      viaBundles: [],
    };
    const withPending = await litHtml(
      renderCard(
        card({
          state: 'installed',
          installs: [
            {
              ...installed,
              outputsPending: [{ client: 'cursor', path: '/repo/.cursor/skills/grim-usage' }],
            },
          ],
        }),
        { variant: 'scope', scope: 'project' },
      ),
    );
    assert.ok(withPending.includes('pending-badge'));
    assert.ok(withPending.includes('codicon-info'), 'info glyph, not a warning');
    assert.ok(!withPending.includes('codicon-warning'), 'never badged as damage');
    assert.ok(
      withPending.includes('/repo/.cursor/skills/grim-usage'),
      'tooltip names the path an install would write',
    );

    const none = await litHtml(
      renderCard(card({ state: 'installed', installs: [{ ...installed, outputsPending: [] }] }), {
        variant: 'scope',
        scope: 'project',
      }),
    );
    assert.ok(!none.includes('pending-badge'), 'an empty array renders no badge');
  });

  test('deprecated card marks the name only — no warning line', async () => {
    const html = await litHtml(
      renderCard(card({ state: 'deprecated', deprecated: 'use x instead', description: 'desc' })),
    );
    // The struck/dimmed name is the whole signal (.card.deprecated .card-name).
    assert.ok(html.includes('class="card deprecated"'));
    assert.ok(!html.includes('deprecated-msg'), 'no coloured deprecation line on cards');
    assert.ok(!html.includes('codicon-warning'));
    assert.ok(html.includes('title="use x instead"'), 'message survives as a tooltip');
    assert.ok(html.includes('desc'), 'description keeps its slot');
  });

  test('a card without deprecation emits no title attribute', async () => {
    const html = await litHtml(renderCard(card({ deprecated: null })));
    assert.ok(!html.includes('<span class="card-name" title='));
  });

  test('replacedBy adds nothing to a card — the details banner owns the switch', async () => {
    const html = await litHtml(
      renderCard(
        card({
          state: 'deprecated',
          deprecated: 'use x instead',
          replacedBy: 'ghcr.io/grimoire-rs/skills/new-skill',
        }),
      ),
    );
    assert.ok(!html.includes('data-action="open-details"'));
    assert.ok(!html.includes('new-skill'));
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
      renderSidebar(sidebarState({ phase: 'loading', defaultRegistry: 'ghcr.io' }), DEFAULT_FILTER),
    );
    assert.ok(html.includes('Refreshing from ghcr.io'));
    assert.ok(html.includes('codicon-sync'));
    // Unknown default registry still shows a footer — plain "Refreshing…",
    // never "null" and never an empty swap (#38).
    const noHost = await litHtml(renderSidebar(sidebarState({ phase: 'loading' }), DEFAULT_FILTER));
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
    assert.ok(
      !html.includes('filter-registry'),
      'search spans all registries — no registry filter',
    );
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
    assert.strictEqual(
      await litString(renderSidebarFooter(sidebarState({ phase: 'no-grim' }))),
      '',
    );
  });

  test('tab bar: three tabs, active underline, updates count, hidden on no-grim', async () => {
    const outdated = outdatedCard();
    const html = await litHtml(
      renderSidebarTabs(sidebarState({ mode: 'updates', installedItems: [outdated] })),
    );
    assert.ok(html.includes('sidebar-tabs'));
    for (const tab of ['browse', 'updates', 'installed']) {
      assert.ok(html.includes(`data-action="set-tab" data-tab="${tab}"`), tab);
    }
    assert.match(html, /class="tab active"[^>]*data-tab="updates"/);
    assert.ok(
      html.includes('<span class="tab-count">1</span>'),
      'outdated count on the Updates tab',
    );
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
      renderSidebarResults({ ...unconfigured, mode: 'installed' }, DEFAULT_FILTER),
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
    // Catalog cards still render — the catalog loaded fine. The item's own
    // data-repo, not `class="card`: that also matches the `class="cards"`
    // container, which renders even over the empty state.
    assert.ok(
      html.includes('data-repo="ghcr.io/grimoire-rs/skills/grim-usage"'),
      `the browse card renders: ${html}`,
    );
    assert.ok(!html.includes('No artifacts found'), 'not the empty state');
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

  test('the Updates pill reads "?" when install state is unknown, so it can never contradict the frozen badge', async () => {
    // The native view badge is deliberately left at its last known value while
    // status is unavailable; the tab pill counts `installedItems`, which is
    // empty for want of data. A count of 0 (no pill) beside a badge of 1 is two
    // surfaces stating different things about the same fact — the pill has to
    // say "unknown" instead. This is the invariant a deleted extension.test.ts
    // assertion used to protect.
    const unknown = await litHtml(
      renderSidebarTabs(sidebarState({ installStateUnknown: 'grim status failed' })),
    );
    assert.ok(unknown.includes('tab-count'), 'the pill still renders — absence would read as zero');
    // The pill carries an accessible label/title (a bare "?" is opaque to a
    // screen reader) — hence the attribute-tolerant match.
    assert.match(
      unknown,
      /<span[^>]*class="tab-count"[^>]*>\?<\/span>/,
      'the pill reads "?", not a count it cannot know',
    );
    assert.ok(unknown.includes('aria-label="update count unavailable"'), 'the ? pill is labelled');
    assert.ok(!/class="tab-count"[^>]*>\d/.test(unknown), 'never a number while unknown');

    // With install state known, the pill is a plain count again (and absent at
    // zero) — the "?" is strictly the unknown case.
    const outdated = outdatedCard();
    const known = await litHtml(renderSidebarTabs(sidebarState({ installedItems: [outdated] })));
    assert.ok(known.includes('<span class="tab-count">1</span>'));
    assert.ok(!(await litHtml(renderSidebarTabs(sidebarState()))).includes('tab-count'));
  });

  test('the unknown-install-state banner escapes its message', async () => {
    const html = await litHtml(
      renderSidebarNotice(sidebarState({ installStateUnknown: '<img src=x onerror=alert(1)>' })),
    );
    assert.ok(!html.includes('<img'), html);
    assert.ok(html.includes('&lt;img'), html);
  });

  test('the banner remedy gates on reason AND origin (A4)', async () => {
    const remedy = (
      reason: 'too-old' | 'status-failed' | 'probe-failed',
      origin: GrimOrigin,
    ): Promise<string> =>
      litHtml(
        renderSidebarNotice(
          sidebarState({
            installStateUnknown: 'grim is not usable',
            installStateUnknownReason: reason,
            installStateUnknownOrigin: origin,
          }),
        ),
      );
    // Install grim only when a too-old binary is one the extension can replace.
    for (const origin of ['bundled', 'missing'] as const) {
      const html = await remedy('too-old', origin);
      assert.ok(html.includes('data-action="install-grim"'), `too-old + ${origin} → Install grim`);
      assert.ok(!html.includes('data-action="show-grim-info"'), origin);
    }
    // A too-old grim on PATH / from the setting keeps being preferred, so a
    // download changes nothing → diagnostics instead of the no-op loop.
    for (const origin of ['PATH', 'setting'] as const) {
      const html = await remedy('too-old', origin);
      assert.ok(!html.includes('data-action="install-grim"'), `too-old + ${origin} → no Install`);
      assert.ok(html.includes('data-action="show-grim-info"'), `${origin} → Show grim Info`);
    }
    // A non-too-old failure is never install-fixable, whatever the origin.
    for (const reason of ['status-failed', 'probe-failed'] as const) {
      const html = await remedy(reason, 'bundled');
      assert.ok(!html.includes('data-action="install-grim"'), `${reason} → no Install grim`);
      assert.ok(html.includes('data-action="show-grim-info"'), `${reason} → Show grim Info`);
    }
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
      declared: { 'skill:grim-usage': 'ghcr.io/grimoire-rs/skills/grim-usage:1.4.2' },
    };
    const items = buildCards([searchItem()], [scope]);
    const html = await litHtml(
      renderSidebar(sidebarState({ mode: 'updates', items }), DEFAULT_FILTER),
    );
    assert.ok(html.includes('card-delta'), 'update-row variant');
    assert.ok(!html.includes('section-header'), 'no in-webview sections — the workbench owns them');
    assert.ok(
      !html.includes('data-action="update-all"'),
      'Update All is a native view/title button',
    );
    assert.ok(!html.includes('id="search"'), 'Updates view has no search box');
    assert.strictEqual(
      await litString(
        renderSidebarFilters(sidebarState({ mode: 'updates', items }), DEFAULT_FILTER),
      ),
      '',
      'Updates has no kind chips',
    );
    assert.ok(
      !html.includes('data-action="set-density"'),
      'the view controls are title-bar actions now, not webview chrome',
    );
  });

  test('updates list ignores the Browse kind filter, so it matches the tab count', async () => {
    // main.ts hands this tab BROWSE's filter (activeFilter falls through to it
    // for any tab but Installed) and Browse's chips persist across reloads, so
    // filtering here showed "1" on the pill over "Everything is up to date."
    const view = viewForTab(sidebarState({ installedItems: [outdatedCard()] }), 'updates', '');
    const results = await litHtml(
      renderSidebarResults(view, { ...DEFAULT_FILTER, kinds: ['rule'] }),
    );
    assert.ok(results.includes('card-delta'), 'the outdated skill survives a rule-only chip');
    assert.ok(!results.includes('Everything is up to date.'), 'not the empty state');
    assert.ok(
      (await litHtml(renderSidebarTabs(view))).includes('<span class="tab-count">1</span>'),
      'and the pill counts exactly the row that rendered',
    );
  });

  test('installed view: scope groups + Kind chips, no sections (item 8)', async () => {
    const items = buildCards([searchItem()], [installedScope('project')]);
    const html = await litHtml(
      renderSidebar(
        sidebarState({ mode: 'installed', items }),
        DEFAULT_FILTER,
        DEFAULT_VIEW,
        new Set(['project']),
      ),
    );
    assert.ok(html.includes('data-action="menu"'), 'scope-variant card (manage gear)');
    assert.ok(!html.includes('section-header') && !html.includes('data-section-id'), 'no sections');
    assert.ok(html.includes('<span class="chip-group-label">KIND</span>'));
    assert.ok(html.includes('data-node="project"'), 'a Project group header');
    assert.ok(!html.includes('set-scope'), 'the SCOPE toggle it replaced is gone');
    assert.ok(html.includes('Search installed…'), 'installed view keeps a search box');
  });

  test('installed view: no SCOPE toggle — the filter row is the Kind chips alone', async () => {
    const filters = await litHtml(
      renderSidebarFilters(sidebarState({ mode: 'installed' }), DEFAULT_FILTER),
    );
    assert.ok(
      !filters.includes('set-scope'),
      'the scope toggle is gone (scope grouping replaced it)',
    );
    assert.ok(filters.includes('data-action="toggle-kind"'), 'Kind chips stay');
  });

  test('installed view groups by scope and shows both scopes at once', async () => {
    const items = buildCards([searchItem()], [installedScope('project')]); // project install only
    const collapsed = await litHtml(
      renderSidebarResults(sidebarState({ mode: 'installed', items }), DEFAULT_FILTER),
    );
    assert.ok(
      collapsed.includes('data-action="toggle-node" data-key="g:project" data-node="project"'),
      'a Project group header, not a toggle',
    );
    assert.ok(!collapsed.includes('data-action="menu"'), 'collapsed group renders no rows');
    const expanded = await litHtml(
      renderSidebarResults(
        sidebarState({ mode: 'installed', items }),
        DEFAULT_FILTER,
        DEFAULT_VIEW,
        new Set(['project']),
      ),
    );
    assert.ok(expanded.includes('data-action="menu"'), 'expanded group renders its cards');
    assert.ok(
      !expanded.includes('data-node="global"'),
      'an empty scope contributes no header at all',
    );
  });

  test('empty installed view says nothing is installed; Updates its own (item 8)', async () => {
    const none = await litHtml(
      renderSidebarResults(sidebarState({ mode: 'installed', items: [] }), DEFAULT_FILTER),
    );
    assert.ok(none.includes('Nothing installed.'));
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
    assert.ok(
      !html.includes('data-action="toggle-installed"'),
      'no Installed filter chip (item 4)',
    );
    assert.ok(!html.includes('data-action="set-scope"'), 'no scope filter in browse');
    assert.ok(!html.includes('filter-registry'), 'search spans all registries');
  });
});

suite('sidebar split rendering (item 3)', () => {
  test('search row carries only the textfield, no filters or cards', async () => {
    const html = await litHtml(
      renderSidebarSearch(sidebarState({ items: buildCards([searchItem()], []) })),
    );
    assert.ok(html.includes('vscode-textfield id="search"'));
    assert.ok(!html.includes('kind-chips'));
    assert.ok(!html.includes('class="card'));
  });

  test('the sort control rides the search row, selection following the filter', async () => {
    const asc = await litHtml(
      renderSidebarSearch(sidebarState(), { ...DEFAULT_FILTER, sort: 'rating', dir: 'asc' }),
    );
    assert.ok(asc.includes('class="sort-group"'), 'the pair sits in the search row');
    assert.ok(
      asc.includes('<option selected value="rating">'),
      'the picked field is the selected option',
    );
    assert.ok(asc.includes('value="relevance"'), "Browse offers grim's own ranking");
    assert.ok(asc.includes('m3 8 4-4 4 4'), 'ascending draws the up arrow over rising bars');
    const desc = await litHtml(
      renderSidebarSearch(sidebarState(), { ...DEFAULT_FILTER, sort: 'rating', dir: 'desc' }),
    );
    assert.ok(desc.includes('m3 16 4 4 4-4'), 'descending flips the glyph, not just a label');
    assert.ok(
      desc.includes('aria-label="Descending — click for ascending"'),
      'and says which way it is sorted, not only which way the click goes',
    );
  });

  test('Installed drops the relevance option — grim status ranks nothing', async () => {
    const installed = await litHtml(
      renderSidebarSearch(sidebarState({ mode: 'installed' }), DEFAULT_INSTALLED_FILTER),
    );
    assert.ok(!installed.includes('value="relevance"'), 'no order it could name');
    assert.ok(installed.includes('<option selected value="name">'), 'name-first instead');
  });

  test('search row placeholder tracks the mode; withheld in no-grim and Updates', async () => {
    assert.ok(
      (await litHtml(renderSidebarSearch(sidebarState({ mode: 'installed' })))).includes(
        'Search installed…',
      ),
    );
    assert.ok((await litHtml(renderSidebarSearch(sidebarState()))).includes('Search artifacts…'));
    assert.strictEqual(
      await litString(renderSidebarSearch(sidebarState({ phase: 'no-grim' }))),
      '',
    );
    assert.strictEqual(
      await litString(renderSidebarSearch(sidebarState({ mode: 'updates' }))),
      '',
      'Updates has no search row',
    );
  });

  test('filter row carries the kind chips, not the search textfield or cards', async () => {
    const html = await litHtml(
      renderSidebarFilters(sidebarState({ items: buildCards([searchItem()], []) }), DEFAULT_FILTER),
    );
    assert.ok(html.includes('kind-chips'));
    assert.ok(html.includes('data-action="toggle-kind"'));
    assert.ok(html.includes('<span class="chip-group-label">KIND</span>'), 'kind row is labeled');
    assert.ok(
      !html.includes('data-action="toggle-installed"'),
      'no Installed filter chip (item 4)',
    );
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
    assert.ok(
      allActive.includes('data-kind="hook"') && allActive.includes('codicon-symbol-event'),
      'hook chip carries its codicon',
    );
    // Two kinds selected → those chips active, All inactive.
    const multi = await litHtml(
      renderSidebarFilters(st, { ...DEFAULT_FILTER, kinds: ['skill', 'bundle'] }),
    );
    assert.ok(
      multi.includes('class="kind-chip active" data-action="toggle-kind" data-kind="skill"'),
    );
    assert.ok(
      multi.includes('class="kind-chip active" data-action="toggle-kind" data-kind="bundle"'),
    );
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
    assert.strictEqual(
      composedUnconfigured,
      await litHtml(renderSidebar(unconfigured, DEFAULT_FILTER)),
    );
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
    const html = await litHtml(
      renderSidebarSearch(sidebarState({ query: '"><img src=x onerror=alert(1)>' })),
    );
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
      renderDetails(
        detailsVM({ description: 'Drive the `grim` **CLI** — see [docs](https://grim.rs).' }),
      ),
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
    const html = await litHtml(
      renderDetails(detailsVM({ latestVersion: '1.5.0', tags: ['1.5.0', '1.4.2'] })),
    );
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
      renderDetails(
        detailsVM({ loading: true, scopesPending: true, latestVersion: null, installs: [] }),
      ),
    );
    assert.ok(noVersion.includes('header-version-pending'), 'version slot reserved');
  });

  test('inline skeleton escapes the repo (server-side first paint)', async () => {
    // The skeleton is inlined into the initial document (details host renderHtml),
    // so its one dynamic value — the repo — must be escaped like every render path.
    const html = await litHtml(
      renderDetails(
        detailsVM({
          loading: true,
          scopesPending: true,
          repo: '"><img src=x onerror=alert(1)>/skills/evil',
        }),
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
    assert.ok(
      html.includes(
        'data-action="uninstall" data-kind="skill" data-name="grim-usage" data-scope="global"',
      ),
    );
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
    assert.ok(
      html.includes(
        'data-action="uninstall" data-kind="skill" data-name="grim-usage" data-scope="global"',
      ),
    );
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
    assert.ok(
      html.includes('<button class="keyword-chip" data-action="search-tag" data-tag="cli"'),
    );
    assert.ok(html.includes('>cli</button>'));
    assert.ok(html.includes('data-tag="oci"'));
  });

  test('a hostile keyword stays inert in the tag button and its data attribute (item 2)', async () => {
    const html = await litHtml(
      renderDetails(detailsVM({ keywords: ['"><img src=x onerror=alert(1)>'] })),
    );
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
    assert.ok(
      actionsCell.indexOf('data-action="scope-gear"') < actionsCell.indexOf('via-bundle-btn'),
    );
    assert.ok(
      html.includes(
        '<button class="via-bundle-btn" data-action="open-details" data-repo="ghcr.io/grimoire-rs/bundles/grim-essentials"',
      ),
    );
    assert.ok(
      html.includes(
        '<span class="btn-label">Bundle</span><span class="codicon codicon-package"></span></button>',
      ),
    );
    assert.ok(
      html.includes(
        'title="Installed via bundle ghcr.io/grimoire-rs/bundles/grim-essentials — uninstall the bundle to remove it"',
      ),
    );
  });

  test('pending outputs: Complete Install leads the split button, the row reads "install incomplete"', async () => {
    const html = await litHtml(
      renderDetails(
        detailsVM({
          scopes: { projectOpen: false, projectConfigured: false, projectName: null },
          state: 'installed',
          installs: [
            {
              scope: 'global',
              version: '1.0.0',
              updateAvailable: false,
              clients: ['claude'],
              state: 'installed',
              kind: 'skill',
              name: 'grim-usage',
              viaBundles: [],
              outputsPending: [{ client: 'cursor', path: '/repo/.cursor/skills/grim-usage' }],
            },
          ],
        }),
      ),
    );
    assert.ok(
      html.includes('data-action="complete-install" data-scope="global"'),
      'Complete Install is the split-main, scoped',
    );
    assert.ok(html.includes('install incomplete'), 'the status cell says so');
    assert.ok(!html.includes('up to date'), 'and does not claim it is up to date');
    assert.ok(html.includes('/repo/.cursor/skills/grim-usage'), 'tooltip names the pending path');
    // Uninstall is still reachable, from the chevron menu.
    assert.ok(html.includes('<span class="menu-label">Uninstall</span>'));
  });

  test('an update outranks pending outputs on the scope row button', async () => {
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
              outputsPending: [{ client: 'cursor', path: '/repo/.cursor/skills/grim-usage' }],
            },
          ],
        }),
      ),
    );
    assert.ok(html.includes('data-action="update"'), 'Update still leads');
    assert.ok(!html.includes('data-action="complete-install"'), 'no competing primary action');
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
    assert.strictEqual(
      (html.match(/data-action="update"/g) ?? []).length,
      1,
      'Update once, not duplicated in the gear',
    );
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
    assert.ok(
      html.includes(
        '<span class="btn-label">Bundle</span><span class="codicon codicon-package"></span></button>',
      ),
    ); // fixed label regardless of hostile repo
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
    const html = await litHtml(
      renderDetails(detailsVM({ tags: ['1', '2', '3', '4', '5', '6', '7', '8'] })),
    );
    assert.ok(html.includes('tag-overflow'));
    assert.ok(html.includes('data-action="toggle-tags"'));
    assert.ok(html.includes('+2 more'));
  });

  test('mcp CONTENTS renders a full-width highlighted JSON block, no markdown (item 6)', async () => {
    const html = await litHtml(
      renderDetails(
        detailsVM({ kind: 'mcp', contentMarkdown: null, contentJson: '{"command": "grim"}' }),
      ),
    );
    assert.ok(html.includes('class="json-code"'), 'full-width json block present');
    assert.ok(html.includes('json-key'), 'keys are tokenized');
    assert.ok(!html.includes('id="md-contents"'), 'mcp bypasses markdown-it for CONTENTS');
  });

  // --- grim's curated annotations (grimoire#106) ---

  /** The rig's annotation showcase, as it reaches the VM. */
  const annotated = {
    authors: 'Grimoire Platform Team',
    vendor: 'Grimoire Manual Rig',
    homepage: 'https://grimoire.rs',
    documentation: 'https://grimoire.rs/publishing.html#metadata-descriptive',
    compatibility: 'claude>=2',
    support: {
      issues: 'https://github.com/grimoire-rs/grimoire/issues',
      chat: 'https://teams.microsoft.com/l/channel/manual-rig',
      contact: 'ai-platform@example.invalid',
      security: 'https://example.invalid/security',
    },
  };

  test('RESOURCES carries homepage, documentation, authors and vendor', async () => {
    const html = await litHtml(renderDetails(detailsVM(annotated)));
    assert.ok(html.includes('data-url="https://grimoire.rs"'), 'homepage is a link row');
    assert.ok(
      html.includes('data-url="https://grimoire.rs/publishing.html#metadata-descriptive"'),
      'documentation is a link row',
    );
    assert.ok(html.includes('codicon-book'), 'documentation gets the book codicon');
    assert.ok(html.includes('Grimoire Platform Team'), 'authors render');
    assert.ok(html.includes('codicon-organization'), 'authors get the organization codicon');
    assert.ok(html.includes('Grimoire Manual Rig'), 'vendor renders');
    // The source forge stays its own row — grim's `url` never replaces it.
    assert.ok(html.includes('Source repository'));
  });

  test('an artifact carrying ONLY documentation still gets a RESOURCES panel', async () => {
    // The widened early-out. Before it, `!sourceRepository && !license` returned
    // nothing and the documentation link was silently dropped.
    const html = await litHtml(
      renderDetails(
        detailsVM({
          sourceRepository: null,
          license: null,
          documentation: 'https://acme.example/docs',
        }),
      ),
    );
    assert.ok(html.includes('RESOURCES'), 'panel renders');
    assert.ok(html.includes('data-url="https://acme.example/docs"'));
  });

  test('RESOURCES is still omitted when every field is null', async () => {
    const html = await litHtml(renderDetails(detailsVM({ sourceRepository: null, license: null })));
    assert.ok(!html.includes('RESOURCES'), 'empty panels are omitted');
  });

  test('SUPPORT renders one row per channel, contact as a mailto link', async () => {
    const html = await litHtml(renderDetails(detailsVM(annotated)));
    assert.ok(html.includes('SUPPORT'), 'panel renders');
    assert.ok(html.includes('data-url="https://github.com/grimoire-rs/grimoire/issues"'));
    assert.ok(html.includes('data-url="https://teams.microsoft.com/l/channel/manual-rig"'));
    assert.ok(
      html.includes('data-url="mailto:ai-platform@example.invalid"'),
      'a bare address becomes a mailto link',
    );
    assert.ok(html.includes('data-url="https://example.invalid/security"'));
    // Every link leaves through the one sanctioned host action.
    assert.ok(!/<a [^>]*href="https?:/.test(html), 'no direct href out of the webview');
  });

  test('SUPPORT is omitted when every channel is null', async () => {
    const html = await litHtml(renderDetails(detailsVM()));
    assert.ok(!html.includes('SUPPORT'), 'most packages carry none — no empty panel');
  });

  test('a partial SUPPORT renders only the channels that are set', async () => {
    const html = await litHtml(
      renderDetails(
        detailsVM({
          support: {
            issues: 'https://acme.example/issues',
            chat: null,
            contact: null,
            security: null,
          },
        }),
      ),
    );
    assert.ok(html.includes('Issue tracker'));
    assert.ok(!html.includes('Chat'));
    assert.ok(!html.includes('Report a vulnerability'));
  });

  test('a contact page URL is labelled, not printed into the rail', async () => {
    const html = await litHtml(
      renderDetails(
        detailsVM({
          support: {
            issues: null,
            chat: null,
            contact: 'https://acme.example/very/long/support/portal/path',
            security: null,
          },
        }),
      ),
    );
    assert.ok(html.includes('>Contact</span>'), 'a URL contact gets a name');
    assert.ok(
      html.includes('data-url="https://acme.example/very/long/support/portal/path"'),
      'and still links to the value grim published',
    );
  });

  test('a non-address, non-URL contact renders as text, never a guessed link', async () => {
    const html = await litHtml(
      renderDetails(
        detailsVM({
          support: { issues: null, chat: null, contact: 'Ask in #platform', security: null },
        }),
      ),
    );
    assert.ok(html.includes('Ask in #platform'), 'it is shown');
    assert.ok(!html.includes('mailto:'), 'but no scheme is invented for it');
    assert.ok(!html.includes('data-action="open" data-url="Ask'), 'and it is not clickable');
  });

  test('compatibility renders on a skill that declares one', async () => {
    const html = await litHtml(renderDetails(detailsVM({ compatibility: 'claude>=2' })));
    assert.ok(html.includes('Compatibility'));
    assert.ok(html.includes('claude&gt;=2'), 'the value is escaped');
  });

  test('compatibility row is absent when grim reports none', async () => {
    // Skills-only annotation: an mcp or a bundle is null by construction, and a
    // permanent "Not provided" row there would be noise, not information.
    const html = await litHtml(renderDetails(detailsVM({ kind: 'mcp', compatibility: null })));
    assert.ok(!html.includes('Compatibility'));
  });

  test('hostile annotation values stay inert in the rail', async () => {
    const hostile = '"><img src=x onerror=alert(1)>';
    const html = await litHtml(
      renderDetails(
        detailsVM({
          authors: hostile,
          vendor: hostile,
          homepage: hostile,
          documentation: hostile,
          compatibility: hostile,
          support: { issues: hostile, chat: hostile, contact: hostile, security: hostile },
        }),
      ),
    );
    assert.ok(!html.includes('<img src=x'), 'no live img anywhere in the rail');
    assert.ok(!html.includes('"><img'), 'attribute position stays escaped');
    assert.ok(html.includes('&lt;img src=x'), 'it is there, escaped');
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
    assert.ok(
      (await litHtml(renderDetails(detailsVM({ loading: true })))).includes(
        'id="revalidate-indicator"',
      ),
    );
  });
});

suite('tree indentation', () => {
  // A namespace chain that branches at every level: each namespace holds a
  // package of its own beside the next namespace down, so the fold can never
  // join two of them and the tree is exactly as deep as the path. Fifteen
  // levels: past MAX_TREE_DEPTH, to pin the clamp as well as the steps below it.
  const CHAIN = Array.from({ length: 15 }, (_, i) => `lvl${i}`);
  const deepItems = () =>
    buildCards(
      CHAIN.map((_, i) =>
        searchItem({ repo: `registry.example/${CHAIN.slice(0, i + 1).join('/')}/pkg${i}` }),
      ),
      [],
    );

  test('every level gets its own indent class up to MAX_TREE_DEPTH, then the last one', async () => {
    // Regression: the classes used to stop at d5, so a registry branching down
    // to a sixth level (host/org/area/team/users/<user>/<kind>) drew those
    // nodes in their parent's column, and only the twisties told the levels
    // apart. The sole host is elided as the root, so lvl0 IS level 0.
    const items = deepItems();
    const treeView = { ...DEFAULT_VIEW, density: 'compact' as const, mode: 'tree' as const };
    const expanded = new Set(collectNodeIds(buildTree(items, {})));
    const html = await litHtml(
      renderSidebarResults(sidebarState({ items }), DEFAULT_FILTER, treeView, expanded),
    );
    const groups = [
      ...html.matchAll(
        /class="tree-node d(\d+)" data-action="toggle-node" data-key="[^"]*" data-node="([^"]+)"/g,
      ),
    ];
    assert.strictEqual(groups.length, CHAIN.length, 'one group row per namespace');
    for (const [, cls = '', id = ''] of groups) {
      const level = CHAIN.findIndex((segment) => id.endsWith(`/${segment}`));
      assert.notStrictEqual(level, -1, `unexpected group id ${id}`);
      assert.strictEqual(Number(cls), Math.min(level, MAX_TREE_DEPTH), `group ${id}`);
    }
    const leaves = [
      ...html.matchAll(
        /class="compact-row tree-leaf d(\d+)" data-key="[^"]*" data-repo="([^"]+)"/g,
      ),
    ];
    assert.strictEqual(leaves.length, CHAIN.length, 'one leaf row per package');
    for (const [, cls = '', repo = ''] of leaves) {
      // pkgN sits under lvlN, one level below it.
      const level = Number(/pkg(\d+)$/.exec(repo)?.[1]) + 1;
      assert.strictEqual(Number(cls), Math.min(level, MAX_TREE_DEPTH), `leaf ${repo}`);
    }
    assert.ok(html.includes('class="tree-node d6"'), 'the sixth level indents past the fifth');
    assert.ok(!html.includes(`d${MAX_TREE_DEPTH + 1}"`), 'nothing claims a class the CSS lacks');
  });

  test('sidebar.css defines one indent class per level, one step each', () => {
    // The class set lives in CSS and the clamp in TypeScript; this is the only
    // thing that keeps them from drifting apart. out/test/render.test.js runs
    // from out/test, so walk back up to the source tree like parity.test.ts.
    // A Windows checkout (core.autocrlf) hands back CRLF; the regex below wants LF.
    const css = fs
      .readFileSync(
        path.join(__dirname, '..', '..', 'src', 'webview', 'sidebar', 'sidebar.css'),
        'utf8',
      )
      .replace(/\r\n/g, '\n');
    const paddings = new Map<number, number>();
    for (const [, level = '', px = ''] of css.matchAll(
      /^\.d(\d+) \{\n {2}padding-left: (\d+)px;\n\}/gm,
    )) {
      paddings.set(Number(level), Number(px));
    }
    assert.deepStrictEqual(
      [...paddings.keys()].sort((a, b) => a - b),
      Array.from({ length: MAX_TREE_DEPTH + 1 }, (_, i) => i),
      'exactly .d0 through .d<MAX_TREE_DEPTH>',
    );
    const base = paddings.get(0) ?? NaN;
    const step = (paddings.get(1) ?? NaN) - base;
    assert.ok(step > 0, 'each level indents further than the one above');
    for (let level = 2; level <= MAX_TREE_DEPTH; level++) {
      assert.strictEqual(paddings.get(level), base + level * step, `.d${level} is one step deeper`);
    }
  });
});

suite('paged Browse rendering', () => {
  const paging = {
    token: 7,
    loaded: 2,
    total: 12_000,
    lowerBound: false,
    hasMore: true,
  };
  const items = [card({ repo: 'reg/a', name: 'a' }), card({ repo: 'reg/b', name: 'b' })];
  const partial = (overrides: Record<string, unknown> = {}): ReturnType<typeof sidebarState> =>
    sidebarState({
      items,
      registries: [],
      paging: { ...paging, ...overrides },
    });
  const results = async (state: ReturnType<typeof sidebarState>): Promise<string> =>
    litHtml(renderSidebarResults(state, DEFAULT_FILTER));

  test('a complete result keeps the plain summary and shows no progress', async () => {
    const done = await results(partial({ total: 2, hasMore: false }));
    assert.match(done, /2 results in 1 registry/);
    assert.ok(!done.includes('role="status"'));
    assert.ok(!done.includes('Loading'));
  });

  test('a loading result states its progress, quietly, and has no next-page control', async () => {
    const html = await results(partial());
    assert.match(
      html,
      /<div[^>]*class="result-summary"[^>]*role="status"[^>]*>Loading 2 of 12,000…<\/div>/,
    );
    assert.match(html, /aria-live="off"/, 'thirty announcements would be noise');
    assert.match(html, /aria-busy="true"/);
    assert.ok(!html.includes('load-more'), 'nothing to press: pages load by themselves');
    assert.ok(!html.includes('retry'), 'no Retry while nothing has failed');
  });

  test('a failed load shows an alert and a Retry that keeps the rows', async () => {
    const html = await results(partial({ failed: true }));
    assert.match(html, /Stopped at 2 of 12,000\./);
    assert.match(
      html,
      /<span[^>]*role="alert"[^>]*>Could not load the remaining results\.<\/span>/,
    );
    assert.match(
      html,
      /<button[^>]*class="retry"[^>]*data-action="retry-load"[^>]*>Retry<\/button>|<button[^>]*data-action="retry-load"[^>]*>Retry<\/button>/,
    );
    assert.match(html, /aria-live="polite"/, 'a failure is announced');
    assert.ok(!html.includes('aria-busy="true"'));
    assert.match(html, /class="card/, 'the loaded rows stay');
  });

  test('no Retry on a stale restored round or outside the ready phase', async () => {
    const failed = partial({ failed: true });
    assert.ok(!(await results({ ...failed, stale: true })).includes('data-action="retry-load"'));
    assert.ok(
      !(await results({ ...failed, phase: 'loading' })).includes('data-action="retry-load"'),
    );
  });

  test('a complete list whose listing is incomplete keeps the lower-bound summary and note', async () => {
    const html = await results(partial({ hasMore: false, lowerBound: true, loaded: 2, total: 2 }));
    assert.match(html, /Showing 2 of 2\+ in 1 registry/);
    assert.match(html, /aria-live="polite"/);
    assert.match(html, /<div class="result-note">A registry listing is incomplete/);
    assert.ok(!html.includes('title="A registry listing'), 'not a hover-only explanation');
    assert.ok(!html.includes('500'), 'the cap number belongs to grim, not to this page');
    assert.ok(!html.includes('data-action="retry-load"'));
    const plain = await results(partial());
    assert.ok(!plain.includes('result-note'), 'no note without a lower bound');
  });

  test('chips that hide every loaded row do not claim nothing matches', async () => {
    const html = await litHtml(
      renderSidebarResults(partial(), { ...DEFAULT_FILTER, kinds: ['mcp'] }),
    );
    assert.match(html, /None of the 2 loaded results match/);
    assert.match(html, /may be in results that are still loading/);
    assert.ok(!html.includes('Nothing matches'), 'the unloaded 14,998 may hold one');
    const failed = await litHtml(
      renderSidebarResults(partial({ failed: true }), { ...DEFAULT_FILTER, kinds: ['mcp'] }),
    );
    assert.match(failed, /None of the 2 loaded results match/);
    assert.match(failed, /may be in results that did not load/);
  });

  test('a complete list with every row filtered out still says nothing matches', async () => {
    const html = await litHtml(
      renderSidebarResults(partial({ total: 2, hasMore: false }), {
        ...DEFAULT_FILTER,
        kinds: ['mcp'],
      }),
    );
    assert.match(html, /Nothing matches/);
    assert.ok(!html.includes('None of the'));
  });

  test('kind chips narrow the loaded rows and the summary says so', async () => {
    const html = await litHtml(
      renderSidebarResults(partial(), { ...DEFAULT_FILTER, kinds: ['rule'] }),
    );
    assert.match(html, /0 shown · Loading 2 of 12,000…/);
  });

  test('the direction toggle is held while pages remain, and free once loaded', async () => {
    const search = await litHtml(
      renderSidebarSearch(partial(), { ...DEFAULT_FILTER, sort: 'rating', dir: 'asc' }),
    );
    assert.match(search, /aria-disabled="true"/);
    assert.match(search, /Loading all results — the order can be reversed once they are loaded/);
    const failed = await litHtml(
      renderSidebarSearch(partial({ failed: true }), { ...DEFAULT_FILTER, sort: 'rating' }),
    );
    assert.match(failed, /aria-disabled="true"/, 'still pinned: the list is not complete');
    const free = await litHtml(
      renderSidebarSearch(partial({ hasMore: false }), { ...DEFAULT_FILTER, sort: 'rating' }),
    );
    assert.ok(!free.includes('aria-disabled'));
  });
});

suite('windowed results (VX-R03)', () => {
  const TOTAL = 20_000;
  const NONE = new Set<string>();
  const decode = (s: string): string =>
    s
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
  const skills = (n: number, hostOf: (i: number) => string = () => 'ghcr.io'): CardVM[] =>
    Array.from({ length: n }, (_, i) =>
      card({ repo: `${hostOf(i)}/team/skills/skill-${i}`, name: `skill-${i}` }),
    );
  const installedInBoth = (n: number): CardVM[] =>
    skills(n).map((c) =>
      card({
        ...c,
        state: 'installed',
        installs: [bothInstalled('project'), bothInstalled('global')],
      }),
    );
  const compact: ViewOptions = { ...DEFAULT_VIEW, density: 'compact' };

  interface Layout {
    name: string;
    state: SidebarState;
    view: ViewOptions;
    expanded: Set<string>;
  }
  const layouts = (): Layout[] => {
    const flat = sidebarState({ items: skills(TOTAL) });
    const hosts = sidebarState({ items: skills(TOTAL, (i) => `host${i % 3}.example`) });
    const treeItems = skills(TOTAL).map((c, i) =>
      card({ ...c, repo: `reg.example/ns${i % 4}/skill-${i}` }),
    );
    const tree = sidebarState({ items: treeItems });
    const treeOpen = new Set(collectNodeIds(buildTree(treeItems, {})));
    return [
      { name: 'comfortable list', state: flat, view: DEFAULT_VIEW, expanded: NONE },
      { name: 'compact list', state: flat, view: compact, expanded: NONE },
      {
        name: 'registry-grouped list',
        state: hosts,
        view: { ...DEFAULT_VIEW, browseGroup: 'registry' },
        expanded: new Set(['host0.example', 'host1.example', 'host2.example']),
      },
      {
        name: 'scope-grouped Installed',
        state: sidebarState({ mode: 'installed', items: installedInBoth(TOTAL / 2) }),
        view: DEFAULT_VIEW,
        expanded: new Set(['project', 'global']),
      },
      {
        name: 'comfortable (roomy) tree',
        state: tree,
        view: { ...DEFAULT_VIEW, mode: 'tree' },
        expanded: treeOpen,
      },
      { name: 'compact tree', state: tree, view: { ...compact, mode: 'tree' }, expanded: treeOpen },
    ];
  };

  /** Reads the rendered window back out of the markup. */
  function inspect(html: string): { keys: string[]; before: number; after: number } {
    const keys = [...html.matchAll(/data-key="([^"]*)"/g)].map((m) => decode(m[1] ?? ''));
    const firstKeyAt = html.search(/data-key="/);
    let before = 0;
    let after = 0;
    for (const m of html.matchAll(/class="win-spacer" data-px="(\d+)"/g)) {
      if (m.index < firstKeyAt) {
        before += Number(m[1]);
      } else {
        after += Number(m[1]);
      }
    }
    return { keys, before, after };
  }

  /** The rendered run is contiguous in `rows`, within the cap, its spacers are
   *  exactly the unrendered rows' heights, and it covers the viewport. */
  function assertWindow(
    html: string,
    rows: FlatRow[],
    view: ViewOptions,
    win: ResultsWindow,
  ): { first: number; end: number } {
    const { keys, before, after } = inspect(html);
    const heightOf = (r: FlatRow): number => win.heights?.get(r.key) ?? estimatedRowHeight(r, view);
    assert.ok(keys.length > 0 && keys.length <= 200, `${keys.length} rows rendered`);
    const first = rows.findIndex((r) => r.key === keys[0]);
    assert.ok(first >= 0, 'the first rendered row is a real row');
    keys.forEach((k, i) => assert.strictEqual(rows[first + i]?.key, k, `row ${i} is contiguous`));
    const end = first + keys.length;
    assert.strictEqual(before, sum(rows.slice(0, first).map(heightOf)), 'leading spacer');
    assert.strictEqual(after, sum(rows.slice(end).map(heightOf)), 'trailing spacer');
    const whole = sum(rows.map(heightOf));
    const top = Math.min(win.scrollTop, Math.max(whole - win.viewport, 0));
    assert.ok(before <= top, 'nothing visible sits under the leading spacer');
    assert.ok(whole - after >= Math.min(top + win.viewport, whole), 'nothing visible is cut off');
    return { first, end };
  }

  suite('every layout at 20,000 rows', () => {
    for (const layout of layouts()) {
      const { name, state, view, expanded } = layout;

      test(`${name}: the first paint renders a bounded window with a trailing spacer`, async () => {
        const html = await litHtml(renderSidebarResults(state, DEFAULT_FILTER, view, expanded));
        const { rows } = prepareResults(state, DEFAULT_FILTER, view, expanded);
        assert.ok(rows.length >= TOTAL, `${rows.length} rows to window`);
        const { first } = assertWindow(html, rows, view, { scrollTop: 0, viewport: 800 });
        assert.strictEqual(first, 0);
        assert.strictEqual(inspect(html).before, 0);
        assert.ok(inspect(html).after > 0);
        assert.ok(!html.includes('class="win-spacer" data-px="0"'), 'a zero spacer is omitted');
      });

      test(`${name}: scrolled to the middle it renders both spacers around that offset`, async () => {
        const { rows } = prepareResults(state, DEFAULT_FILTER, view, expanded);
        const whole = sum(rows.map((r) => estimatedRowHeight(r, view)));
        const win: ResultsWindow = { scrollTop: Math.floor(whole / 2), viewport: 800 };
        const html = await litHtml(
          renderSidebarResults(state, DEFAULT_FILTER, view, expanded, win),
        );
        const { first, end } = assertWindow(html, rows, view, win);
        assert.ok(first > 0 && end < rows.length, 'rows are trimmed on both sides');
        assert.ok(inspect(html).before > 0 && inspect(html).after > 0);
      });

      test(`${name}: scrolled away from the focused row it still renders it, the spacers adding up`, async () => {
        const { rows } = prepareResults(state, DEFAULT_FILTER, view, expanded);
        const whole = sum(rows.map((r) => estimatedRowHeight(r, view)));
        for (const focused of [rows[3], rows[rows.length - 4]]) {
          const win: ResultsWindow = {
            scrollTop: Math.floor(whole / 2),
            viewport: 800,
            focusKey: focused?.key ?? '',
          };
          const html = await litHtml(
            renderSidebarResults(state, DEFAULT_FILTER, view, expanded, win),
          );
          const keys = assertWholeList(html, rows, view, win);
          assert.ok(keys.includes(focused?.key ?? ''), 'the focused row is rendered');
          assert.ok(keys.length <= 201);
          const stops = stopsOf(html);
          assert.strictEqual(stops.length, 1);
          assert.ok(stops[0]?.includes(`data-key="${focused?.key}"`), 'and is the stop');
        }
      });

      test(`${name}: with the last row as the stop, no control before it is in the tab order`, async () => {
        const { rows } = prepareResults(state, DEFAULT_FILTER, view, expanded);
        const last = rows[rows.length - 1]?.key ?? '';
        const html = await litHtml(
          renderSidebarResults(state, DEFAULT_FILTER, view, expanded, {
            scrollTop: 0,
            viewport: 800,
            focusKey: last,
          }),
        );
        const stopAt = html.lastIndexOf('<', html.indexOf(`data-key="${last}"`));
        const ahead = [...html.slice(0, stopAt).matchAll(/<button[^>]*>/g)].map((m) => m[0]);
        assert.ok(ahead.length > 0, 'the window renders buttons ahead of the stop');
        assert.deepStrictEqual(
          ahead.filter((b) => !b.includes('tabindex="-1"')),
          [],
          'every one of them is out of the tab order',
        );
      });

      // main.ts measureScroll() reads the list's offset from `.cards`; a layout
      // without it measures 0, so its window never follows the scroll.
      test(`${name}: the rows sit inside the .cards element the scroll offset is measured from`, async () => {
        const html = await litHtml(renderSidebarResults(state, DEFAULT_FILTER, view, expanded));
        const anchor = html.indexOf('<div class="cards">');
        assert.ok(anchor >= 0, 'a .cards wrapper');
        assert.ok(anchor < html.search(/data-key="/), 'the first row is inside it');
      });

      test(`${name}: rows carry their ARIA position and exactly one roving stop`, async () => {
        const html = await litHtml(renderSidebarResults(state, DEFAULT_FILTER, view, expanded));
        const { keys } = inspect(html);
        // Rows only: the buttons nested in them carry their own tabindex.
        const stops = [...html.matchAll(/<[^>]*data-key="[^"]*"[^>]*>/g)].flatMap((m) => {
          const stop = /tabindex="(-?\d+)"/.exec(m[0]);
          return stop ? [stop[1]] : [];
        });
        assert.strictEqual(stops.length, keys.length, 'every windowed row is a focus stop');
        assert.strictEqual(stops.filter((t) => t === '0').length, 1);
        assert.strictEqual(stops[0], '0', 'the first rendered row when nothing is focused');
        const sized = [...html.matchAll(/aria-setsize="(\d+)"/g)].length;
        const placed = [...html.matchAll(/aria-posinset="(\d+)"/g)].length;
        assert.strictEqual(sized, placed);
        assert.ok(sized > 0 && sized <= keys.length, 'headers carry no set position');
        if (view.mode === 'tree') {
          assert.strictEqual(
            [...html.matchAll(/aria-level="(\d+)"/g)].length,
            keys.length,
            'every tree row has a level',
          );
          assert.match(html, /role="tree"/);
        }
      });
    }
  });

  test('focusKey moves the single roving stop onto that row', async () => {
    const state = sidebarState({ items: skills(TOTAL) });
    const { rows } = prepareResults(state, DEFAULT_FILTER, DEFAULT_VIEW, NONE);
    const target = rows[3]?.key ?? '';
    const html = await litHtml(
      renderSidebarResults(state, DEFAULT_FILTER, DEFAULT_VIEW, NONE, {
        scrollTop: 0,
        viewport: 800,
        focusKey: target,
      }),
    );
    const zero = [...html.matchAll(/<[^>]*tabindex="0"[^>]*>/g)];
    assert.strictEqual(zero.length, 1);
    assert.ok(zero[0]?.[0].includes(`data-key="${target}"`), 'on the focused row');
  });

  /** Walks the markup in document order: the rendered rows' keys and the
   *  spacers between them, so a pinned row's position and the sum can be read. */
  function walk(html: string): {
    keys: string[];
    spacers: number[];
    order: Array<string | number>;
  } {
    const order: Array<string | number> = [];
    for (const m of html.matchAll(/data-key="([^"]*)"|class="win-spacer" data-px="(\d+)"/g)) {
      order.push(m[1] !== undefined ? decode(m[1]) : Number(m[2]));
    }
    return {
      keys: order.filter((o): o is string => typeof o === 'string'),
      spacers: order.filter((o): o is number => typeof o === 'number'),
      order,
    };
  }

  /** Every row that renders plus every spacer is the whole list, and the rows
   *  come out in list order. */
  function assertWholeList(
    html: string,
    rows: FlatRow[],
    view: ViewOptions,
    win: ResultsWindow,
  ): string[] {
    const { keys, spacers } = walk(html);
    const at = keys.map((k) => rows.findIndex((r) => r.key === k));
    assert.ok(
      at.every((i) => i >= 0),
      'every rendered row is a real row',
    );
    assert.deepStrictEqual(
      at,
      [...at].sort((a, b) => a - b),
      'rows keep their list order',
    );
    const heightOf = (r: FlatRow): number => win.heights?.get(r.key) ?? estimatedRowHeight(r, view);
    assert.strictEqual(
      sum(spacers) + sum(at.map((i) => heightOf(rows[i] as FlatRow))),
      sum(rows.map(heightOf)),
      'spacers and rendered rows add up to the list',
    );
    return keys;
  }

  const stopsOf = (html: string): string[] =>
    [
      ...html.matchAll(
        /<[^>]*data-key="[^"]*"[^>]*tabindex="0"[^>]*>|<[^>]*tabindex="0"[^>]*data-key="[^"]*"[^>]*>/g,
      ),
    ].map((m) => m[0]);

  test('a focusKey outside the window renders that row pinned, as the one roving stop', async () => {
    const state = sidebarState({ items: skills(TOTAL) });
    const { rows } = prepareResults(state, DEFAULT_FILTER, DEFAULT_VIEW, NONE);
    const far = rows[TOTAL - 1]?.key ?? '';
    const win: ResultsWindow = { scrollTop: 0, viewport: 800, focusKey: far };
    const html = await litHtml(
      renderSidebarResults(state, DEFAULT_FILTER, DEFAULT_VIEW, NONE, win),
    );
    const keys = assertWholeList(html, rows, DEFAULT_VIEW, win);
    assert.strictEqual(keys[keys.length - 1], far, 'rendered after the window');
    const stops = stopsOf(html);
    assert.strictEqual(stops.length, 1);
    assert.ok(stops[0]?.includes(`data-key="${far}"`), 'the pinned row is the stop');
  });

  test('a focused row that the list scrolls far away from stays mounted, above the window', async () => {
    const state = sidebarState({ items: skills(TOTAL) });
    const { rows } = prepareResults(state, DEFAULT_FILTER, DEFAULT_VIEW, NONE);
    const focused = rows[3]?.key ?? '';
    const win: ResultsWindow = { scrollTop: 9200, viewport: 800, focusKey: focused };
    const html = await litHtml(
      renderSidebarResults(state, DEFAULT_FILTER, DEFAULT_VIEW, NONE, win),
    );
    const keys = assertWholeList(html, rows, DEFAULT_VIEW, win);
    assert.strictEqual(keys[0], focused, 'rendered before the window');
    assert.ok(keys.length > 2 && keys.length <= 201, `${keys.length} rows rendered`);
    const stops = stopsOf(html);
    assert.strictEqual(stops.length, 1);
    assert.ok(stops[0]?.includes(`data-key="${focused}"`));
    const [lead, gap] = walk(html).spacers;
    assert.strictEqual(lead, 3 * estimatedRowHeight(rows[0] as FlatRow, DEFAULT_VIEW));
    assert.ok((gap ?? 0) > 0, 'a spacer stands in for the rows between it and the window');
  });

  test('a focused row inside the window is not pinned twice', async () => {
    const state = sidebarState({ items: skills(TOTAL) });
    const { rows } = prepareResults(state, DEFAULT_FILTER, DEFAULT_VIEW, NONE);
    const win: ResultsWindow = { scrollTop: 0, viewport: 800, focusKey: rows[3]?.key ?? '' };
    const html = await litHtml(
      renderSidebarResults(state, DEFAULT_FILTER, DEFAULT_VIEW, NONE, win),
    );
    const { keys } = walk(html);
    assert.strictEqual(new Set(keys).size, keys.length);
    assert.strictEqual(inspect(html).before, 0);
  });

  test('a focusKey that names no row falls back to the first row at the visible top', async () => {
    const state = sidebarState({ items: skills(TOTAL) });
    const { rows } = prepareResults(state, DEFAULT_FILTER, DEFAULT_VIEW, NONE);
    const html = await litHtml(
      renderSidebarResults(state, DEFAULT_FILTER, DEFAULT_VIEW, NONE, {
        scrollTop: 0,
        viewport: 800,
        focusKey: 'gone',
      }),
    );
    const stops = stopsOf(html);
    assert.strictEqual(stops.length, 1);
    assert.ok(stops[0]?.includes(`data-key="${rows[0]?.key}"`));
  });

  test('with no focus and a scrolled list the tab stop is the first row at the visible top, not the overscan', async () => {
    const state = sidebarState({ items: skills(TOTAL) });
    const { rows } = prepareResults(state, DEFAULT_FILTER, DEFAULT_VIEW, NONE);
    const win: ResultsWindow = { scrollTop: 9200, viewport: 800 };
    const html = await litHtml(
      renderSidebarResults(state, DEFAULT_FILTER, DEFAULT_VIEW, NONE, win),
    );
    const heights = rows.map((r) => estimatedRowHeight(r, DEFAULT_VIEW));
    const { start, firstVisible } = windowRows(heights, win.scrollTop, win.viewport);
    assert.ok(start < firstVisible, 'the window renders overscan above the viewport');
    const zero = [...html.matchAll(/<[^>]*tabindex="0"[^>]*>/g)];
    assert.strictEqual(zero.length, 1);
    assert.ok(zero[0]?.[0].includes(`data-key="${rows[firstVisible]?.key}"`), 'on the visible top');
    assert.ok(!zero[0]?.[0].includes(`data-key="${rows[start]?.key}"`), 'not the first rendered');
  });

  suite('nested controls and the single roving tab stop', () => {
    const buttonTags = (html: string): string[] =>
      [...html.matchAll(/<button[^>]*>/g)].map((m) => m[0]);
    const cases: Array<[string, CardVM]> = [
      ['not installed', card()],
      ['installed', card({ state: 'installed', installs: [bothInstalled('project')] })],
      ['outdated', outdatedCard()],
      ['deprecated', card({ state: 'deprecated', deprecated: 'use another' })],
    ];
    const renderers: Array<[string, (c: CardVM, tabindex: 0 | -1) => unknown]> = [
      ['card', (c, tabindex) => renderCard(c, { row: { key: 'k', tabindex } })],
      [
        'installed-tab card',
        (c, tabindex) => renderCard(c, { variant: 'scope', row: { key: 'k', tabindex } }),
      ],
      ['compact row', (c, tabindex) => renderCompactRow(c, { row: { key: 'k', tabindex } })],
    ];

    for (const [layout, render] of renderers) {
      for (const [label, c] of cases) {
        test(`${layout}, ${label}: buttons leave the tab order unless the row is the stop`, async () => {
          const off = buttonTags(await litHtml(render(c, -1)));
          assert.ok(off.length > 0, 'the row has controls to guard');
          assert.deepStrictEqual(
            off.filter((b) => !b.includes('tabindex="-1"')),
            [],
            'all of them are tabindex -1 off the stop',
          );
          const on = buttonTags(await litHtml(render(c, 0)));
          assert.deepStrictEqual(
            on.filter((b) => b.includes('tabindex')),
            [],
            'none of them is touched on the stop row',
          );
        });
      }
    }

    test('rows rendered without row options keep their buttons as they were', async () => {
      for (const [, c] of cases) {
        for (const out of [renderCard(c), renderCompactRow(c)]) {
          assert.ok(!buttonTags(await litHtml(out)).some((b) => b.includes('tabindex')));
        }
      }
    });
  });

  suite('a windowed row is named with its kind and install state', () => {
    const row = { key: 'k', tabindex: 0 as const };
    const installed = card({ state: 'installed', installs: [bothInstalled('project')] });
    const renderers: Array<[string, (c: CardVM, unknown?: boolean) => unknown]> = [
      ['card', (c, u) => renderCard(c, { row, ...(u ? { installStateUnknown: true } : {}) })],
      [
        'compact row',
        (c, u) => renderCompactRow(c, { row, ...(u ? { installStateUnknown: true } : {}) }),
      ],
    ];
    const labelOf = async (out: unknown): Promise<string> =>
      /<div[^>]*role="article"[^>]*>/
        .exec(await litHtml(out))?.[0]
        .match(/aria-label="([^"]*)"/)?.[1] ?? '';

    for (const [layout, render] of renderers) {
      test(`${layout}: an outdated and an installed row read differently`, async () => {
        const outdated = await labelOf(render(outdatedCard()));
        const current = await labelOf(render(installed));
        assert.notStrictEqual(outdated, current);
        assert.match(outdated, /grim-usage, skill, installed .*, update to 1\.5\.0/);
        assert.match(current, /grim-usage, skill, installed 1\.5\.0$/);
        assert.match(await labelOf(render(card())), /not installed$/);
      });

      test(`${layout}: an unknown install state claims nothing about installs`, async () => {
        const label = await labelOf(render(installed, true));
        assert.strictEqual(label, 'grim-usage, skill');
      });

      test(`${layout}: a hostile name stays inert inside the label`, async () => {
        const html = await litHtml(render(card({ name: '"><img src=x onerror=alert(1)>' })));
        assert.ok(!html.includes('<img src=x'), 'no element built from the name');
        assert.match(html, /aria-label="&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;, skill/);
      });
    }
  });

  test('the tree has an accessible name that tells Browse and Installed apart', async () => {
    const items = skills(3).map((c) =>
      card({ ...c, state: 'installed', installs: [bothInstalled('project')] }),
    );
    const open = new Set(collectNodeIds(buildTree(items, {})));
    const tree = { ...compact, mode: 'tree' as const };
    const nameOf = async (state: SidebarState): Promise<string | undefined> => {
      const html = await litHtml(renderSidebarResults(state, DEFAULT_FILTER, tree, open));
      const tag = /<div[^>]*role="tree"[^>]*>/.exec(html)?.[0] ?? '';
      return /aria-label="([^"]*)"/.exec(tag)?.[1];
    };
    const browse = await nameOf(sidebarState({ items }));
    const installed = await nameOf(sidebarState({ mode: 'installed', items }));
    assert.ok(browse && installed, `named: ${browse} / ${installed}`);
    assert.notStrictEqual(browse, installed);
  });

  test('windowed card and compact rows are named; tree items, headers and bare rows are not', async () => {
    const state = sidebarState({ items: [card({ repo: 'ghcr.io/team/skills/one', name: 'one' })] });
    const named = /aria-label="one, skill, not installed"[^>]*>/;
    const list = await litHtml(renderSidebarResults(state, DEFAULT_FILTER));
    assert.match(/<div[^>]*class="card"[^>]*>/.exec(list)?.[0] ?? '', named);
    const dense = await litHtml(renderSidebarResults(state, DEFAULT_FILTER, compact));
    assert.match(/<div[^>]*class="compact-row"[^>]*>/.exec(dense)?.[0] ?? '', named);
    const open = new Set(collectNodeIds(buildTree(state.items, {})));
    const tree = await litHtml(
      renderSidebarResults(state, DEFAULT_FILTER, { ...compact, mode: 'tree' }, open),
    );
    const rowsOnly = tree.replace(/<div[^>]*role="tree"[^>]*>/, '');
    assert.ok(!rowsOnly.includes('aria-label'), 'a treeitem is named by its content');
    const grouped = await litHtml(
      renderSidebarResults(
        state,
        DEFAULT_FILTER,
        { ...DEFAULT_VIEW, browseGroup: 'registry' },
        new Set(['ghcr.io']),
      ),
    );
    assert.ok(!/<button[^>]*group-header[^>]*aria-label/.test(grouped));
    for (const out of [renderCard(card()), renderCompactRow(card())]) {
      assert.ok(!(await litHtml(out)).includes('aria-label'), 'no row options, no label');
    }
  });

  suite('aria-setsize while Browse pages are still loading', () => {
    const loading = (hasMore: boolean): SidebarState =>
      sidebarState({
        items: skills(3),
        paging: { token: 1, loaded: 3, total: 600, lowerBound: false, hasMore },
      });
    const sizesOf = (html: string): string[] =>
      [...html.matchAll(/aria-setsize="(-?\d+)"/g)].map((m) => m[1] ?? '');

    test('flat, grouped and tree rows say -1 until the last page is in', async () => {
      const tree = { ...compact, mode: 'tree' as const };
      const layouts: Array<[ViewOptions, Set<string>]> = [
        [DEFAULT_VIEW, NONE],
        [compact, NONE],
        [{ ...DEFAULT_VIEW, browseGroup: 'registry' }, new Set(['ghcr.io'])],
        [tree, new Set(collectNodeIds(buildTree(skills(3), {})))],
      ];
      for (const [view, expanded] of layouts) {
        const partial = sizesOf(
          await litHtml(renderSidebarResults(loading(true), DEFAULT_FILTER, view, expanded)),
        );
        assert.ok(partial.length >= 3, `${view.mode}/${view.density}: rows carry a size`);
        assert.ok(
          partial.every((n) => n === '-1'),
          `${view.mode}/${view.density}: ${partial}`,
        );
        const done = sizesOf(
          await litHtml(renderSidebarResults(loading(false), DEFAULT_FILTER, view, expanded)),
        );
        assert.ok(
          done.every((n) => n !== '-1'),
          `${view.mode}/${view.density}: complete`,
        );
      }
    });

    test('prepareResults hands the unknown size to flattenRows', () => {
      const { rows } = prepareResults(loading(true), DEFAULT_FILTER, DEFAULT_VIEW, NONE);
      assert.ok(rows.every((r) => r.type === 'group' || r.setsize === -1));
    });
  });

  test('a measured height replaces the estimate in the spacers', async () => {
    const state = sidebarState({ items: skills(TOTAL) });
    const { rows } = prepareResults(state, DEFAULT_FILTER, DEFAULT_VIEW, NONE);
    const heights = new Map<string, number>([
      [rows[0]?.key ?? '', 140],
      [rows[TOTAL - 1]?.key ?? '', 61],
    ]);
    const win = { scrollTop: 0, viewport: 800, heights };
    const html = await litHtml(
      renderSidebarResults(state, DEFAULT_FILTER, DEFAULT_VIEW, NONE, win),
    );
    assertWindow(html, rows, DEFAULT_VIEW, win);
  });

  test('a prepared list is reused, not recomputed, on a scroll render', async () => {
    const state = sidebarState({ items: skills(50) });
    const other = sidebarState({
      items: skills(5).map((c) => card({ ...c, repo: `other/${c.name}` })),
    });
    const prepared = prepareResults(other, DEFAULT_FILTER, DEFAULT_VIEW, NONE);
    const html = await litHtml(
      renderSidebarResults(state, DEFAULT_FILTER, DEFAULT_VIEW, NONE, {
        scrollTop: 0,
        viewport: 800,
        prepared,
      }),
    );
    assert.deepStrictEqual(
      inspect(html).keys,
      prepared.rows.map((r) => r.key).slice(0, inspect(html).keys.length),
      'the rows come from `prepared`',
    );
    assert.ok(html.includes('5 results'), 'and so does the count');
  });

  test('prepareResults: Browse and Installed flatten, Updates and non-ready phases do not', () => {
    const items = skills(7);
    const browse = prepareResults(sidebarState({ items }), DEFAULT_FILTER, DEFAULT_VIEW, NONE);
    assert.strictEqual(browse.filtered.length, 7);
    assert.strictEqual(browse.rows.length, 7);
    const installed = prepareResults(
      sidebarState({ mode: 'installed', items: installedInBoth(3) }),
      DEFAULT_FILTER,
      DEFAULT_VIEW,
      new Set(['project', 'global']),
    );
    assert.strictEqual(installed.filtered.length, 3);
    assert.strictEqual(installed.rows.length, 3 * 2 + 2, 'both scopes, plus their headers');
    const updates = prepareResults(
      sidebarState({ mode: 'updates', items }),
      DEFAULT_FILTER,
      DEFAULT_VIEW,
      NONE,
    );
    assert.strictEqual(updates.filtered, items, 'the whole slice, unfiltered');
    assert.deepStrictEqual(updates.rows, [], 'never windowed');
    for (const phase of ['loading', 'error', 'no-grim'] as const) {
      const empty = prepareResults(
        sidebarState({ phase, items }),
        DEFAULT_FILTER,
        DEFAULT_VIEW,
        NONE,
      );
      assert.deepStrictEqual([empty.filtered, empty.rows], [[], []], phase);
    }
  });

  test('the Updates tab is not windowed: every card renders, plain', async () => {
    const items = skills(300).map((c) =>
      card({
        ...c,
        state: 'outdated',
        installs: [{ ...bothInstalled('project'), updateAvailable: true }],
      }),
    );
    const html = await litHtml(
      renderSidebarResults(sidebarState({ mode: 'updates', items }), DEFAULT_FILTER),
    );
    assert.strictEqual([...html.matchAll(/<div[^>]*class="card"/g)].length, 300);
    assert.ok(!html.includes('win-spacer'));
    assert.ok(!html.includes('data-key'));
  });

  test('rows keep the card and group markup the delegated handlers rely on', async () => {
    const view = { ...DEFAULT_VIEW, browseGroup: 'registry' as const };
    const state = sidebarState({ items: skills(3) });
    const html = await litHtml(
      renderSidebarResults(state, DEFAULT_FILTER, view, new Set(['ghcr.io'])),
    );
    assert.match(
      html,
      /<button[^>]*class="group-header"[^>]*data-action="toggle-node"[^>]*data-node="ghcr\.io"/,
    );
    assert.match(
      html,
      /<button[^>]*data-key="g:ghcr\.io"[^>]*tabindex="0"/,
      'a header is a focus stop',
    );
    assert.ok(!/<button[^>]*group-header[^>]*aria-setsize/.test(html), 'but not a set member');
    const cards = [...html.matchAll(/<div[^>]*class="card"[^>]*>/g)];
    assert.strictEqual(cards.length, 3);
    cards.forEach((m, i) => {
      assert.match(m[0], /role="article"/);
      assert.match(m[0], /data-repo="ghcr\.io\/team\/skills\/skill-\d"/);
      assert.match(m[0], new RegExp(`aria-posinset="${i + 1}"`));
      assert.match(m[0], /aria-setsize="3"/, 'the group size');
      assert.match(m[0], /tabindex="-?[01]"/);
    });
  });

  test('list-mode compact rows are articles; tree leaves stay treeitems with a level', async () => {
    const state = sidebarState({ items: skills(2) });
    const list = await litHtml(renderSidebarResults(state, DEFAULT_FILTER, compact));
    assert.strictEqual(
      [...list.matchAll(/<div[^>]*class="compact-row"[^>]*role="article"/g)].length,
      2,
    );
    const tree = await litHtml(
      renderSidebarResults(
        state,
        DEFAULT_FILTER,
        { ...compact, mode: 'tree' },
        new Set(collectNodeIds(buildTree(state.items, {}))),
      ),
    );
    const leaf = /<div[^>]*class="compact-row tree-leaf d1"[^>]*>/.exec(tree)?.[0] ?? '';
    assert.match(leaf, /role="treeitem"/);
    assert.match(leaf, /aria-level="2"/, 'one below its namespace node');
    assert.match(leaf, /aria-setsize="2"/);
    assert.match(leaf, /aria-posinset="1"/);
    const node = /<button[^>]*class="tree-node d0"[^>]*>/.exec(tree)?.[0] ?? '';
    assert.match(node, /aria-level="1"/);
    assert.match(node, /aria-expanded="true"/);
  });

  test('a card or compact row rendered without row options is unchanged', async () => {
    for (const out of [renderCard(card()), renderCompactRow(card())]) {
      const html = await litHtml(out);
      assert.ok(!/data-key|tabindex|aria-setsize|aria-posinset|role=/.test(html), html);
    }
  });

  test('a hostile repo or group id stays inert inside data-key', async () => {
    const hostile = '"<>&';
    const flat = await litHtml(
      renderSidebarResults(
        sidebarState({ items: [card({ repo: `ghcr.io/x/${hostile}y`, name: 'y' })] }),
        DEFAULT_FILTER,
      ),
    );
    assert.ok(flat.includes('data-key="ghcr.io/x/&quot;&lt;&gt;&amp;y"'), flat);
    assert.ok(!flat.includes(hostile));
    const alias = `a${hostile}`;
    const grouped = await litHtml(
      renderSidebarResults(
        sidebarState({
          items: [card({ repo: 'ghcr.io/x/y', name: 'y' })],
          registries: [{ alias, oci: 'ghcr.io/x', kind: 'registry', isDefault: true }],
        }),
        DEFAULT_FILTER,
        { ...DEFAULT_VIEW, browseGroup: 'registry' },
        new Set([alias]),
      ),
    );
    assert.ok(grouped.includes('data-key="g:a&quot;&lt;&gt;&amp;"'), grouped);
    assert.ok(grouped.includes('data-key="a&quot;&lt;&gt;&amp;:ghcr.io/x/y"'), grouped);
    assert.ok(!grouped.includes(hostile));
    const items = [
      card({ repo: `reg.example/${hostile}/y`, name: 'y' }),
      card({ repo: 'reg.example/ok/z', name: 'z' }),
    ];
    const tree = await litHtml(
      renderSidebarResults(
        sidebarState({ items }),
        DEFAULT_FILTER,
        { ...compact, mode: 'tree' },
        new Set(collectNodeIds(buildTree(items, {}))),
      ),
    );
    assert.ok(
      tree.includes('data-key="reg.example/&quot;&lt;&gt;&amp;"') ||
        tree.includes('&quot;&lt;&gt;&amp;'),
      tree,
    );
    assert.ok(!tree.includes(hostile));
  });

  test('vscode-scrollable still ships the .scrollable-container main.ts selects', () => {
    // main.ts reaches into the component's shadow root for this class; a rename
    // upstream would leave the scroller null and only the first window reachable.
    const dist = path.join(
      __dirname,
      '..',
      '..',
      'node_modules',
      '@vscode-elements',
      'elements',
      'dist',
      'vscode-scrollable',
      'vscode-scrollable.js',
    );
    assert.match(fs.readFileSync(dist, 'utf8'), /scrollable-container/);
    const main = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'webview', 'sidebar', 'main.ts'),
      'utf8',
    );
    assert.ok(main.includes("'.scrollable-container'"), 'main.ts still selects the same class');
  });

  test('sidebar.css agrees with the heights the windower assumes', () => {
    const css = fs
      .readFileSync(
        path.join(__dirname, '..', '..', 'src', 'webview', 'sidebar', 'sidebar.css'),
        'utf8',
      )
      .replace(/\r\n/g, '\n');
    const px = (re: RegExp): number => Number(re.exec(css)?.[1]);
    const open = new Set(['ghcr.io', 'ghcr.io/team', 'ghcr.io/team/skills']);
    const row = (view: ViewOptions, nth: number): FlatRow => {
      const rows = prepareResults(
        sidebarState({ items: skills(1) }),
        DEFAULT_FILTER,
        view,
        open,
      ).rows;
      return rows[nth] ?? assert.fail(`no row ${nth}`);
    };
    const height = (view: ViewOptions, nth: number): number =>
      estimatedRowHeight(row(view, nth), view);
    // A comfortable card has no fixed height in CSS: 92px is only the estimate a
    // card keeps until it renders and is measured.
    assert.strictEqual(height(DEFAULT_VIEW, 0), 92, '.card estimate');
    assert.strictEqual(
      height(compact, 0),
      px(/^\.compact-row \{[^}]*\n {2}height: (\d+)px;/m),
      '.compact-row',
    );
    const headerPx = px(/^\.group-header,\n\.tree-node \{[^}]*\n {2}height: (\d+)px;/m);
    const grouped: ViewOptions = { ...compact, browseGroup: 'registry' };
    assert.strictEqual(row(grouped, 0).type, 'group');
    assert.strictEqual(height(grouped, 0), headerPx, '.group-header');
    const roomyPx = px(
      /^\.tree\.roomy \.compact-row,\n\.tree\.roomy \.tree-node \{\n {2}height: (\d+)px;/m,
    );
    const roomyTree: ViewOptions = { ...DEFAULT_VIEW, mode: 'tree' };
    assert.strictEqual(row(roomyTree, 0).type, 'node');
    assert.strictEqual(height(roomyTree, 0), roomyPx, '.tree.roomy .tree-node');
    assert.strictEqual(row(roomyTree, 1).type, 'card');
    assert.strictEqual(height(roomyTree, 1), roomyPx, '.tree.roomy .compact-row');
    const denseTree: ViewOptions = { ...compact, mode: 'tree' };
    assert.strictEqual(height(denseTree, 0), headerPx, '.tree-node');
    assert.strictEqual(height(denseTree, 1), px(/^\.compact-row \{[^}]*\n {2}height: (\d+)px;/m));
  });
});
