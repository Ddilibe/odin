import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Verifier } from "../check/verifier.js";
import { BudgetBook } from "../ledger.js";
import type { ApprovalGate, MarketGateway } from "../market/gateway.js";
import { parseUsdc } from "../money.js";
import { DefaultPaymentResolver } from "../payments/router.js";
import { Procurement } from "../procurement.js";
import { ReceiptStore } from "../receipts.js";
import type { AgentCandidate, Bid, Deliverable, JobStatus, Subtask, TaskRequest } from "../types.js";

const directories: string[] = [];

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "contractor-procurement-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const subtask: Subtask = {
  id: "research",
  title: "Research competitors",
  brief: "Find and summarize the top three competitors.",
  mode: "buy",
  category: "research",
  maxPriceUsdc: "5",
  acceptanceCriteria: ["min-length: 5"],
};

const request: TaskRequest = {
  objective: "Research competitors",
  budgetUsdc: "10",
  spendingMode: "autonomous",
  paymentPreference: "usdc",
};

const candidate: AgentCandidate = {
  agentId: "agent-1",
  handle: "researcher",
  name: "Researcher",
  description: "Market research",
  category: "research",
  priceUsdc: "1.5",
  slaSeconds: 60,
  deliveredJobs: 10,
  successRate: 95,
  payableWith: ["USDC"],
  availableNow: true,
  verification: "verified",
};

function bid(id: string, amountUsdc: string, handle = id): Bid {
  return {
    bidId: id,
    jobId: "job",
    amountUsdc,
    proposal: "proposal",
    status: "pending",
    slaSeconds: 60,
    bidder: { handle, name: handle },
  };
}

class FakeMarket implements Partial<MarketGateway> {
  countered = false;
  accepted = false;
  canceled = false;
  messages: string[] = [];
  agents: AgentCandidate[] = [];
  prepared = 0;
  bids: Bid[] = [];
  directPrice = "1.5";
  result = "A sufficiently detailed delivered result.";
  assignmentAmount: string | undefined;
  requireAwardGate = false;
  awardGatePassed = false;
  failCategoryBrowse = false;

  async browseAgents(input?: { category?: string }): Promise<AgentCandidate[]> {
    if (this.failCategoryBrowse && input?.category) {
      this.failCategoryBrowse = false;
      throw new Error("unknown category");
    }
    return this.agents;
  }

  async createJob(): Promise<{ job_id: string; assignment_id: string; price: string }> {
    return { job_id: "job-1", assignment_id: "assignment-1", price: this.directPrice };
  }

  async prepareJob(): Promise<Record<string, unknown>> {
    this.prepared += 1;
    if (this.prepared === 1) {
      return { draft_id: "draft-1", approval_url: "https://market.near.ai/approve/draft-1", quoted_price: this.directPrice };
    }
    return { job_id: "job-1", assignment_id: "assignment-1", quoted_price: this.directPrice, replayed: true };
  }

  async postJob(): Promise<{ job_id: string; status: string }> {
    return { job_id: "job-2", status: "open" };
  }

  async listBids(): Promise<Bid[]> {
    if (this.countered) return [bid("revised", "4.5", "worker")];
    return this.bids;
  }

  async messageBidder(_jobId: string, _bidId: string, body: string): Promise<void> {
    this.messages.push(body);
    this.countered = true;
  }

  async awardBid(): Promise<Record<string, unknown>> {
    if (this.requireAwardGate) {
      return { action_required: true, job_url: "https://market.near.ai/approve/award-1" };
    }
    return { assignment_id: "assignment-bid" };
  }

  async getJobStatus(): Promise<JobStatus> {
    if (this.requireAwardGate && !this.awardGatePassed) {
      throw new Error("job status was read before the award was approved");
    }
    return {
      jobId: "job",
      status: "completed",
      workerState: "done",
      resultAvailable: true,
      assignments: [{ assignmentId: "assignment-1", status: "delivered", amountUsdc: this.assignmentAmount }],
      raw: {},
    };
  }

  async getJobResult(): Promise<Deliverable> {
    return { text: this.result };
  }

  async requestChanges(): Promise<void> {
    this.result = "A corrected and sufficiently detailed deliverable.";
  }

  async acceptResult(): Promise<{ approval_url: string }> {
    this.accepted = true;
    return { approval_url: "https://market.near.ai/approve/accept-1" };
  }

  async cancelJob(): Promise<void> {
    this.canceled = true;
  }

  async getDraftStatus(): Promise<{ job_id: string }> {
    return { job_id: "job-1" };
  }
}

function makeProcurement(input: {
  market: FakeMarket;
  agents: AgentCandidate[];
  directory: string;
  budget?: string;
  gate?: ApprovalGate;
}): { procurement: Procurement; budget: BudgetBook; receipts: ReceiptStore } {
  input.market.agents = input.agents;
  const budget = new BudgetBook("run-1", parseUsdc(input.budget ?? "10"), input.directory);
  const receipts = new ReceiptStore(input.directory);
  const procurement = new Procurement({
    market: input.market as unknown as MarketGateway,
    marketBaseUrl: "https://market.near.ai",
    budget,
    receipts,
    verifier: new Verifier(),
    approvalGate: input.gate ?? { waitForApproval: async () => undefined },
    paymentResolver: new DefaultPaymentResolver(),
    config: { bidWindowMs: 0, counterWindowMs: 0, pollMs: 0 },
  });
  return { procurement, budget, receipts };
}

