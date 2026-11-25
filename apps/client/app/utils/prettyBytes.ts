const UNITS = ['B', 'kB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

/** Decimal byte size to three significant digits, e.g. 1500 -> "1.5 kB". Throws on non-finite input. */
export function prettyBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) {
    throw new TypeError(`Expected a finite number, got ${typeof bytes}: ${bytes}`);
  }

  const negative = bytes < 0;
  let value = negative ? -bytes : bytes;
  let exponent = value >= 1 ? Math.min(Math.floor(Math.log10(value) / 3), UNITS.length - 1) : 0;

  value /= 1000 ** exponent;
  value = Number(value.toPrecision(Math.max(3, Math.floor(value).toString().length)));
  // Rounding to three digits can land on 1000 (999.5 B), which belongs to the next unit.
  if (value >= 1000 && exponent < UNITS.length - 1) {
    value /= 1000;
    exponent += 1;
  }

  return `${negative ? '-' : ''}${value} ${UNITS[exponent]}`;
}
