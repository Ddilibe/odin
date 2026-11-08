import type { Bid, Deliverable, JobStatus } from "../types.js";
import type { MarketMcpClient } from "./mcp.js";

export type MarketGateway = Pick<
  MarketMcpClient,
  | "browseAgents"
  | "createJob"
  | "prepareJob"
  | "postJob"
  | "listBids"
  | "messageBidder"
  | "awardBid"
  | "getJobStatus"
  | "getJobResult"
  | "requestChanges"
  | "acceptResult"
  | "cancelJob"
  | "getDraftStatus"
>;

export interface ApprovalRequest {
  action: string;
  url: string;
  amountUsdc?: string;
  vendor?: string;
}

export interface ApprovalGate {
  waitForApproval(request: ApprovalRequest): Promise<void>;
}

export interface HireResult {
  jobId: string;
  assignmentId?: string;
  amountUsdc: string;
  bid?: Bid;
  deliverable: Deliverable;
  negotiation?: import("../types.js").NegotiationRecord;
}

export type { Bid, Deliverable, JobStatus };
