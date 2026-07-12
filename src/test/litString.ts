// SSR string-rendering helper for tests: turns a lit-html TemplateResult (or
// the `nothing` sentinel render.ts uses in place of the old `''` "omit this"
// return) into a string, via the same @lit-labs/ssr path the host will use
// for the details skeleton. Self-contained on purpose — normalizeHtml.ts
// (whitespace/marker-comment tolerances) is a separate module owned by the
// goldens stage; nothing here depends on it.
import { nothing } from 'lit-html';
import { render } from '@lit-labs/ssr';
import { collectResult } from '@lit-labs/ssr/lib/render-result.js';

export async function litString(out: unknown): Promise<string> {
  if (out === nothing || out === null || out === undefined || out === '') {
    return '';
  }
  return collectResult(render(out));
}
