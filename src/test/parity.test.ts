// Regression baselines for src/webview/render.ts markup. Originally captured
// from the pre-migration string renderers to prove the lit-html port changed
// nothing; now that the port has landed they serve as golden regression
// tests: a strictEqual failure names a real markup delta, not a tolerance
// gap. INTENTIONAL UI changes regenerate the affected files via
// UPDATE_GOLDENS=1 — review the golden diff like code; never regenerate to
// silence a failure you can't explain.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { goldenCases } from './fixtures/vms';
import * as render from '../webview/render';
import { litString } from './litString';
import { normalizeHtml } from './normalizeHtml';

// out/test/parity.test.js's __dirname is out/test; goldens live under the
// source tree, not the esbuild output, so walk back up to src/test/fixtures.
const GOLDENS_DIR = path.join(__dirname, '..', '..', 'src', 'test', 'fixtures', 'goldens');
const INDEX_PATH = path.join(GOLDENS_DIR, 'index.json');

if (!fs.existsSync(INDEX_PATH)) {
  // Thrown at suite-build time (not inside a test) so a missing capture
  // stage fails the whole run loudly instead of quietly collecting 0 tests.
  throw new Error(
    `parity goldens index missing: ${INDEX_PATH} — run the pre-migration golden ` +
      'capture script before trusting this suite.',
  );
}

const indexNames: string[] = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
const cases = goldenCases(render);

suite('lit parity vs pre-migration goldens', () => {
  // The fixture matrix and the captured goldens must name exactly the same
  // cases — silent drift (a case added/renamed/removed on one side only)
  // would otherwise skip coverage instead of failing it.
  test('golden index matches goldenCases() fixture matrix', () => {
    const caseNames = cases.map((c) => c.name).sort();
    assert.deepStrictEqual(caseNames, [...indexNames].sort());
  });

  for (const kase of cases) {
    test(kase.name, async () => {
      const goldenPath = path.join(GOLDENS_DIR, `${kase.name}.html`);
      const actual = normalizeHtml(await litString(kase.out));
      if (process.env['UPDATE_GOLDENS'] === '1') {
        fs.writeFileSync(goldenPath, actual);
      }
      if (!fs.existsSync(goldenPath)) {
        throw new Error(`missing golden file for case "${kase.name}": ${goldenPath}`);
      }
      const golden = fs.readFileSync(goldenPath, 'utf8');
      assert.strictEqual(actual, golden);
    });
  }
});