describe("Procurement", () => {
  it("hires a listed agent directly when the price is inside the plan", async () => {
    const directory = tempDir();
    const market = new FakeMarket();
    const { procurement, budget, receipts } = makeProcurement({ market, agents: [candidate], directory });

    const outcome = await procurement.execute({ taskId: "run-1", request, subtask, priorResults: [] });

    expect(outcome.amountUsdc).toBe("1.5");
    expect(budget.spent).toBe(parseUsdc("1.5"));
    expect(market.accepted).toBe(true);
    expect(receipts.list()[0]?.status).toBe("paid");
    expect(receipts.list()[0]?.action).toBe("market_hire");
  });

  it("counters once and awards a revised bid inside budget", async () => {
    const directory = tempDir();
    const market = new FakeMarket();
    market.bids = [bid("initial", "8", "worker")];
    const { procurement, budget, receipts } = makeProcurement({ market, agents: [], directory });

    const outcome = await procurement.execute({ taskId: "run-1", request, subtask, priorResults: [] });

    expect(market.messages).toHaveLength(1);
    expect(market.messages[0]).toContain("only counter");
    expect(outcome.amountUsdc).toBe("4.5");
    expect(budget.spent).toBe(parseUsdc("4.5"));
    expect(receipts.list()[0]?.negotiation?.outcome).toBe("revised");
    expect(receipts.list()[0]?.negotiation?.revisedAmountUsdc).toBe("4.5");
  });

  it("waits for human approval before confirming an approval-mode hire", async () => {
    const directory = tempDir();
    const market = new FakeMarket();
    const approvals: string[] = [];
    const { procurement, budget } = makeProcurement({
      market,
      agents: [candidate],
      directory,
      gate: {
        waitForApproval: async (approval) => {
          approvals.push(approval.url);
        },
      },
    });

    await procurement.execute({
      taskId: "run-1",
      request: { ...request, spendingMode: "approval" },
      subtask,
      priorResults: [],
    });

    expect(approvals).toEqual([
      "https://market.near.ai/approve/draft-1",
      "https://market.near.ai/approve/accept-1",
    ]);
    expect(market.prepared).toBe(2);
    expect(budget.spent).toBe(parseUsdc("1.5"));
  });

  it("approves an award before reading the assignment", async () => {
    const directory = tempDir();
    const market = new FakeMarket();
    market.requireAwardGate = true;
    market.bids = [bid("within", "4.5", "worker")];
    const approvals: string[] = [];
    const { procurement, budget } = makeProcurement({
      market,
      agents: [],
      directory,
      gate: {
        waitForApproval: async (approval) => {
          approvals.push(approval.action);
          if (approval.action.startsWith("Award")) market.awardGatePassed = true;
        },
      },
    });

    const outcome = await procurement.execute({
      taskId: "run-1",
      request: { ...request, spendingMode: "approval" },
      subtask,
      priorResults: [],
    });

    expect(approvals).toEqual(["Award worker at 4.5 USDC", "Accept the deliverable for research and release 4.5 USDC"]);
    expect(outcome.amountUsdc).toBe("4.5");
    expect(budget.spent).toBe(parseUsdc("4.5"));
  });

  it("retries MCP browsing without an invalid category filter", async () => {
    const directory = tempDir();
    const market = new FakeMarket();
    market.failCategoryBrowse = true;
    const { procurement, budget } = makeProcurement({ market, agents: [candidate], directory });

    const outcome = await procurement.execute({ taskId: "run-1", request, subtask, priorResults: [] });

    expect(outcome.amountUsdc).toBe("1.5");
    expect(budget.spent).toBe(parseUsdc("1.5"));
  });

  it("cancels a hire that escrows more than the reservation", async () => {
    const directory = tempDir();
    const market = new FakeMarket();
    market.assignmentAmount = "6";
    const { procurement, budget } = makeProcurement({ market, agents: [candidate], directory });

    await expect(
      procurement.execute({ taskId: "run-1", request, subtask, priorResults: [] }),
    ).rejects.toThrow(/no bids arrived/);
    expect(market.canceled).toBe(true);
    expect(budget.spent).toBe(0n);
  });

  it("refuses to reserve more than the hard budget", async () => {
    const directory = tempDir();
    const market = new FakeMarket();
    const { procurement } = makeProcurement({ market, agents: [candidate], directory, budget: "5" });

    await expect(
      procurement.execute({
        taskId: "run-1",
        request,
        subtask: { ...subtask, maxPriceUsdc: "6" },
        priorResults: [],
      }),
    ).rejects.toThrow(/only 5 USDC/);
  });
});
