import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import type { SelfWorker } from "./check/self-worker.js";
import type { Verifier } from "./check/verifier.js";
import { ContractorError, NoQualifiedBidError, VerificationError } from "./errors.js";
import type { BudgetBook } from "./ledger.js";
import type { MarketGateway, ApprovalGate } from "./market/gateway.js";
import { formatUsdc, parseUsdc } from "./money.js";
import { buildCounterOffer, cheapestBid, chooseBidWithinBudget } from "./negotiation.js";
import type { ReceiptStore } from "./receipts.js";
import type {
  AgentCandidate,
  Bid,
  Deliverable,
  JobStatus,
  NegotiationRecord,
  PaymentRailName,
  Receipt,
  Subtask,
  TaskRequest,
} from "./types.js";
import type { PaymentResolver } from "./payments/router.js";

export interface ProcurementDeps {
  market: MarketGateway;
  marketBaseUrl?: string;
  budget: BudgetBook;
  receipts: ReceiptStore;
  verifier: Verifier;
  selfWorker?: SelfWorker;
  approvalGate: ApprovalGate;
  paymentResolver: PaymentResolver;
  config: Pick<AppConfig, "bidWindowMs" | "counterWindowMs" | "pollMs">;
  log?: (message: string) => void;
}

export interface ProcurementOutcome {
  receipt: Receipt;
  deliverable: Deliverable;
  amountUsdc: string;
}

export class Procurement {
  private readonly deps: ProcurementDeps;

  constructor(deps: ProcurementDeps) {
    this.deps = deps;
  }

  async execute(input: {
    taskId: string;
    request: TaskRequest;
    subtask: Subtask;
    priorResults: string[];
  }): Promise<ProcurementOutcome> {
    const { taskId, request, subtask, priorResults } = input;
    const max = parseUsdc(subtask.maxPriceUsdc);
    this.deps.budget.reserve(subtask.id, max, `reserve for ${subtask.title}`);
    try {
      if (subtask.mode === "self") {
        return await this.doSelf({ taskId, request, subtask, priorResults });
      }
      return await this.buy({ taskId, request, subtask, priorResults });
    } catch (error) {
      this.deps.budget.release(subtask.id, "released after failed subtask");
      throw error;
    }
  }

  private async doSelf(input: {
    taskId: string;
    request: TaskRequest;
    subtask: Subtask;
    priorResults: string[];
  }): Promise<ProcurementOutcome> {
    if (!this.deps.selfWorker) {
      throw new ContractorError(
        "no_self_worker",
        `subtask ${input.subtask.id} was planned as self-work, but no LLM is configured for local execution`,
      );
    }
    this.log(`self: ${input.subtask.title}`);
    const deliverable = await this.deps.selfWorker.work({
      request: input.request,
      subtask: input.subtask,
      priorResults: input.priorResults,
    });
    const checks = await this.deps.verifier.verify(input.subtask, deliverable);
    const now = new Date().toISOString();
    const receipt = this.deps.receipts.create({
      taskId: input.taskId,
      subtaskId: input.subtask.id,
      action: "self",
      vendor: { name: "contractor-agent", handle: "self" },
      amountUsdc: "0",
      currency: "OTHER",
      rail: "none",
      spendingMode: input.request.spendingMode,
      deliverable: { summary: summarize(deliverable.text), sha256: deliverable.sha256 },
      checks,
      status: checks.passed ? "paid" : "failed",
    });
    if (!checks.passed) {
      throw new VerificationError(`self-work for ${input.subtask.id} failed its checks: ${checks.reasons.join("; ")}`, {
        receiptId: receipt.id,
      });
    }
    this.deps.budget.release(input.subtask.id, "self-work billed at zero");
    this.log(`self: ${input.subtask.title} passed (${checks.score}/100)`);
    return { receipt, deliverable, amountUsdc: "0" };
  }

