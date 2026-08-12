// Frozen-golden regression tests for src/webview/settings/render.ts, same
// convention as parity.test.ts: a strictEqual failure names a real markup
// delta. INTENTIONAL UI changes regenerate the affected files via
// UPDATE_GOLDENS=1 — review the diff like code, never regenerate to silence a
// failure you can't explain.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { settingsGoldenCases } from './fixtures/settingsGoldenCases';
import {
  registryFieldVMs,
  settingsState,
  wireConfigEntry,
  wireRegistryEntry,
} from './fixtures/settingsVms';
import * as render from '../webview/settings/render';
import {
  buildRegistryRow,
  buildSettingsRow,
  CLOSED_ADD_REGISTRY,
  EMPTY_REGISTRY_DRAFT,
  type AddRegistryDraft,
  type AddRegistryMode,
  type AddRegistryUI,
} from '../webview/settings/model';
import type { SettingsState } from '../webview/protocol';
import { litString } from './litString';
import { normalizeHtml } from './normalizeHtml';

const GOLDENS_DIR = path.join(__dirname, '..', '..', 'src', 'test', 'fixtures', 'goldens');

async function litHtml(out: unknown): Promise<string> {
  return normalizeHtml(await litString(out));
}

/** A grim that accepts the filter flags and `registry set`. The fixture default
 *  is the shipping `false` (settingsVms.ts), so every case that exercises a
 *  pattern repeater or an edit affordance opts in here, by name. */
function editSupported(overrides: Partial<SettingsState> = {}): SettingsState {
  return settingsState({ registryEditSupported: true, ...overrides });
}

/** Edit mode for an `acme` entry that started out unfiltered — the same shape
 *  model.ts's editRegistryUI builds when the pencil is clicked. */
