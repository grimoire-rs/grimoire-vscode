// Which experimental-hook gate the project prompt offers, from grim status rows.
import * as assert from 'assert';
import type { StatusItem } from '../grim';
import { hookPromptFor } from '../views/hookPrompt';

const row = (name: string, causes: string[], kind = 'hook'): StatusItem => ({
  kind,
  name,
  source: 'direct',
  pinned: null,
  state: causes.length > 0 ? 'gated' : 'installed',
  outputs: [],
  clients_missing: [],
  clients_extra: [],
  deprecated: null,
  replaced_by: null,
  update_available: null,
  arming: causes.map((cause) => ({ client: 'claude', cause, message: cause })),
});

suite('hookPromptFor', () => {
  test('feature flag off offers enabling, ahead of consent', () => {
    assert.deepStrictEqual(
      hookPromptFor([row('a', ['feature-flag-off']), row('b', ['workspace-not-consented'])]),
      { gate: 'enable', hooks: ['a'] },
    );
  });

  test('missing or drifted consent offers allowing', () => {
    assert.deepStrictEqual(
      hookPromptFor([row('a', ['workspace-not-consented']), row('b', ['consent-drifted'])]),
      { gate: 'consent', hooks: ['a', 'b'] },
    );
  });

  test('armed, client-declined, non-hook and unknown status offer nothing', () => {
    assert.strictEqual(hookPromptFor([row('a', [])]), null);
    assert.strictEqual(hookPromptFor([row('a', ['client-has-no-hook-surface'])]), null);
    assert.strictEqual(hookPromptFor([row('s', ['feature-flag-off'], 'skill')]), null);
    assert.strictEqual(hookPromptFor(null), null);
  });
});

