import type { Subtask, TaskRequest } from "../types.js";

export interface PaymentResolver {
  resolveMarketplaceRail(input: { request: TaskRequest; subtask: Subtask }): Promise<"USD" | "USDC">;
}

export class DefaultPaymentResolver implements PaymentResolver {
  async resolveMarketplaceRail(): Promise<"USD" | "USDC"> {
    return "USDC";
  }
}

export class StaticPaymentResolver implements PaymentResolver {
  private readonly token: "USD" | "USDC";

  constructor(token: "USD" | "USDC") {
    this.token = token;
  }

  async resolveMarketplaceRail(): Promise<"USD" | "USDC"> {
    return this.token;
  }
}
