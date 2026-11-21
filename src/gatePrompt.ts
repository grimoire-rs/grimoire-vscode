// Pure gate selection for the hook, settings and mod project prompts. Kept free of
// `vscode` so it runs under plain mocha.
import { configSetArgs, dialogText, hookAllowArgs, installArgs, type StatusItem } from './grim';

export type HookGate = 'enable' | 'enable-settings' | 'enable-mods' | 'consent';
export type GatedKind = 'hook' | 'settings' | 'mod';

export interface GatePrompt {
  gate: HookGate;
  /** The kinds the prompt names. */
  kinds: GatedKind[];
  names: string[];
  /** The kinds the gate holds back now, which a "No" and the session memory
   *  cover; `kinds` when absent. The consent prompt names more, since
   *  `grim hook allow` consents to every kind. */
  held?: GatedKind[];
}

const KINDS: GatedKind[] = ['hook', 'settings', 'mod'];
const isGatedKind = (kind: string): kind is GatedKind => (KINDS as string[]).includes(kind);
const MAX_NAMES = 5;
const CONSENT_CAUSES = new Set(['workspace-not-consented', 'consent-drifted']);

/** Which gate to offer for a project's status rows, and what it names. A flag
 *  gate names the rows its flag holds back; the consent gate names every row
 *  `grim hook allow` covers and lists the kinds consent holds back in `held`.
 *  Order: hook flag, settings flag, mods flag, consent. With a flag off grim never gets
 *  as far as consent. `isDeclined` skips a gate already answered for a kind.
 *  Pure; exported for tests. */
export function hookPromptFor(
  status: StatusItem[] | null | undefined,
  isDeclined: (gate: HookGate, kind: GatedKind) => boolean = () => false,
): GatePrompt | null {
  const rows = status ?? [];
  const heldBy = (kind: GatedKind, causes: (cause: string) => boolean): StatusItem[] =>
    rows.filter((r) => r.kind === kind && (r.arming ?? []).some((a) => causes(a.cause)));
  const flagOff = (cause: string): boolean => cause === 'feature-flag-off';

  const hookFlag = heldBy('hook', flagOff);
  if (hookFlag.length > 0 && !isDeclined('enable', 'hook')) {
    return { gate: 'enable', kinds: ['hook'], names: hookFlag.map((r) => r.name) };
  }
  const settingsFlag = heldBy('settings', flagOff);
  if (settingsFlag.length > 0 && !isDeclined('enable-settings', 'settings')) {
    return {
      gate: 'enable-settings',
      kinds: ['settings'],
      names: settingsFlag.map((r) => r.name),
    };
  }
  const modsFlag = heldBy('mod', flagOff);
  if (modsFlag.length > 0 && !isDeclined('enable-mods', 'mod')) {
    return { gate: 'enable-mods', kinds: ['mod'], names: modsFlag.map((r) => r.name) };
  }
  const consentHeld = KINDS.filter((k) => heldBy(k, (c) => CONSENT_CAUSES.has(c)).length > 0);
  if (consentHeld.length === 0 || consentHeld.every((k) => isDeclined('consent', k))) {
    return null;
  }
  const covered = consentCovered(rows);
  const kinds = KINDS.filter((k) => covered.some((r) => r.kind === k));
  return { gate: 'consent', kinds, names: covered.map((r) => r.name), held: consentHeld };
}

/** The rows `grim hook allow` consents to. It records every hook, settings and
 *  mod package the lock pins, whatever the feature flags say
 *  (`reviewed_consent_keys` turns all three flags on, `hook_consent.rs`:98-111;
 *  `command/hook/allow.rs`:84-90 takes `consent::all_keys` of it), so this is
 *  every pinned hook, settings and mod row, plus any row a consent cause holds. */
function consentCovered(rows: readonly StatusItem[]): StatusItem[] {
  return rows.filter(
    (r) =>
      isGatedKind(r.kind) &&
      (r.pinned !== null || (r.arming ?? []).some((a) => CONSENT_CAUSES.has(a.cause))),
  );
}

/** A covered row's identity for comparing two prompts. grim's own record entry
 *  is `<binding>@<registry>/<repository>` with no kind (`consent_key` in
 *  `hook/consent.rs`), so grim treats a hook and a mod of one binding and
 *  repository as one entry. This identity keeps the kind on purpose: it compares
 *  the ROWS the prompt named, and a row of another kind under the same binding
 *  and repository is a row the user was not shown. It is stricter than grim's
 *  key, never looser. `pinned` reads `<registry>/<repository>@<digest>`; the
 *  digest is dropped, since a version bump is not consent drift. */
function coverKey(r: StatusItem): string {
  const at = r.pinned?.lastIndexOf('@') ?? -1;
  const repository = r.pinned === null ? '' : at > 0 ? r.pinned.slice(0, at) : r.pinned;
  return `${r.kind}:${r.name}@${repository}`;
}

/** Names of the rows `now` would have the consent prompt cover that `shown`
 *  did not, a row whose repository changed included; `[]` when Allow still
 *  consents to no more than the prompt named, and `null` when `now` is not a
 *  list of rows, which Allow treats as a failed status check. It sees only
 *  what `grim status` reports: a lock entry with no status row, or a change
 *  after this check, still reaches `grim hook allow`. Pure; exported for
 *  tests. */
