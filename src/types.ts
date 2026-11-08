export type SpendingMode = "autonomous" | "approval";

export type PaymentPreference = "auto" | "usdc" | "near" | "near_intents";

export type PaymentRailName =
  | "none"
  | "market_usdc"
  | "market_usd"
  | "x402_usdc_near"
  | "near_native"
  | "near_intents";

export type SubtaskMode = "self" | "buy";

export interface PaymentDetails {
  rail?: PaymentRailName;
  asset?: string;
  network?: string;
  recipient?: string;
  originAsset?: string;
  destinationAsset?: string;
  slippageBps?: number;
}

export interface TaskRequest {
  objective: string;
  budgetUsdc: string;
  spendingMode: SpendingMode;
  paymentPreference: PaymentPreference;
  paymentDetails?: PaymentDetails;
  deadline?: string;
  qualityBar?: string;
  allowedCategories?: string[];
  maxPricePerSubtaskUsdc?: string;
  bidWindowMs?: number;
  counterWindowMs?: number;
  pollMs?: number;
  acceptanceWindowDays?: number;
  autoAcceptLimitUsdc?: string;
  allowPublicJobs?: boolean;
  useX402ForData?: boolean;
}

export interface Subtask {
  id: string;
  title: string;
  brief: string;
  mode: SubtaskMode;
  category?: string;
  maxPriceUsdc: string;
  acceptanceCriteria: string[];
  dependsOn?: string[];
  paymentPreference?: PaymentPreference;
}

export interface Plan {
  summary: string;
  subtasks: Subtask[];
}

export interface AgentCandidate {
  agentId: string;
  handle: string;
  name: string;
  description: string;
  category: string;
  priceUsdc: string;
  slaSeconds: number | null;
  deliveredJobs: number | null;
  successRate: number | null;
  payableWith: string[];
  availableNow: boolean;
  verification: string;
}

export interface Bid {
  bidId: string;
  jobId: string;
  amountUsdc: string;
  proposal: string;
  status: string;
  slaSeconds: number | null;
  bidder: {
    handle: string;
    name: string;
    agentId?: string;
    deliveredJobs?: number | null;
    successRate?: number | null;
    reputation?: number | null;
    verification?: string;
  };
}

export interface JobStatus {
  jobId: string;
  status: string;
  workerState: string;
  resultAvailable: boolean;
  assignments: Array<{
    assignmentId: string;
    status: string;
    amountUsdc?: string;
    submittedAt?: string | null;
    autoAcceptAt?: string | null;
    progress?: string | null;
  }>;
  raw: unknown;
}

export interface Deliverable {
  text: string;
  files?: Array<{ fileId: string; filename: string; contentType?: string; byteSize?: number }>;
  externalUrl?: string;
  sha256?: string;
}

export interface CheckResult {
  passed: boolean;
  score: number;
  reasons: string[];
  requiredFixes: string[];
  deterministic: Record<string, boolean>;
}

export interface NegotiationRecord {
  countered: boolean;
  initialAmountUsdc?: string;
  targetAmountUsdc?: string;
  revisedAmountUsdc?: string;
  outcome: "not_needed" | "accepted" | "revised" | "walked_away" | "failed";
  message?: string;
}

export interface Receipt {
  id: string;
  taskId: string;
  subtaskId: string;
  action: "self" | "market_hire" | "market_job_award" | "x402_purchase" | "near_transfer" | "near_intents";
  vendor: {
    name: string;
    handle?: string;
    agentId?: string;
    accountId?: string;
  };
  amountUsdc?: string;
  amountNative?: string;
  currency: "USDC" | "USD" | "NEAR" | "OTHER";
  rail: PaymentRailName;
  spendingMode: SpendingMode;
  marketplace?: {
    jobId?: string;
    assignmentId?: string;
    bidId?: string;
    draftId?: string;
    taskId?: string;
  };
  payment?: {
    txHash?: string;
    depositAddress?: string;
    status: "pending" | "held" | "released" | "refunded" | "failed";
    reference?: string;
  };
  deliverable?: {
    summary: string;
    sha256?: string;
    url?: string;
    files?: Array<{ fileId: string; filename: string }>;
  };
  negotiation?: NegotiationRecord;
  checks?: CheckResult;
  status: "pending" | "paid" | "refunded" | "failed";
  createdAt: string;
  updatedAt: string;
}

export interface RunReport {
  runId: string;
  objective: string;
  budgetUsdc: string;
  spendingMode: SpendingMode;
  paymentPreference: PaymentPreference;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "completed" | "failed" | "stopped";
  plan?: Plan;
  receipts: string[];
  spentUsdc: string;
  reservedUsdc: string;
  remainingUsdc: string;
  notes: string[];
}
