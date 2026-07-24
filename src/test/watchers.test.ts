import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Watchers } from '../watchers';

function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (check()) {
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        reject(new Error('timeout waiting for watcher event'));
      } else {
        setTimeout(tick, 100);
      }
    };
    tick();
  });
}

// Windows never delivers two kinds of out-of-workspace watcher event on the CI
// runner: a write under $GRIM_HOME/state/ (12s of writes at 300ms intervals,
// zero events) and a grim-home write after a rebuild(undefined) → rebuild(home)
// re-arm — while a single-rebuild grim-home watch fires there in ~200ms. Those
// three assertions have never passed on Windows; the teardown rm below threw
// first and masked the timeout. Whether the global state watcher works on a
// real Windows install is unverified — it needs a Windows machine to answer.
const isWindows = process.platform === 'win32';

// Disposing a FileSystemWatcher only asks the (out-of-process) watcher service
// to stop; on Windows it still holds a handle on the watched directory long
// after dispose() returns, so removing a grim home fails with ENOTEMPTY/EPERM
// no matter how long we retry — verified in CI at 10 retries. The directory is
// a mkdtemp under the OS temp dir and the assertions have already run by then,
// so a failed cleanup must not fail the test.
function rmGrimHome(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
  } catch (e) {
    console.warn(`watchers test: leaving ${dir} for the OS to reclaim (${e})`);
  }
}

