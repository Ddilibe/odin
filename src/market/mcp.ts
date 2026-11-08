import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MarketToolError } from "../errors.js";
import type { WhoamiResponse } from "../responses/whoami.js";
import type { AgentCandidate, Bid, Deliverable, JobStatus } from "../types.js";

interface ToolTextContent {
  type: string;
  text?: string;
}

export class MarketMcpClient {
  private readonly endpoint: string;
  private readonly token: string;
  private client: Client | undefined;
  private transport: StreamableHTTPClientTransport | undefined;

  constructor(baseUrl: string, options: { endpoint: "mcp" | "mcp/pro"; token: string }) {
    this.endpoint = `${baseUrl.replace(/\/+$/, "")}/${options.endpoint}`;
    this.token = options.token;
  }

  async connect(): Promise<void> {
    if (this.client) return;
    this.client = new Client(
      { name: "contractor-agent", version: "0.1.0" },
      { capabilities: {} },
    );
    this.transport = new StreamableHTTPClientTransport(new URL(this.endpoint), {
      requestInit: {
        headers: {
          authorization: `Bearer ${this.token}`,
        },
      },
    });
    await this.client.connect(this.transport);
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
    this.transport = undefined;
  }

  async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
    await this.connect();
    const toolName = name.startsWith("marketplace__") ? name : `marketplace__${name}`;
    const result = await this.client!.callTool({ name: toolName, arguments: args });
    const content = (result.content ?? []) as ToolTextContent[];
    const text = content
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
      .trim();

    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (result.isError) {
      const details = (parsed ?? {}) as { code?: string | number; message?: string; data?: unknown };
      throw new MarketToolError(details.message ?? text ?? `marketplace tool ${name} failed`, {
        tool: toolName,
        code: details.code,
        data: details.data,
        raw: parsed,
      });
    }
    if (parsed !== undefined) return parsed as T;
    if (result.structuredContent !== undefined) return result.structuredContent as T;
    return {} as T;
  }

  async whoami(): Promise<WhoamiResponse | unknown> {
    return this.callTool("whoami", {});
  }

  async balances(): Promise<unknown> {
    const who = await this.whoami();
    if (who && typeof who === "object" && "balances" in who) {
      return (who as WhoamiResponse).balances;
    }
    return who;
  }

  async browseAgents(input: { query?: string; category?: string; limit?: number }): Promise<AgentCandidate[]> {
    const response = await this.callTool<{ agents?: RawMarketAgent[] } | RawMarketAgent[]>("browse_agents", {
      ...(input.query ? { query: input.query } : {}),
      ...(input.category ? { category: input.category } : {}),
      limit: Math.max(1, Math.min(input.limit ?? 12, 50)),
    });
    const agents = Array.isArray(response) ? response : response.agents ?? [];
    return agents.map(normalizeAgent);
  }

  async createJob(input: {
    workerAgentId: string;
    title: string;
    description: string;
    clientRequestId: string;
    token?: "USD" | "USDC";
    acceptanceWindowDays?: number;
  }): Promise<{
    job_id: string;
    assignment_id?: string;
    price?: string;
    amount?: string;
    quoted_price?: string;
    job_url?: string;
    funded?: boolean;
    replayed?: boolean;
  }> {
    return this.callTool("create_job", {
      worker_agent_id: input.workerAgentId,
      title: input.title,
      description: input.description,
      client_request_id: input.clientRequestId,
      token: input.token ?? "USDC",
      ...(input.acceptanceWindowDays ? { acceptance_window_days: input.acceptanceWindowDays } : {}),
    });
  }

  async prepareJob(input: {
    workerAgentId: string;
    title: string;
    description: string;
    clientRequestId: string;
    token?: "USD" | "USDC";
    acceptanceWindowDays?: number;
  }): Promise<{
    draft_id?: string;
    approval_url?: string;
    quoted_price?: string;
    job_id?: string;
    assignment_id?: string;
    funded?: boolean;
    replayed?: boolean;
  }> {
    return this.callTool("prepare_job", {
      worker_agent_id: input.workerAgentId,
      title: input.title,
      description: input.description,
      client_request_id: input.clientRequestId,
      token: input.token ?? "USDC",
      ...(input.acceptanceWindowDays ? { acceptance_window_days: input.acceptanceWindowDays } : {}),
    });
  }

  async postJob(input: {
    title: string;
    description: string;
    budgetAmountUsdc: string;
    token?: "USD" | "USDC";
    tags?: string[];
    acceptanceWindowDays?: number;
  }): Promise<{ job_id: string; status: string }> {
    return this.callTool("post_job", {
      title: input.title,
      description: input.description,
      budget_amount: input.budgetAmountUsdc,
      token: input.token ?? "USDC",
      ...(input.tags ? { tags: input.tags } : {}),
      ...(input.acceptanceWindowDays ? { acceptance_window_days: input.acceptanceWindowDays } : {}),
    });
  }

  async listBids(jobId: string, sort: "price" | "reputation" | "newest" = "price"): Promise<Bid[]> {
    const response = await this.callTool<{ bids?: RawBid[] }>("list_bids", { job_id: jobId, sort });
    return (response.bids ?? []).map(normalizeBid);
  }

  async messageBidder(jobId: string, bidId: string, body: string): Promise<unknown> {
    return this.callTool("message_worker", { job_id: jobId, bid_id: bidId, body });
  }

  async awardBid(jobId: string, bidId: string): Promise<unknown> {
    return this.callTool("award_bid", { job_id: jobId, bid_id: bidId });
  }

  async getJobStatus(jobId: string): Promise<JobStatus> {
    const raw = await this.callTool<RawJobStatus>("get_job_status", { job_id: jobId });
    return normalizeJobStatus(jobId, raw);
  }

  async getJobResult(jobId: string, assignmentId?: string): Promise<Deliverable> {
    let offset: number | undefined;
    let text = "";
    let externalUrl: string | undefined;
    let files: Deliverable["files"];
    for (let page = 0; page < 50; page += 1) {
      const response = await this.callTool<{
        status: string;
        content_chunk?: string;
        next_offset?: number;
        deliverable_url?: string;
        files?: Array<{ file_id: string; filename: string; content_type?: string; byte_size?: number }>;
        note?: string;
      }>("get_job_result", {
        job_id: jobId,
        ...(assignmentId ? { assignment_id: assignmentId } : {}),
        ...(offset !== undefined ? { offset } : {}),
      });
      if (response.status === "external" && response.deliverable_url) {
        externalUrl = response.deliverable_url;
        break;
      }
      if (response.status !== "delivered") {
        throw new Error(`no deliverable available: ${response.note ?? response.status}`);
      }
      text += response.content_chunk ?? "";
      files = response.files?.map((file) => ({
        fileId: file.file_id,
        filename: file.filename,
        contentType: file.content_type,
        byteSize: file.byte_size,
      }));
      if (response.next_offset === undefined) break;
      offset = response.next_offset;
    }
    return { text, files, externalUrl };
  }

  async requestChanges(jobId: string, feedback: string, assignmentId?: string): Promise<unknown> {
    return this.callTool("request_changes", {
      job_id: jobId,
      feedback,
      ...(assignmentId ? { assignment_id: assignmentId } : {}),
    });
  }

  async acceptResult(jobId: string, assignmentId?: string): Promise<unknown> {
    return this.callTool("accept_result", {
      job_id: jobId,
      ...(assignmentId ? { assignment_id: assignmentId } : {}),
    });
  }

  async cancelJob(jobId: string): Promise<unknown> {
    return this.callTool("cancel_job", { job_id: jobId });
  }

  async getDraftStatus(draftId: string): Promise<unknown> {
    return this.callTool("get_draft_status", { draft_id: draftId });
  }
}

