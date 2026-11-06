// Which experimental-hook gate the project prompt offers, from grim status rows.
import * as assert from 'assert';
import type { StatusItem } from '../grim';
import {
  declinedKey,
  gatePromptText,
  promptNamesLine,
  hookPromptFor,
  newlyCovered,
  type HookGate,
} from '../gatePrompt';
import { configSetArgs, hookAllowArgs, installArgs } from '../grim';

const row = (
  name: string,
  causes: string[],
  kind = 'hook',
  pinned: string | null = `ghcr.io/acme/${name}@sha256:1`,
): StatusItem => ({
  kind,
  name,
  source: 'direct',
  pinned,
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
  test('consent prompt covers flag-off rows too', () => {
    const rows = [
      row('h', ['feature-flag-off']),
      row('s', ['workspace-not-consented'], 'settings'),
    ];
    const declineEnable = (gate: HookGate): boolean => gate === 'enable';
    assert.deepStrictEqual(hookPromptFor(rows, declineEnable), {
      gate: 'consent',
      kinds: ['hook', 'settings'],
      names: ['h', 's'],
      held: ['settings'],
    });
  });

  test('consent prompt names rows another cause holds, and armed ones', () => {
    // grim reports one cause per client, and a cause ranked ahead of consent
    // hides it; grim hook allow still consents to that row.
    const rows = [
      row('s', ['workspace-not-consented'], 'settings'),
      row('h', ['client-has-no-hook-surface']),
      row('armed', []),
      row('skill', [], 'skill'),
    ];
    assert.deepStrictEqual(hookPromptFor(rows), {
      gate: 'consent',
      kinds: ['hook', 'settings'],
      names: ['s', 'h', 'armed'],
      held: ['settings'],
    });
  });

  test('consent prompt leaves out a row the lock does not pin', () => {
    // grim hook allow consents only to what the lock pins.
    const rows = [
      row('s', ['workspace-not-consented'], 'settings'),
      row('local', ['feature-flag-off'], 'hook', null),
    ];
    assert.deepStrictEqual(
      hookPromptFor(rows, (gate) => gate === 'enable'),
      {
        gate: 'consent',
        kinds: ['settings'],
        names: ['s'],
        held: ['settings'],
      },
    );
  });

  test('a flag-off hook row alone never yields a consent prompt', () => {
    assert.strictEqual(
      hookPromptFor([row('h', ['feature-flag-off'])], (gate) => gate === 'enable'),
      null,
    );
  });

  test('feature flag off offers enabling, ahead of consent', () => {
    assert.deepStrictEqual(
      hookPromptFor([row('a', ['feature-flag-off']), row('b', ['workspace-not-consented'])]),
      { gate: 'enable', kinds: ['hook'], names: ['a'] },
    );
  });

  test('missing or drifted consent offers allowing', () => {
    assert.deepStrictEqual(
      hookPromptFor([row('a', ['workspace-not-consented']), row('b', ['consent-drifted'])]),
      { gate: 'consent', kinds: ['hook'], names: ['a', 'b'], held: ['hook'] },
    );
  });

  test('armed, client-declined, other kinds and unknown status offer nothing', () => {
    assert.strictEqual(hookPromptFor([row('a', [])]), null);
    assert.strictEqual(hookPromptFor([row('a', ['client-has-no-hook-surface'])]), null);
    assert.strictEqual(hookPromptFor([row('s', ['feature-flag-off'], 'skill')]), null);
    assert.strictEqual(hookPromptFor([row('s', ['something-new'], 'settings')]), null);
    assert.strictEqual(hookPromptFor(null), null);
    assert.strictEqual(hookPromptFor(undefined), null);
    assert.strictEqual(hookPromptFor([]), null);
  });

  test('settings flag off offers enabling settings', () => {
    assert.deepStrictEqual(hookPromptFor([row('s', ['feature-flag-off'], 'settings')]), {
      gate: 'enable-settings',
      kinds: ['settings'],
      names: ['s'],
    });
  });

  test('hook flag off beats settings flag off', () => {
    assert.deepStrictEqual(
      hookPromptFor([row('s', ['feature-flag-off'], 'settings'), row('h', ['feature-flag-off'])]),
      { gate: 'enable', kinds: ['hook'], names: ['h'] },
    );
  });

  test('consent with hook and settings rows names both kinds', () => {
    assert.deepStrictEqual(
      hookPromptFor([
        row('s', ['workspace-not-consented'], 'settings'),
        row('h', ['consent-drifted']),
      ]),
      {
        gate: 'consent',
        kinds: ['hook', 'settings'],
        names: ['s', 'h'],
        held: ['hook', 'settings'],
      },
    );
  });

  test('one consent kind declined still offers both kinds and names', () => {
    const rows = [
      row('h', ['workspace-not-consented']),
      row('s', ['workspace-not-consented'], 'settings'),
    ];
    assert.deepStrictEqual(
      hookPromptFor(rows, (gate, kind) => gate === 'consent' && kind === 'hook'),
      {
        gate: 'consent',
        kinds: ['hook', 'settings'],
        names: ['h', 's'],
        held: ['hook', 'settings'],
      },
    );
  });

  test('every consent kind declined offers nothing', () => {
    const rows = [
      row('h', ['workspace-not-consented']),
      row('s', ['workspace-not-consented'], 'settings'),
    ];
    assert.strictEqual(
      hookPromptFor(rows, (gate) => gate === 'consent'),
      null,
    );
  });

  test('a declined enable gate lets enable-settings through', () => {
    const rows = [row('h', ['feature-flag-off']), row('s', ['feature-flag-off'], 'settings')];
    assert.deepStrictEqual(
      hookPromptFor(rows, (gate: HookGate) => gate === 'enable'),
      { gate: 'enable-settings', kinds: ['settings'], names: ['s'] },
    );
  });
});

