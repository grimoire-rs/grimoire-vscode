// Frozen-golden regression tests for src/webview/settings/render.ts, same
// convention as parity.test.ts: a strictEqual failure names a real markup
// delta. INTENTIONAL UI changes regenerate the affected files via
// UPDATE_GOLDENS=1 — review the diff like code, never regenerate to silence a
// failure you can't explain.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { settingsGoldenCases } from './fixtures/settingsGoldenCases';
import { registryFieldVMs, settingsState, wireConfigEntry } from './fixtures/settingsVms';
import * as render from '../webview/settings/render';
import { buildSettingsRow, EMPTY_REGISTRY_DRAFT } from '../webview/settings/model';
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

suite('settings controls', () => {
  // Regression check for the dirty-value-flag bug (a plain `value="${…}"`
  // attribute binding stops updating an <input> the user has already typed
  // into — see textControl/numberControl's comment in render.ts). The SSR
  // golden path above can't tell the two binding kinds apart (@lit-labs/ssr
  // renders a reflected property identically to a plain attribute — see
  // renderPropertyPart in its render-value.js), so this inspects the
  // TemplateResult's own static strings for the literal `.value=` marker lit
  // uses to recognize a property binding at template-parse time, before any
  // DOM is involved.
  test('text/number controls bind value via the lit-html property syntax, not a plain attribute', () => {
    const stringRow = buildSettingsRow(wireConfigEntry({ type: 'string', value: 'x' }));
    const integerRow = buildSettingsRow(wireConfigEntry({ type: 'integer', value: '1' }));
    for (const row of [stringRow, integerRow]) {
      const tpl = render.renderControl(row) as unknown as { strings: TemplateStringsArray };
      const raw = tpl.strings.raw.join('');
      assert.ok(
        raw.includes('.value="'),
        `expected a property binding (".value=") for a ${row.type} control, got: ${raw}`,
      );
    }
  });
});

suite('scope mismatch notice', () => {
  test('names both scopes when Browse searches the one this panel is not editing', async () => {
    const html = await litHtml(
      render.renderSettings(settingsState({ scope: 'project', searchScope: 'global' })),
    );
    assert.ok(html.includes('Browse is searching Global scope'), html);
    assert.ok(html.includes('these settings apply to Project'), html);
  });

  test('stays silent when the scopes agree, or when the search scope is unknown', async () => {
    const agreeing = settingsState({ scope: 'global', searchScope: 'global' });
    assert.strictEqual(await litString(render.renderScopeMismatch(agreeing)), '');
    // No snapshot taken yet: claim nothing rather than guess a mismatch.
    const unknown = settingsState({ scope: 'global' });
    assert.strictEqual(unknown.searchScope, undefined);
    assert.strictEqual(await litString(render.renderScopeMismatch(unknown)), '');
  });
});

suite('settings registry field labels (grim config registry fields)', () => {
  test('radio/checkbox labels source from grim title when the fetch succeeded', async () => {
    const state = settingsState({ registryFields: registryFieldVMs() });
    const html = await litHtml(
      render.renderSettings(state, { open: true, draft: EMPTY_REGISTRY_DRAFT, helpOpen: null }),
    );
    assert.ok(html.includes('Package-index locator'), 'index radio label sourced from grim title');
    assert.ok(html.includes('OCI registry ref'), 'oci radio label sourced from grim title');
    assert.ok(html.includes('Default registry flag'), 'checkbox label sourced from grim title');
  });

  // Spec: "Fetch failure => full hardcoded fallback for labels + tooltips" —
  // an empty registryFields list (no fetch yet, or the fetch failed) must
  // render EXACTLY the pre-existing hardcoded copy, no error surfaced.
  test('empty registryFields (fetch failure or not-yet-resolved) falls back fully to the hardcoded labels', async () => {
    const state = settingsState({ registryFields: [] });
    const html = await litHtml(
      render.renderSettings(state, { open: true, draft: EMPTY_REGISTRY_DRAFT, helpOpen: null }),
    );
    assert.ok(html.includes('>Index<'));
    assert.ok(html.includes('>OCI<'));
    assert.ok(html.includes('Set as default registry'));
  });

  test('help tooltip prefers the hardcoded REGISTRY_HELP_COPY over grim description even once fetched', async () => {
    const state = settingsState({ registryFields: registryFieldVMs() });
    const html = await litHtml(
      render.renderSettings(state, { open: true, draft: EMPTY_REGISTRY_DRAFT, helpOpen: 'index' }),
    );
    assert.ok(
      html.includes('curated catalogs like the hosted Grimoire index'),
      'hardcoded tooltip copy still wins',
    );
    assert.ok(
      !html.includes('Sets a package-index locator that replaces'),
      "grim's description must not replace the hardcoded tooltip copy",
    );
  });
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

  // New render path this package introduces: state.registryFields' title
  // (radio/checkbox label) and description (tooltip fallback) are now
  // dynamic, grim-sourced bindings rather than hardcoded literals.
  test('hostile registry field title/description (grim config registry fields) stay inert', async () => {
    const state = settingsState({
      registryFields: [
        { key: 'index', title: '<script>alert(1)</script>', description: '<img src=x onerror=alert(1)>' },
      ],
    });
    const html = await litHtml(
      render.renderSettings(state, { open: true, draft: EMPTY_REGISTRY_DRAFT, helpOpen: 'index' }),
    );
    assert.ok(!html.includes('<script>alert(1)'));
    assert.ok(html.includes('&lt;script&gt;'));
    // REGISTRY_HELP_COPY covers 'index', so the hostile description (the
    // grim-description FALLBACK path) never even reaches the DOM here — this
    // still pins that IF it ever did (a future kind missing from the
    // hardcoded map), the binding is a plain lit-html text binding, not
    // unsafeHTML, so it would render inert too.
    assert.ok(!html.includes('<img src=x onerror'));
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
        helpOpen: null,
        error: '<script>alert(1)</script>',
      }),
    );
    assert.ok(!html.includes('<script>alert(1)'));
    assert.ok(html.includes('&lt;script&gt;'));
  });

  test('a rejected registry rm/use surfaces its message over the table and stays inert', async () => {
    const html = await litHtml(
      render.renderSettings(settingsState(), undefined, '<script>alert(1)</script> refused'),
    );
    assert.ok(html.includes('refused'));
    assert.ok(!html.includes('<script>alert(1)'));
    assert.ok(html.includes('&lt;script&gt;'));
  });

  test('no registryError renders no banner', async () => {
    const html = await litHtml(render.renderSettings(settingsState()));
    assert.ok(!html.includes('codicon-error'));
  });
});
