// One suite that walks the program's own KINDS: a kind added to ArtifactKind /
// KINDS without an icon, label, colour, chip, details body, declared table,
// golden or recorded coverage fails here (or in the compiler, where a
// Record<ArtifactKind, ...> table is involved).
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { KIND_TABLES, parseDeclaredRefs } from '../scopes';
import {
  buildCards,
  buildDetailsVM,
  buildInstalledCards,
  declaredKey,
  KIND_ICONS,
  KIND_LABELS,
  KINDS,
  normalizeKind,
  type DetailsSources,
  type WireSearchItem,
  type WireStatusItem,
} from '../webview/model';
import type { ArtifactKind } from '../webview/protocol';
import { KIND_CHIPS } from '../webview/render';
import { recordedMod, recordedModFetch } from './fixtures/recorded';

const root = path.join(__dirname, '..', '..');
const text = (...p: string[]): string => fs.readFileSync(path.join(root, ...p), 'utf8');
const scopes = { projectOpen: true, projectConfigured: true, projectName: 'my-app' };

/** What each kind's recorded fetch becomes in the details CONTENTS tab. A new
 *  kind does not compile until it says what its body is. */
interface Body {
  markdown: boolean;
  /** The raw block: a JSON descriptor, a TOML file, or null. */
  block: 'json' | 'toml' | null;
  members: boolean;
  harnesses: boolean;
}
const BODY: Record<ArtifactKind, Body> = {
  skill: { markdown: true, block: null, members: false, harnesses: false },
  rule: { markdown: true, block: null, members: false, harnesses: false },
  agent: { markdown: true, block: null, members: false, harnesses: false },
  mcp: { markdown: false, block: 'json', members: false, harnesses: false },
  bundle: { markdown: false, block: 'json', members: true, harnesses: false },
  hook: { markdown: false, block: 'toml', members: false, harnesses: false },
  settings: { markdown: false, block: 'json', members: false, harnesses: false },
  mod: { markdown: false, block: 'toml', members: false, harnesses: true },
};

/** Recorded name per kind, as `record-kinds.sh` publishes them. */
const names = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const k of KINDS) {
    const row = recordedMod<{ items: WireStatusItem[] }>(`${k}-status`).items.find(
      (i) => i.kind === k,
    );
    assert.ok(row, `${k}-status has a ${k} row`);
    out[k] = row.name;
  }
  return out;
};

const detailsOf = (k: ArtifactKind) =>
  buildDetailsVM({
    repo: `ghcr.io/acme/${names()[k]}`,
    searchItem: null,
    describe: recordedMod<DetailsSources['describe']>(`${k}-describe`),
    fetch: recordedModFetch(`${k}-fetch`),
    installs: [],
    scopes,
    logoUri: null,
  });