  private async buy(input: {
    taskId: string;
    request: TaskRequest;
    subtask: Subtask;
    priorResults: string[];
  }): Promise<ProcurementOutcome> {
    const { taskId, request, subtask, priorResults } = input;
    const max = parseUsdc(subtask.maxPriceUsdc);
    const marketToken = await this.deps.paymentResolver.resolveMarketplaceRail({ request, subtask });
    const candidates = await this.discoverCandidates(subtask);
    const withinBudget = candidates.filter((candidate) => {
      try {
        return parseUsdc(candidate.priceUsdc) <= max;
      } catch {
        return false;
      }
    });
    const direct = withinBudget[0];

    if (direct) {
      this.log(`buy: direct hire ${direct.handle} at ${direct.priceUsdc} USDC`);
      try {
        return await this.hireDirect({ taskId, request, subtask, candidate: direct, token: marketToken });
      } catch (error) {
        if (error instanceof ContractorError && (error.details as { committed?: boolean } | undefined)?.committed) {
          throw error;
        }
        this.log(`buy: direct hire failed (${errorMessage(error)}); falling back to the job board`);
      }
    }

    return this.postJobAndNegotiate({ taskId, request, subtask, token: marketToken, priorResults });
  }

  private async discoverCandidates(subtask: Subtask): Promise<AgentCandidate[]> {
    const query = `${subtask.title} ${subtask.brief}`.replace(/\s+/g, " ").slice(0, 180);
    let agents: AgentCandidate[];
    try {
      agents = await this.deps.market.browseAgents({ query, category: subtask.category, limit: 10 });
    } catch (error) {
      if (!subtask.category) throw error;
      this.log(`market: category browse failed (${errorMessage(error)}); retrying without a category filter`);
      agents = await this.deps.market.browseAgents({ query, limit: 10 });
    }
    const enriched = agents
      .filter((agent) => agent.agentId && agent.handle)
      .filter((agent) => agent.priceUsdc !== "0" && agent.payableWith.includes("USDC"))
      .slice(0, 8);
    return enriched.sort((a, b) => {
      const available = Number(b.availableNow) - Number(a.availableNow);
      if (available !== 0) return available;
      const success = (b.successRate ?? 0) - (a.successRate ?? 0);
      if (success !== 0) return success;
      const delivered = (b.deliveredJobs ?? 0) - (a.deliveredJobs ?? 0);
      if (delivered !== 0) return delivered;
      return Number(parseUsdc(a.priceUsdc) - parseUsdc(b.priceUsdc));
    });
  }

