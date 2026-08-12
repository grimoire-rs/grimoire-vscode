import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { MUTATING_ACTIONS, isMutating } from '../webview/actions';

// The drift guard for the busy lock.
//
// `complete-install` shipped dispatched by both webviews and guarded by
// neither: each surface kept its own Set of mutating names, and a Set compared
// only against itself cannot report what is missing from it. One shared record
// with an explicit entry per action makes "forgotten" a distinguishable state —
// and this test is what turns it into a failure.
//
// Two sources, because the vocabulary is not all in one place. Templates emit
// most actions as `data-action="literal"`, but menu entries carry theirs as
// `action: 'literal'` in the model and reach the DOM through a single dynamic
// binding (render.ts's menu item). `pin` exists ONLY that way — there is no
// `data-action="pin"` anywhere — so a scan of the templates alone would miss the
// entire menu vocabulary, including a future mutating one.
const SRC = path.join(__dirname, '..', '..', 'src', 'webview');

function readSource(file: string): string {
  return fs.readFileSync(path.join(SRC, file), 'utf8');
}

function literalActions(source: string): Set<string> {
  const found = new Set<string>();
  for (const m of source.matchAll(/data-action="([a-z][a-z-]*)"/g)) {
    found.add(m[1]!);
  }
  return found;
}

function menuActions(source: string): Set<string> {
  const found = new Set<string>();
  for (const m of source.matchAll(/\baction:\s*'([a-z][a-z-]*)'/g)) {
    found.add(m[1]!);
  }
  return found;
}

suite('webview action vocabulary', () => {
  test('every data-action the templates emit is classified', () => {
    const emitted = literalActions(readSource('render.ts'));
    assert.ok(emitted.size > 20, `expected the template sweep to find actions, got ${emitted.size}`);
    const unclassified = [...emitted].filter((a) => !(a in MUTATING_ACTIONS));
    assert.deepStrictEqual(
      unclassified,
      [],
      `unclassified data-action(s) — add each to MUTATING_ACTIONS with an explicit true/false: ${unclassified.join(', ')}`,
    );
  });

  test('every menu action the model builds is classified', () => {
    const built = menuActions(readSource('model.ts'));
    assert.ok(built.size > 0, 'expected the model sweep to find menu actions');
    const unclassified = [...built].filter((a) => !(a in MUTATING_ACTIONS));
    assert.deepStrictEqual(
      unclassified,
      [],
      `unclassified menu action(s) — add each to MUTATING_ACTIONS: ${unclassified.join(', ')}`,
    );
  });

  test('pin is reachable only through the model, which is why both sweeps exist', () => {
    // Not a tautology: it pins the reason the model sweep cannot be dropped. If
    // pin ever gains a template literal this can go, but until then a
    // render.ts-only scan would be blind to the whole menu vocabulary.
    assert.ok(!literalActions(readSource('render.ts')).has('pin'));
    assert.ok(menuActions(readSource('model.ts')).has('pin'));
  });

  test('the actions that run grim are marked mutating', () => {
    for (const action of [
      'install',
      'uninstall',
      'update',
      'switch',
      'pin',
      'pick-version',
      'init-project',
      'install-grim',
      'complete-install',
    ]) {
      assert.strictEqual(isMutating(action), true, `${action} must be guarded by the busy lock`);
    }
  });

  test('pure-UI actions are not mutating', () => {
    for (const action of ['menu', 'copy', 'open-details', 'toggle-node', 'set-tab', 'promote']) {
      assert.strictEqual(isMutating(action), false, `${action} must stay clickable while busy`);
    }
  });

  test('an unknown action reads as non-mutating', () => {
    // Same posture as the Set.has check this replaced: a template that grows an
    // action without a record entry stays clickable rather than going
    // mysteriously inert. The sweeps above are what catch it.
    assert.strictEqual(isMutating('not-an-action'), false);
    assert.strictEqual(isMutating(undefined), false);
  });
});