export function newlyCovered(
  shown: readonly StatusItem[] | null | undefined,
  now: readonly StatusItem[] | null | undefined,
): string[] | null {
  if (!Array.isArray(now)) {
    return null;
  }
  const seen = new Set(consentCovered(shown ?? []).map(coverKey));
  return consentCovered(now)
    .filter((r) => !seen.has(coverKey(r)))
    .map((r) => r.name);
}

/** Workspace-state key remembering a "No". Keyed by gate; consent for
 *  settings and for mods has its own key so declining one kind does not silence
 *  the others. */
export const declinedKey = (gate: HookGate, kind: GatedKind): string =>
  gate === 'consent' && kind !== 'hook'
    ? `grimoire.hookPrompt.consent-${kind === 'mod' ? 'mods' : kind}.declined`
    : `grimoire.hookPrompt.${gate}.declined`;

/** The output-channel line naming every entry when the toast hides some behind
 *  "and N more"; `undefined` when the toast shows them all. Pure; exported for
 *  tests. */
export function promptNamesLine(prompt: GatePrompt): string | undefined {
  if (prompt.names.length <= MAX_NAMES) {
    return undefined;
  }
  const subject =
    prompt.gate === 'enable'
      ? 'the hooks prompt'
      : prompt.gate === 'enable-settings'
        ? 'the settings prompt'
        : prompt.gate === 'enable-mods'
          ? 'the mods prompt'
          : 'the consent prompt';
  return `Grimoire: ${subject} covers: ${prompt.names.map((n) => dialogText(n, 200)).join(', ')}`;
}

/** Consent copy per kind; the message for any subset is built from these. */
const CONSENT_PARTS: Record<
  GatedKind,
  { noun: string; short: string; says: string; verb: string }
> = {
  hook: {
    noun: 'hooks',
    short: 'hooks',
    says: "Hooks run commands on your agents' tool calls.",
    verb: 'to run',
  },
  settings: {
    noun: 'settings packages',
    short: 'settings',
    says: 'Settings change how your AI client behaves and what it may do.',
    verb: 'to apply',
  },
  mod: {
    noun: 'mods',
    short: 'mods',
    says:
      'A mod is code your AI client (Claude Code, OpenCode) loads into its own process; ' +
      "Allow lets grim write the mod's files so the client loads them.",
    verb: 'to load',
  },
};

/** The toast text, accept label, grim steps and progress title for a gate. */
export function gatePromptText(prompt: GatePrompt): {
  message: string;
  yes: string;
  steps: string[][];
  title: string;
} {
  const shown = prompt.names.slice(0, MAX_NAMES).map((n) => dialogText(n, 60));
  const extra = prompt.names.length - MAX_NAMES;
  const names =
    extra > 0
      ? `${shown.join(', ')} and ${extra} more, listed in the Grimoire output`
      : shown.join(', ');
  if (prompt.gate === 'enable') {
    return {
      message:
        `Grimoire: This project declares experimental hooks (${names}). ` +
        'Enable hooks for this project? This sets options.experimental.hooks in grimoire.toml.',
      yes: 'Enable',
      steps: [configSetArgs('options.experimental.hooks', 'true'), installArgs()],
      title: 'Enabling hooks',
    };
  }
  if (prompt.gate === 'enable-settings') {
    return {
      message:
        `Grimoire: This project declares experimental settings packages (${names}) ` +
        "that change your AI clients' own config files. " +
        'Enable settings for this project? This sets options.experimental.settings in grimoire.toml.',
      yes: 'Enable',
      steps: [configSetArgs('options.experimental.settings', 'true'), installArgs()],
      title: 'Enabling settings',
    };
  }
  if (prompt.gate === 'enable-mods') {
    return {
      message:
        `Grimoire: This project declares experimental mods (${names}). ` +
        'A mod is code your AI client (Claude Code, OpenCode) loads into its own process. ' +
        'Enable mods for this project? This sets options.experimental.mods in grimoire.toml.',
      yes: 'Enable',
      steps: [configSetArgs('options.experimental.mods', 'true'), installArgs()],
      title: 'Enabling mods',
    };
  }
  const steps = [hookAllowArgs(), installArgs()];
  const present = KINDS.filter((k) => prompt.kinds.includes(k));
  if (present.length === 1 && present[0] === 'hook') {
    return {
      message:
        `Grimoire: This workspace declares hooks (${names}) that run commands on ` +
        "your agents' tool calls. Allow them to run?",
      yes: 'Allow',
      steps,
      title: 'Allowing hooks',
    };
  }
  const parts = present.map((k) => CONSENT_PARTS[k]);
  const list = (items: string[]): string =>
    items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
  const ask =
    parts.length === 1
      ? `Allow them ${parts[0]?.verb}?`
      : `Allow ${list(parts.map((p) => `${p.short} ${p.verb}`))}?`;
  return {
    message:
      `Grimoire: This workspace declares ${list(parts.map((p) => p.noun))} (${names}). ` +
      `${parts.map((p) => p.says).join(' ')} ${ask}`,
    yes: 'Allow',
    steps,
    title: `Allowing ${list(parts.map((p) => p.short))}`,
  };
}