  private async hireDirect(input: {
    taskId: string;
    request: TaskRequest;
    subtask: Subtask;
    candidate: AgentCandidate;
    token: "USD" | "USDC";
  }): Promise<ProcurementOutcome> {
    const { taskId, request, subtask, candidate, token } = input;
    const clientRequestId = randomUUID();
    const brief = buildBrief(subtask);
    let jobId: string | undefined;
    let assignmentId: string | undefined;
    let amountUsdc = candidate.priceUsdc;
    let receipt: Receipt | undefined;
    let settled = false;

    try {
      if (request.spendingMode === "autonomous") {
        const hired = await this.deps.market.createJob({
          workerAgentId: candidate.agentId,
          title: subtask.title,
          description: brief,
          clientRequestId,
          token,
          acceptanceWindowDays: request.acceptanceWindowDays,
        });
        if (hired.funded === false) {
          throw new ContractorError("hire_not_funded", `create_job did not fund the hire with ${candidate.handle}`);
        }
        jobId = hired.job_id;
        assignmentId = hired.assignment_id;
        amountUsdc = hired.price ?? hired.quoted_price ?? hired.amount ?? candidate.priceUsdc;
        receipt = this.createMarketReceipt({
          taskId,
          request,
          subtask,
          action: "market_hire",
          vendor: { name: candidate.name, handle: candidate.handle, agentId: candidate.agentId },
          amountUsdc,
          rail: token === "USD" ? "market_usd" : "market_usdc",
          status: "pending",
          jobId,
          assignmentId,
          paymentStatus: "held",
        });
        this.log(`market: hired ${candidate.handle} for ${amountUsdc} USDC (job ${jobId})`);
      } else {
        const draft = await this.deps.market.prepareJob({
          workerAgentId: candidate.agentId,
          title: subtask.title,
          description: brief,
          clientRequestId,
          token,
          acceptanceWindowDays: request.acceptanceWindowDays,
        });
        if (!draft.approval_url) throw new ContractorError("approval_link_missing", "prepare_job returned no approval_url");
        await this.deps.approvalGate.waitForApproval({
          action: `Hire ${candidate.handle} for ${draft.quoted_price ?? candidate.priceUsdc} USDC`,
          url: draft.approval_url,
          amountUsdc: draft.quoted_price ?? candidate.priceUsdc,
          vendor: candidate.handle,
        });
        const approved = await this.deps.market.prepareJob({
          workerAgentId: candidate.agentId,
          title: subtask.title,
          description: brief,
          clientRequestId,
          token,
          acceptanceWindowDays: request.acceptanceWindowDays,
        });
        if (approved.funded === false) {
          throw new ContractorError("hire_not_funded", `the approved draft for ${candidate.handle} was not funded`);
        }
        const resolvedJobId = approved.job_id ?? (await this.waitForDraftJob(approved.draft_id ?? draft.draft_id));
        if (!resolvedJobId) throw new ContractorError("missing_job_id", "the approved draft did not produce a job");
        jobId = resolvedJobId;
        assignmentId = approved.assignment_id;
        amountUsdc = approved.quoted_price ?? draft.quoted_price ?? candidate.priceUsdc;
        receipt = this.createMarketReceipt({
          taskId,
          request,
          subtask,
          action: "market_hire",
          vendor: { name: candidate.name, handle: candidate.handle, agentId: candidate.agentId },
          amountUsdc,
          rail: token === "USD" ? "market_usd" : "market_usdc",
          status: "pending",
          jobId,
          assignmentId,
          paymentStatus: "held",
        });
        this.log(`market: approved hire of ${candidate.handle} for ${amountUsdc} USDC (job ${jobId})`);
      }

      if (!jobId) throw new ContractorError("missing_job_id", "market hire did not return a job id");
      const fundedAssignment = await this.readFundedAssignment(jobId, assignmentId);
      if (fundedAssignment) {
        assignmentId = fundedAssignment.assignmentId;
        amountUsdc = fundedAssignment.amountUsdc;
      }
      const amount = parseUsdc(amountUsdc);
      this.ensureWithinReservation(subtask, amount);
      this.deps.budget.settle(subtask.id, amount, `escrow ${candidate.handle}`);
      settled = true;
      this.deps.receipts.update(receipt.id, {
        marketplace: { jobId, assignmentId },
        payment: { status: "held" },
      });
    } catch (error) {
      if (jobId && !settled) {
        const canceled = await this.tryCancelJob(jobId);
        if (receipt) {
          this.deps.receipts.update(receipt.id, {
            status: canceled ? "refunded" : "failed",
            payment: {
              status: canceled ? "refunded" : "failed",
              reference: canceled ? "the hire was cancelled before settlement" : "the hire could not be cancelled; check the job page",
            },
          });
        }
      }
      if (settled) {
        throw new ContractorError("direct_hire_committed", errorMessage(error), { committed: true, cause: error });
      }
      throw error;
    }

    if (!jobId || !receipt) throw new ContractorError("missing_job_id", "market hire completed without a job or receipt");
    try {
      return await this.finishMarketJob({
        taskId,
        request,
        subtask,
        receiptId: receipt.id,
        jobId,
        assignmentId,
        amountUsdc,
        slaSeconds: candidate.slaSeconds,
      });
    } catch (error) {
      throw new ContractorError("direct_hire_committed", errorMessage(error), { committed: true, cause: error });
    }
  }

