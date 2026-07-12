// Allows the webview entries to import their stylesheet so esbuild emits a
// sibling .css bundle; tsc only needs the module declaration.
declare module '*.css';