suite('promptNamesLine', () => {
  const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  test('is undefined for five names or fewer', () => {
    assert.strictEqual(
      promptNamesLine({ gate: 'consent', kinds: ['hook'], names: names.slice(0, 5) }),
      undefined,
    );
  });

  test('names every entry in order for a longer list', () => {
    assert.strictEqual(
      promptNamesLine({ gate: 'consent', kinds: ['hook', 'settings'], names }),
      'Grimoire: the consent prompt covers: a, b, c, d, e, f, g',
    );
  });

  test('wording follows the gate', () => {
    assert.ok(promptNamesLine({ gate: 'enable', kinds: ['hook'], names })?.includes('hooks'));
    assert.ok(
      promptNamesLine({ gate: 'enable-settings', kinds: ['settings'], names })?.includes(
        'settings',
      ),
    );
  });

  test('a name with a line break is flattened', () => {
    const line = promptNamesLine({ gate: 'consent', kinds: ['hook'], names: [...names, 'x\ny'] });
    assert.ok(line?.endsWith('g, x y'));
    assert.ok(!line?.includes('\n'));
  });
});

suite('gatePromptText', () => {
  test('names are flattened, capped and limited to five', () => {
    const flat = gatePromptText({ gate: 'enable', kinds: ['hook'], names: ['a\nb\u202ec'] });
    assert.ok(flat.message.includes('(a b c)'));
    const many = gatePromptText({
      gate: 'enable',
      kinds: ['hook'],
      names: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
    });
    assert.ok(many.message.includes('(a, b, c, d, e and 2 more, listed in the Grimoire output)'));
    const long = gatePromptText({ gate: 'enable', kinds: ['hook'], names: ['x'.repeat(200)] });
    assert.ok(long.message.includes(`(${'x'.repeat(60)}…)`));
  });

  test('hook enable keeps the existing text and steps', () => {
    assert.deepStrictEqual(gatePromptText({ gate: 'enable', kinds: ['hook'], names: ['a', 'b'] }), {
      message:
        'Grimoire: This project declares experimental hooks (a, b). ' +
        'Enable hooks for this project? This sets options.experimental.hooks in grimoire.toml.',
      yes: 'Enable',
      steps: [configSetArgs('options.experimental.hooks', 'true'), installArgs()],
      title: 'Enabling hooks',
    });
  });

  test('settings enable', () => {
    assert.deepStrictEqual(
      gatePromptText({ gate: 'enable-settings', kinds: ['settings'], names: ['s'] }),
      {
        message:
          "Grimoire: This project declares experimental settings packages (s) that change your AI clients' own config files. " +
          'Enable settings for this project? This sets options.experimental.settings in grimoire.toml.',
        yes: 'Enable',
        steps: [configSetArgs('options.experimental.settings', 'true'), installArgs()],
        title: 'Enabling settings',
      },
    );
  });

  test('hook consent keeps the existing text and steps', () => {
    assert.deepStrictEqual(gatePromptText({ gate: 'consent', kinds: ['hook'], names: ['a'] }), {
      message:
        'Grimoire: This workspace declares hooks (a) that run commands on ' +
        "your agents' tool calls. Allow them to run?",
      yes: 'Allow',
      steps: [hookAllowArgs(), installArgs()],
      title: 'Allowing hooks',
    });
  });

  test('settings consent', () => {
    const text = gatePromptText({ gate: 'consent', kinds: ['settings'], names: ['s'] });
    assert.strictEqual(
      text.message,
      'Grimoire: This workspace declares settings packages (s). ' +
        'Settings change how your AI client behaves and what it may do. Allow them to apply?',
    );
    assert.ok(
      text.message.includes('Settings change how your AI client behaves and what it may do.'),
    );
    assert.strictEqual(text.yes, 'Allow');
    assert.deepStrictEqual(text.steps, [hookAllowArgs(), installArgs()]);
    assert.strictEqual(text.title, 'Allowing settings');
  });

  test('combined consent', () => {
    assert.deepStrictEqual(
      gatePromptText({ gate: 'consent', kinds: ['hook', 'settings'], names: ['h', 's'] }),
      {
        message:
          'Grimoire: This workspace declares hooks and settings packages (h, s). ' +
          "Hooks run commands on your agents' tool calls. Settings change how your AI client " +
          'behaves and what it may do. Allow hooks to run and settings to apply?',
        yes: 'Allow',
        steps: [hookAllowArgs(), installArgs()],
        title: 'Allowing hooks and settings',
      },
    );
  });
});

