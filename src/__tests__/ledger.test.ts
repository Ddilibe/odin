import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BudgetBook } from "../ledger.js";
import { parseUsdc } from "../money.js";

const directories: string[] = [];

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "contractor-ledger-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("BudgetBook", () => {
  it("reserves, settles, and enforces the hard budget", () => {
    const book = new BudgetBook("run-1", parseUsdc("10"), tempDir());
    book.reserve("a", parseUsdc("6"));
    expect(book.available).toBe(parseUsdc("4"));
    expect(() => book.reserve("b", parseUsdc("5"))).toThrow(/only 4 USDC/);
    book.settle("a", parseUsdc("5.5"));
    expect(book.spent).toBe(parseUsdc("5.5"));
    expect(book.available).toBe(parseUsdc("4.5"));
  });

  it("releases unused reservations", () => {
    const book = new BudgetBook("run-1", parseUsdc("10"), tempDir());
    book.reserve("a", parseUsdc("6"));
    book.release("a");
    expect(book.reserved).toBe(0n);
    expect(book.available).toBe(parseUsdc("10"));
    expect(book.spent).toBe(0n);
  });

  it("refunds a settled subtask", () => {
    const book = new BudgetBook("run-1", parseUsdc("10"), tempDir());
    book.reserve("a", parseUsdc("6"));
    book.settle("a", parseUsdc("5"));
    book.refund("a", parseUsdc("5"));
    expect(book.spent).toBe(0n);
    expect(book.available).toBe(parseUsdc("10"));
  });

  it("reloads persisted state", () => {
    const directory = tempDir();
    const book = new BudgetBook("run-1", parseUsdc("10"), directory);
    book.reserve("a", parseUsdc("2"));
    const reloaded = new BudgetBook("run-1", parseUsdc("10"), directory);
    expect(reloaded.reserved).toBe(parseUsdc("2"));
    expect(reloaded.entries()).toHaveLength(1);
  });
});
