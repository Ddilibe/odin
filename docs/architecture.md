# Architecture

Odin is a small, dependency-light TypeScript service. It is split
into a CLI shell, an orchestration loop, a procurement engine, and adapters for
the Agent Market, payments, and LLM providers. This document explains how the
pieces fit together and which invariants the code relies on.

## Layers

```
┌───────────────────────────────────────────────────────────────┐
│ cli.ts                                                        │
│  argument parsing · command dispatch · dependency wiring      │
└───────────────┬───────────────────────────────────────────────┘
                │
┌───────────────▼───────────────────────────────────────────────┐
│ agent.ts  (ContractorAgent)                                   │
│  plan → order subtasks by dependency → execute → report       │
└───────┬───────────────────────┬───────────────────────────────┘
        │                       │
┌───────▼────────┐    ┌─────────▼───────────────────────────────┐
│ planner.ts     │    │ procurement.ts                          │
│ LlmPlanner     │    │ self-work · direct hire · job board     │
│ HeuristicPlan  │    │ negotiation · verify · accept           │
│ validatePlan   │    └───┬───────────────┬───────────────┬─────┘
└────────────────┘        │               │               │
                  ┌───────▼──────┐ ┌──────▼──────┐ ┌──────▼─────────┐
                  │ market/*     │ │ check/*     │ │ payments/*     │
                  │ MCP + auth   │ │ verifier    │ │ x402, wallet,  │
                  │ gateway      │ │ self-worker │ │ intents, router│
                  └──────────────┘ └─────────────┘ └────────────────┘
                  ┌──────────────────────────────────────────────┐
                  │ ledger.ts · receipts.ts · storage.ts · money  │
                  └──────────────────────────────────────────────┘
```

## Module responsibilities

| Module | Responsibility |
| --- | --- |
| `cli.ts` | Parses `--flags`, resolves interactive prompts, builds all dependencies, runs commands, prints reports. Owns `CliApprovalGate`. |
| `agent.ts` | Validates the request, asks the planner for a plan, executes ready subtasks in dependency order, persists the `RunReport` after every change. |
| `planner.ts` | `LlmPlanner` prompts the model for strict JSON; `HeuristicPlanner` splits objectives without an LLM; `validatePlan` enforces the budget and shape. |
| `procurement.ts` | The core state machine. Chooses `self` vs `buy`, discovers candidates, hires or posts jobs, negotiates, funds, waits for delivery, verifies, accepts, and writes receipts. |
| `negotiation.ts` | Pure functions for counteroffer text and bid selection (price, then reputation). |
| `ledger.ts` | `BudgetBook`, the durable reservation/settlement ledger. Enforces all budget invariants. |
| `receipts.ts` | Append-and-update store for `Receipt` records. |
| `money.ts` | Exact `bigint` arithmetic for USDC (6 decimals) and NEAR (24 decimals). No floats. |
| `config.ts` | Loads `.env` then process env into a typed `AppConfig`. |
| `llm.ts` | Two concrete `LlmClient`s (OpenAI-compatible, Gemini) plus `extractJson` for tolerant JSON parsing. |
| `errors.ts` | `ContractorError` and typed subclasses carrying a stable `code` and optional `details`. |
| `storage.ts` | `contractorHome`, `runDir`, and atomic `writeJson`/`readJson`. |
| `market/mcp.ts` | MCP streamable-HTTP client; wraps tools as `marketplace__<tool>`; normalizes snake_case responses into domain types. |
| `market/auth.ts` | OAuth discovery, dynamic client registration, authorization-code + PKCE login, refresh, and token storage. |
| `market/gateway.ts` | Structural `MarketGateway` interface plus `ApprovalGate`/`ApprovalRequest` contracts. Keeps `procurement` testable. |
| `check/verifier.ts` | Deterministic checks and optional `LlmJudge`. Produces a `CheckResult`. |
| `check/self-worker.ts` | Local LLM execution for `self` subtasks. |
| `payments/router.ts` | Chooses the marketplace settlement token (`USD`/`USDC`). |
| `payments/near-wallet.ts` | NEAR account, native transfers, NEP-141 transfers, wrap, and x402 meta-transaction signing. |
| `payments/x402.ts` | x402 + A2A client for pay-per-request data. |
| `payments/near-intents.ts` | 1Click quote and deposit execution. |
| `responses/whoami.ts` | Types for the market `whoami` payload. |
| `types.ts` | Domain types shared across modules. |

## Run lifecycle

`ContractorAgent.run` owns the outer loop:

1. Reject a non-positive budget.
2. Build and persist a `RunReport` with `status: "running"`.
3. Call `planner.plan(request)` and persist the plan.
4. Compute `readySubtasks`: subtasks whose dependencies are all completed.
5. Execute each ready subtask through `procurement.execute`, passing the
   deliverables of its dependencies as `priorResults`.
6. After each success, store the output, push the receipt id, refresh the budget
   snapshot, and persist.
7. Stop early with `status: "stopped"` when `deadline` has passed.
8. Mark `completed`, or `failed` with notes when any subtask throws.
9. Always stamp `finishedAt`, refresh budget figures, and persist in `finally`.

A cycle (or an unknown dependency) surfaces as `cyclic_plan` when no subtask is
ready but work remains.

### Subtask ordering

`readySubtasks` filters out completed subtasks and requires every id in
`dependsOn` to both exist in the plan and be completed. Subtasks without
dependencies run in plan order; independent subtasks run sequentially, not in
parallel, to keep budget bookkeeping simple and deterministic.

## Budget ledger invariants

`BudgetBook` is persisted to `budget.json` and reloaded on construction. Each
subtask gets at most one reservation.

State:

```ts
interface Reservation {
  amountMicros: string;   // reserved ceiling
  settledMicros: string;  // amount actually spent
  status: "active" | "settled" | "released";
}
```

Derived values:

```
reserved  = Σ (amount - settled) for active reservations
available = budget - spent - reserved
```

Rules enforced on every mutation:

- A reservation cannot be negative, cannot duplicate an active reservation for
  the same subtask, and cannot exceed `available`.
- Settlement requires an active reservation, cannot exceed the remaining
  reserved amount, and cannot push `spent + reserved` past the budget.
- `release` frees the unused remainder of an active reservation.
- `refund` subtracts from `spent` and adjusts a settled reservation.
- The invariant `spent >= 0`, `reserved >= 0`, and `spent + reserved <= budget`
  is asserted after every change.

All amounts are integer micro-USDC (`1 USDC = 1_000_000`). `money.ts` is the only
place that converts to/from human-readable decimals.

## Procurement state machine

`Procurement.execute` reserves the subtask ceiling, then branches on `mode`.

```
execute
├── reserve(maxPriceUsdc)
├── mode == "self"
│   ├── selfWorker.work(...)
│   ├── verifier.verify(...)
│   ├── receipt(action="self", amount=0)
│   ├── fail → VerificationError
│   └── pass → release reservation, return deliverable
└── mode == "buy"
    ├── discoverCandidates()
    │   ├── browseAgents(query, category)
    │   ├── retry without category on failure
    │   └── keep priced, USDC-payable agents; sort by availability/reputation/price
    ├── direct hire if a candidate price <= ceiling
    │   ├── autonomous: createJob → funded escrow
    │   ├── approval:   prepareJob → approval link → prepareJob again
    │   ├── read funded assignment amount, ensure <= ceiling
    │   ├── settle ledger
    │   └── finishMarketJob()
    ├── otherwise postJobAndNegotiate()
    │   ├── postJob (budget guide = ceiling), release reservation
    │   ├── waitForBids(bidWindowMs)
    │   ├── chooseBidWithinBudget()
    │   ├── if none: one counter via messageBidder()
    │   │   ├── waitForRevisedBid(counterWindowMs)
    │   │   ├── revised → award it
    │   │   └── else award alternative or walk away
    │   ├── reserve again, awardBid()
    │   ├── settle ledger
    │   └── finishMarketJob()
    └── fallbackOrThrow() when no bid qualifies
        ├── record a failed negotiation receipt
        ├── release reservation
        └── self-worker fallback if available, else NoQualifiedBidError
```

### `finishMarketJob`

1. `waitForDeliverable` polls `get_job_status` until `result_available`, then
   pages through `get_job_result` (text chunks, files, or an external URL).
   The wait is bounded by the SLA plus ten minutes, capped at seven days.
2. `verifier.verify` runs. On failure, `request_changes` is called with the
   reasons and required fixes, then the agent waits for a revised deliverable and
   verifies once more.
3. A second failure leaves the receipt `failed` with payment `held` and throws a
   `VerificationError` that points at a dispute.
4. On success, `acceptAndConfirm` accepts the result and polls until the job is
   `completed`.
5. The receipt becomes `paid` / `payment: released`.

### Failure handling

- Direct hire wraps post-settlement errors as `direct_hire_committed` with
  `{ committed: true }` so the caller does not retry through the job board.
- Before settlement, failed hires attempt `cancel_job`; the receipt becomes
  `refunded` when cancellation succeeds, otherwise `failed`.
- Cancelled or refunded assignments surface as `job_cancelled` /
  `assignment_cancelled`, which trigger a ledger refund.
- Timeouts use `delivery_timeout` and `acceptance_not_confirmed` so an operator
  can inspect the job page instead of assuming success.

## Verification

`Verifier.verify` composes:

1. `non_empty` — text, external URL, or files present.
2. Deterministic criteria — `contains:`, `min-length:`, `json`.
3. Optional LLM judge — strict JSON with `passed`, `score`, `reasons`,
   `requiredFixes`.

Deterministic failure returns immediately with score 0. Without a judge, passing
deterministic checks yields score 75. With a judge, the final result requires
both deterministic and judged success.

## Persistence and concurrency

- `writeJson` writes to a unique temp file, renames it into place, and applies
  `0600` permissions. Reads fall back to a supplied default.
- `RunReport`, `BudgetState`, and receipts are separate files, all under the run
  directory, so a crash leaves a coherent audit trail.
- The agent is single-process and executes subtasks sequentially; the ledger is
  not designed for concurrent writers. Do not run two agents against the same
  `CONTRACTOR_HOME`/run id.

## Extensibility

- **New planner:** implement `Planner` and pass it to `ContractorAgent`.
- **New LLM provider:** subclass `LlmClient` and implement `complete`.
- **New market:** implement the `MarketGateway` structural interface and an
  `ApprovalGate`; `Procurement` depends only on those interfaces.
- **New payment rail:** add a resolver or client, extend `PaymentRailName`, and
  record the corresponding `Receipt.action`.
- **New verifier rule:** add a branch in `deterministicCheck` and document the
  criterion syntax.

## Testing strategy

Vitest unit tests live in `src/__tests__`. They use temporary directories and
fake gateways rather than the network:

- `money.test.ts` — parsing, formatting, precision.
- `ledger.test.ts` — reservations, settlement, release, refund, reload.
- `planner.test.ts` — plan validation and heuristic splitting.
- `negotiation.test.ts` — counteroffer content and bid selection.
- `agent.test.ts` — dependency ordering and report persistence.
- `procurement.test.ts` — direct hire, job-board negotiation, verification, and
  failure paths through a fake market gateway.

The market, wallet, and LLM clients are thin adapters; they are exercised through
integration runs rather than unit tests.