const EDIT_ACME: AddRegistryMode = {
  kind: 'edit',
  alias: 'acme',
  previous: { include: [], exclude: [], default: false, insecure: false },
};

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
    // The notice names a remedy, not just the fact: switching this panel to the
    // tab Browse reads (Global here) is how an edit reaches what Browse shows.
    assert.ok(html.includes('Switch to the Global tab to change what Browse sees'), html);
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
      render.renderSettings(state, { ...CLOSED_ADD_REGISTRY, open: true, draft: EMPTY_REGISTRY_DRAFT, helpOpen: null }),
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
      render.renderSettings(state, { ...CLOSED_ADD_REGISTRY, open: true, draft: EMPTY_REGISTRY_DRAFT, helpOpen: null }),
    );
    assert.ok(html.includes('>Index<'));
    assert.ok(html.includes('>OCI<'));
    assert.ok(html.includes('Set as default registry'));
  });

  test('help tooltip prefers the hardcoded REGISTRY_HELP_COPY over grim description even once fetched', async () => {
    const state = settingsState({ registryFields: registryFieldVMs() });
    const html = await litHtml(
      render.renderSettings(state, { ...CLOSED_ADD_REGISTRY, open: true, draft: EMPTY_REGISTRY_DRAFT, helpOpen: 'index' }),
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
        {
          key: 'index',
          title: '<script>alert(1)</script>',
          description: '<img src=x onerror=alert(1)>',
        },
      ],
    });
    const html = await litHtml(
      render.renderSettings(state, { ...CLOSED_ADD_REGISTRY, open: true, draft: EMPTY_REGISTRY_DRAFT, helpOpen: 'index' }),
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
              insecure: false,
              include: [],
              exclude: [],
              legacy: false,
            },
          ],
        }),
      ),
    );
    assert.ok(!html.includes('<script>x</script>'));
    assert.ok(!html.includes('"><img src=x'));
  });

  test('a filtered registry row is marked; its patterns live in the tooltip', async () => {
    const html = await litHtml(
      render.renderSettings(
        settingsState({
          registries: [
            {
              alias: 'acme',
              type: 'index',
              locator: 'https://index.acme.internal',
              default: false,
              insecure: false,
              include: ['acme/platform/**', 'acme/tools/**'],
              exclude: ['acme/platform/legacy/**'],
              legacy: false,
            },
          ],
        }),
      ),
    );
    assert.ok(html.includes('registry-filter-mark'), 'the entry is marked as filtered');
    assert.ok(html.includes('Include (2)') && html.includes('Exclude (1)'), 'counts per side');
    assert.ok(html.includes('acme/platform/legacy/**'), 'the patterns reach the tooltip');
    // A pattern's meaning IS which side it is on, so the two lists never merge
    // into one run the reader has to split by counting.
    const excludeAt = html.indexOf('Exclude (1)');
    assert.ok(html.indexOf('acme/tools/**') < excludeAt, 'includes are listed under theirs');
    assert.ok(html.indexOf('acme/platform/legacy/**') > excludeAt, 'excludes under theirs');
  });

  test('an unfiltered registry row carries no marker and no filter prose', async () => {
    // The default state needs no words. A FILTERS column spent a sixth of a
    // narrow table saying "Not filtered" on nearly every row; the marker only
    // appears on the exception.
    const registries = [buildRegistryRow(wireRegistryEntry({ alias: 'plain' }))];
    const html = await litHtml(render.renderSettings(settingsState({ registries })));
    assert.ok(!html.includes('registry-filter-mark'));
    assert.ok(!html.includes('Not filtered'));
    assert.ok(!html.includes('FILTERS'), 'the column header went with it');
  });

  test('hostile filter patterns stay inert', async () => {
    const html = await litHtml(
      render.renderSettings(
        settingsState({
          registries: [
            {
              alias: 'acme',
              type: 'index',
              locator: 'https://index.acme.internal',
              default: false,
              insecure: false,
              include: ['<script>alert(1)</script>/**'],
              exclude: ['"><img src=x onerror=alert(1)>'],
              legacy: false,
            },
          ],
        }),
      ),
    );
    // The patterns now land in a title ATTRIBUTE, so the quote is the escape
    // that matters: an unescaped `"` would close the attribute and everything
    // after it would parse as markup.
    assert.ok(!html.includes('<script>alert(1)'));
    assert.ok(!html.includes('"><img src=x'));
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(html.includes('&quot;'), 'a quote inside the tooltip stays inside it');
  });

  test('the add-registry form hides its pattern repeaters on a grim that rejects the flags', async () => {
    const open = { ...CLOSED_ADD_REGISTRY, open: true, draft: EMPTY_REGISTRY_DRAFT, helpOpen: null } as const;
    const shown = await litHtml(
      render.renderSettings(settingsState({ registryEditSupported: true }), open),
    );
    assert.ok(shown.includes('pattern-input'), 'repeaters render on a grim that accepts them');

    const hidden = await litHtml(
      render.renderSettings(settingsState({ registryEditSupported: false }), open),
    );
    assert.ok(!hidden.includes('pattern-input'), 'no control whose every save would fail');
    assert.ok(hidden.includes('form-locator'), 'the rest of the form is untouched');
    // A control that is merely absent reads as a feature this panel never had.
    // Naming the running version beside the required one is what makes it
    // actionable rather than a riddle about which grim is on the PATH.
    assert.ok(
      hidden.includes('Browse filters and the plain-HTTP option need grim 0.13.0 or newer (running 0.12.1).'),
      'the gate says what it needs AND what is running, where the repeaters would have been',
    );
    assert.ok(!shown.includes('Browse filters and the plain-HTTP option need grim'), 'and only when it bites');

    // No version resolved yet: the requirement still shows, the clause does not
    // — "(running null)" would be worse than saying nothing.
    const unknown = await litHtml(
      render.renderSettings(
        settingsState({ registryEditSupported: false, grimVersion: null }),
        open,
      ),
    );
    assert.ok(unknown.includes('Browse filters and the plain-HTTP option need grim 0.13.0 or newer.'), 'requirement stands');
    assert.ok(!unknown.includes('running'), 'no clause invented for an unknown version');
  });

  test('the plain-HTTP checkbox exists on the OCI kind only, and says what it costs', async () => {
    const openWith = (draft: AddRegistryDraft): AddRegistryUI => ({
      ...CLOSED_ADD_REGISTRY,
      open: true,
      draft,
      helpOpen: null,
    });
    const oci = await litHtml(
      render.renderSettings(
        editSupported(),
        openWith({ ...EMPTY_REGISTRY_DRAFT, kind: 'oci', locator: 'localhost:5050/grimoire' }),
      ),
    );
    assert.ok(oci.includes('data-field="insecure"'), 'the OCI kind can opt in');
    assert.ok(
      oci.includes('downgrades transport for everyone who clones the project'),
      'the warning ships with the box, not in a tooltip',
    );
    // grim refuses `--insecure` on an index locator (exit 65), so there is
    // nothing the box could mean there.
    const index = await litHtml(
      render.renderSettings(editSupported(), openWith(EMPTY_REGISTRY_DRAFT)),
    );
    assert.ok(!index.includes('data-field="insecure"'));
    // And it is gated with the rest of the 0.13.0 surface.
    const oldGrim = await litHtml(
      render.renderSettings(
        settingsState({ registryEditSupported: false }),
        openWith({ ...EMPTY_REGISTRY_DRAFT, kind: 'oci' }),
      ),
    );
    assert.ok(!oldGrim.includes('data-field="insecure"'));
  });

  test('an opted-in registry row is marked as plain HTTP', async () => {
    const row = buildRegistryRow(
      wireRegistryEntry({ alias: 'local', oci: 'localhost:5050/grimoire', insecure: true }),
    );
    const html = await litHtml(
      render.renderSettings(settingsState({ registries: [row] })),
    );
    assert.ok(html.includes('registry-insecure-mark'), 'a transport downgrade is never silent');
    assert.ok(html.includes('cleartext'));
    const secure = await litHtml(
      render.renderSettings(
        settingsState({ registries: [buildRegistryRow(wireRegistryEntry())] }),
      ),
    );
    assert.ok(!secure.includes('registry-insecure-mark'));
  });

  test('the two glob lists ship the rules that make them surprising', async () => {
    const html = await litHtml(
      render.renderSettings(editSupported(), {
        ...CLOSED_ADD_REGISTRY,
        open: true,
        draft: EMPTY_REGISTRY_DRAFT,
      }),
    );
    assert.ok(html.includes('How browse filters match'), 'the help is reachable');
    assert.ok(html.includes('with the registry host stripped'), 'what a pattern matches against');
    assert.ok(
      html.includes('empty include list shows everything') &&
        html.includes('empty exclude list hides nothing'),
      'the asymmetry between the two empty lists',
    );
    assert.ok(html.includes('Exclude wins'), 'which side wins a path both match');
    assert.ok(html.includes('is ONE pattern'), 'a comma is alternation, not a separator');
  });

  test('the row edit button follows the same grim gate as the repeaters', async () => {
    const registries = [buildRegistryRow(wireRegistryEntry({ alias: 'acme' }))];
    const shown = await litHtml(
      render.renderSettings(settingsState({ registries, registryEditSupported: true })),
    );
    assert.ok(shown.includes('data-action="edit-registry"'), 'editable on a grim with `set`');

    const hidden = await litHtml(
      render.renderSettings(settingsState({ registries, registryEditSupported: false })),
    );
    assert.ok(
      !hidden.includes('data-action="edit-registry"'),
      'no button whose every save would fail',
    );
    assert.ok(hidden.includes('data-action="remove-registry"'), 'remove is unaffected');
    assert.ok(
      hidden.includes('Editing a registry needs grim 0.13.0 or newer (running 0.12.1).'),
      'the gate says what it needs and what is running, once, under the table',
    );
    assert.ok(!shown.includes('Editing a registry needs grim'), 'and only when it bites');

    // A legacy row carries no edit button at ANY version, so a table of
    // nothing but legacy rows loses nothing to the gate and is told nothing.
    const legacyOnly = await litHtml(
      render.renderSettings(
        settingsState({
          registries: [buildRegistryRow(wireRegistryEntry({ alias: null }))],
          registryEditSupported: false,
        }),
      ),
    );
    assert.ok(!legacyOnly.includes('Editing a registry needs grim'));
  });

  test('both star states are clickable, and each names its own write', async () => {
    const registries = [
      buildRegistryRow(wireRegistryEntry({ alias: 'on', default: true })),
      buildRegistryRow(wireRegistryEntry({ alias: 'off', default: false })),
    ];
    const html = await litHtml(render.renderSettings(settingsState({ registries })));
    assert.ok(
      html.includes('data-action="unset-default-registry" data-alias="on"'),
      'the filled star clears the default',
    );
    assert.ok(
      html.includes('data-action="use-registry" data-alias="off"'),
      'the hollow star sets it',
    );
  });

  test('a legacy row is never editable, whatever grim supports', async () => {
    // grim addresses entries by alias, and this one has none — `registry set`
    // could not name it even on a version that has the verb. It can still
    // CARRY filters (a hand-written grimoire.toml predating aliases), so the
    // marker has to survive the alias cell's legacy branch too.
    const registries = [
      buildRegistryRow(wireRegistryEntry({ alias: null, oci: 'ghcr.io/old', include: ['a/**'] })),
    ];
    const html = await litHtml(
      render.renderSettings(settingsState({ registries, registryEditSupported: true })),
    );
    assert.ok(!html.includes('data-action="edit-registry"'));
    assert.ok(html.includes('codicon-lock'), 'it keeps the read-only marker instead');
    assert.ok(html.includes('registry-filter-mark'), 'a legacy row can be filtered too');
    assert.ok(html.includes('Include (1)'), 'and its patterns still reach the tooltip');
  });

  test('edit mode locks the alias and renames the form, add mode does neither', async () => {
    const draft = {
      alias: 'acme',
      kind: 'index' as const,
      locator: 'https://index.acme.internal',
      include: ['acme/{tools,libs}/**'],
      exclude: [],
      default: false,
      insecure: false,
    };
    const editing = await litHtml(
      render.renderSettings(editSupported(), {
        ...CLOSED_ADD_REGISTRY,
        open: true,
        draft,
        mode: EDIT_ACME,
      }),
    );
    assert.ok(editing.includes('Edit registry'), 'the title states the mode');
    assert.ok(editing.includes('readonly'), 'grim has no rename, so the alias is not editable');
    assert.ok(editing.includes('>Save<'), 'the submit button states the mode');
    // The reason is readable, not buried in a `title` only a mouse finds — a
    // readonly box that looks editable just eats keystrokes.
    assert.ok(editing.includes('grim has no rename — remove and re-add'), 'and says why');

    const adding = await litHtml(
      render.renderSettings(editSupported(), { ...CLOSED_ADD_REGISTRY, open: true, draft }),
    );
    assert.ok(adding.includes('Add registry'));
    assert.ok(!adding.includes('readonly'), 'a new alias is free text');
    assert.ok(adding.includes('>Add Registry<'));
  });

  test('a stored pattern is a click-to-edit control, and one opens as a text box', async () => {
    const draft = {
      alias: 'acme',
      kind: 'index' as const,
      locator: 'https://index.acme.internal',
      include: ['a/**', 'b/**'],
      exclude: [],
      default: false,
      insecure: false,
    };
    const closed = await litHtml(
      render.renderSettings(editSupported(), { ...CLOSED_ADD_REGISTRY, open: true, draft }),
    );
    assert.ok(closed.includes('data-action="edit-pattern"'), 'every chip is clickable');
    // Matched with the sibling class, since the container is `pattern-editor`.
    assert.ok(
      !closed.includes('pattern-input pattern-edit'),
      'nothing is open until one is clicked',
    );

    const open = await litHtml(
      render.renderSettings(editSupported(), {
        ...CLOSED_ADD_REGISTRY,
        open: true,
        draft,
        editingPattern: { field: 'include', index: 1 },
      }),
    );
    assert.ok(
      open.includes('pattern-input pattern-edit'),
      'the clicked chip became an input',
    );
    // Exactly one — the other chip, and the whole other list, stay chips.
    assert.strictEqual(open.match(/pattern-input pattern-edit/g)?.length, 1);
    // Attribute order is the SSR serializer's (alphabetical), not the
    // template's.
    assert.ok(
      open.includes('data-action="edit-pattern" data-index="0" data-pattern-field="include"'),
      'its sibling is still a chip',
    );
  });

  test('the example placeholder clears once a pattern exists; the key hint does not', async () => {
    // A placeholder is the example. Once the user has followed it, it is noise
    // sitting under the thing it was an example of — but the key still needs
    // naming, so the hint lives on the label row and outlasts it.
    const base = {
      alias: 'acme',
      kind: 'index' as const,
      locator: 'https://index.acme.internal',
      exclude: [],
      default: false,
      insecure: false,
    };
    const empty = await litHtml(
      render.renderSettings(editSupported(), {
        ...CLOSED_ADD_REGISTRY,
        open: true,
        draft: { ...base, include: [] },
      }),
    );
    assert.ok(empty.includes('placeholder="acme/platform/**"'), 'the example shows when empty');
    assert.ok(empty.includes('enter to add'));

    const filled = await litHtml(
      render.renderSettings(editSupported(), {
        ...CLOSED_ADD_REGISTRY,
        open: true,
        draft: { ...base, include: ['a/**'] },
      }),
    );
    assert.ok(!filled.includes('placeholder="acme/platform/**"'), 'the example clears');
    assert.ok(
      filled.includes('placeholder="acme/platform/legacy/**"'),
      'the still-empty exclude list keeps its own example',
    );
    assert.ok(filled.includes('enter to add'), 'the key hint stays');
  });

  test('hostile patterns in an edit draft stay inert', async () => {
    const html = await litHtml(
      render.renderSettings(editSupported(), {
        ...CLOSED_ADD_REGISTRY,
        open: true,
        draft: {
          alias: 'x',
          kind: 'oci',
          locator: '<img src=x onerror=alert(1)>',
          include: ['<script>alert(1)</script>'],
          exclude: ['" onmouseover="alert(2)'],
          default: false,
          insecure: false,
        },
        mode: { kind: 'edit', alias: 'x', previous: { include: [], exclude: [], default: false, insecure: false } },
      }),
    );
    assert.ok(!html.includes('<script>alert(1)'));
    assert.ok(!html.includes('<img src=x onerror'));
    assert.ok(!html.includes('" onmouseover="alert(2)"'));
    assert.ok(html.includes('&lt;script&gt;'));
  });

  test('a save in flight freezes the whole form and says so', async () => {
    const html = await litHtml(
      render.renderSettings(editSupported(), {
        ...CLOSED_ADD_REGISTRY,
        open: true,
        draft: {
          alias: 'acme',
          kind: 'index',
          locator: 'https://index.acme.internal',
          include: ['a/**'],
          exclude: [],
          default: false,
          insecure: false,
        },
        mode: EDIT_ACME,
        saving: true,
      }),
    );
    // `inert` is the whole freeze in one attribute: the repeaters' handlers are
    // delegated, so a per-input `disabled` would never reach them.
    assert.ok(html.includes('<div class="add-registry-form saving" inert>'), html.slice(0, 200));
    assert.ok(html.includes('codicon-modifier-spin'), 'the spinner says slow, not stuck');
    assert.ok(html.includes('Saving…'));
    assert.ok(
      html.includes('data-action="submit-add-registry" disabled'),
      'the submit cannot be fired twice',
    );
    assert.ok(
      html.includes('data-action="cancel-add-registry" disabled'),
      'and Cancel cannot orphan a write already on its way',
    );
  });

  test('a pattern chip names itself to both a mouse and a screen reader', async () => {
    const html = await litHtml(
      render.renderSettings(editSupported(), {
        ...CLOSED_ADD_REGISTRY,
        open: true,
        draft: {
          alias: 'acme',
          kind: 'index',
          locator: 'https://index.acme.internal',
          include: ['a/**', 'b/**'],
          exclude: [],
          default: false,
          insecure: false,
        },
      }),
    );
    // Unlabelled, the pair announced as "a/** button, button".
    assert.ok(html.includes('aria-label="Edit a/**"'));
    assert.ok(html.includes('aria-label="Remove a/**"'));
    // Removal is BY INDEX (model.ts removePattern): by value, a repeated glob
    // loses every twin instead of the one that was clicked.
    assert.ok(
      html.includes(
        'aria-label="Remove b/**" class="chip-remove" data-action="remove-pattern" data-index="1"',
      ),
      html,
    );
    // The trailing add box is a bare <input> in a <div>, with no <label> of its
    // own — its only name is this one.
    assert.ok(html.includes('aria-label="Add include pattern"'));
    assert.ok(html.includes('aria-label="Add exclude pattern"'));
  });

  test('hostile patterns stay inert in the chips, their labels and their data', async () => {
    const html = await litHtml(
      render.renderSettings(editSupported(), {
        ...CLOSED_ADD_REGISTRY,
        open: true,
        draft: {
          alias: 'acme',
          kind: 'index',
          locator: 'https://index.acme.internal',
          include: ['"><img src=x onerror=alert(1)>'],
          exclude: ['<script>alert(1)</script>'],
          default: false,
          insecure: false,
        },
      }),
    );
    // One pattern now reaches four places: the chip text, `data-value`,
    // `data-index`'s sibling attributes and two aria-labels. The quote is the
    // escape that matters — unescaped, it closes the attribute and everything
    // after it parses as markup.
    assert.ok(!html.includes('"><img src=x'));
    assert.ok(!html.includes('<script>alert(1)'));
    assert.ok(html.includes('&quot;'), 'the quote stays inside its attribute');
    assert.ok(html.includes('&lt;script&gt;'));
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
        ...CLOSED_ADD_REGISTRY,
        open: true,
        draft: {
          alias: 'x',
          kind: 'oci',
          locator: 'y',
          include: [],
          exclude: [],
          default: false,
          insecure: false,
        },
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
