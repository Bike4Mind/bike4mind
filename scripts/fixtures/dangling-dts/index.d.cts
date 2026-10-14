// Intentionally broken: ns$1 is never declared. The check's self-test relies on it.
export type X = ns$1.Missing;
// Intentionally broken: Document is a DOM global, absent from the DOM-free consumer. The self-test relies on it.
export type D = Document;
