// Pure gate selection for the experimental-hook project prompt. Kept free of
// `vscode` so it runs under plain mocha.
import type { StatusItem } from './grim';

export type HookGate = 'enable' | 'consent';

export const CONSENT_CAUSES = new Set(['workspace-not-consented', 'consent-drifted']);

/** Which gate to offer for a project's status rows, and the hooks it holds.
 *  The flag comes first: with it off grim never gets as far as consent. Pure;
 *  exported for tests. */
export function hookPromptFor(
  status: StatusItem[] | null | undefined,
): { gate: HookGate; hooks: string[] } | null {
  const hooks = (status ?? []).filter((item) => item.kind === 'hook');
  const held = (causes: (cause: string) => boolean): string[] =>
    hooks.filter((h) => (h.arming ?? []).some((a) => causes(a.cause))).map((h) => h.name);
  const flagOff = held((cause) => cause === 'feature-flag-off');
  if (flagOff.length > 0) {
    return { gate: 'enable', hooks: flagOff };
  }
  const unconsented = held((cause) => CONSENT_CAUSES.has(cause));
  return unconsented.length > 0 ? { gate: 'consent', hooks: unconsented } : null;
}

export const declinedKey = (gate: HookGate): string => `grimoire.hookPrompt.${gate}.declined`;
