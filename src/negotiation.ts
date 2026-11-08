import { formatUsdc, parseUsdc } from "./money.js";
import type { Bid, Subtask } from "./types.js";

export interface CounterOffer {
  bid: Bid;
  targetUsdc: string;
  message: string;
}

export function buildCounterOffer(input: {
  bid: Bid;
  subtask: Subtask;
  targetUsdc: string;
  counterWindowMs: number;
}): CounterOffer {
  const target = parseUsdc(input.targetUsdc);
  const amount = parseUsdc(input.bid.amountUsdc);
  const overBy = amount - target;
  const overPercent = target > 0n ? Number((overBy * 10_000n) / target) / 100 : 0;
  const criteria = input.subtask.acceptanceCriteria.slice(0, 3).join("; ");
  const minutes = Math.max(1, Math.round(input.counterWindowMs / 60_000));
  const message = [
    `Your bid is ${formatUsdc(amount)} USDC; my planned ceiling for this subtask is ${formatUsdc(target)} USDC`,
    `(${formatUsdc(overBy)} USDC, ${overPercent.toFixed(1)}% over).`,
    `The ceiling is set by the scope and acceptance criteria: ${criteria}.`,
    `I can pay ${formatUsdc(target)} USDC and no more.`,
    `If you can deliver at that price, withdraw this bid and submit a revised bid at ${formatUsdc(target)} USDC within ${minutes} minutes.`,
    `This is my only counter. If no revised bid arrives, I will walk away and award elsewhere or do the work myself.`,
  ].join(" ");
  return { bid: input.bid, targetUsdc: formatUsdc(target), message };
}

export function chooseBidWithinBudget(bids: Bid[], maxUsdc: string, excludeHandles: Set<string> = new Set()): Bid | undefined {
  const max = parseUsdc(maxUsdc);
  return bids
    .filter((bid) => bid.status === "pending" && !excludeHandles.has(bid.bidder.handle))
    .filter((bid) => {
      try {
        return parseUsdc(bid.amountUsdc) <= max;
      } catch {
        return false;
      }
    })
    .sort((a, b) => compareBids(a, b))[0];
}

export function cheapestBid(bids: Bid[]): Bid | undefined {
  return bids.filter((bid) => bid.status === "pending").sort((a, b) => compareBids(a, b))[0];
}

function compareBids(a: Bid, b: Bid): number {
  const priceA = parseUsdc(a.amountUsdc);
  const priceB = parseUsdc(b.amountUsdc);
  if (priceA !== priceB) return priceA < priceB ? -1 : 1;
  const repA = a.bidder.reputation ?? a.bidder.successRate ?? 0;
  const repB = b.bidder.reputation ?? b.bidder.successRate ?? 0;
  return repB - repA;
}
