import type { LlmClient } from "../llm.js";
import type { Deliverable, Subtask, TaskRequest } from "../types.js";

export interface SelfWorker {
  work(input: { request: TaskRequest; subtask: Subtask; priorResults: string[] }): Promise<Deliverable>;
}

export class LlmSelfWorker implements SelfWorker {
  private readonly llm: LlmClient;

  constructor(llm: LlmClient) {
    this.llm = llm;
  }

  async work(input: { request: TaskRequest; subtask: Subtask; priorResults: string[] }): Promise<Deliverable> {
    const response = await this.llm.complete({
      system: "You are the local worker inside a general contractor agent. Complete the subtask directly and return only the deliverable.",
      user: `Overall objective:
${input.request.objective}

Quality bar:
${input.request.qualityBar ?? "meet the objective"}

Subtask:
${input.subtask.brief}

Acceptance criteria:
${input.subtask.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}

Earlier results that may be useful:
${input.priorResults.join("\n\n---\n\n").slice(0, 20_000) || "(none)"}

Return the finished work, not a plan or commentary.`,
      temperature: 0.3,
    });
    return { text: response };
  }
}
