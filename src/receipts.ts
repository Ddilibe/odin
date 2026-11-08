import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readJson, writeJson } from "./storage.js";
import type { Receipt } from "./types.js";

export class ReceiptStore {
  private readonly path: string;
  private receipts: Receipt[];

  constructor(directory: string) {
    this.path = join(directory, "receipts.json");
    this.receipts = readJson<Receipt[]>(this.path, []);
  }

  create(input: Omit<Receipt, "id" | "createdAt" | "updatedAt">): Receipt {
    const now = new Date().toISOString();
    const receipt: Receipt = {
      ...input,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    this.receipts.push(receipt);
    this.persist();
    return receipt;
  }

  update(id: string, patch: Partial<Omit<Receipt, "id" | "createdAt">>): Receipt {
    const index = this.receipts.findIndex((receipt) => receipt.id === id);
    if (index < 0) throw new Error(`unknown receipt ${id}`);
    const current = this.receipts[index]!;
    const next: Receipt = {
      ...current,
      ...patch,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    };
    this.receipts[index] = next;
    this.persist();
    return next;
  }

  list(): Receipt[] {
    return [...this.receipts];
  }

  private persist(): void {
    writeJson(this.path, this.receipts);
  }
}
