// Recorded from grim at ef2f133, the head of grimoire PR #318 (main carries its tree as c5e3824;
// binary reports 0.15.1), run sandboxed and sanitized. Re-record when grim releases the kind.
// consent-drifted and the GRIM_HOME not-armed causes have no recording; hand-built rows
// elsewhere cover them. The two global root-fence causes are recorded.
import * as assert from 'assert';
import * as fs from 'fs';
import { recordedSettingsDir, recordedSettingsRaw } from './fixtures/recorded';
import { gatePromptText, hookPromptFor } from '../gatePrompt';
import {
  configSetArgs,
  hookAllowArgs,
  installArgs,
  parseReport,
  refusedNames,
  refusedPieces,
  withRefusedPieces,
} from '../grim';
import type { StatusItem } from '../grim';
import {
  armingLabel,
  buildCards,
  buildDetailsVM,
  buildInstalledCards,
  DEFAULT_FILTER,
  driftTitle,
  filterCards,
  hasClientDrift,
  isUnarmed,
  normalizeKind,
  unarmedTooltip,
  type DetailsSources,
  type ScopeStatus,
  type WireSearchItem,
  type WireStatusItem,
} from '../webview/model';
import type { InstallVM, ScopesVM } from '../webview/protocol';

const raw = recordedSettingsRaw;
type Row = WireStatusItem;
const load = <T = { items: Row[] }>(name: string): T => JSON.parse(raw(name)) as T;
const scopesVM: ScopesVM = { projectOpen: true, projectConfigured: true, projectName: 'my-app' };

const statusFiles = fs
  .readdirSync(recordedSettingsDir)
  .filter((f) => f.startsWith('status-'))
  .map((f) => f.replace(/\.json$/, ''));

const repoOf = (row: Row): string => String(row.pinned).split('@')[0] ?? '';

const firstRow = (name: string): Row => {
  const row = load(name).items[0];
  assert.ok(row, name);
  return row;
};

const scopeFor = (row: Row, scope: ScopeStatus['scope'] = 'project'): ScopeStatus => ({
  scope,
  status: [row],
  declared: { [`settings:${row.name}`]: `${repoOf(row)}:1.0.0` },
});

const installOf = (name: string, scope: ScopeStatus['scope'] = 'project'): InstallVM => {
  const row = firstRow(name);
  const cards = buildInstalledCards([], [scopeFor(row, scope)]);
  assert.strictEqual(cards.length, 1, name);
  return cards[0]?.installs[0] as InstallVM;
};

const settingsItem = (overrides: Partial<WireSearchItem> = {}): WireSearchItem => ({
  kind: 'settings',
  repo: 'ghcr.io/acme/settings/team-defaults',
  summary: null,
  description: null,
  version: null,
  latest_tag: null,
  repository: null,
  revision: null,
  created: null,
  deprecated: null,
  status: 'not-installed',
  ...overrides,
});

