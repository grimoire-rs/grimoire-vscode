// Expiry sweep for `grim-polyfill<X.Y.Z:` markers (see
// .claude/rules/grim-compat-markers.md). Standing policy is no pre-1.0 compat
// shims; a marker is the price of the rare approved one, and this test is what
// makes it expire on schedule instead of rotting into permanent code nobody
// dares delete. It ships with the first marker, never after it.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { MINIMUM_GRIM_VERSION, isNewerVersion } from '../installer';

// out/test/compatMarkers.test.js's __dirname is out/test — same hop parity.test.ts makes.
const SRC_DIR = path.join(__dirname, '..', '..', 'src');
const SELF = 'compatMarkers.test.ts';

/** The marker word, assembled rather than written whole so this file's own
 *  prose and patterns can never be mistaken for a marker by the sweep — the
 *  path skip below is the real guard, this is belt and braces. */
const WORD = ['grim', 'polyfill'].join('-') + '<';
const WELL_FORMED = new RegExp(WORD + '(\\d+\\.\\d+\\.\\d+):', 'g');

function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return tsFiles(full);
    }
    return entry.isFile() && entry.name.endsWith('.ts') && entry.name !== SELF ? [full] : [];
  });
}

suite('grim compatibility markers', () => {
  test('every marker names a version the floor has not yet reached', () => {
    const stale: string[] = [];
    for (const file of tsFiles(SRC_DIR)) {
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(WELL_FORMED)) {
        const version = match[1] ?? '';
        if (!isNewerVersion(version, MINIMUM_GRIM_VERSION)) {
          stale.push(`${path.relative(SRC_DIR, file)}: ${WORD}${version}`);
        }
      }
    }
    assert.deepStrictEqual(
      stale,
      [],
      `MINIMUM_GRIM_VERSION is now ${MINIMUM_GRIM_VERSION} — delete the branches these guard:\n` +
        stale.join('\n'),
    );
  });

  test('no marker escapes the sweep through a malformed version', () => {
    // A typo like `grim-polyfill<0.13:` would never match the strict pattern
    // above, so it would silently outlive every floor bump.
    const malformed: string[] = [];
    for (const file of tsFiles(SRC_DIR)) {
      const source = fs.readFileSync(file, 'utf8');
      const all = source.split(WORD).length - 1;
      const wellFormed = [...source.matchAll(WELL_FORMED)].length;
      if (all !== wellFormed) {
        malformed.push(`${path.relative(SRC_DIR, file)}: ${all - wellFormed} malformed`);
      }
    }
    assert.deepStrictEqual(malformed, [], `markers must read ${WORD}X.Y.Z: exactly`);
  });
});
