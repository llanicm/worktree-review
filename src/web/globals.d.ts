// highlight.js is loaded from cdnjs by index.html before app.js; only the part we use is declared.
// Optional on purpose: if the CDN is blocked the page must still work, just without colours.
interface Hljs {
  getLanguage(name: string): unknown;
  highlight(code: string, options: { language: string; ignoreIllegals?: boolean }): { value: string };
}
interface Window {
  hljs?: Hljs;
}
