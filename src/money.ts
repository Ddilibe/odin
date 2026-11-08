export const USDC_DECIMALS = 6;
export const NEAR_DECIMALS = 24;

const TEN = 10n;

export function pow10(exp: number): bigint {
  if (!Number.isInteger(exp) || exp < 0) throw new Error(`invalid exponent: ${exp}`);
  return TEN ** BigInt(exp);
}

export function parseUnits(value: string | number | bigint, decimals = USDC_DECIMALS): bigint {
  if (typeof value === "bigint") return value;
  const text = String(value).trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) throw new Error(`invalid decimal amount: ${text}`);
  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const normalizedFraction = fraction.replace(/0+$/, "");
  if (normalizedFraction.length > decimals) {
    throw new Error(`too many decimal places for ${decimals}-decimal asset: ${text}`);
  }
  const padded = normalizedFraction.padEnd(decimals, "0");
  const units = BigInt(whole) * pow10(decimals) + BigInt(padded || "0");
  return negative ? -units : units;
}

export function formatUnits(value: bigint, decimals = USDC_DECIMALS): string {
  const negative = value < 0n;
  const unsigned = negative ? -value : value;
  const base = pow10(decimals);
  const whole = unsigned / base;
  const fraction = (unsigned % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export function parseUsdc(value: string | number | bigint): bigint {
  return parseUnits(value, USDC_DECIMALS);
}

export function formatUsdc(value: bigint): string {
  return formatUnits(value, USDC_DECIMALS);
}

export function parseNear(value: string | number | bigint): bigint {
  return parseUnits(value, NEAR_DECIMALS);
}

export function formatNear(value: bigint): string {
  return formatUnits(value, NEAR_DECIMALS);
}

export function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function maxBigInt(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

export function percentOf(value: bigint, basisPoints: number): bigint {
  return (value * BigInt(basisPoints)) / 10_000n;
}

export function sum(values: Iterable<bigint>): bigint {
  let total = 0n;
  for (const value of values) total += value;
  return total;
}
