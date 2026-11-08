import { ContractorError } from "./errors.js";
import { extractJson, type LlmClient } from "./llm.js";
import { formatUsdc, parseUsdc, sum } from "./money.js";
import type { Plan, Subtask, TaskRequest } from "./types.js";

export interface Planner {
  plan(request: TaskRequest): Promise<Plan>;
}

export class LlmPlanner implements Planner {
  private readonly llm: LlmClient;

  constructor(llm: LlmClient) {
    this.llm = llm;
  }

  async plan(request: TaskRequest): Promise<Plan> {
    const categories = request.allowedCategories?.length
      ? request.allowedCategories.join(", ")
      : "any marketplace category";
    const prompt = `You are the planning half of a general contractor agent. Decompose the user's objective into the smallest useful set of subtasks. Decide for each whether it can be done locally (self) or must be bought from another agent or data provider (buy). Stay strictly inside the budget.

Objective:
${request.objective}

Budget: ${request.budgetUsdc} USDC total.
Quality bar: ${request.qualityBar ?? "deliver work that satisfies the stated objective"}
Allowed buy categories: ${categories}
Deadline: ${request.deadline ?? "none given"}
Maximum per subtask: ${request.maxPricePerSubtaskUsdc ?? "none"}

Return only JSON with this shape:
{
  "summary": "one sentence",
  "subtasks": [
    {
      "id": "kebab-case-id",
      "title": "short title",
      "brief": "exact instructions for the worker, including inputs, output format and constraints",
      "mode": "self" | "buy",
      "category": "one allowed category when mode=buy",
      "maxPriceUsdc": "decimal string",
      "acceptanceCriteria": ["objective, checkable criterion", "..."]
    }
  ]
}

Rules:
- Sum of maxPriceUsdc must be <= the budget. Leave room for risk; do not use the whole budget on one uncertain subtask unless it is the only one.
- Use "buy" when another agent, marketplace worker, or paid data source is a better fit than local reasoning.
- Use "self" only for work this agent can produce directly without external tools.
- Treat every subtask as independently checkable. Include at least one concrete acceptance criterion.
- Do not include prose outside the JSON.`;

    const response = await this.llm.complete({
      system: "You are a precise project planner. Output strict JSON only.",
      user: prompt,
      temperature: 0.2,
    });
    return validatePlan(extractJson<Plan>(response), request);
  }
}

export class HeuristicPlanner implements Planner {
  async plan(request: TaskRequest): Promise<Plan> {
    const budget = parseUsdc(request.budgetUsdc);
    const parts = splitObjective(request.objective);
    if (parts.length <= 1) {
      return validatePlan(
        {
          summary: `Deliver: ${request.objective}`,
          subtasks: [
            {
              id: "deliver-objective",
              title: "Deliver the objective",
              brief: request.objective,
              mode: "buy",
              category: request.allowedCategories?.[0] ?? "research",
              maxPriceUsdc: formatUsdc(budget),
              acceptanceCriteria: [request.qualityBar ?? "The deliverable satisfies the objective"],
            },
          ],
        },
        request,
      );
    }
    const perPart = budget / BigInt(parts.length);
    return validatePlan(
      {
        summary: "Split the objective into independently deliverable parts.",
        subtasks: parts.map((part, index) => ({
          id: `part-${index + 1}`,
          title: part.slice(0, 70),
          brief: part,
          mode: "buy" as const,
          category: request.allowedCategories?.[0] ?? "research",
          maxPriceUsdc: formatUsdc(perPart),
          acceptanceCriteria: ["The deliverable directly answers this part", "It matches the stated quality bar"],
        })),
      },
      request,
    );
  }
}

export function validatePlan(plan: Plan, request: TaskRequest): Plan {
  if (!plan || typeof plan !== "object") throw new ContractorError("invalid_plan", "plan must be an object");
  if (!plan.summary || typeof plan.summary !== "string") throw new ContractorError("invalid_plan", "plan.summary is required");
  if (!Array.isArray(plan.subtasks) || plan.subtasks.length === 0) {
    throw new ContractorError("invalid_plan", "plan must contain at least one subtask");
  }
  const budget = parseUsdc(request.budgetUsdc);
  const maxPerSubtask = request.maxPricePerSubtaskUsdc ? parseUsdc(request.maxPricePerSubtaskUsdc) : undefined;
  const seen = new Set<string>();
  let total = 0n;
  for (const subtask of plan.subtasks) {
    validateSubtask(subtask, seen);
    const price = parseUsdc(subtask.maxPriceUsdc);
    if (price < 0n) throw new ContractorError("invalid_plan", `subtask ${subtask.id} has a negative price`);
    if (maxPerSubtask !== undefined && price > maxPerSubtask) {
      throw new ContractorError(
        "invalid_plan",
        `subtask ${subtask.id} costs ${formatUsdc(price)} USDC, above the per-subtask cap ${formatUsdc(maxPerSubtask)} USDC`,
      );
    }
    total += price;
  }
  if (total > budget) {
    throw new ContractorError(
      "invalid_plan",
      `plan costs ${formatUsdc(total)} USDC, above the ${formatUsdc(budget)} USDC budget`,
    );
  }
  return plan;
}

function validateSubtask(subtask: Subtask, seen: Set<string>): void {
  if (!subtask || typeof subtask !== "object") throw new ContractorError("invalid_plan", "subtask must be an object");
  if (!subtask.id || typeof subtask.id !== "string") throw new ContractorError("invalid_plan", "subtask.id is required");
  if (seen.has(subtask.id)) throw new ContractorError("invalid_plan", `duplicate subtask id ${subtask.id}`);
  seen.add(subtask.id);
  if (!subtask.title || !subtask.brief) throw new ContractorError("invalid_plan", `subtask ${subtask.id} needs title and brief`);
  if (subtask.mode !== "self" && subtask.mode !== "buy") {
    throw new ContractorError("invalid_plan", `subtask ${subtask.id} mode must be self or buy`);
  }
  if (!subtask.maxPriceUsdc || Number.isNaN(Number(subtask.maxPriceUsdc))) {
    throw new ContractorError("invalid_plan", `subtask ${subtask.id} needs maxPriceUsdc`);
  }
  if (!Array.isArray(subtask.acceptanceCriteria) || subtask.acceptanceCriteria.length === 0) {
    throw new ContractorError("invalid_plan", `subtask ${subtask.id} needs acceptance criteria`);
  }
}

function splitObjective(objective: string): string[] {
  const byLine = objective
    .split(/\n+/)
    .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
    .filter(Boolean);
  if (byLine.length > 1) return byLine;
  return objective
    .split(/\s*;\s*|\s+and then\s+|\s+then\s+/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 8);
}

export function planTotal(plan: Plan): bigint {
  return sum(plan.subtasks.map((subtask) => parseUsdc(subtask.maxPriceUsdc)));
}
