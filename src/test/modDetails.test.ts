import * as assert from 'assert';
import {
  buildCards,
  buildInstalledCards,
  buildDetailsVM,
  groupModHarnesses,
  type WireSearchItem,
  type WireStatusItem,
} from '../webview/model';
import { renderDetails } from '../webview/render';
import { litString } from './litString';
import { normalizeHtml } from './normalizeHtml';
import { recordedMod, recordedModFetch } from './fixtures/recorded';
import { detailsVM } from './fixtures/vms';

const litHtml = async (out: unknown): Promise<string> => normalizeHtml(await litString(out));

const scopes = { projectOpen: true, projectConfigured: true, projectName: 'my-app' };

suite('mod harness grouping', () => {
  const f = (path: string, size = 1) => ({ path, size });
  const toml = '[claude]\nentry = "register.tsx"\n[opencode]\nentry = 7\n';

  test('groups by the second segment in first-appearance order, paths relative', () => {
    const out = groupModHarnesses(
      [
        f('m/mod.toml'),
        f('m/opencode/a.ts'),
        f('m/claude/register.tsx'),
        f('m/opencode/lib/b.ts'),
        f('m/claude/c.ts'),
      ],
      toml,
    );
    assert.deepStrictEqual(
      out.map((h) => [h.name, h.entry, h.files.map((x) => x.path)]),
      [
        ['opencode', null, ['a.ts', 'lib/b.ts']],
        ['claude', 'register.tsx', ['register.tsx', 'c.ts']],
      ],
    );
  });

  test('short, empty-segment and malformed paths belong to no harness', () => {
    const out = groupModHarnesses(
      [f('m/mod.toml'), f('m'), f(''), f('m//x'), f('m/h/'), f('m/ok/x')],
      null,
    );
    assert.deepStrictEqual(
      out.map((h) => h.name),
      ['ok'],
    );
  });

  test('empty, missing and non-array files give no harnesses', () => {
    assert.deepStrictEqual(groupModHarnesses([], toml), []);
    assert.deepStrictEqual(groupModHarnesses(undefined, toml), []);
    assert.deepStrictEqual(groupModHarnesses(null, toml), []);
  });

  test('a parse error, a missing table or a non-string entry reads as null', () => {
    const files = [f('m/claude/x'), f('m/zed/y')];
    for (const bad of [
      '[claude\nentry=',
      null,
      '',
      '[claude]\nentry = 3\n',
      '[zed]\nother = "x"\n',
    ]) {
      assert.deepStrictEqual(
        groupModHarnesses(files, bad).map((h) => h.entry),
        [null, null],
        String(bad),
      );
    }
  });

  test('a harness named like an object member is just a name', () => {
    const out = groupModHarnesses([f('m/__proto__/x'), f('m/constructor/y')], '');
    assert.deepStrictEqual(
      out.map((h) => [h.name, h.entry]),
      [
        ['__proto__', null],
        ['constructor', null],
      ],
    );
  });
});

