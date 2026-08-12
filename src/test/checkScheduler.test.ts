// The debounce that replaced the once-a-day `grim status --check` throttle.
// Every refresh now asks for verdicts; these pin the part that keeps "every
// refresh" from meaning "every refresh spawns a network round".
import * as assert from 'assert';
import { CheckScheduler } from '../checkScheduler';

const WINDOW = 20;
const past = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function make(options: { enabled?: () => boolean } = {}): {
  scheduler: CheckScheduler;
  rounds: number[];
} {
  const rounds: number[] = [];
  const scheduler = new CheckScheduler(
    async () => {
      rounds.push(rounds.length);
    },
    WINDOW,
    options.enabled ?? (() => true),
  );
  return { scheduler, rounds };
}

suite('CheckScheduler', () => {
  test('a burst of requests collapses to one round after the window', async () => {
    const { scheduler, rounds } = make();
    // Five lock writes in a row — the shape an install or `grim update` makes.
    for (let i = 0; i < 5; i += 1) {
      scheduler.request();
    }
    assert.strictEqual(rounds.length, 0, 'nothing runs during the burst');
    await past(WINDOW * 3);
    assert.strictEqual(rounds.length, 1, 'exactly one round after the quiet window');
    scheduler.dispose();
  });

  test('each request restarts the window — the last state is the one checked', async () => {
    const { scheduler, rounds } = make();
    scheduler.request();
    await past(WINDOW * 0.6);
    scheduler.request(); // still inside the first window
    await past(WINDOW * 0.6);
    assert.strictEqual(rounds.length, 0, 'the second request pushed the round out');
    await past(WINDOW * 2);
    assert.strictEqual(rounds.length, 1);
    scheduler.dispose();
  });

  test('a later request opens a new window rather than being swallowed', async () => {
    const { scheduler, rounds } = make();
    scheduler.request();
    await past(WINDOW * 3);
    scheduler.request();
    await past(WINDOW * 3);
    assert.strictEqual(rounds.length, 2, 'two separated bursts, two rounds');
    scheduler.dispose();
  });

  test('disabled requests never arm', async () => {
    const { scheduler, rounds } = make({ enabled: () => false });
    scheduler.request();
    assert.strictEqual(scheduler.pending, false);
    await past(WINDOW * 3);
    assert.strictEqual(rounds.length, 0, 'the setting/trust gate holds automatic rounds');
    scheduler.dispose();
  });

  test('now() runs immediately, ungated, and drops the pending window', async () => {
    const { scheduler, rounds } = make({ enabled: () => false });
    scheduler.request();
    await scheduler.now();
    assert.strictEqual(rounds.length, 1, 'an explicit request outranks the gate');
    await past(WINDOW * 3);
    assert.strictEqual(rounds.length, 1, 'and no scheduled round follows it');
    scheduler.dispose();
  });

  test('dispose stops an armed round', async () => {
    const { scheduler, rounds } = make();
    scheduler.request();
    scheduler.dispose();
    await past(WINDOW * 3);
    assert.strictEqual(rounds.length, 0);
  });
});
