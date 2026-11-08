#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { ContractorAgent } from "./agent.js";
import { LlmJudge, Verifier } from "./check/verifier.js";
import { LlmSelfWorker } from "./check/self-worker.js";
import { loadConfig, type AppConfig } from "./config.js";
import { ApprovalRequiredError, ContractorError } from "./errors.js";
import { BudgetBook } from "./ledger.js";
import { OpenAiCompatibleLlm, GoogleCompatibleLlm } from "./llm.js";
import { MarketAuth } from "./market/auth.js";
import type { ApprovalRequest, ApprovalGate } from "./market/gateway.js";
import { MarketMcpClient } from "./market/mcp.js";
import { parseNear, parseUsdc, formatUsdc } from "./money.js";
import { NearIntentsClient } from "./payments/near-intents.js";
import { NearWallet } from "./payments/near-wallet.js";
import { DefaultPaymentResolver } from "./payments/router.js";
import { X402Client } from "./payments/x402.js";
import { HeuristicPlanner, LlmPlanner } from "./planner.js";
import { Procurement } from "./procurement.js";
import { ReceiptStore } from "./receipts.js";
import { contractorHome, ensureDir, runDir } from "./storage.js";
import type { PaymentDetails, PaymentPreference, RunReport, SpendingMode, TaskRequest } from "./types.js";

const HELP = `contractor-agent - budget-bound general contractor for NEAR AI Agent Market

Usage:
  contractor-agent <command> [options]

Commands:
  run --task "..." --budget 10 [options]   Plan, source, verify, and pay for a task
  login                                    Log in to Agent Market with OAuth
  whoami                                   Show the Agent Market identity
  balance                                  Show the Agent Market wallet balance
  receipts [--run <id>] [--json]           Show receipts for a run
  data --handle <agent> --task "..." --max-usdc 1
                                           Buy data through x402 with USDC on NEAR
  pay-intents --to <account> --amount 1 --dest <asset>
                                           Swap NEAR through NEAR Intents
  pay-near --to <account> --amount 1       Send native NEAR from the hot wallet

Run options:
  --task "..."              Objective (required unless --task-file)
  --task-file <path>        Read the objective from a file
  --budget <usdc>           Hard budget ceiling in USDC (required)
  --mode <autonomous|approval>
                            autonomous: /mcp/pro spends in-call
                            approval:   /mcp returns links you approve
  --pay <auto|usdc|near|near_intents>
                            Payment preference; marketplace jobs settle in USDC
  --quality "..."           Quality bar passed to the planner
  --category <name>         Allowed marketplace category (repeatable)
  --max-subtask <usdc>      Per-subtask price ceiling
  --bid-window <seconds>    How long to wait for job bids
  --counter-window <secs>   How long to wait after one counteroffer
  --poll <seconds>          Marketplace polling interval
  --deadline <iso-date>     Stop starting new work after this time
  --accept-after <days>     Marketplace acceptance window
  --yes                     Non-interactive approval waits; still requires clicking the link

Environment:
  LLM_API_KEY, MARKET_MCP_TOKEN, MARKET_MCP_PRO_TOKEN, NEAR_ACCOUNT_ID,
  NEAR_PRIVATE_KEY, NEAR_INTENTS_API_KEY. See .env.example.
`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = new Args(rest);
  if (!command || command === "help" || args.has("help")) {
    console.log(HELP);
    return;
  }
  const config = loadConfig();
  switch (command) {
    case "run":
      await commandRun(args, config);
      return;
    case "login":
      await commandLogin(config);
      return;
    case "whoami":
      await commandWhoami(config);
      return;
    case "balance":
      await commandBalance(config);
      return;
    case "receipts":
      commandReceipts(args);
      return;
    case "data":
      await commandData(args, config);
      return;
    case "pay-near":
      await commandPayNear(args, config);
      return;
    case "pay-intents":
      await commandPayIntents(args, config);
      return;
    default:
      throw new ContractorError("unknown_command", `unknown command: ${command}\n\n${HELP}`);
  }
}