suite('recorded settings status rows', () => {
  test('every recorded row builds a settings card with each client once', () => {
    assert.ok(statusFiles.length >= 7, 'the status recordings are present');
    for (const file of statusFiles) {
      const row = firstRow(file);
      const cards = buildInstalledCards([], [scopeFor(row)]);
      assert.strictEqual(cards[0]?.kind, 'settings', file);
      const clients = cards[0]?.installs[0]?.clients ?? [];
      assert.deepStrictEqual(clients, [...new Set(clients)], file);
    }
  });

  test('gated rows are unarmed with the settings header and grim message', () => {
    for (const [file, text, label] of [
      ['status-flag-off', 'settings are gated', 'not applied'],
      ['status-not-consented', 'not been consented', 'not applied'],
      ['status-client-config-absent', 'cli-config.json', 'not applied'],
    ] as const) {
      const vm = installOf(file);
      const message = firstRow(file).arming?.[0]?.message ?? '';
      assert.strictEqual(isUnarmed(vm), true, file);
      const tip = unarmedTooltip(vm);
      assert.ok(tip.startsWith('Settings not applied:\n'), file);
      assert.ok(tip.includes(message), file);
      assert.ok(tip.includes(text), file);
      assert.strictEqual(armingLabel(vm), label, file);
    }
  });

  test('a global root-fence refusal is not applied and names the --global remedy', () => {
    for (const [file, cause] of [
      ['status-root-relative', 'settings-root-relative'],
      ['status-root-in-workspace', 'settings-root-in-workspace'],
    ] as const) {
      const row = firstRow(file);
      assert.strictEqual(row.state, 'not-armed', file);
      assert.strictEqual(row.arming?.[0]?.cause, cause, file);
      const vm = installOf(file, 'global');
      assert.strictEqual(isUnarmed(vm), true, file);
      const tip = unarmedTooltip(vm);
      assert.ok(tip.startsWith('Settings not applied:\ncodex: '), file);
      assert.ok(tip.includes(row.arming?.[0]?.message ?? '\0'), file);
      assert.ok(tip.includes('grim install --global'), file);
      assert.strictEqual(armingLabel(vm), 'not applied', file);
    }
  });

  test('a recorded gated row shows no client drift', () => {
    for (const file of ['status-flag-off', 'status-not-consented']) {
      assert.strictEqual(firstRow(file).state, 'gated', file);
      assert.strictEqual(hasClientDrift(installOf(file)), false, file);
    }
  });

  test('a flag-off hook row pins the full tooltip and label', () => {
    const base = installOf('status-consented');
    const vm: InstallVM = {
      ...base,
      kind: 'hook',
      arming: [{ client: 'claude', cause: 'feature-flag-off', message: 'm' }],
    };
    assert.strictEqual(unarmedTooltip(vm), 'Hook not armed:\nclaude: m');
    assert.strictEqual(armingLabel(vm), 'not armed');
  });

  test('a git-tracked local file needs attention', () => {
    const vm = installOf('status-local-tracked');
    assert.strictEqual(isUnarmed(vm), true);
    assert.ok(unarmedTooltip(vm).startsWith('Settings need attention:\n'));
    assert.strictEqual(armingLabel(vm), 'needs attention');
  });

  test('applied rows are not unarmed, and a modified row words its drift for values', () => {
    assert.strictEqual(isUnarmed(installOf('status-consented')), false);
    assert.strictEqual(isUnarmed(installOf('status-no-applicable')), false);
    const modified = installOf('status-modified');
    assert.strictEqual(isUnarmed(modified), false);
    assert.strictEqual(driftTitle(modified), 'Settings values were changed locally');
  });

  test('the consented row lists claude once', () => {
    assert.deepStrictEqual(installOf('status-consented').clients, ['claude']);
  });
});

suite('recorded settings gate prompts', () => {
  const rows = (file: string): StatusItem[] => load(file).items as StatusItem[];
  const hookRow = {
    kind: 'hook',
    name: 'shell-guard',
    source: 'direct',
    pinned: null,
    state: 'gated',
    outputs: [],
    arming: [{ client: 'claude', cause: 'workspace-not-consented', message: 'm' }],
  } as unknown as StatusItem;

  test('flag off asks to enable settings, then installs', () => {
    const prompt = hookPromptFor(rows('status-flag-off'));
    assert.deepStrictEqual(prompt, {
      gate: 'enable-settings',
      kinds: ['settings'],
      names: ['team-defaults'],
    });
    const text = gatePromptText(prompt as NonNullable<typeof prompt>);
    assert.deepStrictEqual(text.steps, [
      configSetArgs('options.experimental.settings', 'true'),
      installArgs(),
    ]);
  });

  test('no consent asks to allow settings, then installs', () => {
    const prompt = hookPromptFor(rows('status-not-consented'));
    assert.deepStrictEqual(prompt, {
      gate: 'consent',
      kinds: ['settings'],
      names: ['team-defaults'],
      held: ['settings'],
    });
    const text = gatePromptText(prompt as NonNullable<typeof prompt>);
    assert.ok(text.message.includes('settings packages'));
    assert.ok(!text.message.includes('hooks'));
    assert.deepStrictEqual(text.steps, [hookAllowArgs(), installArgs()]);
  });

  test('a hook row awaiting consent joins the settings row in one prompt', () => {
    const prompt = hookPromptFor([...rows('status-not-consented'), hookRow]);
    assert.ok(prompt);
    assert.strictEqual(prompt.gate, 'consent');
    assert.deepStrictEqual(prompt.kinds, ['hook', 'settings']);
    const text = gatePromptText(prompt);
    assert.ok(text.message.includes('hooks and settings packages'));
    assert.ok(text.message.includes('team-defaults'));
    assert.ok(text.message.includes('shell-guard'));
  });

  test('applied and merely tracked rows prompt nothing', () => {
    for (const file of ['status-consented', 'status-modified', 'status-local-tracked']) {
      assert.strictEqual(hookPromptFor(rows(file)), null, file);
    }
  });

  test('a root-fence refusal prompts nothing: no flag or consent clears it', () => {
    for (const file of ['status-root-relative', 'status-root-in-workspace']) {
      assert.strictEqual(hookPromptFor(rows(file)), null, file);
    }
  });
});

