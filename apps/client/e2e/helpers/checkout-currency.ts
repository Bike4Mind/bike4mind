/** Match a complete dollar amount, excluding other dollar currencies such as CA$ and A$. */
export function checkoutUsdAmountPattern(total: number): RegExp {
  if (!Number.isFinite(total) || total < 0) {
    throw new Error(`Invalid checkout total: ${total}`);
  }
  const [dollars, cents] = total.toFixed(2).split('.');
  const groupedDollars = dollars.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const integer = groupedDollars === dollars ? dollars : `(?:${dollars}|${groupedDollars})`;
  const amount = cents === '00' ? `${integer}(?:\\.00)?` : `${integer}\\.${cents}`;
  return new RegExp(`(?<![\\p{L}\\p{N}$])(?:US)?\\$${amount}(?![\\d.,])`, 'u');
}