async function commandRun(args: Args, config: AppConfig): Promise<void> {
  const objective = args.string("task") ?? (args.string("task-file") ? readFileSync(args.string("task-file")!, "utf8").trim() : undefined);
  if (!objective) throw new ContractorError("missing_task", "run requires --task or --task-file");
  const budget = args.string("budget");
  if (!budget) throw new ContractorError("missing_budget", "run requires --budget in USDC");
  parseUsdc(budget);

  const mode = await resolveMode(args);
  const paymentPreference = await resolvePaymentPreference(args);
  const paymentDetails = paymentPreference === "auto" || paymentPreference === "usdc"
    ? undefined
    : await resolvePaymentDetails(paymentPreference, args);
  if (paymentPreference === "near" || paymentPreference === "near_intents") {
    console.error(
      "[contractor] Marketplace jobs settle in USDC escrow. The NEAR preference applies to x402 data buys and off-market transfers; this run uses USDC for marketplace awards.",
    );
  }

  const auth = await marketAccessToken(config, mode);
  const market = new MarketMcpClient(config.marketBaseUrl, {
    endpoint: mode === "autonomous" ? "mcp/pro" : "mcp",
    token: auth,
  });
  const runId = `${timestampId()}-${randomUUID().slice(0, 6)}`;
  const directory = runDir(runId);
  ensureDir(directory);

  const llm = config.llmApiKey
    ? new OpenAiCompatibleLlm({ baseUrl: config.llmBaseUrl, apiKey: config.llmApiKey, model: config.llmModel })
    : new GoogleCompatibleLlm({baseUrl:config.googlebaseurl, apiKey:config.googleapikey, model:config.googlemodel});
  const planner = llm ? new LlmPlanner(llm) : new HeuristicPlanner();
  if (!llm) console.error("[contractor] LLM_API_KEY is not set; using the heuristic planner and deterministic checks only.");

  const verifier = new Verifier(llm ? new LlmJudge(llm) : undefined);
  const receipts = new ReceiptStore(directory);
  const budgetBook = new BudgetBook(runId, parseUsdc(budget), directory);
  const procurement = new Procurement({
    market,
    marketBaseUrl: config.marketBaseUrl,
    budget: budgetBook,
    receipts,
    verifier,
    selfWorker: llm ? new LlmSelfWorker(llm) : undefined,
    approvalGate: new CliApprovalGate(args.has("yes")),
    paymentResolver: new DefaultPaymentResolver(),
    config: {
      bidWindowMs: numberSeconds(args, "bid-window", config.bidWindowMs),
      counterWindowMs: numberSeconds(args, "counter-window", config.counterWindowMs),
      pollMs: numberSeconds(args, "poll", config.pollMs),
    },
    log: (message) => console.log(`[contractor] ${message}`),
  });
  const agent = new ContractorAgent({
    planner,
    procurement,
    budget: budgetBook,
    receipts,
    runId,
    runDirectory: directory,
    log: (message) => console.log(`[contractor] ${message}`),
  });

  const request: TaskRequest = {
    objective,
    budgetUsdc: budget,
    spendingMode: mode,
    paymentPreference,
    paymentDetails,
    qualityBar: args.string("quality"),
    allowedCategories: args.list("category"),
    maxPricePerSubtaskUsdc: args.string("max-subtask"),
    deadline: args.string("deadline"),
    acceptanceWindowDays: args.string("accept-after") ? Number(args.string("accept-after")) : undefined,
    autoAcceptLimitUsdc: args.string("auto-accept-limit"),
    bidWindowMs: args.string("bid-window") ? numberSeconds(args, "bid-window", config.bidWindowMs) : undefined,
    counterWindowMs: args.string("counter-window") ? numberSeconds(args, "counter-window", config.counterWindowMs) : undefined,
    pollMs: args.string("poll") ? numberSeconds(args, "poll", config.pollMs) : undefined,
  };

  try {
    const report = await agent.run(request);
    printReport(report);
  } finally {
    await market.close().catch(() => undefined);
  }
}

async function commandLogin(config: AppConfig): Promise<void> {
  const auth = new MarketAuth(config.marketBaseUrl);
  const stored = await auth.login({ scope: "mcp hiring" });
  console.log(`Logged in. Token stored in ${join(contractorHome(), "market-auth.json")} (scope: ${stored.scope ?? "unknown"}).`);
}

async function commandWhoami(config: AppConfig): Promise<void> {
  const mode: SpendingMode = "autonomous";
  const token = await marketAccessToken(config, mode);
  const client = new MarketMcpClient(config.marketBaseUrl, {
    endpoint: mode === "autonomous" ? "mcp/pro" : "mcp",
    token,
  });
  try {
    console.log(JSON.stringify(await client.whoami(), null, 2));
  } finally {
    await client.close();
  }
}

