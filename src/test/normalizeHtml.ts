// Normalizer shared by the pre-migration golden capture and parity.test.ts's
// post-migration comparison (spec Addendum item 7). It absorbs the ONLY deltas
// the lit-html port is allowed to introduce: part-marker comments, incidental
// whitespace reflow, and lit's `disabled=""` (vs. the old strings' bare
// `disabled`) rendering of boolean-ish attributes. Nothing else is tolerated —
// attribute VALUES and PRESENCE must still match; sorting attribute names is
// safe only because esc()/attr() escape `<`/`>` so a tag boundary can never be
// mistaken for one inside an attribute value. Written to be a no-op-safe pass
// over plain (marker-free) strings too, since the golden files themselves are
// produced by running today's string output through this same function.
// `<?>` is lit's nonce-less child-part terminator, emitted by SSR whenever a
// template's LAST position is a child binding. Safe to strip for the same
// reason attribute sorting is safe: content `<` is always entity-escaped, so a
// raw `<?>` can never be real content.
const LIT_MARKER = /<!--\/?lit-part[^]*?-->|<!--lit-node \d+-->|<!---->|<\?>/g;

/** Matches one opening/self-closing tag's `<name ...attrs...>` so its
 *  attributes can be re-sorted; deliberately excludes closing tags (`</div>`
 *  never matches — the char after `<` must be a letter) and never spans a `>`,
 *  which esc() guarantees can't appear raw inside an attribute value. */
const TAG = /<([a-zA-Z][\w-]*)([^>]*)>/g;

/** One attribute token: a bare name, or `name="value"` (values are always
 *  double-quoted and `"`-escaped by esc(), so this never over-matches). */
const ATTR = /[^\s=]+(?:="[^"]*")?/g;

function attrName(token: string): string {
  const eq = token.indexOf('=');
  return eq === -1 ? token : token.slice(0, eq);
}

function sortTagAttributes(html: string): string {
  return html.replace(TAG, (_whole, tagName: string, rawAttrs: string) => {
    // A trailing `/` (self-closing, e.g. `<img .../>`) belongs after the
    // sorted attributes, not among them — peel it off first.
    const trimmedEnd = rawAttrs.replace(/\s+$/, '');
    const selfClosing = trimmedEnd.endsWith('/');
    const body = (selfClosing ? trimmedEnd.slice(0, -1) : rawAttrs).trim();
    if (!body) {
      return `<${tagName}${selfClosing ? '/' : ''}>`;
    }
    const attrs = (body.match(ATTR) ?? []).sort((a, b) => {
      const an = attrName(a);
      const bn = attrName(b);
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    return `<${tagName} ${attrs.join(' ')}${selfClosing ? '/' : ''}>`;
  });
}

export function normalizeHtml(html: string): string {
  const stripped = html.replace(LIT_MARKER, '');
  const collapsed = stripped.replace(/\s+/g, ' ');
  const tight = collapsed.replace(/>\s+</g, '><');
  const boolAttrs = tight.replace(/([A-Za-z][\w-]*)=""/g, '$1');
  return sortTagAttributes(boolAttrs).trim();
}