  private async postJobAndNegotiate(input: {
    taskId: string;
    request: TaskRequest;
    subtask: Subtask;
    token: "USD" | "USDC";
    priorResults: string[];
  }): Promise<ProcurementOutcome> {
    const { taskId, request, subtask, token, priorResults } = input;
    const max = parseUsdc(subtask.maxPriceUsdc);
    const posted = await this.deps.market.postJob({
      title: subtask.title,
      description: buildBrief(subtask),
      budgetAmountUsdc: subtask.maxPriceUsdc,
      token,
      tags: subtask.category ? [subtask.category] : undefined,
      acceptanceWindowDays: request.acceptanceWindowDays,
    });
    const jobId = posted.job_id;
    this.log(`market: posted job ${jobId} with a ${subtask.maxPriceUsdc} USDC budget guide`);
    this.deps.budget.release(subtask.id, "job posting reserves no funds");

    const bidWindowMs = request.bidWindowMs ?? this.deps.config.bidWindowMs;
    const bids = await this.waitForBids(jobId, bidWindowMs);
    let chosen = chooseBidWithinBudget(bids, subtask.maxPriceUsdc);
    let negotiation: NegotiationRecord = { countered: false, outcome: "not_needed" };

    if (!chosen) {
      const candidateBid = cheapestBid(bids);
      if (!candidateBid) {
        this.log("market: no bids arrived; cancelling the posting");
        await this.tryCancelJob(jobId);
        return this.fallbackOrThrow(taskId, request, subtask, "no bids arrived", priorResults);
      }

      const counter = buildCounterOffer({
        bid: candidateBid,
        subtask,
        targetUsdc: subtask.maxPriceUsdc,
        counterWindowMs: request.counterWindowMs ?? this.deps.config.counterWindowMs,
      });
      this.log(`negotiation: countering ${candidateBid.bidder.handle} once at ${counter.targetUsdc} USDC`);
      await this.deps.market.messageBidder(jobId, candidateBid.bidId, counter.message);
      negotiation = {
        countered: true,
        initialAmountUsdc: candidateBid.amountUsdc,
        targetAmountUsdc: counter.targetUsdc,
        outcome: "walked_away",
        message: counter.message,
      };
      const revised = await this.waitForRevisedBid({
        jobId,
        bidderHandle: candidateBid.bidder.handle,
        originalBidId: candidateBid.bidId,
        targetUsdc: counter.targetUsdc,
        timeoutMs: request.counterWindowMs ?? this.deps.config.counterWindowMs,
      });
      if (revised) {
        chosen = revised;
        negotiation.revisedAmountUsdc = revised.amountUsdc;
        negotiation.outcome = "revised";
        this.log(`negotiation: ${revised.bidder.handle} revised to ${revised.amountUsdc} USDC`);
      } else {
        const alternative = chooseBidWithinBudget(bids, subtask.maxPriceUsdc, new Set([candidateBid.bidder.handle]));
        if (alternative) {
          chosen = alternative;
          this.log(`negotiation: walking away from ${candidateBid.bidder.handle}; awarding ${alternative.bidder.handle}`);
        } else {
          this.log(`negotiation: walking away from ${candidateBid.bidder.handle}; no bid inside budget`);
          await this.tryCancelJob(jobId);
          return this.fallbackOrThrow(
            taskId,
            request,
            subtask,
            "a counter was sent but no revised bid arrived inside budget",
            priorResults,
            negotiation,
          );
        }
      }
    }

    const amount = parseUsdc(chosen.amountUsdc);
    if (amount > max) throw new NoQualifiedBidError(`selected bid ${chosen.amountUsdc} exceeds ${subtask.maxPriceUsdc}`);
    this.deps.budget.reserve(subtask.id, max, "re-reserve before award");
    let settled = false;
    let assignmentId: string | undefined;
    try {
      const awarded = await this.deps.market.awardBid(jobId, chosen.bidId);
      if (request.spendingMode === "approval") {
        const url = extractUrl(awarded) ?? `${this.deps.marketBaseUrl ?? "https://market.near.ai"}/jobs/${jobId}`;
        await this.deps.approvalGate.waitForApproval({
          action: `Award ${chosen.bidder.handle} at ${chosen.amountUsdc} USDC`,
          url,
          amountUsdc: chosen.amountUsdc,
          vendor: chosen.bidder.handle,
        });
      }
      assignmentId =
        extractId(awarded, ["assignment_id", "assignmentId"]) ?? (await this.waitForAssignment(jobId));
      if (!assignmentId) {
        throw new ContractorError("assignment_missing", `job ${jobId} has no assignment after the award`);
      }
      this.deps.budget.settle(subtask.id, amount, `award ${chosen.bidder.handle}`);
      settled = true;
    } catch (error) {
      if (!settled) await this.tryCancelJob(jobId);
      throw error;
    }
    const receipt = this.createMarketReceipt({
      taskId,
      request,
      subtask,
      action: "market_job_award",
      vendor: { name: chosen.bidder.name, handle: chosen.bidder.handle, agentId: chosen.bidder.agentId },
      amountUsdc: chosen.amountUsdc,
      rail: token === "USD" ? "market_usd" : "market_usdc",
      status: "pending",
      jobId,
      assignmentId,
      bidId: chosen.bidId,
      paymentStatus: "held",
      negotiation,
    });
    this.log(`market: awarded ${chosen.bidder.handle} at ${chosen.amountUsdc} USDC (job ${jobId})`);
    return this.finishMarketJob({
      taskId,
      request,
      subtask,
      receiptId: receipt.id,
      jobId,
      assignmentId,
      amountUsdc: chosen.amountUsdc,
      slaSeconds: chosen.slaSeconds,
    });
  }

