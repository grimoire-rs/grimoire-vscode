import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { GrimoireApi } from '../extension';
import {
  configSetArgs,
  contextArgs,
  describeArgs,
  fetchArgs,
  installArgs,
  lockArgs,
  registryFieldsArgs,
  runJson,
  statusArgs,
  updateArgs,
  updateSummary,
  type ConfigWriteResult,
  type ContextInfo,
  type DigestResult,
  type ItemsEnvelope,
  type DescribeResult,
  type RegistryFieldEntry,
  type StatusItem,
  type UpdateEntry,
} from '../grim';
import { grimTooOld } from '../installer';
import { withGlobalFlag } from '../scopes';

// Live contract tests against a real grim. Defaults to `grim` on PATH (the
// released CLI ships the full v2 surface: describe, fetch --description,
// --digest-only); set GRIM_LIVE_BIN to an absolute path to pin a local build
// for debugging (e.g. ../grimoire/target/release/grim). No grim available →
// the whole suite self-skips. Network-touching checks stay gated behind
// GRIM_LIVE_NETWORK=1.
const GRIM = process.env['GRIM_LIVE_BIN'] ?? 'grim';
const VERSION_PROBE = spawnSync(GRIM, ['--version'], { timeout: 10000, encoding: 'utf8' });
const HAVE_GRIM = VERSION_PROBE.status === 0;
// `grim --version` prints e.g. "grim 0.11.0" — the semver is the last token.
const GRIM_VERSION = HAVE_GRIM
  ? (/(\d+\.\d+\.\d+)/.exec(VERSION_PROBE.stdout ?? '')?.[1] ?? null)
  : null;
const NETWORK = process.env['GRIM_LIVE_NETWORK'] === '1';
// CI sets this next to GRIM_LIVE_BIN: a grim it cannot run, or one too old for
// a check, fails the suite there instead of skipping it, so a broken build of
// the pinned grim cannot pass as green.
const REQUIRED = process.env['GRIM_LIVE_REQUIRED'] === '1';

/** Skips the running test or suite, or fails it when the live suite is required. */
function skipOrFail(ctx: Mocha.Context, why: string): never {
  if (REQUIRED) {
    throw new Error(`GRIM_LIVE_REQUIRED=1, but ${why}`);
  }
  ctx.skip();
}
// A reference resolvable by the grim under test, carrying grim's curated
// annotations — the grimoire manual rig's `support-desk` showcase. Unset (the
// default, and CI) skips the annotation gate; the rig is a local docker
// registry, not something a test may assume.
//   cd ../grimoire && test/manual/scripts/bootstrap.sh
//   GRIM_LIVE_ANNOTATED_REF=localhost:5050/grimoire/skills/support-desk npm test
const ANNOTATED_REF = process.env['GRIM_LIVE_ANNOTATED_REF'] ?? null;

