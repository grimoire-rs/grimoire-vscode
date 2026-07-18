import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  configSetArgs,
  contextArgs,
  describeArgs,
  fetchArgs,
  registryFieldsArgs,
  runJson,
  statusArgs,
  type ConfigWriteResult,
  type ContextInfo,
  type DigestResult,
  type ItemsEnvelope,
  type RegistryFieldEntry,
  type StatusItem,
} from '../grim';
import { withGlobalFlag } from '../scopes';

// Live contract tests against a real grim. Defaults to `grim` on PATH (the
// released CLI ships the full v2 surface: describe, fetch --description,
// --digest-only); set GRIM_LIVE_BIN to an absolute path to pin a local build
// for debugging (e.g. ../grimoire/target/release/grim). No grim available →
// the whole suite self-skips. Network-touching checks stay gated behind
// GRIM_LIVE_NETWORK=1.
const GRIM = process.env['GRIM_LIVE_BIN'] ?? 'grim';
const HAVE_GRIM = spawnSync(GRIM, ['--version'], { timeout: 10000 }).status === 0;
const NETWORK = process.env['GRIM_LIVE_NETWORK'] === '1';

suite('grim live (real binary)', function () {
  this.timeout(30000);

  suiteSetup(function () {
    if (!HAVE_GRIM) {
      this.skip();
    }
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
      const keys = result.value.items.map((f) => f.key).sort();
      assert.deepStrictEqual(keys, ['default', 'index', 'oci']);
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
        ['--config', configPath, ...configSetArgs('options.tui.default_view', 'tree', { dryRun: true })],
        { timeoutMs: 15000 },
      );
      assert.ok(result.ok, result.ok ? '' : `config set --dry-run not ok: ${JSON.stringify(result)}`);
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