suite('recorded settings reports', () => {
  const exits = load<Record<string, number>>('exits');

  test('every recording has its exit code, and every one parses', () => {
    const files = fs
      .readdirSync(recordedSettingsDir)
      .filter((f) => f.endsWith('.json') && f !== 'exits.json')
      .map((f) => f.replace(/\.json$/, ''))
      .sort();
    assert.deepStrictEqual(Object.keys(exits).sort(), files);
    for (const [file, exit] of Object.entries(exits)) {
      const r = parseReport<unknown>(raw(file), exit, '');
      // install-modified is the one error document; update-modified exits 65
      // with a normal report.
      assert.strictEqual(r.ok, file !== 'install-modified', file);
    }
  });

  test('only the refused update carries refused rows or pieces', () => {
    for (const [file, exit] of Object.entries(exits)) {
      const r = parseReport<unknown>(raw(file), exit, '');
      if (!r.ok) {
        continue;
      }
      const refused = file === 'update-modified';
      assert.strictEqual(refusedNames(r.value).length > 0, refused, file);
      assert.strictEqual(refusedPieces(r.value).length > 0, refused, file);
    }
  });
});

suite('recorded settings refusals', () => {
  test('install-modified names the refused value and never the user value', () => {
    const r = parseReport<unknown>(raw('install-modified'), 65, '');
    assert.strictEqual(r.ok, false);
    const pieces = (r as { pieces?: never }).pieces ?? [];
    const detail = withRefusedPieces('Reinstalling discards your local changes.', pieces);
    assert.ok(detail.includes('Refused settings values:'));
    assert.ok(detail.includes('claude .claude/settings.local.json /model'));
    assert.ok(!detail.includes('opus'));
    assert.ok(!detail.includes('sonnet'));
  });

  test('update-modified lists the same piece and names the row', () => {
    const report = load('update-modified');
    const detail = withRefusedPieces('detail', refusedPieces(report));
    assert.ok(detail.includes('claude .claude/settings.local.json /model'));
    assert.ok(!detail.includes('opus'));
    assert.deepStrictEqual(refusedNames(report), ['team-defaults']);
  });
});

suite('recorded settings catalog output', () => {
  test('search-settings items browse as settings cards and survive the settings filter', () => {
    const items = load<{ items: WireSearchItem[] }>('search-settings').items;
    assert.ok(items.length > 0);
    assert.strictEqual(normalizeKind(items[0]?.kind ?? null), 'settings');
    const skill = settingsItem({ kind: 'skill', repo: 'ghcr.io/acme/skills/other' });
    const cards = buildCards([...items, skill], []);
    const kept = filterCards(cards, { ...DEFAULT_FILTER, kinds: ['settings'] });
    assert.deepStrictEqual(
      kept.map((c) => c.repo),
      items.map((i) => i.repo),
    );
    assert.ok(kept.every((c) => c.kind === 'settings'));
  });

  test('fetch and describe build a settings details view with JSON contents', () => {
    const vm = buildDetailsVM({
      repo: 'ghcr.io/acme/settings/team-defaults',
      searchItem: null,
      describe: load<DetailsSources['describe']>('describe-settings'),
      fetch: load<DetailsSources['fetch']>('fetch-settings'),
      installs: [],
      scopes: scopesVM,
      logoUri: null,
    });
    assert.strictEqual(vm.kind, 'settings');
    assert.strictEqual(vm.contentMarkdown, null);
    assert.ok((vm.contentJson ?? '').length > 0);
  });

  test('config list carries the experimental settings flag', () => {
    const rows = load<{ items: { key: string; section: string; type: string }[] }>(
      'config-list-all',
    ).items;
    const flag = rows.find((r) => r.key === 'options.experimental.settings');
    assert.ok(flag);
    assert.strictEqual(flag.section, 'experimental');
    assert.strictEqual(flag.type, 'boolean');
  });
});