suite('mod details view (recorded grim 0.16.1)', () => {
  const vm = () =>
    buildDetailsVM({
      repo: 'ghcr.io/acme/status-band',
      searchItem: null,
      describe: null,
      fetch: recordedModFetch('mod-fetch'),
      installs: [],
      scopes,
      logoUri: null,
    });

  test('the VM keeps mod.toml raw and groups the recorded harnesses', () => {
    const v = vm();
    assert.strictEqual(v.kind, 'mod');
    assert.ok(v.contentJson?.includes('[claude]'));
    assert.deepStrictEqual(
      v.modHarnesses.map((h) => [h.name, h.entry]),
      [
        ['claude', 'status-band.tsx'],
        ['opencode', 'status-band.ts'],
      ],
    );
    assert.deepStrictEqual(v.modHarnesses[0]?.files, [{ path: 'status-band.tsx', size: 18 }]);
  });

  test('a harness directory with no mod.toml table renders as plain text, entry not stated', async () => {
    const fetch = recordedModFetch('mod-fetch')!;
    const v = buildDetailsVM({
      repo: 'ghcr.io/acme/status-band',
      searchItem: null,
      describe: null,
      fetch: {
        ...fetch,
        files: [...(fetch.files ?? []), { path: 'status-band/zed/lib/main.lua', size: 54 }],
      },
      installs: [],
      scopes,
      logoUri: null,
    });
    assert.deepStrictEqual(
      v.modHarnesses.map((h) => [h.name, h.entry]),
      [
        ['claude', 'status-band.tsx'],
        ['opencode', 'status-band.ts'],
        ['zed', null],
      ],
    );
    const html = await litHtml(renderDetails(v));
    for (const id of ['h:claude', 'h:opencode', 'h:zed', 'raw']) {
      assert.ok(html.includes(`data-harness="${id}"`), id);
    }
    assert.ok(html.includes('lib/main.lua'));
    assert.ok(html.includes('No entry stated'));
  });

  test('chips and panels render the recorded entries and files, Raw holds mod.toml', async () => {
    const html = await litHtml(renderDetails(vm()));
    assert.ok(html.includes('status-band.tsx'));
    assert.ok(html.includes('18 B'));
    assert.ok(html.includes('schema'), 'raw block shows mod.toml');
    assert.ok(!html.includes('No entry stated'));
  });

  test('a mod without files shows mod.toml alone, no harness chip', async () => {
    const v = buildDetailsVM({
      repo: 'ghcr.io/acme/status-band',
      searchItem: null,
      describe: null,
      fetch: { ...recordedModFetch('mod-fetch')!, files: [] },
      installs: [],
      scopes,
      logoUri: null,
    });
    assert.deepStrictEqual(v.modHarnesses, []);
    const html = await litHtml(renderDetails(v));
    assert.ok(!html.includes('harness-chip'));
    assert.ok(html.includes('code-block'));
  });

  test('every other kind has no mod harnesses', () => {
    assert.deepStrictEqual(detailsVM().modHarnesses, []);
    const v = buildDetailsVM({
      repo: 'ghcr.io/acme/skills/x',
      searchItem: null,
      describe: null,
      fetch: {
        ...recordedModFetch('mod-fetch')!,
        kind: 'skill',
      },
      installs: [],
      scopes,
      logoUri: null,
    });
    assert.deepStrictEqual(v.modHarnesses, []);
  });

  test('details carry serves from describe, then the catalog row', () => {
    const base = {
      repo: 'ghcr.io/acme/status-band',
      fetch: null,
      installs: [],
      scopes,
      logoUri: null,
    };
    const describe = (serves: unknown) =>
      ({
        ref: 'r',
        digest: 'd',
        kind: 'mod',
        name: 'n',
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
        serves,
      }) as never;
    assert.deepStrictEqual(
      buildDetailsVM({ ...base, searchItem: null, describe: describe(['claude', '<x>']) }).serves,
      ['claude'],
    );
    assert.ok(
      !('serves' in buildDetailsVM({ ...base, searchItem: null, describe: describe(null) })),
    );
  });

  test('a hostile harness directory, entry and file name render escaped', async () => {
    // No `/`: the path is split on it, so a slash would end the harness name.
    const evil = '<script>alert(1)<!script>';
    const v = buildDetailsVM({
      repo: 'ghcr.io/acme/status-band',
      searchItem: null,
      describe: null,
      fetch: {
        ref: 'r',
        digest: 'd',
        kind: 'mod',
        name: 'status-band',
        content: `["${evil}"]\nentry = "\\"><img src=x onerror=alert(1)>"\n`,
        files: [
          { path: `m/${evil}/<b>file&"x".ts`, size: 3 },
          { path: 'm/mod.toml', size: 1 },
        ],
      },
      installs: [],
      scopes,
      logoUri: null,
    });
    assert.strictEqual(v.modHarnesses[0]?.name, evil);
    const html = await litHtml(renderDetails(v));
    assert.ok(!html.includes('<script>'));
    assert.ok(!html.includes('<img'));
    assert.ok(!html.includes('<b>file'));
    assert.ok(html.includes('&lt;script&gt;'));
  });
});

suite('mod rows recorded from grim 0.16.1', () => {
  test('the search row carries serves into the card, other kinds carry none', () => {
    const rows = recordedMod<{ items: WireSearchItem[] }>('mod-search').items;
    assert.deepStrictEqual(buildCards(rows, [])[0]?.serves, ['claude', 'opencode']);
    const skills = recordedMod<{ items: WireSearchItem[] }>('search-all').items.filter(
      (i) => i.kind !== 'mod',
    );
    assert.ok(skills.length > 0);
    assert.ok(buildCards(skills, []).every((c) => !('serves' in c)));
  });

  test('an installed mod row carries serves and reads as written, not armed', () => {
    const row = recordedMod<{ items: WireStatusItem[] }>('mod-status-installed').items[0]!;
    const repo = String(row.pinned).split('@')[0] ?? '';
    const [card] = buildInstalledCards(
      [],
      [{ scope: 'project', status: [row], declared: { [`mod:${row.name}`]: `${repo}:1.0.0` } }],
    );
    assert.deepStrictEqual(card?.serves, ['claude', 'opencode']);
    assert.strictEqual(card?.installs[0]?.state, 'installed');
  });
});
