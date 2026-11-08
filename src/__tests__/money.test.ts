import { describe, expect, it } from "vitest";
import { formatNear, formatUsdc, parseNear, parseUsdc } from "../money.js";

describe("money", () => {
  it("parses and formats USDC", () => {
    expect(parseUsdc("1.23")).toBe(1_230_000n);
    expect(formatUsdc(1_230_000n)).toBe("1.23");
    expect(parseUsdc("0.000001")).toBe(1n);
  });

  it("rejects excess decimals", () => {
    expect(() => parseUsdc("0.0000001")).toThrow(/decimal/);
  });

  it("parses and formats NEAR", () => {
    expect(parseNear("1")).toBe(10n ** 24n);
    expect(formatNear(1_500_000_000_000_000_000_000_000n)).toBe("1.5");
  });
});

describe("marketplace amount normalization", () => {
  it("accepts trailing zeros beyond the asset precision", () => {
    expect(parseUsdc("25.000000000000")).toBe(25_000_000n);
    expect(formatUsdc(parseUsdc("42.500000000000"))).toBe("42.5");
  });

  it("still rejects real precision loss", () => {
    expect(() => parseUsdc("1.0000001")).toThrow(/decimal/);
  });
});
