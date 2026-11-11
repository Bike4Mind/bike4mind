declare module 'mime-types' {
  const mime: { lookup(path: string): string | false };
  export default mime;
}
