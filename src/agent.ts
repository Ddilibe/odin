import { join } from "node:path";
import type { Planner } from "./planner.js";
import type { Procurement, ProcurementOutcome } from "./procurement.js";
import type { BudgetBook } from "./ledger.js";
import type { ReceiptStore } from "./receipts.js";
import { writeJson } from "./storage.js";
import { ContractorError } from "./errors.js";
import { formatUsdc, parseUsdc } from "./money.js";
import type { Plan, RunReport, Subtask, TaskRequest } from "./types.js";

export interface ContractorDeps {
  planner: Planner;
  procurement: Procurement;
  budget: BudgetBook;
  receipts: ReceiptStore;
  runId: string;
  runDirectory: string;
  log?: (message: string) => void;
}

export class ContractorAgent {
  private readonly deps: ContractorDeps;

  constructor(deps: ContractorDeps) {
    this.deps = deps;
  }

  async run(request: TaskRequest): Promise<RunReport> {
    if (parseUsdc(request.budgetUsdc) <= 0n) {
      throw new ContractorError("invalid_budget", "budget must be greater than zero");
    }
    const startedAt = new Date().toISOString();
    const report: RunReport = {
      runId: this.deps.runId,
      objective: request.objective,
      budgetUsdc: request.budgetUsdc,
      spendingMode: request.spendingMode,
      paymentPreference: request.paymentPreference,
      startedAt,
      status: "running",
      receipts: [],
      spentUsdc: "0",
      reservedUsdc: "0",
      remainingUsdc: request.budgetUsdc,
      notes: [],
    };
    this.persist(report);

    try {
      this.log(`planning: ${request.objective}`);
      const plan = await this.deps.planner.plan(request);
      report.plan = plan;
      this.persist(report);
      this.logPlan(plan);

      const completed = new Set<string>();
      const outputs = new Map<string, string>();
      const deadline = request.deadline ? Date.parse(request.deadline) : undefined;
      if (deadline !== undefined && Number.isNaN(deadline)) {
        throw new ContractorError("invalid_deadline", `deadline is not a valid date: ${request.deadline}`);
      }

      while (completed.size < plan.subtasks.length) {
        if (deadline !== undefined && Date.now() > deadline) {
          report.status = "stopped";
          report.notes.push("stopped because the requested deadline passed");
          break;
        }
        const ready = this.readySubtasks(plan, completed);
        if (ready.length === 0) {
          throw new ContractorError("cyclic_plan", "plan contains a dependency cycle or references an unknown subtask");
        }
        for (const subtask of ready) {
          const priorResults = (subtask.dependsOn ?? [])
            .map((id) => outputs.get(id))
            .filter((value): value is string => Boolean(value));
          try {
            const outcome = await this.deps.procurement.execute({
              taskId: this.deps.runId,
              request,
              subtask,
              priorResults,
            });
            outputs.set(subtask.id, outcome.deliverable.text);
            completed.add(subtask.id);
            report.receipts.push(outcome.receipt.id);
            this.refreshBudget(report);
            this.persist(report);
            this.log(`done: ${subtask.id} (${outcome.amountUsdc} USDC)`);
          } catch (error) {
            report.status = "failed";
            report.notes.push(`${subtask.id}: ${errorMessage(error)}`);
            this.refreshBudget(report);
            this.persist(report);
            throw error;
          }
        }
      }

      if (report.status === "running") report.status = "completed";
    } catch (error) {
      if (report.status === "running") report.status = "failed";
      report.notes.push(errorMessage(error));
      this.refreshBudget(report);
      this.persist(report);
      throw error;
    } finally {
      report.finishedAt = new Date().toISOString();
      this.refreshBudget(report);
      this.persist(report);
    }

    this.log(`report: ${join(this.deps.runDirectory, "run.json")}`);
    return report;
  }

  private readySubtasks(plan: Plan, completed: Set<string>): Subtask[] {
    const ids = new Set(plan.subtasks.map((subtask) => subtask.id));
    return plan.subtasks.filter((subtask) => {
      if (completed.has(subtask.id)) return false;
      return (subtask.dependsOn ?? []).every((dependency) => ids.has(dependency) && completed.has(dependency));
    });
  }

  private refreshBudget(report: RunReport): void {
    const snapshot = this.deps.budget.snapshot();
    report.spentUsdc = snapshot.spent;
    report.reservedUsdc = snapshot.reserved;
    report.remainingUsdc = snapshot.available;
  }

  private persist(report: RunReport): void {
    writeJson(join(this.deps.runDirectory, "run.json"), report);
  }

  private logPlan(plan: Plan): void {
    this.log(`plan: ${plan.summary}`);
    for (const subtask of plan.subtasks) {
      const deps = subtask.dependsOn?.length ? ` after ${subtask.dependsOn.join(", ")}` : "";
      this.log(`  - ${subtask.id}: ${subtask.mode} ${subtask.maxPriceUsdc} USDC${deps} | ${subtask.title}`);
    }
    this.log(`plan total: ${formatUsdc(plan.subtasks.reduce((total, subtask) => total + parseUsdc(subtask.maxPriceUsdc), 0n))} USDC`);
  }

  private log(message: string): void {
    this.deps.log?.(message);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { ProcurementOutcome };