async function commandBalance(config: AppConfig): Promise<void> {
  const token = await marketAccessToken(config, "autonomous");
  const client = new MarketMcpClient(config.marketBaseUrl, { endpoint: "mcp/pro", token });
  try {
    console.log(JSON.stringify(await client.balances(), null, 2));
  } finally {
    await client.close();
  }
}

function commandReceipts(args: Args): void {
  const directory = args.string("run") ? runDir(args.string("run")!) : latestRunDirectory();
  if (!directory) throw new ContractorError("no_runs", "no runs found under .contractor/runs");
  const receipts = new ReceiptStore(directory).list();
  if (args.has("json")) {
    console.log(JSON.stringify(receipts, null, 2));
    return;
  }
  if (receipts.length === 0) {
    console.log(`No receipts in ${directory}`);
    return;
  }
  for (const receipt of receipts) {
    const amount = receipt.amountUsdc ? `${receipt.amountUsdc} USDC` : receipt.amountNative ? `${receipt.amountNative} NEAR` : "0";
    console.log(
      `${receipt.createdAt}  ${receipt.subtaskId}  ${receipt.action}  ${amount}  ${receipt.vendor.handle ?? receipt.vendor.name}  ${receipt.status}  ${receipt.id}`,
    );
    if (receipt.negotiation?.countered) {
      console.log(
        `  negotiated: ${receipt.negotiation.initialAmountUsdc} -> ${receipt.negotiation.revisedAmountUsdc ?? "no revised bid"} (${receipt.negotiation.outcome})`,
      );
    }
    if (receipt.payment?.txHash) console.log(`  tx: ${receipt.payment.txHash}`);
    if (receipt.payment?.reference) console.log(`  note: ${receipt.payment.reference}`);
  }
}

async function commandData(args: Args, config: AppConfig): Promise<void> {
  const handle = requireFlag(args, "handle");
  const task = requireFlag(args, "task");
  const maxUsdc = requireFlag(args, "max-usdc");
  parseUsdc(maxUsdc);
  const wallet = new NearWallet(config);
  const client = new X402Client(wallet, { pollMs: numberSeconds(args, "poll", config.pollMs) });
  console.error(`[contractor] x402: requesting ${handle} with a ${maxUsdc} USDC ceiling`);
  const result = await client.hire({ handle, task, maxUsdc });
  const id = `x402-${timestampId()}-${randomUUID().slice(0, 6)}`;
  const directory = join(contractorHome(), "payments", id);
  ensureDir(directory);
  const receipts = new ReceiptStore(directory);
  const receipt = receipts.create({
    taskId: id,
    subtaskId: "x402-data",
    action: "x402_purchase",
    vendor: { name: handle, handle },
    amountUsdc: result.amountUsdc,
    currency: "USDC",
    rail: "x402_usdc_near",
    spendingMode: "autonomous",
    deliverable: { summary: result.text.replace(/\s+/g, " ").slice(0, 500) },
    payment: { status: "released", reference: result.taskId },
    status: "paid",
  });
  console.log(result.text);
  console.error(`[contractor] x402 paid ${result.amountUsdc} USDC to ${handle}; receipt ${receipt.id}`);
}

async function commandPayNear(args: Args, config: AppConfig): Promise<void> {
  const to = requireFlag(args, "to");
  const amount = requireFlag(args, "amount");
  parseNear(amount);
  const wallet = new NearWallet(config);
  console.error(`[contractor] sending ${wallet.describe(amount)} to ${to}`);
  const result = await wallet.sendNear(to, amount);
  const id = `near-${timestampId()}-${randomUUID().slice(0, 6)}`;
  const directory = join(contractorHome(), "payments", id);
  ensureDir(directory);
  const receipt = new ReceiptStore(directory).create({
    taskId: id,
    subtaskId: "near-transfer",
    action: "near_transfer",
    vendor: { name: to, accountId: to },
    amountNative: amount,
    currency: "NEAR",
    rail: "near_native",
    spendingMode: "autonomous",
    payment: { txHash: result.txHash, status: "released" },
    status: "paid",
  });
  console.log(`sent ${amount} NEAR to ${to}\ntx: ${result.txHash}\nreceipt: ${receipt.id}`);
}

