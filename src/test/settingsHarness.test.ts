// Settings CONTENTS: harness extraction (pure model) and the chip/JSON-panel render.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { parseSettingsHarnesses } from '../webview/model';
import { renderDetails } from '../webview/render';
import { litString } from './litString';
import { normalizeHtml } from './normalizeHtml';
import { detailsVM } from './fixtures/vms';

const fixture = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'test', 'fixtures', 'grim', '0.16.0', 'settings-fetch.json'),
    'utf8',
  ),
) as { content: string };

const render = async (contentJson: string): Promise<string> =>
  normalizeHtml(
    await litString(
      renderDetails(
        detailsVM({
          kind: 'settings',
          contentMarkdown: null,
          contentJson,
          settingsHarnesses: parseSettingsHarnesses(contentJson),
        }),
      ),
    ),
  );

suite('settings harness model', () => {
  test('extracts the harness tables of the 0.16.0 fixture in order, metadata excluded', () => {
    const hs = parseSettingsHarnesses(fixture.content);
    assert.deepStrictEqual(
      hs.map((h) => h.name),
      ['claude', 'codex'],
    );
    assert.deepStrictEqual(Object.keys(JSON.parse(hs[0]?.json ?? '') as object), [
      'model',
      'permissions',
    ]);
    assert.deepStrictEqual(JSON.parse(hs[1]?.json ?? ''), { model: 'gpt-5' });
  });

  test('keeps an unknown harness and a deeply nested unknown option verbatim', () => {
    const deep = { a: { b: { c: { d: [1, { e: null }] } } } };
    const hs = parseSettingsHarnesses(
      JSON.stringify({ description: 'x', keywords: ['k'], future: { 'new-opt': deep } }),
    );
    assert.strictEqual(hs.length, 1);
    assert.strictEqual(hs[0]?.name, 'future');
    assert.deepStrictEqual(JSON.parse(hs[0]?.json ?? ''), { 'new-opt': deep });
  });

  test('an empty harness table stays an empty object', () => {
    assert.deepStrictEqual(parseSettingsHarnesses('{"claude":{}}'), [{ name: 'claude', json: '{}' }]);
  });

  test('non-JSON, non-object and zero-harness content yield no harnesses', () => {
    assert.deepStrictEqual(parseSettingsHarnesses('not json'), []);
    assert.deepStrictEqual(parseSettingsHarnesses('[{"a":1}]'), []);
    assert.deepStrictEqual(parseSettingsHarnesses('{"description":"d","keywords":[]}'), []);
  });
});

suite('settings harness render', () => {
  test('chips carry the right icons, the first is active, Raw comes last', async () => {
    const html = await render(
      JSON.stringify({
        claude: { model: 'm', permissions: {} },
        codex: { a: 1 },
        copilot: { a: 1 },
        cursor: { a: 1 },
        newcomer: { a: 1 },
      }),
    );
    for (const icon of ['claude', 'openai', 'copilot', 'cursor', 'settings-gear', 'json']) {
      assert.ok(html.includes(`codicon-${icon}`), icon);
    }
    assert.strictEqual(html.match(/class="harness-chip active"/g)?.length, 1);
    assert.ok(/harness-chip active"[^>]*data-harness="h:claude"/.test(html));
    const ids = [...html.matchAll(/class="harness-chip[^"]*"[^>]*data-harness="([^"]*)"/g)].map(
      (m) => m[1],
    );
    assert.deepStrictEqual(ids, ['h:claude', 'h:codex', 'h:copilot', 'h:cursor', 'h:newcomer', 'raw']);
    assert.strictEqual(html.match(/class="harness-panel"/g)?.length, 1);
    assert.strictEqual(html.match(/class="harness-panel hidden"/g)?.length, 5);
    assert.ok(!html.includes('<table'));
  });

  test('a harness named raw does not collide with the Raw chip', async () => {
    const html = await render('{"raw":{"a":1}}');
    assert.ok(html.includes('data-harness="h:raw"'));
    assert.strictEqual(html.match(/class="harness-chip[^"]*"[^>]*data-harness="raw"/g)?.length, 1);
  });

  test('zero-harness content falls back to the plain JSON block', async () => {
    const html = await render('{"description":"d"}');
    assert.ok(html.includes('class="json-code"'));
    assert.ok(!html.includes('harness-chip'));
  });

  test('hostile harness names, keys and values stay inert', async () => {
    const evil = '<img src=x onerror=1>"\'';
    const html = await render(
      JSON.stringify({ [evil]: { [evil]: '</code><script>alert(1)</script>' } }),
    );
    assert.ok(!html.includes('<img src=x'));
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;img src=x onerror=1&gt;'));
    assert.ok(html.includes('&lt;/code&gt;&lt;script&gt;'));
  });
});
