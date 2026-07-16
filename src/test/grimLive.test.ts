import * as assert from 'assert';
import { spawnSync } from 'child_process';
import {
  contextArgs,
  describeArgs,
  fetchArgs,
  runJson,
  type ContextInfo,
  type DigestResult,
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