suite('every kind is wired at every site', () => {
  test('KINDS has no duplicates and normalizes to itself', () => {
    assert.strictEqual(new Set(KINDS).size, KINDS.length);
    for (const k of KINDS) {
      assert.strictEqual(normalizeKind(k), k);
      assert.strictEqual(normalizeKind(k.toUpperCase()), k);
    }
  });

  test('icon: a codicon that ships in the font, not the fallback', () => {
    const css = text('node_modules', '@vscode', 'codicons', 'dist', 'codicon.css');
    for (const k of KINDS) {
      const icon = KIND_ICONS[k];
      assert.ok(icon && icon !== 'question', k);
      assert.ok(css.includes(`.codicon-${icon}:before`), `${k}: codicon-${icon}`);
    }
  });

  test('label: non-empty', () => {
    for (const k of KINDS) {
      assert.ok(KIND_LABELS[k].length > 0, k);
    }
  });

  test('colour class: .kind-<k> in both stylesheets', () => {
    for (const sheet of [
      ['src', 'webview', 'details', 'details.css'],
      ['src', 'webview', 'sidebar', 'sidebar.css'],
    ]) {
      const css = text(...sheet);
      for (const k of KINDS) {
        assert.ok(new RegExp(`\\.kind-${k}\\s*\\{`).test(css), `${k} in ${sheet.at(-1)}`);
      }
    }
  });

  test('filter chip: All plus one per kind, labelled', () => {
    assert.deepStrictEqual(
      KIND_CHIPS.map((c) => c.id),
      ['all', ...KINDS],
    );
    for (const k of KINDS) {
      assert.strictEqual(KIND_CHIPS.find((c) => c.id === k)?.label, KIND_LABELS[k]);
    }
  });

  test('details body: the recorded fetch shapes the CONTENTS tab as declared', () => {
    for (const k of KINDS) {
      const want = BODY[k];
      const vm = detailsOf(k);
      assert.strictEqual(vm.kind, k);
      assert.strictEqual(vm.contentMarkdown !== null, want.markdown, `${k} markdown`);
      assert.strictEqual(vm.contentJson !== null, want.block !== null, `${k} block`);
      if (want.block === 'json') {
        assert.doesNotThrow(() => JSON.parse(vm.contentJson ?? ''), `${k} json`);
      }
      if (want.block === 'toml') {
        assert.ok(!(vm.contentJson ?? '').trimStart().startsWith('{'), `${k} toml`);
      }
      assert.strictEqual(vm.members.length > 0, want.members, `${k} members`);
      assert.strictEqual(vm.modHarnesses.length > 0, want.harnesses, `${k} harnesses`);
    }
  });

  test('declared table: every kind has a table that parses back and grim declares', () => {
    const script = text('src', 'test', 'fixtures', 'grim', 'record-kinds.sh');
    const block = /fresh_project true "(\[skills\][\s\S]*?)\$mod_decl"/.exec(script)?.[1];
    const mods = /mod_decl="(\[mods\]\n(?:[^"\\]|\\.)*)"/.exec(script)?.[1];
    assert.ok(block && mods, 'install-all declaration found in record-kinds.sh');
    const toml = (block + mods)
      .replace(/\\"/g, '"')
      .replace(/\$\(ref ([\w-]+)\)/g, 'ghcr.io/acme/$1:1.0.0');
    const declared = parseDeclaredRefs(toml);
    const n = names();
    for (const k of KINDS) {
      assert.ok(toml.includes(`[${KIND_TABLES[k]}]`), `${k}: grim declares [${KIND_TABLES[k]}]`);
      assert.strictEqual(
        declared[declaredKey(k, n[k] ?? '')],
        `ghcr.io/acme/${n[k]}:1.0.0`,
        `${k} round trip`,
      );
    }
    assert.strictEqual(Object.keys(declared).length, KINDS.length);
  });

  test('goldens: a card and a details golden per kind', () => {
    const index: string[] = JSON.parse(
      text('src', 'test', 'fixtures', 'goldens', 'index.json'),
    ) as string[];
    for (const k of KINDS) {
      for (const g of [`card-kind-${k}`, `details-kind-${k}`]) {
        assert.ok(index.includes(g), g);
        assert.ok(
          fs.existsSync(path.join(root, 'src', 'test', 'fixtures', 'goldens', `${g}.html`)),
        );
      }
    }
  });

  test('recorded coverage: search, describe, fetch and status parse through the read path', () => {
    const n = names();
    for (const k of KINDS) {
      const serves = k === 'mod' ? ['claude', 'opencode'] : null;
      const search = recordedMod<{ items: WireSearchItem[] }>(`${k}-search`).items;
      const [card] = buildCards(search, []);
      assert.strictEqual(card?.kind, k, `${k} search card`);
      assert.deepStrictEqual(card?.serves ?? null, serves, `${k} search serves`);

      const describe = recordedMod<DetailsSources['describe'] & { serves?: unknown }>(
        `${k}-describe`,
      );
      assert.strictEqual(normalizeKind(describe?.kind), k, `${k} describe`);
      assert.deepStrictEqual(describe?.serves ?? null, serves, `${k} describe serves`);
      assert.strictEqual(detailsOf(k).kind, k);

      const fetch = recordedModFetch(`${k}-fetch`);
      assert.strictEqual(normalizeKind(fetch?.kind), k, `${k} fetch`);

      const rows = recordedMod<{ items: WireStatusItem[] }>(`${k}-status`).items;
      const row = rows.find((r) => r.kind === k);
      assert.ok(row, `${k} status row`);
      assert.deepStrictEqual((row as { serves?: unknown }).serves ?? null, serves, `${k} status`);
      // A bundle row reads `pinned: null`; its ref only comes from grimoire.toml.
      const declared = Object.fromEntries(
        rows.map((r) => [declaredKey(r.kind, r.name), `ghcr.io/acme/${r.name}:1.0.0`]),
      );
      const cards = buildInstalledCards([], [{ scope: 'project', status: rows, declared }]);
      const installed = cards.find((c) => c.kind === k);
      assert.ok(installed, `${k} installed card`);
      assert.strictEqual(installed.name, n[k]);
      assert.deepStrictEqual(installed.serves ?? null, serves, `${k} installed serves`);
    }
  });
});