suite('declinedKey', () => {
  test('asked pairs', () => {
    assert.strictEqual(declinedKey('enable', 'hook'), 'grimoire.hookPrompt.enable.declined');
    assert.strictEqual(declinedKey('consent', 'hook'), 'grimoire.hookPrompt.consent.declined');
    assert.strictEqual(
      declinedKey('enable-settings', 'settings'),
      'grimoire.hookPrompt.enable-settings.declined',
    );
    assert.strictEqual(
      declinedKey('consent', 'settings'),
      'grimoire.hookPrompt.consent-settings.declined',
    );
  });

  test('unasked pairs map like their gate', () => {
    assert.strictEqual(declinedKey('enable', 'settings'), 'grimoire.hookPrompt.enable.declined');
    assert.strictEqual(
      declinedKey('enable-settings', 'hook'),
      'grimoire.hookPrompt.enable-settings.declined',
    );
  });
});

suite('newlyCovered', () => {
  const guard = row('guard', ['workspace-not-consented']);
  const shown = [guard, row('team', [], 'settings')];

  test('the same rows cover nothing new', () => {
    assert.deepStrictEqual(newlyCovered(shown, shown), []);
  });

  test('a pinned hook or settings package added since names it', () => {
    const now = [...shown, row('evil', [], 'hook'), row('extra', ['feature-flag-off'], 'settings')];
    assert.deepStrictEqual(newlyCovered(shown, now), ['evil', 'extra']);
  });

  test('a row consent holds that the lock does not pin yet names it', () => {
    const now = [...shown, row('fresh', ['workspace-not-consented'], 'hook', null)];
    assert.deepStrictEqual(newlyCovered(shown, now), ['fresh']);
  });

  test('a row from another repository under the same name names it', () => {
    const now = [guard, row('team', [], 'settings', 'ghcr.io/evil/team@sha256:1')];
    assert.deepStrictEqual(newlyCovered(shown, now), ['team']);
  });

  test('a package of the other kind under the same name and repository names it', () => {
    // grim keys settings consent as `settings:<binding>@…`, so consent to a
    // hook never covers a settings package of the same name, or back.
    const hook = row('x', [], 'hook', 'ghcr.io/acme/x@sha256:1');
    const settings = row('x', [], 'settings', 'ghcr.io/acme/x@sha256:1');
    assert.deepStrictEqual(newlyCovered([hook], [hook, settings]), ['x']);
    assert.deepStrictEqual(newlyCovered([settings], [settings, hook]), ['x']);
  });

  test('a new digest from the same repository is not new', () => {
    const now = [guard, row('team', [], 'settings', 'ghcr.io/acme/team@sha256:2')];
    assert.deepStrictEqual(newlyCovered(shown, now), []);
  });

  test('a dropped row, an unpinned row and another kind are not new', () => {
    const now = [guard, row('local', ['feature-flag-off'], 'hook', null), row('s', [], 'skill')];
    assert.deepStrictEqual(newlyCovered(shown, now), []);
  });

  test('a missing shown status reads as no rows, a missing current one as unread', () => {
    assert.deepStrictEqual(newlyCovered(null, shown), ['guard', 'team']);
    // Fail closed: a status with no row list is a failed check, not "nothing new".
    assert.strictEqual(newlyCovered(shown, undefined), null);
    assert.strictEqual(newlyCovered(shown, null), null);
    const notRows = { items: shown } as unknown as StatusItem[];
    assert.strictEqual(newlyCovered(shown, notRows), null);
  });
});