suite('grim live (real binary)', function () {
  this.timeout(30000);

  suiteSetup(function () {
    // Skip when grim is absent OR below the declared floor: this suite certifies
    // the v2 surface (status --check, config registry fields, config set
    // --dry-run), and a below-floor binary would either "pass" against an older
    // interface or fail for the wrong reason. Only a grim at/above the floor can
    // legitimately certify the surface this branch targets.
    if (!HAVE_GRIM || GRIM_VERSION === null || grimTooOld(GRIM_VERSION)) {
      skipOrFail(this, `${GRIM} is missing or below the floor (${GRIM_VERSION ?? 'no version'})`);
    }
    // Names the binary under test in the log: a too-old grim skips silently.
    console.log(`grim live: ${GRIM} reports ${(VERSION_PROBE.stdout ?? '').trim()}`);
  });

  test('context --global parses into a clean ok result', async () => {
    const result = await runJson<ContextInfo>(GRIM, withGlobalFlag(contextArgs()), {
      timeoutMs: 15000,
    });
    // Never throws; a real grim yields a discriminated result. Global scope always
    // exists, so this is expected to be ok with a version string.
    assert.ok(result.ok, result.ok ? '' : `context not ok: ${JSON.stringify(result)}`);
    assert.strictEqual(typeof result.value.version, 'string');
  });

  test('fetch --digest-only is a supported flag (v2 surface), errors stay clean', async () => {
    // The bogus registry host fails fast (DNS), no real network needed. What
    // this pins: the v2 flag is KNOWN to the binary — a usage error (exit 64,
    // clap rejecting the flag) would mean the grim in use predates the
    // interface this extension targets (no compat shim by design).
    const result = await runJson<DigestResult>(
      GRIM,
      fetchArgs('does.not.exist/nope/nope', { digestOnly: true }),
      { timeoutMs: 15000 },
    );
    assert.ok(!result.ok, 'a bogus ref is not ok');
    if (result.kind === 'error') {
      assert.notStrictEqual(result.exitCode, 64, 'exit 64 = --digest-only unknown: grim too old');
      assert.ok(result.message.length > 0);
    } else {
      assert.strictEqual(result.kind, 'not-found');
    }
  });

  test('status --check is a supported flag (release gate), stays offline-clean', async () => {
    // THE release gate for this surface: a grim predating `status --check` would
    // reject the flag at clap-parse time (exit 64). `--offline` skips the actual
    // network re-check (grim degrades with a stderr warning, `checked: false`) so
    // this pins "the flag is known" fast and without a real registry round-trip.
    const result = await runJson<ItemsEnvelope<StatusItem>>(
      GRIM,
      [...withGlobalFlag(statusArgs({ check: true })), '--offline'],
      { timeoutMs: 20000 },
    );
    assert.ok(result.ok, result.ok ? '' : `status --check not ok: ${JSON.stringify(result)}`);
    assert.ok(Array.isArray(result.value.items), 'status report carries an items array');
  });

  test('config registry fields is a supported subcommand (release gate), returns oci/index/default rows', async () => {
    // THE release gate for this surface: a grim predating `config registry
    // fields` would reject it at clap-parse time (exit 64) — same signal as
    // the status --check gate above. Context-free (no --offline needed): it
    // never touches the network.
    const result = await runJson<ItemsEnvelope<RegistryFieldEntry>>(
      GRIM,
      withGlobalFlag(registryFieldsArgs()),
      { timeoutMs: 15000 },
    );
    assert.ok(
      result.ok,
      result.ok ? '' : `config registry fields not ok: ${JSON.stringify(result)}`,
    );
    if (result.ok) {
      // A SUBSET, deliberately: grim's interface is additive, and a newer grim
      // already describes more fields here (include/exclude, the browse
      // filters). The gate is "the subcommand exists and describes the fields
      // the settings view edits" — an extra field is not a regression.
      const keys = result.value.items.map((f) => f.key).sort();
      for (const key of ['default', 'index', 'oci']) {
        assert.ok(keys.includes(key), `registry field '${key}' missing — got ${keys.join(', ')}`);
      }
      for (const field of result.value.items) {
        assert.strictEqual(typeof field.title, 'string');
        assert.ok(field.title.length > 0);
      }
    }
  });

  test('config set --dry-run is a supported flag (release gate), validates without writing', async () => {
    // THE release gate for this surface: a grim predating `--dry-run` on
    // `config set` would reject it at clap-parse time (exit 64) — same
    // signal as the status --check and registry fields gates above.
    // `--config` (like `--global`) is a top-level scope flag, so it goes
    // BEFORE the subcommand tree, never after configSetArgs's trailing `--`
    // (see withGlobalFlag). A real key against a scratch config file proves
    // the stronger claim than "not exit 64": grim validates and reports
    // `dry_run: true` while leaving the file exactly as it started.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grim-live-dry-run-'));
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(configPath, '');
    try {
      const result = await runJson<ConfigWriteResult>(
        GRIM,
        [
          '--config',
          configPath,
          ...configSetArgs('options.tui.default_view', 'tree', { dryRun: true }),
        ],
        { timeoutMs: 15000 },
      );
      assert.ok(
        result.ok,
        result.ok ? '' : `config set --dry-run not ok: ${JSON.stringify(result)}`,
      );
      if (result.ok) {
        assert.strictEqual(result.value.dry_run, true);
      }
      assert.strictEqual(
        fs.readFileSync(configPath, 'utf8'),
        '',
        'dry-run must not write the config file',
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // THE contract gate for grimoire#106's read side: the curated annotation keys
  // and the `support` object are what the details rail now renders, and this is
  // the only check that reads them off a REAL binary rather than a fixture.
  // Deliberately NOT a version gate — every field is additive and nullable, so
  // an older grim omitting them is correct behaviour, not a failure. What this
  // pins is that a grim which HAS them answers in the shape grim.ts declares.
  (ANNOTATED_REF ? test : test.skip)(
    'describe carries the curated annotations and the support object',
    async () => {
      const result = await runJson<DescribeResult>(GRIM, describeArgs(ANNOTATED_REF ?? ''), {
        timeoutMs: 20000,
      });
      assert.ok(result.ok, result.ok ? '' : `describe not ok: ${JSON.stringify(result)}`);
      if (!result.ok) {
        return;
      }
      const d = result.value;
      for (const field of ['authors', 'vendor', 'url', 'documentation'] as const) {
        assert.strictEqual(typeof d[field], 'string', `${field} is a populated string`);
      }
      // Provenance is derived by default now — no --git needed at publish time.
      assert.strictEqual(typeof d.created, 'string', 'created is derived by default');
      assert.strictEqual(typeof d.revision, 'string', 'revision is derived by default');
      // Skills-only, and the showcase is a skill.
      assert.strictEqual(typeof d.compatibility, 'string');
      const support = d.support;
      assert.ok(support, 'support object present');
      // grim serializes all four keys, null for a channel the publisher left
      // unset — so the shape is fixed even where the values are not.
      for (const channel of ['issues', 'chat', 'contact', 'security'] as const) {
        const value = support?.[channel];
        assert.ok(
          value === null || typeof value === 'string',
          `support.${channel} is a string or null, got ${typeof value}`,
        );
      }
    },
  );

  // describe resolves through the registry, so it can touch the network — gated.
  // Asserts the envelope parser yields a clean discriminated result whether grim
  // answers with a JSON envelope or plain text.
  (NETWORK ? test : test.skip)(
    'describe on a bogus ref yields a clean discriminated result',
    async () => {
      const result = await runJson(GRIM, describeArgs('does.not.exist/nope/nope'), {
        timeoutMs: 20000,
      });
      assert.ok(!result.ok, 'a bogus ref is not ok');
      assert.ok(result.kind === 'error' || result.kind === 'not-found');
      if (result.kind === 'error') {
        assert.ok(result.message.length > 0);
      }
    },
  );
});

// grimoire-rs/grimoire#269: `grim update -- <name>` works on the named closure
// and nothing else. These drive the extension's own per-artifact Update action
// (the sidebar `update` message) against the real grim, in a sandboxed global
// scope: a private HOME and GRIM_HOME handed to grim through
// `grimoire.extraEnv`, Claude as the only client, offline, and two skills from
// local path sources, so no registry is involved. `alpha` is the one updated;
// `beta` is the one the run must leave alone.
suite('grim live: Update on a named artifact (grimoire#269)', function () {
  this.timeout(60000);

  interface Sandbox {
    root: string;
    env: Record<string, string>;
    /** Where Claude's copies of the skills land. */
    skills: string;
    config: string;
    /** The executable the extension is pointed at: grim behind a logging shim. */
    shim: string;
    /** The shim's log, read through {@link calls}. */
    calls: string;
  }

  const window = vscode.window as unknown as Record<string, unknown>;
  const DIALOGS = ['showWarningMessage', 'showErrorMessage', 'showInformationMessage'] as const;
  /** Every sandbox root this suite made, removed in suiteTeardown. */
  const sandboxes: string[] = [];

  const skillBody = (name: string, body: string): string =>
    `---\nname: ${name}\ndescription: live test skill\n---\n# ${name} ${body}\n`;

  function writeSource(box: Sandbox, name: string, body: string): void {
    const dir = path.join(box.root, 'src', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), skillBody(name, body));
  }

  function declare(box: Sandbox, names: string[]): void {
    // A TOML basic string takes JSON's escapes.
    const lines = names.map((n) => `${n} = ${JSON.stringify(path.join(box.root, 'src', n))}`);
    fs.writeFileSync(
      box.config,
      `[options]\nclients = ["claude"]\n\n[skills]\n${lines.join('\n')}\n`,
    );
  }

  async function grim<T>(box: Sandbox, args: string[]): Promise<T> {
    const result = await runJson<T>(GRIM, withGlobalFlag(args), { env: box.env, timeoutMs: 30000 });
    assert.ok(result.ok, `grim ${args.join(' ')}: ${JSON.stringify(result)}`);
    return result.value;
  }

  const installed = (box: Sandbox, name: string): string | null => {
    const file = path.join(box.skills, name, 'SKILL.md');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  };

  const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

  /** What the extension asked grim, in order: exit code, argv and the parsed
   *  report of every call the sandbox's shim logged. */
  function calls(box: Sandbox): { code: number; argv: string; report: unknown }[] {
    if (!fs.existsSync(box.calls)) {
      return [];
    }
    return fs
      .readFileSync(box.calls, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const [code = '', argv = '', report = ''] = line.split('\t');
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(report);
        } catch {
          // A call that printed no JSON keeps a null report.
        }
        return { code: Number(code), argv, report: parsed };
      });
  }

  /** The names an `items` report lists, in order. */
  const rowNames = (report: unknown): unknown[] => {
    const items = (report as { items?: unknown } | null)?.items;
    return Array.isArray(items) ? items.map((row) => (row as { name?: unknown }).name) : [];
  };

  /** The extension's update and lock calls, as `<exit> <argv>`. */
  const mutations = (box: Sandbox): string[] =>
    calls(box)
      .filter((c) => / (update|lock)\b/.test(` ${c.argv}`))
      .map((c) => `${c.code} ${c.argv}`);

  /** `alpha` and `beta` locked and installed at v1. */
  async function sandbox(ctx: Mocha.Context): Promise<Sandbox> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grim-live-269-'));
    const home = path.join(root, 'home');
    const claude = path.join(home, '.claude');
    const grimHome = path.join(root, 'grim-home');
    fs.mkdirSync(claude, { recursive: true });
    fs.mkdirSync(grimHome, { recursive: true });
    const box: Sandbox = {
      root,
      // CLAUDE_CONFIG_DIR is set, not inherited: one exported by the shell that
      // runs the tests would otherwise send these installs into a real config.
      env: { HOME: home, GRIM_HOME: grimHome, CLAUDE_CONFIG_DIR: claude, GRIM_OFFLINE: '1' },
      skills: path.join(claude, 'skills'),
      config: path.join(grimHome, 'grimoire.toml'),
      shim: path.join(root, 'grim'),
      calls: path.join(root, 'calls.log'),
    };
    sandboxes.push(root);
    // The extension runs grim through this shim, which logs each call's exit
    // code, argv and one-line report, so a test reads what an Update click
    // asked for and what grim answered.
    fs.writeFileSync(
      box.shim,
      [
        '#!/bin/sh',
        `out=$(${shQuote(GRIM)} "$@")`,
        'code=$?',
        `printf '%s\\n' "$out"`,
        `printf '%s\\t%s\\t%s\\n' "$code" "$*" "$(printf '%s' "$out" | tr -d '\\n')" >> ${shQuote(box.calls)}`,
        'exit "$code"',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    writeSource(box, 'alpha', 'v1');
    writeSource(box, 'beta', 'v1');
    declare(box, ['alpha', 'beta']);
    const lock = await grim<ItemsEnvelope<Record<string, unknown>>>(box, lockArgs());
    // `disposition` came with the same grim change as the scoped update, so a
    // grim without it would fail these cases for a fix it does not have.
    if (!lock.items.some((row) => 'disposition' in row)) {
      skipOrFail(ctx, `${GRIM} predates the scoped named update (no lock disposition)`);
    }
    await grim(box, installArgs());
    assert.strictEqual(installed(box, 'beta'), skillBody('beta', 'v1'), 'beta starts installed');
    return box;
  }

  /** Clicks Update on `name` in the sidebar with grim pointed at the sandbox.
   *  Every dialog is recorded and answered with `answer` when it offers it. */
  async function clickUpdate(box: Sandbox, name: string, answer?: string): Promise<string[]> {
    const extension = vscode.extensions.getExtension<GrimoireApi>('grimoire-rs.grimoire-vscode');
    assert.ok(extension, 'extension not found');
    const api = await extension.activate();
    const cfg = vscode.workspace.getConfiguration('grimoire');
    const originals = DIALOGS.map((key) => window[key]);
    const shown: string[] = [];
    for (const key of DIALOGS) {
      window[key] = async (message: string, ...rest: unknown[]) => {
        const items = rest.filter((item): item is string => typeof item === 'string');
        shown.push(`${key}: ${message} [${items.join(', ')}]`);
        return answer !== undefined && items.includes(answer) ? answer : undefined;
      };
    }
    const previous = {
      executable: cfg.inspect<string>('path.executable')?.globalValue,
      extraEnv: cfg.inspect<Record<string, string>>('extraEnv')?.globalValue,
    };
    // The environment first: a refresh the executable change starts must
    // already see the sandbox, never the real HOME. Undone in reverse order,
    // so the grim under test never runs without it.
    await cfg.update('extraEnv', box.env, vscode.ConfigurationTarget.Global);
    await cfg.update('path.executable', box.shim, vscode.ConfigurationTarget.Global);
    try {
      await api.providers.sidebar.handleMessage({
        type: 'update',
        kind: 'skill',
        name,
        scope: 'global',
      });
    } finally {
      DIALOGS.forEach((key, i) => {
        window[key] = originals[i];
      });
      await cfg.update('path.executable', previous.executable, vscode.ConfigurationTarget.Global);
      await cfg.update('extraEnv', previous.extraEnv, vscode.ConfigurationTarget.Global);
    }
    return shown;
  }

  /** The click issued exactly one `grim update -- alpha`, which exited 0 and
   *  reported alpha alone: #269's contract for the unnamed beta. */
  function assertNamedUpdate(box: Sandbox): void {
    assert.deepStrictEqual(mutations(box), ['0 --global update --format json -- alpha']);
    const [update] = calls(box).filter((c) => c.argv.includes(' update '));
    assert.deepStrictEqual(rowNames(update?.report), ['alpha']);
  }

  const stateOf = async (box: Sandbox): Promise<Record<string, string>> => {
    const status = await grim<ItemsEnvelope<StatusItem>>(box, statusArgs());
    return Object.fromEntries(status.items.map((row) => [row.name, row.state]));
  };

  suiteSetup(function () {
    if (process.platform === 'win32') {
      this.skip();
    }
    if (!HAVE_GRIM || GRIM_VERSION === null || grimTooOld(GRIM_VERSION)) {
      skipOrFail(this, `${GRIM} is missing or below the floor (${GRIM_VERSION ?? 'no version'})`);
    }
  });

  suiteTeardown(() => {
    for (const root of sandboxes) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('case A: an unnamed output the user deleted stays deleted, and nothing asks', async function () {
    const box = await sandbox(this);
    fs.rmSync(path.join(box.skills, 'beta'), { recursive: true, force: true });
    writeSource(box, 'alpha', 'v2');

    const shown = await clickUpdate(box, 'alpha');

    assert.deepStrictEqual(shown, [], 'the Update click raised no dialog');
    assertNamedUpdate(box);
    assert.strictEqual(installed(box, 'alpha'), skillBody('alpha', 'v2'), 'alpha moved');
    assert.strictEqual(installed(box, 'beta'), null, 'beta stayed deleted');
    assert.deepStrictEqual(await stateOf(box), { alpha: 'installed', beta: 'missing' });

    // Update All then restores beta at the pin it kept, and says so.
    const all = await grim<ItemsEnvelope<UpdateEntry>>(box, updateArgs());
    const actions = Object.fromEntries(all.items.map((row) => [row.name, row.action]));
    assert.deepStrictEqual(actions, { alpha: 'unchanged', beta: 'restored' });
    assert.strictEqual(
      updateSummary(all.items),
      '0 updated, 1 unchanged, 0 removed, 0 kept-modified, 1 restored',
    );
    assert.strictEqual(installed(box, 'beta'), skillBody('beta', 'v1'), 'beta is back');
  });

  test('case B: an unnamed local edit neither blocks the update nor is overwritten', async function () {
    const box = await sandbox(this);
    const edited = 'locally edited\n';
    fs.writeFileSync(path.join(box.skills, 'beta', 'SKILL.md'), edited);
    writeSource(box, 'alpha', 'v2');

    // Answering Overwrite, were it offered, would also show up as a lost edit.
    const shown = await clickUpdate(box, 'alpha', 'Overwrite');

    assert.deepStrictEqual(shown, [], 'no Overwrite offer for an artifact the click did not name');
    assertNamedUpdate(box);
    assert.strictEqual(installed(box, 'alpha'), skillBody('alpha', 'v2'), 'alpha moved');
    assert.strictEqual(installed(box, 'beta'), edited, 'the edit to beta survived');
    assert.deepStrictEqual(await stateOf(box), { alpha: 'installed', beta: 'modified' });
  });

  test('a stale lock offers Lock and Update, which locks and retries only the named one', async function () {
    const box = await sandbox(this);
    // A new declaration makes the lock stale, so the named update refuses.
    writeSource(box, 'gamma', 'v1');
    declare(box, ['alpha', 'beta', 'gamma']);
    writeSource(box, 'alpha', 'v2');

    const shown = await clickUpdate(box, 'alpha', 'Lock and Update');

    assert.strictEqual(shown.length, 1, `one dialog: ${shown.join(' | ')}`);
    assert.ok(shown[0]?.includes('[Lock and Update, Run Full Update]'), shown[0]);
    assert.deepStrictEqual(mutations(box), [
      '65 --global update --format json -- alpha',
      '0 --global lock --format json',
      '0 --global update --format json -- alpha',
    ]);
    const [refusal] = calls(box).filter((c) => c.code === 65);
    assert.strictEqual(
      (refusal?.report as { error?: { reason?: unknown } } | null)?.error?.reason,
      'stale-lock',
    );
    // Status reports no pin for a path source, so ask the lock: it already
    // holds all three, and locking again carries every pin.
    const relock = await grim<ItemsEnvelope<Record<string, unknown>>>(box, lockArgs());
    assert.deepStrictEqual(
      Object.fromEntries(relock.items.map((row) => [row['name'], row['disposition']])),
      { alpha: 'carried', beta: 'carried', gamma: 'carried' },
    );
    assert.strictEqual(installed(box, 'alpha'), skillBody('alpha', 'v2'), 'alpha moved');
    assert.strictEqual(installed(box, 'beta'), skillBody('beta', 'v1'), 'beta untouched');
    // Only the named closure installs; `grim install` is what writes gamma.
    assert.strictEqual(installed(box, 'gamma'), null);
  });
});