interface RawMarketAgent {
  agent_id?: string;
  handle?: string;
  name?: string;
  description?: string | null;
  category?: string;
  price?: string | number | null;
  price_token?: string | null;
  sla_seconds?: number | null;
  delivered_jobs?: number | null;
  success_rate?: number | null;
  payable_with?: string[] | null;
  accepting_work?: boolean | null;
  builder?: { verification?: { level?: string } };
  verification?: { level?: string };
}

function normalizeAgent(agent: RawMarketAgent): AgentCandidate {
  return {
    agentId: agent.agent_id ?? "",
    handle: agent.handle ?? "",
    name: agent.name ?? agent.handle ?? agent.agent_id ?? "",
    description: agent.description ?? "",
    category: agent.category ?? "",
    priceUsdc: agent.price === null || agent.price === undefined ? "0" : String(agent.price),
    slaSeconds: agent.sla_seconds ?? null,
    deliveredJobs: agent.delivered_jobs ?? null,
    successRate: agent.success_rate ?? null,
    payableWith: agent.payable_with ?? [],
    availableNow: agent.price !== null && agent.price !== undefined && agent.accepting_work !== false,
    verification: agent.builder?.verification?.level ?? agent.verification?.level ?? "none",
  };
}

interface RawBid {
  bid_id?: string;
  id?: string;
  job_id?: string;
  amount: string;
  proposal?: string;
  status?: string;
  sla_seconds?: number | null;
  bidder?: {
    handle?: string;
    name?: string;
    agent_id?: string;
    delivered_jobs?: number | null;
    success_rate?: number | null;
    reputation_overall?: number | null;
    builder_verification?: { level?: string };
  };
  agent_id?: string;
  handle?: string;
  name?: string;
}

function normalizeBid(raw: RawBid): Bid {
  return {
    bidId: raw.bid_id ?? raw.id ?? "",
    jobId: raw.job_id ?? "",
    amountUsdc: raw.amount,
    proposal: raw.proposal ?? "",
    status: raw.status ?? "pending",
    slaSeconds: raw.sla_seconds ?? null,
    bidder: {
      handle: raw.bidder?.handle ?? raw.handle ?? "unknown",
      name: raw.bidder?.name ?? raw.name ?? "Unknown",
      agentId: raw.bidder?.agent_id ?? raw.agent_id,
      deliveredJobs: raw.bidder?.delivered_jobs ?? null,
      successRate: raw.bidder?.success_rate ?? null,
      reputation: raw.bidder?.reputation_overall ?? null,
      verification: raw.bidder?.builder_verification?.level ?? "none",
    },
  };
}

interface RawJobStatus {
  status?: string;
  worker_state?: string;
  result_available?: boolean;
  assignments?: Array<{
    assignment_id: string;
    status?: string;
    amount?: string;
    submitted_at?: string | null;
    auto_accept_at?: string | null;
    progress_report?: { message?: string } | null;
  }>;
}

function normalizeJobStatus(jobId: string, raw: RawJobStatus): JobStatus {
  return {
    jobId,
    status: raw.status ?? "unknown",
    workerState: raw.worker_state ?? "unknown",
    resultAvailable: Boolean(raw.result_available),
    assignments: (raw.assignments ?? []).map((assignment) => ({
      assignmentId: assignment.assignment_id,
      status: assignment.status ?? "unknown",
      amountUsdc: assignment.amount,
      submittedAt: assignment.submitted_at ?? null,
      autoAcceptAt: assignment.auto_accept_at ?? null,
      progress: assignment.progress_report?.message ?? null,
    })),
    raw,
  };
}
