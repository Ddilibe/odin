import { randomUUID } from "node:crypto";
import { ContractorError } from "../errors.js";
import { formatUnits, parseUsdc } from "../money.js";
import type { Deliverable } from "../types.js";
import type { NearWallet } from "./near-wallet.js";

interface PaymentAccept {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
}

interface Challenge {
  x402Version: number;
  error?: string;
  accepts: PaymentAccept[];
}

interface TaskPart {
  text?: string;
  url?: string;
  raw?: string;
}

interface TaskArtifact {
  parts?: TaskPart[];
}

interface A2ATask {
  id: string;
  contextId?: string;
  status?: { state?: string };
  artifacts?: TaskArtifact[];
}

interface A2AResponse {
  jsonrpc?: string;
  id?: string | number;
  result?: {
    task?: A2ATask;
    id?: string;
    status?: { state?: string };
    artifacts?: TaskArtifact[];
  };
  error?: { code?: number; message?: string };
}

export interface X402Result {
  taskId: string;
  state: string;
  text: string;
  deliverable: Deliverable;
  amountUsdc: string;
  network: string;
  asset: string;
  payTo: string;
}

export class X402Client {
  private readonly wallet: NearWallet;
  private readonly pollMs: number;

  constructor(wallet: NearWallet, options: { pollMs?: number } = {}) {
    this.wallet = wallet;
    this.pollMs = options.pollMs ?? 10_000;
  }

  async hire(input: { handle: string; task: string; returnImmediately?: boolean; maxUsdc?: string }): Promise<X402Result> {
    const endpoint = `https://${input.handle}.market.near.ai/a2a/v1`;
    const message = {
      jsonrpc: "2.0",
      id: 1,
      method: "SendMessage",
      params: {
        message: {
          messageId: randomUUID(),
          role: "ROLE_USER",
          parts: [{ text: input.task }],
        },
        configuration: {
          historyLength: 0,
          ...(input.returnImmediately ? { returnImmediately: true } : {}),
        },
      },
    };

    const challengeResponse = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
    });
    if (challengeResponse.status !== 402) {
      const body = await challengeResponse.text();
      throw new ContractorError(
        "x402_no_challenge",
        `expected 402 from ${input.handle}, got ${challengeResponse.status}: ${body.slice(0, 500)}`,
      );
    }
    const challenge = (await challengeResponse.json()) as Challenge;
    const accept = challenge.accepts.find((row) => row.network.startsWith("near:"));
    if (!accept) {
      throw new ContractorError("x402_no_near_rail", `agent ${input.handle} did not offer a NEAR payment rail`, challenge);
    }
    if (input.maxUsdc !== undefined) {
      const requested = BigInt(accept.amount);
      const ceiling = parseUsdc(input.maxUsdc);
      if (requested > ceiling) {
        throw new ContractorError(
          "x402_above_ceiling",
          `agent ${input.handle} asks ${formatUnits(requested, 6)} USDC, above the ${input.maxUsdc} USDC ceiling`,
        );
      }
    }

    const signedDelegateAction = await this.wallet.signX402Delegate({
      asset: accept.asset,
      payTo: accept.payTo,
      amountAtomic: accept.amount,
      maxTimeoutSeconds: accept.maxTimeoutSeconds,
    });
    const xPayment = Buffer.from(
      JSON.stringify({
        x402Version: challenge.x402Version,
        accepted: accept,
        payload: { signedDelegateAction },
      }),
    ).toString("base64");

    const paidResponse = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-PAYMENT": xPayment,
      },
      body: JSON.stringify(message),
    });
    if (!paidResponse.ok) {
      throw new ContractorError(
        "x402_payment_failed",
        `x402 payment to ${input.handle} failed: ${paidResponse.status} ${await paidResponse.text()}`,
      );
    }
    let task = extractTask((await paidResponse.json()) as A2AResponse);
    const deadline = Date.now() + (accept.maxTimeoutSeconds + 600) * 1_000;

    while (isPending(task.status?.state)) {
      if (Date.now() > deadline) {
        throw new ContractorError("x402_timeout", `task ${task.id} did not finish before its deadline`);
      }
      await sleep(this.pollMs);
      const pollResponse = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "GetTask",
          params: { id: task.id, historyLength: 0 },
        }),
      });
      const poll = (await pollResponse.json()) as A2AResponse;
      task = extractTask(poll);
    }

    const state = task.status?.state ?? "UNKNOWN";
    if (state !== "TASK_STATE_COMPLETED") {
      throw new ContractorError("x402_task_failed", `task ${task.id} ended in ${state}`);
    }
    const text = (task.artifacts ?? [])
      .flatMap((artifact) => artifact.parts ?? [])
      .map((part) => part.text)
      .filter((part): part is string => typeof part === "string")
      .join("\n");
    return {
      taskId: task.id,
      state,
      text,
      deliverable: { text },
      amountUsdc: formatUnits(BigInt(accept.amount), 6),
      network: accept.network,
      asset: accept.asset,
      payTo: accept.payTo,
    };
  }
}

function extractTask(response: A2AResponse): A2ATask {
  const task = response.result?.task;
  if (task) return task;
  if (response.result?.id) {
    return {
      id: response.result.id,
      status: response.result.status,
      artifacts: response.result.artifacts,
    };
  }
  throw new ContractorError(
    "x402_bad_response",
    response.error?.message ?? "x402 response did not contain a task",
    response,
  );
}

function isPending(state?: string): boolean {
  return state === "TASK_STATE_SUBMITTED" || state === "TASK_STATE_WORKING";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
