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
  type DescribeResult,
  type RegistryFieldEntry,
  type StatusItem,
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