suite('watchers', () => {
  test('fires (debounced) on grimoire.toml change in the workspace', async () => {
    let fired = 0;
    const watchers = new Watchers(() => {
      fired += 1;
    }, 40);
    try {
      watchers.rebuild(undefined);
      const folder = vscode.workspace.workspaceFolders?.[0];
      assert.ok(folder);
      const file = path.join(folder.uri.fsPath, 'grimoire.toml');
      const original = fs.readFileSync(file, 'utf8');
      try {
        fs.writeFileSync(file, original + `\n# touched ${Date.now()}\n`);
        await waitFor(() => fired > 0);
        assert.strictEqual(fired, 1, 'debounce collapses bursts to one event');
      } finally {
        fs.writeFileSync(file, original);
      }
    } finally {
      watchers.dispose();
    }
  });

  test('fires on grim-home lock changes outside the workspace', async () => {
    const grimHome = fs.mkdtempSync(path.join(os.tmpdir(), 'grim-home-'));
    let fired = 0;
    const watchers = new Watchers(() => {
      fired += 1;
    }, 40);
    try {
      watchers.rebuild(grimHome);
      fs.writeFileSync(path.join(grimHome, 'grimoire.lock'), 'lock_version = 2\n');
      await waitFor(() => fired > 0);
      assert.ok(fired >= 1);
    } finally {
      watchers.dispose();
      rmGrimHome(grimHome);
    }
  });

  test('fires on global install-state changes under $GRIM_HOME/state/global.json', async function () {
    if (isWindows) {
      this.skip();
    }
    this.timeout(15000);
    const grimHome = fs.mkdtempSync(path.join(os.tmpdir(), 'grim-home-'));
    fs.mkdirSync(path.join(grimHome, 'state'), { recursive: true });
    const stateFile = path.join(grimHome, 'state', 'global.json');
    let fired = 0;
    const watchers = new Watchers(() => {
      fired += 1;
    }, 40);
    // An out-of-workspace watcher arms asynchronously; in production it lives
    // long before any install writes state, so re-write until it catches one
    // rather than racing a single write against the arming latency.
    const writer = setInterval(() => fs.writeFileSync(stateFile, `{"ts":${Date.now()}}\n`), 300);
    try {
      watchers.rebuild(grimHome);
      await waitFor(() => fired > 0, 12000);
      assert.ok(fired >= 1);
    } finally {
      clearInterval(writer);
      watchers.dispose();
      rmGrimHome(grimHome);
    }
  });

  test('fires on global install-state changes when state/ does not exist yet (fresh grim home)', async function () {
    if (isWindows) {
      this.skip();
    }
    this.timeout(15000);
    const grimHome = fs.mkdtempSync(path.join(os.tmpdir(), 'grim-home-'));
    // No pre-created state/ dir here (unlike the test above) — rebuild() must
    // create it itself so the watcher can arm against it.
    const stateFile = path.join(grimHome, 'state', 'global.json');
    let fired = 0;
    const watchers = new Watchers(() => {
      fired += 1;
    }, 40);
    const writer = setInterval(() => fs.writeFileSync(stateFile, `{"ts":${Date.now()}}\n`), 300);
    try {
      watchers.rebuild(grimHome);
      await waitFor(() => fired > 0, 12000);
      assert.ok(fired >= 1);
    } finally {
      clearInterval(writer);
      watchers.dispose();
      rmGrimHome(grimHome);
    }
  });

  test('suspendWhile drops watcher events fired during the action (no redundant refresh)', async () => {
    let fired = 0;
    const watchers = new Watchers(() => {
      fired += 1;
    }, 40);
    try {
      watchers.rebuild(undefined);
      const folder = vscode.workspace.workspaceFolders?.[0];
      assert.ok(folder);
      const file = path.join(folder.uri.fsPath, 'grimoire.toml');
      const original = fs.readFileSync(file, 'utf8');
      try {
        // Simulate a mutating action that writes the watched file while suspended.
        await watchers.suspendWhile(async () => {
          fs.writeFileSync(file, original + `\n# during action ${Date.now()}\n`);
          // Long enough for the fs event to be delivered (and dropped) while suspended.
          await new Promise((r) => setTimeout(r, 500));
        });
        await new Promise((r) => setTimeout(r, 150)); // and no refresh after resume either
        assert.strictEqual(fired, 0, "the action's own write triggered no watcher refresh");
      } finally {
        fs.writeFileSync(file, original);
      }
    } finally {
      watchers.dispose();
    }
  });

  test('an external touch (no action in flight) refreshes exactly once after the quiet period', async () => {
    let fired = 0;
    const watchers = new Watchers(() => {
      fired += 1;
    }, 40);
    try {
      watchers.rebuild(undefined);
      const folder = vscode.workspace.workspaceFolders?.[0];
      assert.ok(folder);
      const file = path.join(folder.uri.fsPath, 'grimoire.toml');
      const original = fs.readFileSync(file, 'utf8');
      try {
        fs.writeFileSync(file, original + `\n# external ${Date.now()}\n`);
        await waitFor(() => fired > 0);
        await new Promise((r) => setTimeout(r, 150)); // settle past the debounce
        assert.strictEqual(fired, 1, 'a single external edit debounces to one refresh');
      } finally {
        fs.writeFileSync(file, original);
      }
    } finally {
      watchers.dispose();
    }
  });

  test('suspendWhile is re-entrant and finally-safe (depth restored after a throw)', async () => {
    const watchers = new Watchers(() => {}, 40);
    const value = await watchers.suspendWhile(async () => watchers.suspendWhile(async () => 42));
    assert.strictEqual(value, 42, 'nested suspension returns the inner value');
    await assert.rejects(
      watchers.suspendWhile(async () => {
        throw new Error('boom');
      }),
    );
    watchers.dispose();
    // A throw must restore the depth to 0, so events fire again afterwards.
    let fired = 0;
    const w2 = new Watchers(() => {
      fired += 1;
    }, 40);
    try {
      w2.rebuild(undefined);
      await w2.suspendWhile(async () => {
        throw new Error('x');
      }).catch(() => {});
      const folder = vscode.workspace.workspaceFolders?.[0];
      assert.ok(folder);
      const file = path.join(folder.uri.fsPath, 'grimoire.toml');
      const original = fs.readFileSync(file, 'utf8');
      try {
        fs.writeFileSync(file, original + `\n# after throw ${Date.now()}\n`);
        await waitFor(() => fired > 0);
      } finally {
        fs.writeFileSync(file, original);
      }
    } finally {
      w2.dispose();
    }
  });

  // rebuildWatchers arms once at activation off a single `grim context
  // --global` probe. That probe failing left the global watchers unarmed for
  // the whole session, so refreshAll now re-arms from the snapshot it already
  // has — which only works if a later rebuild can still arm what an earlier
  // rebuild(undefined) skipped.
  test('a later rebuild arms the global watchers a failed probe skipped', async function () {
    if (isWindows) {
      this.skip();
    }
    this.timeout(15000);
    const grimHome = fs.mkdtempSync(path.join(os.tmpdir(), 'grim-home-heal-'));
    fs.mkdirSync(path.join(grimHome, 'state'), { recursive: true });
    let fired = 0;
    const watchers = new Watchers(() => {
      fired += 1;
    }, 40);
    try {
      watchers.rebuild(undefined); // the probe failed: no grim home to watch
      watchers.rebuild(grimHome); // a later refresh knows the home
      // The memo must not mistake this for a no-op: an undefined home and a
      // real one are different arming states, and only the second watches the
      // grim home at all.
      await new Promise((resolve) => setTimeout(resolve, 500));
      fired = 0;
      fs.writeFileSync(path.join(grimHome, 'grimoire.lock'), 'lock_version = 3\n');
      await waitFor(() => fired > 0);
    } finally {
      watchers.dispose();
      rmGrimHome(grimHome);
    }
  });

  // refreshAll re-arms on every refresh now; a rebuild that tore down and
  // recreated its watchers each time would drop events landing in the gap.
  // rebuild() always disposes before it arms, so "created no new watcher" IS
  // "tore none down" — counting creations pins the memo without racing the
  // arming latency. (The earlier version only touched the file after all six
  // rebuilds, so it passed even with the memo deleted.)
  test('re-arming with unchanged inputs reuses the live watchers instead of recreating them', async function () {
    this.timeout(15000);
    const created: vscode.FileSystemWatcher[] = [];
    const workspace = vscode.workspace as unknown as {
      createFileSystemWatcher: typeof vscode.workspace.createFileSystemWatcher;
    };
    const createWatcher = workspace.createFileSystemWatcher;
    workspace.createFileSystemWatcher = ((...args: Parameters<typeof createWatcher>) => {
      const watcher = createWatcher(...args);
      created.push(watcher);
      return watcher;
    }) as typeof createWatcher;
    let fired = 0;
    const watchers = new Watchers(() => {
      fired += 1;
    }, 40);
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder);
    const file = path.join(folder.uri.fsPath, 'grimoire.toml');
    const original = fs.readFileSync(file, 'utf8');
    try {
      watchers.rebuild(undefined);
      const armed = [...created];
      assert.ok(armed.length > 0, 'the first rebuild armed the workspace watchers');
      for (let i = 0; i < 5; i++) {
        watchers.rebuild(undefined);
      }
      assert.deepStrictEqual(
        created,
        armed,
        `re-arming with unchanged inputs created ${created.length - armed.length} extra watcher(s)`,
      );
      // ...and the set it kept is the one still delivering events.
      fired = 0;
      fs.writeFileSync(file, original + `\n# touched ${Date.now()}\n`);
      await waitFor(() => fired > 0);
    } finally {
      workspace.createFileSystemWatcher = createWatcher;
      fs.writeFileSync(file, original);
      watchers.dispose();
    }
  });

  // rev-quality#4: a throw mid-arm (e.g. createFileSystemWatcher failing) must
  // leave the memo EMPTY, not stuck on the previous key. Otherwise the live set
  // is a half-dead partial while armedKey still names the old key, and re-arming
  // that key short-circuits — leaving its home unwatched for the session.
  // disposeWatchers() clears the memo; rebuild() only re-sets it after a full arm.
  test('a throw mid-arm clears the memo so re-arming the previously-armed key still re-arms', () => {
    const created: vscode.FileSystemWatcher[] = [];
    const workspace = vscode.workspace as unknown as {
      createFileSystemWatcher: typeof vscode.workspace.createFileSystemWatcher;
    };
    const createWatcher = workspace.createFileSystemWatcher;
    let calls = 0;
    let armThrows = false;
    workspace.createFileSystemWatcher = ((...args: Parameters<typeof createWatcher>) => {
      calls += 1;
      if (armThrows && calls === 2) {
        throw new Error('createFileSystemWatcher blew up mid-arm');
      }
      const watcher = createWatcher(...args);
      created.push(watcher);
      return watcher;
    }) as typeof createWatcher;
    const homeA = fs.mkdtempSync(path.join(os.tmpdir(), 'grim-home-A-'));
    const homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'grim-home-B-'));
    fs.mkdirSync(path.join(homeA, 'state'), { recursive: true });
    fs.mkdirSync(path.join(homeB, 'state'), { recursive: true });
    const watchers = new Watchers(() => {}, 40);
    try {
      watchers.rebuild(homeA); // clean arm: the memo now holds homeA's key
      // A DIFFERENT key whose 2nd watcher throws mid-arm — the set is left partial.
      armThrows = true;
      calls = 0;
      assert.throws(() => watchers.rebuild(homeB), /blew up mid-arm/);
      const afterThrow = created.length;
      // Re-arming homeA — the key a stale memo would still claim as current — must
      // actually recreate its watchers rather than short-circuit on the memo.
      armThrows = false;
      watchers.rebuild(homeA);
      assert.ok(
        created.length > afterThrow,
        `re-arming the previously-armed key after a mid-arm throw must recreate watchers (was ${afterThrow}, now ${created.length})`,
      );
    } finally {
      workspace.createFileSystemWatcher = createWatcher;
      watchers.dispose();
      rmGrimHome(homeA);
      rmGrimHome(homeB);
    }
  });

  test('dispose stops events', async () => {
    let fired = 0;
    const watchers = new Watchers(() => {
      fired += 1;
    }, 40);
    watchers.rebuild(undefined);
    watchers.dispose();
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder);
    const file = path.join(folder.uri.fsPath, 'grimoire.toml');
    const original = fs.readFileSync(file, 'utf8');
    try {
      fs.writeFileSync(file, original + '\n# after dispose\n');
      await new Promise((resolve) => setTimeout(resolve, 800));
      assert.strictEqual(fired, 0);
    } finally {
      fs.writeFileSync(file, original);
    }
  });
});
