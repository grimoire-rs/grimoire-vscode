// Regression coverage for: changing grimoire.path.executable (or extraEnv)
// must take effect on the next refresh/action, without a window reload.
// (Windows cannot execFile shell scripts — skipped there, like extension.test.ts.)
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { GrimoireApi } from '../extension';
import { MINIMUM_GRIM_VERSION } from '../installer';

const isWindows = process.platform === 'win32';

function contextStub(dir: string, argvLog?: string): string {
  const executable = path.join(dir, 'grim');
  const log = argvLog ? `echo "$@" >> "${argvLog}"\n` : '';
  const doc = {
    version: MINIMUM_GRIM_VERSION,
    scope: 'global',
    workspace: null,
    config_path: '/nonexistent/grimoire.toml',
    config_exists: false,
    lock_path: '/nonexistent/grimoire.lock',
    lock_exists: false,
    grim_home: dir,
    offline: false,
    clients: [],
    registries: [],
    default_registry: null,
  };
  fs.writeFileSync(executable, `#!/bin/sh\n${log}echo '${JSON.stringify(doc)}'\n`, { mode: 0o755 });
  return executable;
}

// Manifest-level guard, deliberately outside the stub-driven suite below (it
// needs no shell stub, so it runs on Windows too). A machine/machine-overridable
// scope makes VS Code drop the key from the LOCAL user settings of any remote
// (WSL/SSH/container) window: LOCAL_MACHINE_SCOPES is
// [APPLICATION, WINDOW, RESOURCE, LANGUAGE_OVERRIDABLE] — no MACHINE_OVERRIDABLE
// — so the value never reaches the remote extension host and the setting reads
// as unset. Worse, it LOOKS like it works after a window reload: local settings
// are parsed before the extension registers its configuration schema, so the
// then-unknown key has no scope and survives that one parse. Untrusted-workspace
// protection comes from `capabilities.untrustedWorkspaces.restrictedConfigurations`,
// not from the scope, so dropping it costs nothing.
suite('config manifest', () => {
  test('path.executable and extraEnv are not machine-scoped (remote windows drop those)', () => {
    const extension = vscode.extensions.getExtension('grimoire-rs.grimoire-vscode');
    assert.ok(extension);
    const properties = extension.packageJSON.contributes.configuration.properties as Record<
      string,
      { scope?: string }
    >;
    for (const key of ['grimoire.path.executable', 'grimoire.extraEnv']) {
      const scope = properties[key]?.scope ?? 'window';
      assert.ok(
        !scope.startsWith('machine'),
        `${key} must not be machine-scoped (is "${scope}") — remote windows ignore it in user settings`,
      );
    }
  });
});

suite('config reload: grimoire.path.executable', () => {
  let dir: string;

  suiteSetup(function () {
    if (isWindows) {
      this.skip();
    }
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grim-config-reload-'));
  });

  suiteTeardown(async () => {
    if (isWindows) {
      return;
    }
    await vscode.workspace
      .getConfiguration('grimoire')
      .update('path.executable', undefined, vscode.ConfigurationTarget.Global);
  });

  test('ScopeService.snapshot() reflects a config change immediately, without reactivating', async function () {
    this.timeout(20000);
    const extension = vscode.extensions.getExtension<GrimoireApi>('grimoire-rs.grimoire-vscode');
    assert.ok(extension);
    const api = await extension.activate();
    const cfg = vscode.workspace.getConfiguration('grimoire');

    await cfg.update(
      'path.executable',
      path.join(dir, 'does-not-exist'),
      vscode.ConfigurationTarget.Global,
    );
    const before = await api.scopes.snapshot();
    assert.strictEqual(before.grimMissing, true, 'expected grimMissing with a bogus path');

    const executable = contextStub(dir);
    await cfg.update('path.executable', executable, vscode.ConfigurationTarget.Global);
    const after = await api.scopes.snapshot();
    assert.strictEqual(
      after.grimMissing,
      false,
      'expected grim to be found after the path is fixed',
    );
  });

  test('changing the setting alone (no manual refresh call) makes the extension re-invoke grim', async function () {
    this.timeout(20000);
    const extension = vscode.extensions.getExtension<GrimoireApi>('grimoire-rs.grimoire-vscode');
    assert.ok(extension);
    await extension.activate();
    const cfg = vscode.workspace.getConfiguration('grimoire');

    const argvLog = path.join(dir, 'argv2.log');
    fs.rmSync(argvLog, { force: true });
    const executable = contextStub(dir, argvLog);

    // Start pointed at a bogus path so any subsequent stub invocation proves
    // the onDidChangeConfiguration listener picked up the new value on its own.
    await cfg.update(
      'path.executable',
      path.join(dir, 'still-missing'),
      vscode.ConfigurationTarget.Global,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));

    await cfg.update('path.executable', executable, vscode.ConfigurationTarget.Global);

    const start = Date.now();
    while (!fs.existsSync(argvLog) && Date.now() - start < 8000) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(
      fs.existsSync(argvLog),
      'onDidChangeConfiguration should have triggered a refresh that invokes the new grim executable',
    );
  });
});
