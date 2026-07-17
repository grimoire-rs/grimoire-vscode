// Frozen-golden regression tests for src/webview/settings/render.ts, same
// convention as parity.test.ts: a strictEqual failure names a real markup
// delta. INTENTIONAL UI changes regenerate the affected files via
// UPDATE_GOLDENS=1 — review the diff like code, never regenerate to silence a
// failure you can't explain.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { settingsGoldenCases } from './fixtures/settingsGoldenCases';
import { settingsState, wireConfigEntry } from './fixtures/settingsVms';
import * as render from '../webview/settings/render';
import { buildSettingsRow } from '../webview/settings/model';
import { litString } from './litString';
import { normalizeHtml } from './normalizeHtml';

const GOLDENS_DIR = path.join(__dirname, '..', '..', 'src', 'test', 'fixtures', 'goldens');

async function litHtml(out: unknown): Promise<string> {
  return normalizeHtml(await litString(out));
}

suite('settings frozen goldens', () => {
  const cases = settingsGoldenCases(render);

  for (const kase of cases) {
    test(kase.name, async () => {
      const goldenPath = path.join(GOLDENS_DIR, `${kase.name}.html`);
      const actual = await litHtml(kase.out);
      if (process.env['UPDATE_GOLDENS'] === '1') {
        fs.writeFileSync(goldenPath, actual);
      }
      if (!fs.existsSync(goldenPath)) {
        throw new Error(
          `missing golden file for case "${kase.name}": ${goldenPath} — run with UPDATE_GOLDENS=1 once to capture it.`,
        );
      }
      const golden = fs.readFileSync(goldenPath, 'utf8');
      assert.strictEqual(actual, golden);
    });
  }
});

suite('settings escaping', () => {
  test('hostile row title/description/value stay inert', async () => {
    const row = buildSettingsRow(
      wireConfigEntry({
        title: '<script>alert(1)</script>',
        description: '<b>bold</b> and a `code span`',
        value: '"><img src=x onerror=alert(1)>',
        type: 'string',
      }),
    );
    const html = await litHtml(
      render.renderSettings(settingsState({ groups: [{ title: 'Options', rows: [row] }] })),
    );
    assert.ok(!html.includes('<script>alert(1)'));
    assert.ok(html.includes('&lt;script&gt;'));
    // description renders as inline markdown (html:false) — raw <b> stays escaped,
    // backtick code span DOES render as <code>.
    assert.ok(!html.includes('<b>bold</b>'));
    assert.ok(html.includes('<code>code span</code>'));
    assert.ok(!html.includes('"><img src=x'));
  });

  test('hostile registry alias/locator stay inert', async () => {
    const html = await litHtml(
      render.renderSettings(
        settingsState({
          registries: [
            {
              alias: '<script>x</script>',
              type: 'oci',
              locator: '"><img src=x onerror=alert(1)>',
              default: false,
              legacy: false,
            },
          ],
        }),
      ),
    );
    assert.ok(!html.includes('<script>x</script>'));
    assert.ok(!html.includes('"><img src=x'));
  });

  test('hostile row error message stays inert', async () => {
    const row = buildSettingsRow(wireConfigEntry({ type: 'string' }));
    row.status = 'error';
    row.errorMessage = '<img src=x onerror=alert(1)>';
    const html = await litHtml(
      render.renderSettings(settingsState({ groups: [{ title: 'Options', rows: [row] }] })),
    );
    assert.ok(!html.includes('<img src=x onerror'));
    assert.ok(html.includes('&lt;img'));
  });

  test('hostile add-registry form error stays inert', async () => {
    const html = await litHtml(
      render.renderSettings(settingsState(), {
        open: true,
        draft: { alias: 'x', kind: 'oci', locator: 'y', default: false },
        error: '<script>alert(1)</script>',
      }),
    );
    assert.ok(!html.includes('<script>alert(1)'));
    assert.ok(html.includes('&lt;script&gt;'));
  });
});