  private async waitForBids(jobId: string, timeoutMs: number): Promise<Bid[]> {
    const deadline = Date.now() + timeoutMs;
    let last: Bid[] = [];
    do {
      last = await this.deps.market.listBids(jobId, "price");
      if (last.some((bid) => bid.status === "pending")) return last;
      if (Date.now() >= deadline) return last;
      await sleep(Math.min(this.deps.config.pollMs, Math.max(250, deadline - Date.now())));
    } while (Date.now() < deadline);
    return last;
  }

  private async waitForRevisedBid(input: {
    jobId: string;
    bidderHandle: string;
    originalBidId: string;
    targetUsdc: string;
    timeoutMs: number;
  }): Promise<Bid | undefined> {
    const deadline = Date.now() + input.timeoutMs;
    do {
      const bids = await this.deps.market.listBids(input.jobId, "price");
      const revised = bids.find(
        (bid) =>
          bid.bidder.handle === input.bidderHandle &&
          bid.bidId !== input.originalBidId &&
          bid.status === "pending" &&
          parseUsdc(bid.amountUsdc) <= parseUsdc(input.targetUsdc),
      );
      if (revised) return revised;
      if (Date.now() >= deadline) return undefined;
      await sleep(Math.min(this.deps.config.pollMs, Math.max(250, deadline - Date.now())));
    } while (Date.now() < deadline);
    return undefined;
  }

  private async finishMarketJob(input: {
    taskId: string;
    request: TaskRequest;
    subtask: Subtask;
    receiptId: string;
    jobId: string;
    assignmentId?: string;
    amountUsdc: string;
    slaSeconds?: number | null;
  }): Promise<ProcurementOutcome> {
    const { taskId, request, subtask, receiptId, jobId } = input;
    let assignmentId = input.assignmentId;
    try {
      const deliverable = await this.waitForDeliverable(jobId, input.amountUsdc, false, input.slaSeconds);
      let checks = await this.deps.verifier.verify(subtask, deliverable);
      this.deps.receipts.update(receiptId, {
        deliverable: { summary: summarize(deliverable.text), sha256: deliverable.sha256, files: deliverable.files, url: deliverable.externalUrl },
        checks,
      });

      if (!checks.passed) {
        this.log(`check: ${subtask.id} failed; requesting one change round`);
        const feedback = [...checks.reasons, ...checks.requiredFixes].filter(Boolean).join("\n") || "The delivery does not meet the brief.";
        await this.deps.market.requestChanges(jobId, feedback, assignmentId);
        const revised = await this.waitForDeliverable(jobId, input.amountUsdc, true, input.slaSeconds);
        checks = await this.deps.verifier.verify(subtask, revised);
        this.deps.receipts.update(receiptId, {
          deliverable: { summary: summarize(revised.text), sha256: revised.sha256, files: revised.files, url: revised.externalUrl },
          checks,
        });
        if (!checks.passed) {
          this.deps.receipts.update(receiptId, {
            status: "failed",
            payment: { status: "held", reference: "delivery failed checks after one change round; open a dispute in the marketplace" },
          });
          throw new VerificationError(
            `${subtask.id} failed its checks after one change round; money remains held and a dispute is needed`,
            { receiptId, jobId, checks },
          );
        }
      }

      await this.acceptAndConfirm({
        request,
        subtask,
        jobId,
        assignmentId,
        amountUsdc: input.amountUsdc,
      });
      this.deps.receipts.update(receiptId, {
        status: "paid",
        payment: { status: "released" },
      });
      this.log(`check: ${subtask.id} passed (${checks.score}/100); payment released`);
      return {
        receipt: this.deps.receipts.list().find((receipt) => receipt.id === receiptId)!,
        deliverable,
        amountUsdc: input.amountUsdc,
      };
    } catch (error) {
      const receipt = this.deps.receipts.list().find((entry) => entry.id === receiptId);
      if (receipt && receipt.status === "pending") {
        const refund = isRefundError(error);
        this.deps.receipts.update(receiptId, {
          status: refund ? "refunded" : "failed",
          payment: { status: refund ? "refunded" : "held" },
          checks: receipt.checks,
        });
        if (refund) this.deps.budget.refund(subtask.id, parseUsdc(input.amountUsdc), "marketplace refund");
      }
      throw error;
    }
  }

