import {
  Account,
  JsonRpcProvider,
  KeyPair,
  KeyPairSigner,
  actions,
  encodeSignedDelegate,
} from "near-api-js";
import type { AppConfig } from "../config.js";
import { ContractorError } from "../errors.js";
import { formatNear, parseNear } from "../money.js";

export interface NearTransferResult {
  txHash: string;
  raw: unknown;
}

export class NearWallet {
  private readonly accountId: string;
  private readonly provider: JsonRpcProvider;
  private readonly signer: KeyPairSigner;
  private readonly account: Account;

  constructor(config: Pick<AppConfig, "nearAccountId" | "nearPrivateKey" | "nearRpcUrl">) {
    if (!config.nearAccountId || !config.nearPrivateKey) {
      throw new ContractorError(
        "near_wallet_missing",
        "NEAR_ACCOUNT_ID and NEAR_PRIVATE_KEY are required for x402 or native NEAR payments",
      );
    }
    this.accountId = config.nearAccountId;
    this.provider = new JsonRpcProvider({ url: config.nearRpcUrl });
    this.signer = new KeyPairSigner(KeyPair.fromString(config.nearPrivateKey as never));
    this.account = new Account(this.accountId, this.provider, this.signer);
  }

  get address(): string {
    return this.accountId;
  }

  async signX402Delegate(input: {
    asset: string;
    payTo: string;
    amountAtomic: string;
    maxTimeoutSeconds: number;
  }): Promise<string> {
    const { signedDelegate } = await this.account.createSignedMetaTransaction({
      receiverId: input.asset,
      actions: [
        actions.functionCall(
          "ft_transfer",
          { receiver_id: input.payTo, amount: input.amountAtomic },
          30_000_000_000_000n,
          1n,
        ),
      ],
      blockHeightTtl: input.maxTimeoutSeconds,
      signer: this.signer,
    });
    return Buffer.from(encodeSignedDelegate(signedDelegate)).toString("base64");
  }

  async sendNear(receiverId: string, amountNear: string): Promise<NearTransferResult> {
    const amount = parseNear(amountNear);
    if (amount <= 0n) throw new ContractorError("invalid_amount", "NEAR amount must be positive");
    const raw = await this.account.transfer({ receiverId, amount });
    return { txHash: transactionHash(raw), raw };
  }

  async transferFungible(input: { token: string; receiverId: string; amountAtomic: string }): Promise<NearTransferResult> {
    const raw = await this.account.signAndSendTransaction({
      receiverId: input.token,
      actions: [
        actions.functionCall(
          "ft_transfer",
          { receiver_id: input.receiverId, amount: input.amountAtomic },
          30_000_000_000_000n,
          1n,
        ),
      ],
    });
    return { txHash: transactionHash(raw), raw };
  }

  async wrapNear(amountNear: string): Promise<NearTransferResult> {
    const amount = parseNear(amountNear);
    if (amount <= 0n) throw new ContractorError("invalid_amount", "NEAR amount must be positive");
    const raw = await this.account.signAndSendTransaction({
      receiverId: "wrap.near",
      actions: [actions.functionCall("near_deposit", {}, 30_000_000_000_000n, amount)],
    });
    return { txHash: transactionHash(raw), raw };
  }

  describe(amountNear: string): string {
    return `${formatNear(parseNear(amountNear))} NEAR from ${this.accountId}`;
  }
}

export function transactionHash(result: unknown): string {
  const raw = result as unknown as {
    transaction?: { hash?: string };
    transaction_outcome?: { id?: string };
    final_execution_outcome?: { final_execution_outcome?: { id?: string } };
  };
  return raw.transaction?.hash ?? raw.transaction_outcome?.id ?? raw.final_execution_outcome?.final_execution_outcome?.id ?? "unknown";
}
