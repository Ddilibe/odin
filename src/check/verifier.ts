import { extractJson, type LlmClient } from "../llm.js";
import type { CheckResult, Deliverable, Subtask } from "../types.js";

export interface Judge {
  judge(input: { subtask: Subtask; deliverable: Deliverable }): Promise<{
    passed: boolean;
    score: number;
    reasons: string[];
    requiredFixes: string[];
  }>;
}

export class LlmJudge implements Judge {
  private readonly llm: LlmClient;

  constructor(llm: LlmClient) {
    this.llm = llm;
  }

  async judge(input: { subtask: Subtask; deliverable: Deliverable }): Promise<{
    passed: boolean;
    score: number;
    reasons: string[];
    requiredFixes: string[];
  }> {
    const response = await this.llm.complete({
      system: "You are a strict acceptance tester. Judge only the delivered work against the brief and criteria. Output strict JSON.",
      user: `Brief:
${input.subtask.brief}

Acceptance criteria:
${input.subtask.acceptanceCriteria.map((criterion, index) => `${index + 1}. ${criterion}`).join("\n")}

Deliverable:
${input.deliverable.text.slice(0, 30_000)}

Return JSON only:
{"passed": true|false, "score": 0-100, "reasons": ["..."], "requiredFixes": ["..."]}
Pass only when the deliverable satisfies every criterion. If it is close, fail with concrete required fixes.`,
      temperature: 0,
    });
    const parsed = extractJson<{
      passed?: boolean;
      score?: number;
      reasons?: string[];
      requiredFixes?: string[];
    }>(response);
    return {
      passed: Boolean(parsed.passed),
      score: Math.max(0, Math.min(100, Number(parsed.score ?? (parsed.passed ? 100 : 0)))),
      reasons: Array.isArray(parsed.reasons) ? parsed.reasons.map(String) : [],
      requiredFixes: Array.isArray(parsed.requiredFixes) ? parsed.requiredFixes.map(String) : [],
    };
  }
}

export class Verifier {
  private readonly judge?: Judge;

  constructor(judge?: Judge) {
    this.judge = judge;
  }

  async verify(subtask: Subtask, deliverable: Deliverable): Promise<CheckResult> {
    const deterministic: Record<string, boolean> = {};
    const reasons: string[] = [];
    const text = deliverable.text.trim();
    deterministic.non_empty = text.length > 0 || Boolean(deliverable.externalUrl) || Boolean(deliverable.files?.length);
    if (!deterministic.non_empty) reasons.push("deliverable is empty");

    for (const criterion of subtask.acceptanceCriteria) {
      const check = deterministicCheck(criterion, deliverable);
      if (check) {
        deterministic[check.name] = check.passed;
        if (!check.passed) reasons.push(check.reason);
      }
    }

    const deterministicPassed = Object.values(deterministic).every(Boolean);
    if (!deterministicPassed) {
      return {
        passed: false,
        score: 0,
        reasons,
        requiredFixes: reasons,
        deterministic,
      };
    }

    if (!this.judge) {
      return {
        passed: true,
        score: 75,
        reasons: ["deterministic checks passed; no semantic judge configured"],
        requiredFixes: [],
        deterministic,
      };
    }

    const judged = await this.judge.judge({ subtask, deliverable });
    return {
      passed: deterministicPassed && judged.passed,
      score: judged.score,
      reasons: [...reasons, ...judged.reasons],
      requiredFixes: judged.requiredFixes,
      deterministic,
    };
  }
}

function deterministicCheck(
  criterion: string,
  deliverable: Deliverable,
): { name: string; passed: boolean; reason: string } | undefined {
  const text = deliverable.text;
  const contains = criterion.match(/^contains:\s*(.+)$/i);
  if (contains?.[1]) {
    const value = contains[1].trim();
    const passed = text.toLowerCase().includes(value.toLowerCase());
    return { name: `contains:${value}`, passed, reason: `deliverable does not contain "${value}"` };
  }
  const minLength = criterion.match(/^min-length:\s*(\d+)$/i);
  if (minLength?.[1]) {
    const minimum = Number(minLength[1]);
    const passed = text.length >= minimum;
    return { name: `min-length:${minimum}`, passed, reason: `deliverable is shorter than ${minimum} characters` };
  }
  const jsonCheck = criterion.match(/^json$/i);
  if (jsonCheck) {
    try {
      JSON.parse(text);
      return { name: "json", passed: true, reason: "" };
    } catch {
      return { name: "json", passed: false, reason: "deliverable is not valid JSON" };
    }
  }
  return undefined;
}