async function commandPayIntents(args: Args, config: AppConfig): Promise<void> {
  const to = requireFlag(args, "to");
  const amount = requireFlag(args, "amount");
  const destinationAsset =
    args.string("dest") ?? "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
  const slippageBps = args.string("slippage") ? Number(args.string("slippage")) : 100;
  const wallet = new NearWallet(config);
  const client = new NearIntentsClient(wallet, {
    baseUrl: args.string("api-url"),
    apiKey: config.nearIntentsApiKey,
  });
  const amountAtomic = parseNear(amount).toString();
  console.error(`[contractor] requesting a NEAR Intents quote for ${amount} NEAR -> ${destinationAsset}`);
  const quote = await client.quote({
    originAsset: "nep141:wrap.near",
    destinationAsset,
    amountAtomic,
    recipient: to,
    refundTo: wallet.address,
    swapType: "EXACT_INPUT",
    slippageBps,
  });
  console.error(`[contractor] deposit ${quote.amountInAtomic} yocto to ${quote.depositAddress}`);
  const result = await client.execute(quote);
  const id = `intents-${timestampId()}-${randomUUID().slice(0, 6)}`;
  const directory = join(contractorHome(), "payments", id);
  ensureDir(directory);
  const receipt = new ReceiptStore(directory).create({
    taskId: id,
    subtaskId: "near-intents",
    action: "near_intents",
    vendor: { name: to, accountId: to },
    amountNative: amount,
    currency: "NEAR",
    rail: "near_intents",
    spendingMode: "autonomous",
    payment: { txHash: result.txHash, depositAddress: quote.depositAddress, status: "pending" },
    status: "pending",
  });
  console.log(`submitted NEAR Intents transfer to ${to}\ndeposit: ${quote.depositAddress}\ntx: ${result.txHash}\nreceipt: ${receipt.id}`);
}

async function resolveMode(args: Args): Promise<SpendingMode> {
  const value = args.string("mode");
  if (value) {
    if (value !== "autonomous" && value !== "approval") throw new ContractorError("invalid_mode", "--mode must be autonomous or approval");
    return value;
  }
  if (!input.isTTY) {
    throw new ContractorError("missing_mode", "run --mode autonomous or --mode approval in non-interactive mode");
  }
  const answer = (await ask("Spending mode: [1] autonomous /mcp/pro, [2] approval links [1]: ")).trim() || "1";
  return answer === "2" ? "approval" : "autonomous";
}

async function resolvePaymentPreference(args: Args): Promise<PaymentPreference> {
  const value = args.string("pay");
  if (value) {
    if (!["auto", "usdc", "near", "near_intents"].includes(value)) {
      throw new ContractorError("invalid_payment", "--pay must be auto, usdc, near, or near_intents");
    }
    return value as PaymentPreference;
  }
  if (!input.isTTY) return "auto";
  const answer = (
    await ask("Payment preference: [1] USDC marketplace, [2] NEAR/x402 + USDC marketplace, [3] NEAR Intents + USDC marketplace [1]: ")
  ).trim();
  if (answer === "2") return "near";
  if (answer === "3") return "near_intents";
  return "usdc";
}

async function resolvePaymentDetails(preference: PaymentPreference, args: Args): Promise<PaymentDetails | undefined> {
  if (preference === "near") {
    const recipient = args.string("near-to") ?? (input.isTTY ? await ask("Native NEAR recipient or x402 handle (blank for marketplace only): ") : "");
    return { rail: "near_native", network: "near:mainnet", recipient: recipient || undefined };
  }
  if (preference === "near_intents") {
    const recipient =
      args.string("intents-to") ?? (input.isTTY ? await ask("NEAR Intents destination recipient (blank for marketplace only): ") : "");
    const destinationAsset =
      args.string("intents-dest") ??
      (input.isTTY ? await ask("Destination asset [USDC on NEAR]: ") : "") ??
      "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
    const slippage =
      args.string("slippage") ?? (input.isTTY ? await ask("Slippage in basis points [100]: ") : "100");
    return {
      rail: "near_intents",
      originAsset: "nep141:wrap.near",
      destinationAsset: destinationAsset || "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      recipient: recipient || undefined,
      slippageBps: Number(slippage || "100"),
    };
  }
  return undefined;
}

