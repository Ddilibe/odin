import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContractorAgent } from "../agent.js";
import { BudgetBook } from "../ledger.js";
import { parseUsdc } from "../money.js";
import type { Procurement, ProcurementOutcome } from "../procurement.js";
import type { Planner } from "../planner.js";
import { ReceiptStore } from "../receipts.js";
import type { Plan, TaskRequest } from "../types.js";

const directories: string[] = [];
function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "contractor-agent-"));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const plan: Plan = {
  summary: "two dependent subtasks",
  subtasks: [
    {
      id: "first",
      title: "First",
      brief: "Do the first part",
      mode: "buy",
      maxPriceUsdc: "1",
      acceptanceCriteria: ["min-length: 1"],
    },
    {
      id: "second",
      title: "Second",
      brief: "Do the second part",
      mode: "buy",
      maxPriceUsdc: "1",
      acceptanceCriteria: ["min-length: 1"],
      dependsOn: ["first"],
    },
  ],
};

class FixedPlanner implements Planner {
  async plan(): Promise<Plan> {
    return plan;
  }
}

describe("ContractorAgent", () => {
  it("runs subtasks in dependency order and persists the report", async () => {
    const directory = tempDir();
    const budget = new BudgetBook("run-1", parseUsdc("10"), directory);
    const receipts = new ReceiptStore(directory);
    const order: string[] = [];
    let prior: string[] = [];
    const procurement = {
      execute: async (input: { subtask: { id: string }; priorResults: string[] }): Promise<ProcurementOutcome> => {
        order.push(input.subtask.id);
        prior = input.priorResults;
        const now = new Date().toISOString();
        const receipt = receipts.create({
          taskId: "run-1",
          subtaskId: input.subtask.id,
          action: "self",
          vendor: { name: "self" },
          amountUsdc: "0",
          currency: "OTHER",
          rail: "none",
          spendingMode: "autonomous",
          status: "paid",
        });
        return { receipt, deliverable: { text: `output of ${input.subtask.id}` }, amountUsdc: "0" };
      },
    } as unknown as Procurement;
    const agent = new ContractorAgent({
      planner: new FixedPlanner(),
      procurement,
      budget,
      receipts,
      runId: "run-1",
      runDirectory: directory,
    });
    const request: TaskRequest = {
      objective: "two parts",
      budgetUsdc: "10",
      spendingMode: "autonomous",
      paymentPreference: "usdc",
    };

    const report = await agent.run(request);

    expect(order).toEqual(["first", "second"]);
    expect(prior).toEqual(["output of first"]);
    expect(report.status).toBe("completed");
    expect(report.receipts).toHaveLength(2);
  });
});
