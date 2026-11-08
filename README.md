<p align="center">
  <img src="public/logo.png" alt="Odin logo" width="180" />
</p>

<h1 align="center">Odin</h1>

Odin is a budget-bound general contractor agent for the [NEAR AI Agent Market](https://market.near.ai).

Give it an objective and a hard USDC budget. It plans the work, decides what to do
itself versus what to buy from other agents, negotiates at most once per subtask,
verifies every deliverable against explicit acceptance criteria, and only then
releases payment. Every action is written to a local receipt and budget ledger.

```
objective + budget
        │
        ▼
   plan subtasks  ──►  self-work (local LLM)
        │
        └──────────►  buy from market
                        ├─ direct hire
                        └─ post job ─► bids ─► one counter ─► award
                                              │
                                              ▼
                                    deliver ─► verify ─► accept/release
                                              └─ fail ─► one change round
```

## Highlights

- **Hard budget enforcement.** A reservation ledger (`BudgetBook`) makes it
  impossible to spend or reserve beyond the run budget, even across restarts.
- **Two spending modes.** `autonomous` spends in-call through the market's
  `/mcp/pro` endpoint; `approval` returns links that a human must approve.
- **Plan, don't overpay.** The planner must keep the sum of subtask ceilings at or
  below the budget and honors a per-subtask cap.
- **Source intelligently.** Discovers agents, prefers available/reputable/cheap
  matches, falls back to the job board when direct hire fails or is too expensive.
- **One counteroffer.** If the cheapest bid is over budget, it sends a single
  reasoned counter, waits for a revision, then walks away or awards elsewhere.
- **Verification before payment.** Deterministic checks plus an optional LLM judge.
  Failed deliveries get one change round before money stays held for a dispute.
- **Auditable.** Runs, plans, ledger entries, receipts, and payment details are
  persisted as JSON under `.contractor/`.
- **Multiple payment rails.** Agent Market USDC escrow, x402 pay-per-request data
  on NEAR, native NEAR transfers, and NEAR Intents (1Click) swaps.

## Requirements

- Node.js 22 LTS or newer (uses `process.loadEnvFile`; Node 20.12+ also works)
- An LLM key: OpenAI-compatible (`LLM_API_KEY`) or Google Gemini (`GOOGLE_API_KEY`)
- An Agent Market account (OAuth via `login`, or a pre-issued MCP token)
- For NEAR rails: a dedicated, limited NEAR account with a small balance

## Install

```bash
npm install
cp .env.example .env
# edit .env
```

## Configure

`loadConfig()` reads `.env` from the current working directory, then the process
environment. Environment variables win only if they are already set before load;
keep secrets out of source control.

| Variable | Default | Purpose |
| --- | --- | --- |
| `LLM_API_KEY` | — | OpenAI-compatible API key. Selects the OpenAI client. |
| `LLM_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible base URL. |
| `LLM_MODEL` | `gpt-4.1-mini` | Model used for planning, self-work, and judging. |
| `GOOGLE_API_KEY` | — | Gemini API key. Used when `LLM_API_KEY` is not set. |
| `GOOGLE_BASE_URL` | `https://generativelanguage.googleapis.com` | Gemini base URL. |
| `GOOGLE_MODEL` | `gemini-3.5-flash-lite` | Gemini model. |
| `MARKET_MCP_TOKEN` | — | Agent Market MCP token (approval mode / standard endpoint). |
| `MARKET_MCP_PRO_TOKEN` | — | Agent Market pro token (autonomous spending). |
| `MARKET_BASE_URL` | `https://market.near.ai` | Agent Market base URL. |
| `NEAR_ACCOUNT_ID` | — | Account used for x402 and native NEAR payments. |
| `NEAR_PRIVATE_KEY` | — | Private key for that account. Use a limited account only. |
| `NEAR_RPC_URL` | `https://rpc.mainnet.fastnear.com` | NEAR RPC endpoint. |
| `NEAR_NETWORK` | `mainnet` | `mainnet` or `testnet`. |
| `NEAR_INTENTS_API_KEY` | — | Optional 1Click API key. |
| `DEFAULT_BID_WINDOW_MS` | `120000` | How long to wait for bids. |
| `DEFAULT_COUNTER_WINDOW_MS` | `300000` | How long to wait after a counter. |
| `DEFAULT_POLL_MS` | `10000` | Marketplace polling interval. |
| `CONTRACTOR_HOME` | `./.contractor` | Directory for runs, auth, and receipts. |
| `CONTRACTOR_NO_BROWSER` | — | Set to `1` to skip auto-opening the login URL. |
| `OAUTH_PORT` | `8787` | Local OAuth callback port for `login`. |

> The CLI picks the OpenAI client when `LLM_API_KEY` is set, otherwise it uses the
> Gemini client. At least one working LLM key is required for planning and judging.

## Quick start

```bash
# 1. Authenticate with Agent Market (opens a browser)
npm run dev -- login

# 2. Inspect the identity and wallet balance
npm run dev -- whoami
npm run dev -- balance

# 3. Run a task with a hard 10 USDC budget
npm run dev -- run \
  --task "Research the top 3 NEAR AI agent marketplaces and write a brief comparison" \
  --budget 10 \
  --mode autonomous \
  --quality "Cite sources and keep it under 600 words"

# 4. Review receipts for the latest run
npm run dev -- receipts
```

During development `npm run dev` runs TypeScript directly with `tsx`. After
`npm run build`, use `npm start` (or `node dist/cli.js`).

## CLI reference

```
npm run dev -- <command> [options]
```

### `run`

Plan, source, verify, and pay for a task.

| Flag | Description |
| --- | --- |
| `--task "..."` | Objective (required unless `--task-file`). |
| `--task-file <path>` | Read the objective from a file. |
| `--budget <usdc>` | Hard budget ceiling in USDC (required). |
| `--mode <autonomous\|approval>` | Spending mode. Prompted when interactive. |
| `--pay <auto\|usdc\|near\|near_intents>` | Payment preference (default `auto`/`usdc`). |
| `--quality "..."` | Quality bar passed to the planner. |
| `--category <name>` | Allowed marketplace category (repeatable). |
| `--max-subtask <usdc>` | Per-subtask price ceiling. |
| `--bid-window <seconds>` | How long to wait for bids. |
| `--counter-window <seconds>` | How long to wait after one counteroffer. |
| `--poll <seconds>` | Marketplace polling interval. |
| `--deadline <iso-date>` | Stop starting new work after this time. |
| `--accept-after <days>` | Marketplace acceptance window. |
| `--auto-accept-limit <usdc>` | Auto-accept limit (passed through to the request). |
| `--yes` | Non-interactive approval waits; the link still must be approved. |
| `--near-to <account>` | Native NEAR recipient for the `near` preference. |
| `--intents-to <account>` | NEAR Intents recipient. |
| `--intents-dest <asset>` | NEAR Intents destination asset. |
| `--slippage <bps>` | NEAR Intents slippage tolerance in basis points. |

### `login`

Runs the OAuth 2.0 authorization-code + PKCE flow with the market's OAuth server,
then stores the token in `.contractor/market-auth.json`. Use
`CONTRACTOR_NO_BROWSER=1` on headless machines and open the printed URL manually.

### `whoami` / `balance`

Print the market identity or wallet balances as JSON.

### `receipts`

```bash
npm run dev -- receipts [--run <run-id>] [--json]
```

Lists receipts for a run, or for the most recent run when `--run` is omitted.

### `data`

Buy data from an agent that exposes an x402 endpoint.

```bash
npm run dev -- data --handle <agent> --task "..." --max-usdc 1 [--poll 10]
```

Performs the x402 `402 Payment Required` handshake, signs a NEAR meta-transaction
delegate for the requested amount, and polls the A2A task until completion.

### `pay-near`

Send native NEAR from the configured hot wallet.

```bash
npm run dev -- pay-near --to <account> --amount 1
```

### `pay-intents`

Swap NEAR through NEAR Intents (1Click) and deliver another asset.

```bash
npm run dev -- pay-intents --to <account> --amount 1 \
  [--dest <asset>] [--slippage 100] [--api-url https://1click.chaindefuser.com]
```

## How a run works

1. **Validate.** The budget must parse as a positive USDC amount.
2. **Plan.** `LlmPlanner` (or `HeuristicPlanner` when used programmatically)
   decomposes the objective into subtasks. Each subtask declares `mode`
   (`self`/`buy`), a `maxPriceUsdc`, and at least one acceptance criterion.
   `validatePlan` rejects duplicates, overspending, and per-subtask overruns.
3. **Reserve.** Before touching a subtask, `BudgetBook.reserve` locks its ceiling.
4. **Source.**
   - `self`: the local LLM completes the work; it costs zero.
   - `buy`: browse agents and filter to USDC-payable, priced, available matches.
     A direct hire is attempted first when a candidate is within the subtask
     ceiling. Otherwise the agent posts a job to the board.
5. **Negotiate.** Bids are ranked by price, then reputation. If the cheapest bid
   exceeds the ceiling, the agent sends exactly one counteroffer with the target
   price and acceptance criteria. It waits for a revised bid, awards an
   alternative inside budget, or walks away.
6. **Fund.** Escrow is created through the market; the ledger settles the amount.
7. **Deliver.** Polls the job until a result is available (bounded by the SLA plus
   a grace period, up to seven days).
8. **Verify.** Deterministic checks run first, then the LLM judge. On failure the
   agent requests one change round with concrete feedback. If it still fails,
   payment stays held and the run fails with a dispute note.
9. **Accept & release.** Accepts the result and confirms the job reaches
   `completed` before marking the receipt `paid`.
10. **Record.** Writes `run.json`, `budget.json`, and `receipts.json` atomically.

If a subtask cannot be bought and an LLM is configured, the agent falls back to
doing it locally. Otherwise the run fails with `no_qualified_bid`.

## Spending modes

| Mode | Endpoint | Behavior |
| --- | --- | --- |
| `autonomous` | `/mcp/pro` | Funds hires and awards in-call. No human in the loop. |
| `approval` | `/mcp` | Returns approval URLs. The CLI waits for you to approve and press Enter. |

In `approval` mode, `prepare_job`, `award_bid`, and `accept_result` each require
human approval. Use `--yes` only in trusted automation; it skips the Enter prompt
but still requires clicking the approval link.

## Payment rails

| Rail | Used by | Settlement |
| --- | --- | --- |
| `market_usdc` / `market_usd` | `run` | Agent Market escrow, released after acceptance. |
| `x402_usdc_near` | `data` | Per-request USDC on NEAR via a signed meta-transaction. |
| `near_native` | `pay-near` | Direct NEAR transfer from the hot wallet. |
| `near_intents` | `pay-intents` | 1Click quote, then wrap/transfer to the deposit address. |

Marketplace jobs always settle in USDC escrow. The `near` and `near_intents`
preferences apply to x402 data purchases and off-market transfers; the CLI prints
a notice when this happens.

## Verification criteria

`Verifier` always checks that a deliverable is non-empty, then interprets special
acceptance-criteria strings deterministically:

| Criterion | Meaning |
| --- | --- |
| `contains: <text>` | Deliverable must contain the text (case-insensitive). |
| `min-length: <n>` | Deliverable text must be at least `n` characters. |
| `json` | Deliverable text must parse as JSON. |

Any other criterion is left to the LLM judge. Without a judge, deterministic checks
passing yields a score of 75. Deterministic failure short-circuits the judge.

## Files and state

Everything is stored under `CONTRACTOR_HOME` (default `.contractor/`), which is
git-ignored:

```
.contractor/
├── market-auth.json            # OAuth tokens (mode 0600)
├── runs/
│   └── <run-id>/
│       ├── run.json            # objective, plan, status, notes, budget snapshot
│       ├── budget.json         # reservations and ledger entries
│       └── receipts.json       # one receipt per action
└── payments/
    └── <payment-id>/
        └── receipts.json       # x402 / native NEAR / Intents receipts
```

JSON writes are atomic (temp file + rename) and created with `0600` permissions.

## Project structure

```
src/
├── cli.ts                 # argument parsing, commands, wiring
├── agent.ts               # run loop: plan → execute in dependency order → report
├── planner.ts             # LLM planner, heuristic planner, plan validation
├── procurement.ts         # self-work vs buy, direct hire, job board, negotiation
├── negotiation.ts         # counteroffer text, bid selection
├── ledger.ts              # BudgetBook: reserve/settle/release/refund invariants
├── receipts.ts            # append-only receipt store
├── money.ts               # bigint USDC/NEAR parsing and formatting
├── config.ts              # env/.env configuration
├── llm.ts                 # OpenAI-compatible and Gemini clients
├── errors.ts              # typed ContractorError hierarchy
├── storage.ts             # atomic JSON persistence
├── types.ts               # shared domain types
├── check/
│   ├── verifier.ts        # deterministic checks + LLM judge
│   └── self-worker.ts     # local LLM execution for self subtasks
├── market/
│   ├── mcp.ts             # Agent Market MCP client and response normalization
│   ├── auth.ts            # OAuth 2.0 + PKCE login and refresh
│   └── gateway.ts         # interfaces for market and approval gate
├── payments/
│   ├── router.ts          # marketplace rail selection
│   ├── near-wallet.ts     # NEAR account, transfers, x402 delegate signing
│   ├── x402.ts            # x402 + A2A data purchase client
│   └── near-intents.ts    # 1Click quote and execution
├── responses/
│   └── whoami.ts          # whoami response types
└── __tests__/             # vitest unit tests
```

## Development

```bash
npm test          # vitest run
npm run typecheck # tsc --noEmit
npm run build     # tsc -> dist/
npm run dev -- help
```

Tests cover money parsing, the budget ledger, plan validation, negotiation, the
agent loop, and the procurement flow. Use `npm run typecheck` before committing.

## Safety notes

- Use a **dedicated NEAR account** with a limited balance for `NEAR_PRIVATE_KEY`.
  The agent can sign transfers and x402 delegates without further prompts.
- `.env` and `.contractor/` contain secrets and are git-ignored. Never commit them.
- `autonomous` mode spends real funds in-call. Prefer `approval` mode until you
  trust a workflow.
- Marketplace acceptance releases escrow. Failed verifications deliberately leave
  funds held; resolve them through the market's dispute process.
- A counteroffer is sent at most once per subtask. There is no bidding war.

## Further reading

- [`docs/architecture.md`](docs/architecture.md) — module responsibilities, data
  flow, ledger invariants, and the procurement state machine.
- [`docs/payments.md`](docs/payments.md) — payment rails, x402 handshake, and
  NEAR Intents flow.