  private async waitForDeliverable(
    jobId: string,
    amountUsdc: string,
    isRevision = false,
    slaSeconds?: number | null,
  ): Promise<Deliverable> {
    const started = Date.now();
    const slaMs = slaSeconds && slaSeconds > 0 ? slaSeconds * 1_000 : 30 * 60_000;
    const maxWaitMs = Math.min(slaMs + 10 * 60_000, 7 * 24 * 60 * 60_000);
    while (Date.now() - started < maxWaitMs) {
      const status = await this.deps.market.getJobStatus(jobId);
      if (status.resultAvailable) {
        try {
          return await this.deps.market.getJobResult(jobId, status.assignments[0]?.assignmentId);
        } catch (error) {
          if (isRevision && Date.now() - started < this.deps.config.pollMs * 2) {
            await sleep(this.deps.config.pollMs);
            continue;
          }
          throw error;
        }
      }
      if (status.status === "cancelled" || status.status === "closed") {
        throw new ContractorError("job_cancelled", `job ${jobId} ended without a deliverable`, { refund: amountUsdc });
      }
      const assignment = status.assignments[0];
      if (assignment && ["cancelled", "refunded", "failed"].includes(assignment.status)) {
        throw new ContractorError("assignment_cancelled", `assignment on job ${jobId} was ${assignment.status}`, { refund: amountUsdc });
      }
      await sleep(this.deps.config.pollMs);
    }
    throw new ContractorError("delivery_timeout", `job ${jobId} did not deliver before the wait limit`);
  }

