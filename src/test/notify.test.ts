import * as assert from 'assert';
import { _statusState, notifyError, runWithStatusProgress } from '../notify';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

suite('notify', () => {
  test('notifyError without dedupe always shows, even for identical repeats', () => {
    // Unique per run so prior tests' lastMessage can't interfere.
    const msg = `err-${Date.now()}-plain`;
    assert.strictEqual(notifyError(msg), true, 'first shows');
    assert.strictEqual(notifyError(msg), true, 'identical repeat still shows (user action)');
  });

  test('notifyError with dedupe swallows an identical message within the window', () => {
    const msg = `err-${Date.now()}-dedupe`;
    assert.strictEqual(notifyError(msg, { dedupe: true }), true, 'first shows');
    assert.strictEqual(notifyError(msg, { dedupe: true }), false, 'repeat swallowed');
    assert.strictEqual(
      notifyError(`${msg}-different`, { dedupe: true }),
      true,
      'different always shows',
    );
    assert.strictEqual(
      notifyError(msg, { dedupe: true }),
      true,
      'a different intervening message resets dedupe',
    );
  });

  test('a plain notifyError arms the dedupe for a background echo of the same failure', () => {
    const msg = `err-${Date.now()}-echo`;
    assert.strictEqual(notifyError(msg), true, 'user action shows');
    assert.strictEqual(notifyError(msg, { dedupe: true }), false, 'background echo swallowed');
  });

  test('notifyError dedupe window expires: the same message shows again after it', async () => {
    const msg = `err-${Date.now()}-window`;
    assert.strictEqual(notifyError(msg, { dedupe: true, windowMs: 50 }), true);
    assert.strictEqual(notifyError(msg, { dedupe: true, windowMs: 50 }), false, 'inside window');
    await sleep(60);
    assert.strictEqual(
      notifyError(msg, { dedupe: true, windowMs: 50 }),
      true,
      'shows again once the window has passed',
    );
  });

  test('runWithStatusProgress refcounts: latest title wins, hides on the last settle', async () => {
    let releaseA: () => void = () => {};
    let releaseB: () => void = () => {};
    const a = runWithStatusProgress('First', () => new Promise<void>((r) => (releaseA = r)));
    assert.deepStrictEqual(_statusState().visible, true);
    assert.ok(_statusState().text.includes('First'));
    assert.strictEqual(_statusState().refs, 1);

    const b = runWithStatusProgress('Second', () => new Promise<void>((r) => (releaseB = r)));
    assert.strictEqual(_statusState().refs, 2);
    assert.ok(_statusState().text.includes('Second'), 'most recent title shown');

    releaseA();
    await a;
    assert.strictEqual(_statusState().refs, 1, 'still visible while one runs');
    assert.strictEqual(_statusState().visible, true);

    releaseB();
    await b;
    assert.strictEqual(_statusState().refs, 0);
    assert.strictEqual(_statusState().visible, false, 'hides when the last settles');
  });
});
