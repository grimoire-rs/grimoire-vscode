// markdown-it factory for the details webview bodies. No vscode/DOM — kept pure
// so tests can render with the exact same config the webview uses.
import MarkdownIt, { type MarkdownIt as MarkdownItInstance } from 'markdown-it';

const CODE_COPY_BUTTON =
  '<button class="code-copy" data-action="copy-code" title="Copy" aria-label="Copy"><span class="codicon codicon-copy" aria-hidden="true"></span></button>';

/** markdown-it configured for the details bodies: html:false keeps raw
 *  HTML inert, and validateLink additionally permits our
 *  `data:image/svg+xml;base64,…` companion images — markdown-it's default
 *  allowlist blocks svg data URIs (only gif/png/jpeg/webp), so without this an
 *  inlined SVG renders as `<img src="">`. Everything else keeps the default
 *  behavior, so javascript:/other data: links stay neutralized. SVG via <img>
 *  can't execute script and the webview CSP already allows img-src data:. */
export function createMarkdown(): MarkdownItInstance {
  const md = new MarkdownIt({ linkify: true });
  const defaultValidate = md.validateLink.bind(md);
  md.validateLink = (url) =>
    /^data:image\/svg\+xml;base64,/i.test(url.trim()) || defaultValidate(url);
  // Every block-level code block gets a copy button. The wrapper is constant
  // markup; the inner <pre> is markdown-it's own (already escaped) output.
  for (const rule of ['fence', 'code_block']) {
    const original = md.renderer.rules[rule];
    if (!original) {
      continue;
    }
    md.renderer.rules[rule] = (...args) =>
      `<div class="code-block">${CODE_COPY_BUTTON}${original(...args)}</div>`;
  }
  return md;
}
