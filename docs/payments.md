# Payments

The agent can move value over four rails. Marketplace work always settles in USDC
escrow; the NEAR rails are used for x402 data purchases, native transfers, and
cross-asset swaps. Every payment produces a `Receipt` with a `rail`, `action`,
amount, status, and any transaction hash or reference.

## Rails at a glance

| `PaymentRailName` | Command | Asset | How it settles |
| --- | --- | --- | --- |
| `market_usdc` | `run` | USDC | Agent Market escrow, released on acceptance |
| `market_usd` | `run` | USD | Same escrow, selected by the payment resolver |
| `x402_usdc_near` | `data` | USDC on NEAR | Signed meta-transaction delegate per request |
| `near_native` | `pay-near` | NEAR | Direct `transfer` from the hot wallet |
| `near_intents` | `pay-intents` | NEAR → other asset | 1Click quote + deposit |
| `none` | `run` (self) | — | Zero-cost local work |

## Payment preference

`--pay` controls how the agent prefers to pay:

- `auto` / `usdc` — marketplace USDC (default).
- `near` — x402 and native NEAR for off-market work; marketplace awards still use
  USDC.
- `near_intents` — NEAR Intents for off-market swaps; marketplace awards still use
  USDC.

`DefaultPaymentResolver` returns `USDC` for marketplace hires. The CLI prints a
notice when a NEAR preference cannot apply to marketplace settlement.

## Marketplace escrow

Marketplace jobs are funded and settled by the Agent Market:

1. **Autonomous:** `create_job` funds the assignment immediately. The response
   must include a job id and must not report `funded: false`.
2. **Approval:** `prepare_job` returns a draft and `approval_url`. After the human
   approves, `prepare_job` is called again with the same `client_request_id`; the
   response must be funded and yield a job id (polling `get_draft_status` if
   needed).
3. The agent reads the funded assignment amount, checks it against the subtask
   ceiling, and settles the ledger.
4. After delivery and verification, `accept_result` releases escrow. The agent
   polls `get_job_status` until `completed` before marking the receipt paid.

`client_request_id` is a UUID generated per hire so retries are idempotent from the
market's perspective.

Job-board awards follow the same funding rules: `post_job` sets a budget guide,
bids are collected, one counter may be sent, and `award_bid` creates the
assignment.

## x402 data purchases

`data` buys a single response from an agent exposing an x402 + A2A endpoint at
`https://<handle>.market.near.ai/a2a/v1`.

```
client                                      provider
  │  POST SendMessage (no payment)             │
  ├───────────────────────────────────────────►│
  │  402 Payment Required + accepts[]           │
  │◄───────────────────────────────────────────┤
  │  pick network startsWith("near:")           │
  │  enforce maxUsdc ceiling                    │
  │  sign ft_transfer meta-tx delegate          │
  │  POST SendMessage + X-PAYMENT               │
  ├───────────────────────────────────────────►│
  │  200 + task                                 │
  │◄───────────────────────────────────────────┤
  │  poll GetTask until completed               │
  ├───────────────────────────────────────────►│
  │  artifacts[].parts[].text                   │
  │◄───────────────────────────────────────────┤
```

Details:

- The challenge must be `402`; anything else is `x402_no_challenge`.
- The chosen `accept` must have a `near:` network; otherwise `x402_no_near_rail`.
- `accept.amount` is compared to `--max-usdc` before signing. Over the ceiling is
  `x402_above_ceiling`.
- `NearWallet.signX402Delegate` builds a signed `ft_transfer` delegate with a
  block-height TTL equal to `maxTimeoutSeconds` and returns base64 NEP-366 bytes.
- The `X-PAYMENT` header is base64 JSON: `{ x402Version, accepted, payload }`.
- Polling stops at `TASK_STATE_COMPLETED`; pending states are
  `TASK_STATE_SUBMITTED` and `TASK_STATE_WORKING`. Timeouts are bounded by
  `maxTimeoutSeconds + 600`.
- The receipt records `action: "x402_purchase"`, `rail: "x402_usdc_near"`, the
  actual amount from the challenge, and the provider's task id as `reference`.

## Native NEAR transfers

`pay-near --to <account> --amount <near>` calls `NearWallet.sendNear`, which parses
the amount as yoctoNEAR (24 decimals), rejects non-positive values, and calls the
account's `transfer`. The transaction hash is extracted from the RPC result and
stored on the receipt (`rail: "near_native"`, `status: "paid"`).

## NEAR Intents (1Click)

`pay-intents` requests a quote from `https://1click.chaindefuser.com` (override
with `--api-url`) and then deposits the origin asset.

1. **Quote** — `POST /v0/quote` with origin asset (default `nep141:wrap.near`),
   destination asset (default USDC on NEAR), atomic amount, recipient, refund
   address, `swapType: EXACT_INPUT`, slippage in basis points, and a 30-minute
   deadline. `NEAR_INTENTS_API_KEY`, when set, is sent as a bearer token.
2. **Deposit address** — the quote must contain `depositAddress`, else
   `intents_no_deposit_address`.
3. **Execute**
   - Origin `nep141:wrap.near`: wrap the NEAR (`near_deposit` on `wrap.near`),
     then `ft_transfer` the wrapped amount to the deposit address.
   - Other `nep141:` origins: `ft_transfer` directly.
   - Anything else: `intents_unsupported_origin`.
4. **Receipt** — `action: "near_intents"`, `rail: "near_intents"`, status
   `pending`, with the deposit address and tx hash. Completion is asynchronous and
   tracked by the provider.

## Amount handling

- All arithmetic is `bigint`. `parseUsdc` uses 6 decimals, `parseNear` uses 24.
- Trailing zeros beyond the asset precision are accepted (`25.000000000000`),
  but real precision loss is rejected (`1.0000001`).
- Marketplace responses sometimes include more decimals than the token; the
  parser normalizes those before comparison.

## Wallet and key safety

`NearWallet` requires `NEAR_ACCOUNT_ID` and `NEAR_PRIVATE_KEY`. It can:

- sign native transfers,
- sign NEP-141 `ft_transfer` calls,
- wrap NEAR,
- sign x402 meta-transaction delegates without broadcasting.

This is effectively an unrestricted hot wallet for the configured account. Use a
dedicated account with a small balance, prefer `approval` mode for marketplace
spending, and never commit `.env` or `.contractor/`. The x402 delegate is scoped to
one transfer, but native and fungible transfers are not otherwise limited by the
agent.

## Failure codes

| Code | Meaning |
| --- | --- |
| `near_wallet_missing` | Missing account id or private key. |
| `invalid_amount` | Non-positive NEAR amount. |
| `x402_no_challenge` | Provider did not return `402`. |
| `x402_no_near_rail` | No `near:` payment option in the challenge. |
| `x402_above_ceiling` | Requested amount exceeds `--max-usdc`. |
| `x402_payment_failed` | Paid request was rejected. |
| `x402_timeout` | Task did not finish in time. |
| `x402_task_failed` | Task ended in a non-completed state. |
| `x402_bad_response` | Response contained no task. |
| `intents_quote_failed` | 1Click quote request failed. |
| `intents_no_deposit_address` | Quote lacked a deposit address. |
| `intents_unsupported_origin` | Origin asset is not NEP-141. |
