import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { BudgetExceededError } from "./errors.js";
import { formatUsdc } from "./money.js";
import { readJson, writeJson } from "./storage.js";

export type LedgerEntryKind = "reserve" | "settle" | "release" | "refund";

export interface LedgerEntry {
  id: string;
  kind: LedgerEntryKind;
  at: string;
  subtaskId: string;
  amountMicros: string;
  note?: string;
}

interface Reservation {
  amountMicros: string;
  settledMicros: string;
  status: "active" | "settled" | "released";
}

export interface BudgetState {
  taskId: string;
  budgetMicros: string;
  spentMicros: string;
  reservations: Record<string, Reservation>;
  entries: LedgerEntry[];
}

function toBigInt(value: string): bigint {
  return BigInt(value);
}

export class BudgetBook {
  private readonly path: string;
  private state: BudgetState;

  constructor(taskId: string, budgetMicros: bigint, directory: string) {
    this.path = join(directory, "budget.json");
    this.state = readJson<BudgetState>(this.path, {
      taskId,
      budgetMicros: budgetMicros.toString(),
      spentMicros: "0",
      reservations: {},
      entries: [],
    });
    if (toBigInt(this.state.budgetMicros) !== budgetMicros) {
      throw new BudgetExceededError(
        `budget for run ${taskId} was previously ${formatUsdc(toBigInt(this.state.budgetMicros))} USDC, not ${formatUsdc(budgetMicros)}`,
      );
    }
    this.assertInvariant();
  }

  get budget(): bigint {
    return toBigInt(this.state.budgetMicros);
  }

  get spent(): bigint {
    return toBigInt(this.state.spentMicros);
  }

  get reserved(): bigint {
    return Object.values(this.state.reservations)
      .filter((entry) => entry.status === "active")
      .reduce((total, entry) => total + toBigInt(entry.amountMicros) - toBigInt(entry.settledMicros), 0n);
  }

  get available(): bigint {
    return this.budget - this.spent - this.reserved;
  }

  reservation(subtaskId: string): Reservation | undefined {
    return this.state.reservations[subtaskId];
  }

  reserve(subtaskId: string, amountMicros: bigint, note?: string): void {
    if (amountMicros < 0n) throw new BudgetExceededError("cannot reserve a negative amount");
    const existing = this.state.reservations[subtaskId];
    if (existing && existing.status === "active") {
      throw new BudgetExceededError(`subtask ${subtaskId} already has an active reservation`);
    }
    if (amountMicros > this.available) {
      throw new BudgetExceededError(
        `cannot reserve ${formatUsdc(amountMicros)} USDC for ${subtaskId}; only ${formatUsdc(this.available)} USDC is available`,
        { budget: formatUsdc(this.budget), spent: formatUsdc(this.spent), reserved: formatUsdc(this.reserved) },
      );
    }
    this.state.reservations[subtaskId] = {
      amountMicros: amountMicros.toString(),
      settledMicros: "0",
      status: "active",
    };
    this.entry("reserve", subtaskId, amountMicros, note);
    this.assertInvariant();
    this.persist();
  }

  settle(subtaskId: string, amountMicros: bigint, note?: string): void {
    if (amountMicros < 0n) throw new BudgetExceededError("cannot settle a negative amount");
    const reservation = this.state.reservations[subtaskId];
    if (!reservation || reservation.status !== "active") {
      throw new BudgetExceededError(`subtask ${subtaskId} has no active reservation`);
    }
    const reserved = toBigInt(reservation.amountMicros) - toBigInt(reservation.settledMicros);
    if (amountMicros > reserved) {
      throw new BudgetExceededError(
        `cannot settle ${formatUsdc(amountMicros)} USDC for ${subtaskId}; only ${formatUsdc(reserved)} USDC was reserved`,
      );
    }
    if (amountMicros > this.available + reserved) {
      throw new BudgetExceededError(`settling ${subtaskId} would exceed the run budget`);
    }
    reservation.settledMicros = (toBigInt(reservation.settledMicros) + amountMicros).toString();
    reservation.status = "settled";
    this.state.spentMicros = (this.spent + amountMicros).toString();
    this.entry("settle", subtaskId, amountMicros, note);
    this.assertInvariant();
    this.persist();
  }

  release(subtaskId: string, note?: string): void {
    const reservation = this.state.reservations[subtaskId];
    if (!reservation || reservation.status !== "active") return;
    const remaining = toBigInt(reservation.amountMicros) - toBigInt(reservation.settledMicros);
    reservation.status = "released";
    this.entry("release", subtaskId, remaining, note);
    this.assertInvariant();
    this.persist();
  }

  refund(subtaskId: string, amountMicros: bigint, note?: string): void {
    if (amountMicros < 0n) throw new BudgetExceededError("cannot refund a negative amount");
    if (amountMicros > this.spent) throw new BudgetExceededError("refund exceeds total spent");
    this.state.spentMicros = (this.spent - amountMicros).toString();
    const reservation = this.state.reservations[subtaskId];
    if (reservation && reservation.status === "settled") {
      reservation.settledMicros = (toBigInt(reservation.settledMicros) - amountMicros).toString();
    }
    this.entry("refund", subtaskId, amountMicros, note);
    this.assertInvariant();
    this.persist();
  }

  snapshot(): { budget: string; spent: string; reserved: string; available: string } {
    return {
      budget: formatUsdc(this.budget),
      spent: formatUsdc(this.spent),
      reserved: formatUsdc(this.reserved),
      available: formatUsdc(this.available),
    };
  }

  entries(): LedgerEntry[] {
    return [...this.state.entries];
  }

  private entry(kind: LedgerEntryKind, subtaskId: string, amountMicros: bigint, note?: string): void {
    this.state.entries.push({
      id: randomUUID(),
      kind,
      at: new Date().toISOString(),
      subtaskId,
      amountMicros: amountMicros.toString(),
      note,
    });
  }

  private assertInvariant(): void {
    if (this.spent < 0n || this.reserved < 0n) {
      throw new BudgetExceededError("ledger invariant violated: negative spent or reserved amount");
    }
    if (this.spent + this.reserved > this.budget) {
      throw new BudgetExceededError(
        `ledger invariant violated: spent ${formatUsdc(this.spent)} + reserved ${formatUsdc(this.reserved)} exceeds budget ${formatUsdc(this.budget)}`,
      );
    }
  }

  private persist(): void {
    writeJson(this.path, this.state);
  }
}
