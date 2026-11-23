// Every lit-html render path that shows grim-sourced text gets hostile input
// and must emit it escaped. `unsafeHTML` carries two sources only (markdown-it
// with html:false, and highlightJson); both are fed through here too. The gate
// prompt (`gatePromptText`) is plain modal text, never HTML: hookPrompt.test.ts
// pins it.
import * as assert from 'assert';
import { buildDetailsVM, type DetailsSources } from '../webview/model';
import type { CardVM, DetailsVM, InstallVM } from '../webview/protocol';
import {
  renderCard,
  renderCardContextMenu,
  renderCardMenu,
  renderCompactRow,
  renderDetails,
} from '../webview/render';
import { litString } from './litString';
import { normalizeHtml } from './normalizeHtml';
import { card, detailsVM } from './fixtures/vms';

/** Script tag, an attribute breakout, a quote of each kind and a bare ampersand. */
const EVIL = `<script>alert(1)</script>"><img src=x onerror=alert(1)>'&`;

const html = async (out: unknown): Promise<string> => normalizeHtml(await litString(out));

/** The output carries the payload only as inert text. */
function assertInert(out: string, label: string): void {
  assert.ok(!out.includes('<script'), `${label}: raw <script`);
  assert.ok(!out.includes('<img'), `${label}: raw <img`);
  assert.ok(out.includes('&lt;script&gt;'), `${label}: payload not rendered escaped`);
}

const scopes = { projectOpen: true, projectConfigured: true, projectName: 'my-app' };
const sources = (over: Partial<DetailsSources>): DetailsSources => ({
  repo: 'ghcr.io/acme/x',
  searchItem: null,
  describe: null,
  fetch: null,
  installs: [],
  scopes,
  logoUri: null,
  ...over,
});
const fetchOf = (kind: string, content: string, files?: { path: string; size: number }[]) =>
  ({
    ref: 'ghcr.io/acme/x:1',
    digest: 'sha256:aa',
    kind,
    name: 'x',
    content,
    ...(files ? { files } : {}),
  }) as DetailsSources['fetch'];

suite('escaping: details bodies (JSON, TOML and markdown)', () => {
  // The body of each kind, carrying EVIL in a key, a value and a comment.
  const json = JSON.stringify({ [EVIL]: EVIL, nested: { list: [EVIL] } }, null, 2);
  const toml = `# ${EVIL}\n[t]\nkey = ${JSON.stringify(EVIL)}\n`;
  const cases: [string, string, string][] = [
    ['mcp JSON body', 'mcp', json],
    [
      'settings JSON body',
      'settings',
      JSON.stringify({ claude: { model: EVIL }, [EVIL]: { a: EVIL } }),
    ],
    [
      'bundle manifest',
      'bundle',
      JSON.stringify({ members: [{ kind: 'skill', name: EVIL, id: EVIL }] }),
    ],
    ['hook TOML body', 'hook', toml],
    ['mod TOML body', 'mod', `schema = 1\nname = ${JSON.stringify(EVIL)}\n${toml}`],
    [
      'skill markdown',
      'skill',
      `---\nname: x\n---\n# ${EVIL}\n\n${EVIL}\n\n[l](javascript:alert(1))\n\n\`\`\`\n${EVIL}\n\`\`\`\n`,
    ],
    ['rule markdown', 'rule', `${EVIL}\n\n<script>alert(1)</script>\n`],
    ['agent markdown', 'agent', `---\nname: x\n---\n${EVIL}\n`],
  ];
  for (const [label, kind, content] of cases) {
    test(label, async () => {
      const vm = buildDetailsVM(sources({ fetch: fetchOf(kind, content) }));
      const out = await html(renderDetails(vm));
      assertInert(out, label);
      assert.ok(!out.includes('href="javascript:'), `${label}: javascript: link`);
      assert.ok(!out.includes('onerror=alert(1)>'), `${label}: attribute breakout`);
    });
  }

  test('README and CHANGELOG tabs', async () => {
    const md = `${EVIL}\n\n<script>alert(1)</script>\n`;
    const out = await html(renderDetails(detailsVM({ readmeMarkdown: md, changelogMarkdown: md })));
    assertInert(out, 'readme/changelog');
  });

  test('a mod body with hostile harness, entry and file names', async () => {
    const vm = buildDetailsVM(
      sources({
        fetch: fetchOf('mod', `[${JSON.stringify(EVIL)}]\nentry = ${JSON.stringify(EVIL)}\n`, [
          { path: `m/${EVIL.replace(/\//g, '')}/${EVIL.replace(/\//g, '')}`, size: 1 },
          { path: 'm/mod.toml', size: 1 },
        ]),
      }),
    );
    assertInert(await html(renderDetails(vm)), 'mod harness');
  });
});

