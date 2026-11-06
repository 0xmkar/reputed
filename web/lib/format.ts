/** 0x1234567890abcdef... -> 0x12…ab34 */
export function shortAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}