  private async acceptAndConfirm(input: {
    request: TaskRequest;
    subtask: Subtask;
    jobId: string;
    assignmentId?: string;
    amountUsdc: string;
  }): Promise<void> {
    const result = await this.deps.market.acceptResult(input.jobId, input.assignmentId);
    if (input.request.spendingMode === "approval") {
      const url = extractUrl(result);
      if (!url) throw new ContractorError("approval_link_missing", "accept_result returned no approval URL");
      await this.deps.approvalGate.waitForApproval({
        action: `Accept the deliverable for ${input.subtask.id} and release ${input.amountUsdc} USDC`,
        url,
        amountUsdc: input.amountUsdc,
      });
    }
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      const status = await this.deps.market.getJobStatus(input.jobId);
      if (status.status === "completed") return;
      if (status.status === "closed") throw new ContractorError("job_closed_before_acceptance", `job ${input.jobId} closed before acceptance`);
      await sleep(Math.min(this.deps.config.pollMs, 5_000));
    }
    throw new ContractorError(
      "acceptance_not_confirmed",
      `acceptance for job ${input.jobId} was not confirmed; check the job page before treating this as paid`,
    );
  }

  private async fallbackOrThrow(
    taskId: string,
    request: TaskRequest,
    subtask: Subtask,
    reason: string,
    priorResults: string[],
    negotiation?: NegotiationRecord,
  ): Promise<ProcurementOutcome> {
    if (negotiation) {
      const receipt = this.deps.receipts.create({
        taskId,
        subtaskId: subtask.id,
        action: "market_job_award",
        vendor: { name: "none", handle: "none" },
        amountUsdc: "0",
        currency: "USDC",
        rail: "market_usdc",
        spendingMode: request.spendingMode,
        negotiation,
        status: "failed",
        payment: { status: "failed", reference: reason },
      });
      this.deps.receipts.update(receipt.id, { status: "failed" });
    }
    this.deps.budget.release(subtask.id, `no purchase: ${reason}`);
    if (this.deps.selfWorker) {
      this.log(`fallback: doing ${subtask.title} locally because ${reason}`);
      return this.doSelf({ taskId, request, subtask, priorResults });
    }
    throw new NoQualifiedBidError(`could not buy ${subtask.id}: ${reason}`);
  }

  private async tryCancelJob(jobId: string): Promise<boolean> {
    try {
      const result = await this.deps.market.cancelJob(jobId);
      const url = extractUrl(result);
      if (url) {
        this.log(`market: cancellation for job ${jobId} needs approval: ${url}`);
        return false;
      }
      return true;
    } catch (error) {
      this.log(`market: could not cancel job ${jobId}: ${errorMessage(error)}`);
      return false;
    }
  }

  private async waitForDraftJob(draftId?: string): Promise<string | undefined> {
    if (!draftId) return undefined;
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      const status = await this.deps.market.getDraftStatus(draftId);
      const jobId = extractId(status, ["job_id", "jobId"]);
      if (jobId) return jobId;
      await sleep(Math.min(this.deps.config.pollMs, 5_000));
    }
    return undefined;
  }

  private async waitForAssignment(jobId: string): Promise<string | undefined> {
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      const status: JobStatus = await this.deps.market.getJobStatus(jobId);
      const assignmentId = status.assignments[0]?.assignmentId;
      if (assignmentId) return assignmentId;
      await sleep(Math.min(this.deps.config.pollMs, 5_000));
    }
    return undefined;
  }

  private async readFundedAssignment(
    jobId: string,
    assignmentId?: string,
  ): Promise<{ assignmentId: string; amountUsdc: string } | undefined> {
    try {
      const status = await this.deps.market.getJobStatus(jobId);
      const assignment = assignmentId
        ? status.assignments.find((row) => row.assignmentId === assignmentId)
        : status.assignments[0];
      if (assignment?.amountUsdc) {
        return { assignmentId: assignment.assignmentId, amountUsdc: assignment.amountUsdc };
      }
    } catch {
      // the hire is already confirmed; the caller falls back to the listed price
    }
    return undefined;
  }

  private ensureWithinReservation(subtask: Subtask, amount: bigint): void {
    if (amount > parseUsdc(subtask.maxPriceUsdc)) {
      throw new ContractorError(
        "price_above_plan",
        `${subtask.id} was quoted ${formatUsdc(amount)} USDC, above the planned ${subtask.maxPriceUsdc} USDC`,
      );
    }
  }

  private createMarketReceipt(input: {
    taskId: string;
    request: TaskRequest;
    subtask: Subtask;
    action: Receipt["action"];
    vendor: Receipt["vendor"];
    amountUsdc: string;
    rail: PaymentRailName;
    status: Receipt["status"];
    jobId: string;
    assignmentId?: string;
    bidId?: string;
    paymentStatus: Receipt["payment"] extends infer _ ? "pending" | "held" | "released" | "refunded" | "failed" : never;
    negotiation?: NegotiationRecord;
  }): Receipt {
    const now = new Date().toISOString();
    return this.deps.receipts.create({
      taskId: input.taskId,
      subtaskId: input.subtask.id,
      action: input.action,
      vendor: input.vendor,
      amountUsdc: input.amountUsdc,
      currency: "USDC",
      rail: input.rail,
      spendingMode: input.request.spendingMode,
      marketplace: {
        jobId: input.jobId,
        assignmentId: input.assignmentId,
        bidId: input.bidId,
      },
      payment: { status: input.paymentStatus },
      negotiation: input.negotiation,
      status: input.status,
    });
  }

  private log(message: string): void {
    this.deps.log?.(message);
  }
}

function buildBrief(subtask: Subtask): string {
  return `${subtask.brief}

Deliverable requirements:
${subtask.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}

Return the completed work. If a requirement is ambiguous, state the assumption you made and continue.`;
}

function summarize(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 500 ? `${oneLine.slice(0, 497)}...` : oneLine;
}

function extractId(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate) return candidate;
  }
  for (const key of ["job", "assignment", "data", "result"]) {
    const nested = record[key];
    if (nested && typeof nested === "object") {
      const found = extractId(nested, keys);
      if (found) return found;
    }
  }
  return undefined;
}

function extractUrl(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["job_url", "approval_url", "url"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return undefined;
}

function isRefundError(error: unknown): boolean {
  if (!(error instanceof ContractorError)) return false;
  return ["job_cancelled", "assignment_cancelled"].includes(error.code);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
