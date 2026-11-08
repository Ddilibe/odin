import { describe, expect, it } from "vitest";
import { HeuristicPlanner, validatePlan } from "../planner.js";
import type { Plan, TaskRequest } from "../types.js";

const request: TaskRequest = {
  objective: "Research a topic and write a summary",
  budgetUsdc: "10",
  spendingMode: "autonomous",
  paymentPreference: "usdc",
};

function plan(overrides: Partial<Plan["subtasks"][number]>[] = []): Plan {
  return {
    summary: "test",
    subtasks: overrides.map((override, index) => ({
      id: `s${index}`,
      title: "Title",
      brief: "Brief",
      mode: "buy",
      category: "research",
      maxPriceUsdc: "1",
      acceptanceCriteria: ["Non-empty answer"],
      ...override,
    })),
  };
}

describe("validatePlan", () => {
  it("accepts a plan inside the budget", () => {
    expect(validatePlan(plan([{}, { maxPriceUsdc: "2" }]), request).subtasks).toHaveLength(2);
  });

  it("rejects a plan above the budget", () => {
    expect(() => validatePlan(plan([{ maxPriceUsdc: "11" }]), request)).toThrow(/above the 10 USDC budget/);
  });

  it("rejects duplicate ids", () => {
    expect(() => validatePlan(plan([{ id: "same" }, { id: "same" }]), request)).toThrow(/duplicate/);
  });

  it("rejects missing acceptance criteria", () => {
    expect(() => validatePlan(plan([{ acceptanceCriteria: [] }]), request)).toThrow(/acceptance criteria/);
  });

  it("rejects a per-subtask overrun", () => {
    expect(() => validatePlan(plan([{ maxPriceUsdc: "3" }]), { ...request, maxPricePerSubtaskUsdc: "2" })).toThrow(
      /per-subtask cap/,
    );
  });
});

describe("HeuristicPlanner", () => {
  it("splits a multi-part objective and stays inside budget", async () => {
    const result = await new HeuristicPlanner().plan({
      ...request,
      objective: "gather sources; analyze the sources; write the final brief",
    });
    expect(result.subtasks.length).toBeGreaterThan(1);
    expect(result.subtasks.reduce((total, subtask) => total + Number(subtask.maxPriceUsdc), 0)).toBeLessThanOrEqual(10);
  });
});
