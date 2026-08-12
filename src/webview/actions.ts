// The one place that says which `data-action` runs a grim command.
//
// Shared by both webview entries because mutating-ness is a property of the
// ACTION NAME, not of the surface it was clicked on: an action a surface never
// emits simply never looks itself up here, and costs one entry. Two per-surface
// sets is what let `complete-install` ship guarded on neither — it was present
// in both click dispatchers and absent from both busy sets, and nothing could
// see the omission because each set was only ever compared against itself.
//
// Every emitted action is listed, including the harmless ones. A Set of the
// mutating names cannot distinguish "known and safe" from "forgotten"; an
// explicit `false` can, and the drift test (test/actions.test.ts) turns a
// missing entry into a failure instead of a silently-unguarded button.
export const MUTATING_ACTIONS: Record<string, boolean> = {
  // Runs grim. Refused while another mutation is in flight.
  install: true,
  uninstall: true,
  update: true,
  switch: true,
  pin: true,
  'pick-version': true,
  'init-project': true,
  'install-grim': true,
  // Re-materializes a whole scope's lock (`grim install`) — as mutating as any
  // of the above, and the omission this record exists to prevent.
  'complete-install': true,

  // Pure UI. Listed so the drift test can tell classified from forgotten.
  menu: false,
  'scope-menu': false,
  'scope-gear': false,
  copy: false,
  'copy-share': false,
  open: false,
  'open-details': false,
  'toggle-node': false,
  'toggle-kind': false,
  'toggle-tags': false,
  'set-tab': false,
  refresh: false,
  'clear-search': false,
  'search-tag': false,
  'show-grim-info': false,
  'revalidate-error': false,
  // Pins the preview tab open ("Keep open"), not a grim call.
  promote: false,
};

/** True only for an action this record marks mutating. An unknown action reads
 *  as non-mutating — same posture as the `Set.has` check this replaced, so a
 *  template that grows an action without updating the record stays clickable
 *  rather than becoming mysteriously inert; the drift test is what catches it. */
export function isMutating(action: string | undefined): boolean {
  return action !== undefined && MUTATING_ACTIONS[action] === true;
}
