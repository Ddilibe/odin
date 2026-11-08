import { ContractorError } from "../errors.js";
import type { NearWallet } from "./near-wallet.js";

interface QuoteRequest {
  originAsset: string;
  destinationAsset: string;
  amountAtomic: string;
  recipient: string;
  refundTo: string;
  swapType?: "EXACT_INPUT" | "EXACT_OUTPUT";
  slippageBps?: number;
  deadline?: string;
}

interface QuoteResponse {
  quote?: {
    depositAddress?: string;
    depositType?: string;
    amountIn?: string;
    amountOut?: string;
    deadline?: string;
  };
  depositAddress?: string;
  amountIn?: string;
  amountOut?: string;
  deadline?: string;
}

export interface IntentsQuote {
  depositAddress: string;
  amountInAtomic: string;
  amountOutAtomic: string;
  deadline: string;
  originAsset: string;
  destinationAsset: string;
  raw: unknown;
}

export class NearIntentsClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly wallet: NearWallet;

  constructor(wallet: NearWallet, options: { baseUrl?: string; apiKey?: string } = {}) {
    this.wallet = wallet;
    this.baseUrl = (options.baseUrl ?? "https://1click.chaindefuser.com").replace(/\/+$/, "");
    this.apiKey = options.apiKey;
  }

  async quote(input: QuoteRequest): Promise<IntentsQuote> {
    const body = {
      dry: false,
      swapType: input.swapType ?? "EXACT_OUTPUT",
      originAsset: input.originAsset,
      destinationAsset: input.destinationAsset,
      amount: input.amountAtomic,
      recipient: input.recipient,
      recipientType: "DESTINATION_CHAIN",
      refundTo: input.refundTo,
      refundType: "ORIGIN_CHAIN",
      depositType: "ORIGIN_CHAIN",
      slippageTolerance: input.slippageBps ?? 100,
      deadline: input.deadline ?? new Date(Date.now() + 30 * 60_000).toISOString(),
    };
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const response = await fetch(`${this.baseUrl}/v0/quote`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new ContractorError("intents_quote_failed", `1Click quote failed: ${response.status} ${await response.text()}`);
    }
    const payload = (await response.json()) as QuoteResponse;
    const quote = payload.quote ?? payload;
    const depositAddress = quote.depositAddress;
    if (!depositAddress) throw new ContractorError("intents_no_deposit_address", "1Click quote had no deposit address", payload);
    return {
      depositAddress,
      amountInAtomic: quote.amountIn ?? input.amountAtomic,
      amountOutAtomic: quote.amountOut ?? input.amountAtomic,
      deadline: quote.deadline ?? body.deadline,
      originAsset: input.originAsset,
      destinationAsset: input.destinationAsset,
      raw: payload,
    };
  }

  async execute(quote: IntentsQuote): Promise<{ txHash: string }> {
    if (quote.originAsset === "nep141:wrap.near") {
      const wrap = await this.wallet.wrapNear(formatNearFromYocto(quote.amountInAtomic));
      const transfer = await this.wallet.transferFungible({
        token: "wrap.near",
        receiverId: quote.depositAddress,
        amountAtomic: quote.amountInAtomic,
      });
      return { txHash: `${wrap.txHash}:${transfer.txHash}` };
    }
    if (quote.originAsset.startsWith("nep141:")) {
      const token = quote.originAsset.slice("nep141:".length);
      const transfer = await this.wallet.transferFungible({
        token,
        receiverId: quote.depositAddress,
        amountAtomic: quote.amountInAtomic,
      });
      return { txHash: transfer.txHash };
    }
    throw new ContractorError(
      "intents_unsupported_origin",
      `origin asset ${quote.originAsset} is not a NEP-141 token; wrap NEAR first or use a supported token`,
    );
  }
}

function formatNearFromYocto(value: string): string {
  const yocto = BigInt(value);
  const base = 10n ** 24n;
  const whole = yocto / base;
  const fraction = (yocto % base).toString().padStart(24, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""}`;
}