suite('escaping: details fields', () => {
  const evil = (s: string): string => `${EVIL}${s}`;
  const member = (n: string) => ({
    kind: 'skill',
    name: evil(n),
    id: evil(`id${n}`),
    version: evil('v'),
    repo: null,
    description: evil('d'),
  });
  const install: InstallVM = {
    scope: 'project',
    version: evil('ver'),
    updateAvailable: false,
    clients: [evil('c1')],
    state: 'gated',
    kind: 'mod',
    name: evil('n'),
    viaBundles: [evil('bundle')],
    requiredBy: [{ kind: 'agent', name: evil('rb'), repo: null }],
    alsoRequiredBy: [evil('also')],
    clientsMissing: [evil('missing')],
    clientsExtra: [evil('extra')],
    outputsPending: [{ client: evil('oc'), path: evil('/p') }],
    arming: [{ client: evil('ac'), cause: evil('cause'), message: evil('msg') }],
  };

  test('every string field of the details view', async () => {
    const vm: DetailsVM = detailsVM({
      name: evil('name'),
      kind: 'mod',
      description: evil('desc'),
      latestVersion: evil('lv'),
      deprecated: evil('dep'),
      replacedBy: evil('rep'),
      state: 'deprecated',
      tags: [evil('t')],
      published: evil('pub'),
      revision: evil('rev'),
      digest: evil('dig'),
      sourceRepository: evil('src'),
      license: evil('lic'),
      authors: evil('auth'),
      vendor: evil('ven'),
      homepage: evil('home'),
      documentation: evil('doc'),
      compatibility: evil('compat'),
      support: { issues: evil('i'), chat: evil('c'), contact: evil('m'), security: evil('s') },
      keywords: [evil('k')],
      serves: [evil('claude'), evil('zed')],
      members: [member('m')],
      dependencies: [member('dep')],
      installs: [install],
      busy: null,
      error: evil('err'),
    });
    assertInert(await html(renderDetails(vm)), 'details');
  });

  test('a details error and the logo URI', async () => {
    const out = await html(
      renderDetails(detailsVM({ error: EVIL, logoUri: `data:image/png;base64,${EVIL}` })),
    );
    assert.ok(!out.includes('<img src=x'));
    assert.ok(!out.includes('<script'));
  });
});

suite('escaping: sidebar cards and rows', () => {
  const evil = (s: string): string => `${EVIL}${s}`;
  const hostile = (): CardVM =>
    card({
      name: evil('name'),
      repo: `ghcr.io/${evil('repo')}`,
      kind: 'mod',
      description: evil('desc'),
      registryHost: evil('host'),
      latestVersion: evil('lv'),
      deprecated: evil('dep'),
      replacedBy: evil('rep'),
      state: 'deprecated',
      serves: [evil('claude'), evil('zed')],
      source: { alias: evil('alias'), locator: evil('loc') },
      installs: [
        {
          scope: 'project',
          version: evil('v'),
          updateAvailable: true,
          clients: [evil('c')],
          state: 'gated',
          kind: 'mod',
          name: evil('n'),
          viaBundles: [evil('b')],
          arming: [{ client: evil('ac'), cause: evil('cause'), message: evil('msg') }],
          outputsPending: [{ client: evil('oc'), path: evil('/p') }],
          clientsMissing: [evil('cm')],
          clientsExtra: [evil('ce')],
        },
      ],
    });

  const surfaces: [string, (c: CardVM) => unknown][] = [
    ['browse card', (c) => renderCard(c)],
    ['scope card', (c) => renderCard(c, { variant: 'scope', scope: 'project' })],
    ['compact row', (c) => renderCompactRow(c)],
    ['gear menu', (c) => renderCardMenu(c, true)],
    ['context menu', (c) => renderCardContextMenu(c, true)],
  ];
  for (const [label, fn] of surfaces) {
    test(label, async () => {
      const out = await html(fn(hostile()));
      assert.ok(!out.includes('<script'), `${label}: raw <script`);
      assert.ok(!out.includes('<img'), `${label}: raw <img`);
      assert.ok(!out.includes('onerror=alert(1)>'), `${label}: breakout`);
    });
  }

  test('the card description is inline markdown with html off', async () => {
    const out = await html(
      renderCard(card({ description: `${EVIL} **b** [l](javascript:alert(1))` })),
    );
    assertInert(out, 'description');
    assert.ok(!out.includes('href="javascript:'));
  });

  test('the name and serves badges are plain escaped text', async () => {
    const out = await html(renderCard(card({ name: EVIL, kind: 'mod', serves: [EVIL] })));
    assertInert(out, 'name/serves');
  });
});
