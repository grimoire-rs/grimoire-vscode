// Deliberate fallback for an image that cannot load. Two causes, both outside
// the host's control and both routine:
//
//  - a README references an asset the publisher never packed into the
//    description companion, so resolveCompanionAssets found nothing to rewrite
//    and the relative ref survived into the rendered markdown;
//  - the ref is an absolute URL, which the webview CSP blocks outright
//    (img-src is the extension origin plus data:, never a remote host).
//
// Either way the browser paints its own broken-image glyph, which is unstyled,
// theme-blind and reads like a bug in the extension. Swap in a codicon that
// says "there was an image here and it did not load" on purpose.

/** Arms one capture-phase listener for the whole webview. `error` does not
 *  bubble, so capture is the only way to catch it from a container — and a
 *  single listener survives every re-render, where per-image wiring would have
 *  to be redone each time lit replaces the markdown block. */
export function armBrokenImages(root: HTMLElement): void {
  root.addEventListener(
    'error',
    (event) => {
      const img = event.target;
      if (!(img instanceof HTMLImageElement) || !img.isConnected) {
        return;
      }
      const placeholder = document.createElement('span');
      // The codicon set has no broken-image glyph; file-media (an image file)
      // in the slot an image should have filled reads as the missing picture
      // itself, where an error glyph would overstate it — muted by
      // .broken-image, since absent publisher content is not a fault here.
      placeholder.className = 'codicon codicon-file-media broken-image';
      // The src is the useful part of the diagnosis (an unpacked asset name, or
      // a remote host the CSP refused), so keep it reachable on hover. Set as a
      // property, never markup — this text is publisher-controlled.
      placeholder.title = `Image failed to load: ${img.getAttribute('src') ?? 'unknown source'}`;
      const alt = img.getAttribute('alt');
      if (alt) {
        placeholder.setAttribute('aria-label', alt);
      }
      // Replaced, not hidden: an <img> with a dead src keeps painting the
      // browser glyph however it is styled. The replacement carries no src, so
      // it cannot fire this handler again — no loop, no need for a flag.
      img.replaceWith(placeholder);
    },
    true,
  );
}
