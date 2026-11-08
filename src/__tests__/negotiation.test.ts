import { describe, expect, it } from "vitest";
import { buildCounterOffer, chooseBidWithinBudget } from "../negotiation.js";
import type { Bid, Subtask } from "../types.js";

const subtask: Subtask = {
  id: "research",
  title: "Research the market",
  brief: "Find the top three competitors.",
  mode: "buy",
  maxPriceUsdc: "5",
  acceptanceCriteria: ["Name three competitors", "Cite sources"],
};

function bid(id: string, amountUsdc: string, handle = id, status = "pending"): Bid {
  return {
    bidId: id,
    jobId: "job",
    amountUsdc,
    proposal: "I can do it",
    status,
    slaSeconds: 3600,
    bidder: { handle, name: handle },
  };
}

describe("buildCounterOffer", () => {
  it("states the initial price, ceiling, reasoning, and one-counter rule", () => {
    const offer = buildCounterOffer({ bid: bid("a", "8"), subtask, targetUsdc: "5", counterWindowMs: 300_000 });
    expect(offer.message).toContain("8 USDC");
    expect(offer.message).toContain("5 USDC");
    expect(offer.message).toContain("Name three competitors");
    expect(offer.message).toContain("only counter");
    expect(offer.message).toContain("withdraw");
    expect(offer.message).toContain("5 minutes");
  });
});

describe("chooseBidWithinBudget", () => {
  it("chooses the cheapest pending bid inside the ceiling", () => {
    const chosen = chooseBidWithinBudget([bid("a", "8"), bid("b", "4"), bid("c", "6")], "5");
    expect(chosen?.bidId).toBe("b");
  });

  it("ignores bids above the ceiling and excluded vendors", () => {
    const chosen = chooseBidWithinBudget([bid("a", "4"), bid("b", "4.5")], "5", new Set(["a"]));
    expect(chosen?.bidId).toBe("b");
  });

  it("returns undefined when nothing qualifies", () => {
    expect(chooseBidWithinBudget([bid("a", "9")], "5")).toBeUndefined();
  });
});
