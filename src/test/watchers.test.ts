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
      fs.rmSync(grimHome, { recursive: true, force: true });
    }
  });

  test('fires on global install-state changes under $GRIM_HOME/state/global.json', async function () {
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
      fs.rmSync(grimHome, { recursive: true, force: true });
    }
  });

  test('fires on global install-state changes when state/ does not exist yet (fresh grim home)', async function () {
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
      fs.rmSync(grimHome, { recursive: true, force: true });
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