async function marketAccessToken(config: AppConfig, mode: SpendingMode): Promise<string> {
  const configured = mode === "autonomous" ? config.marketMcpProToken ?? config.marketMcpToken : config.marketMcpToken ?? config.marketMcpProToken;
  if (configured) return configured;
  const auth = new MarketAuth(config.marketBaseUrl);
  try {
    return await auth.accessToken();
  } catch {
    throw new ContractorError("market_auth_missing", "not logged in to Agent Market; run `npm run dev -- login` or set MARKET_MCP_TOKEN");
  }
}

class CliApprovalGate implements ApprovalGate {
  private readonly automatic: boolean;

  constructor(automatic: boolean) {
    this.automatic = automatic;
  }

  async waitForApproval(request: ApprovalRequest): Promise<void> {
    console.log("");
    console.log(`APPROVAL REQUIRED: ${request.action}`);
    if (request.amountUsdc) console.log(`Amount: ${request.amountUsdc} USDC`);
    if (request.vendor) console.log(`Vendor: ${request.vendor}`);
    console.log(request.url);
    if (!input.isTTY) {
      if (this.automatic) return;
      throw new ApprovalRequiredError(
        "approval link requires an interactive session; open it manually and rerun, or use --mode autonomous",
        { url: request.url },
      );
    }
    await ask("Press Enter after you finish approving in the browser: ");
  }
}

class Args {
  private readonly values = new Map<string, string[]>();
  private readonly flags = new Set<string>();

  constructor(argv: string[]) {
    for (let index = 0; index < argv.length; index += 1) {
      const token = argv[index]!;
      if (!token.startsWith("--")) continue;
      const name = token.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        this.flags.add(name);
      } else {
        const list = this.values.get(name) ?? [];
        list.push(next);
        this.values.set(name, list);
        index += 1;
      }
    }
  }

  has(name: string): boolean {
    return this.flags.has(name) || this.values.has(name);
  }

  string(name: string): string | undefined {
    return this.values.get(name)?.at(-1);
  }

  list(name: string): string[] | undefined {
    const values = this.values.get(name);
    return values?.length ? values : undefined;
  }
}

function requireFlag(args: Args, name: string): string {
  const value = args.string(name);
  if (!value) throw new ContractorError("missing_flag", `missing --${name}`);
  return value;
}

function numberSeconds(args: Args, name: string, fallbackMs: number): number {
  const value = args.string(name);
  if (!value) return fallbackMs;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) throw new ContractorError("invalid_number", `--${name} must be a non-negative number of seconds`);
  return Math.round(seconds * 1_000);
}

function latestRunDirectory(): string | undefined {
  const root = join(contractorHome(), "runs");
  if (!existsSync(root)) return undefined;
  const entries = readdirSync(root)
    .map((name) => join(root, name))
    .filter((path) => statSync(path).isDirectory())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return entries[0];
}

function printReport(report: RunReport): void {
  console.log("");
  console.log(`Run ${report.runId}: ${report.status}`);
  console.log(`Objective: ${report.objective}`);
  console.log(`Budget: ${report.budgetUsdc} USDC | spent: ${report.spentUsdc} | reserved: ${report.reservedUsdc} | available: ${report.remainingUsdc}`);
  console.log(`Receipts: ${report.receipts.length}`);
  for (const note of report.notes) console.log(`Note: ${note}`);
  console.log(`Report: ${join(runDir(report.runId), "run.json")}`);
  const receipts = new ReceiptStore(runDir(report.runId)).list();
  for (const receipt of receipts) {
    const amount = receipt.amountUsdc ? `${receipt.amountUsdc} USDC` : receipt.amountNative ? `${receipt.amountNative} NEAR` : "0";
    console.log(
      `  ${receipt.subtaskId}: ${receipt.action} ${amount} -> ${receipt.vendor.handle ?? receipt.vendor.name} [${receipt.status}]`,
    );
    if (receipt.negotiation?.countered) {
      console.log(
        `    negotiation: ${receipt.negotiation.initialAmountUsdc} -> ${receipt.negotiation.revisedAmountUsdc ?? "walked"} (${receipt.negotiation.outcome})`,
      );
    }
  }
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

function timestampId(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
}

main().catch((error) => {
  if (error instanceof ContractorError) {
    console.error(`error (${error.code}): ${error.message}`);
    if (error.details !== undefined) console.error(JSON.stringify(error.details, null, 2));
  } else {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  }
  process.exitCode = 1;
});
