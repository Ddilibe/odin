export class ContractorError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ContractorError";
    this.code = code;
    this.details = details;
  }
}

export class BudgetExceededError extends ContractorError {
  constructor(message: string, details?: unknown) {
    super("budget_exceeded", message, details);
    this.name = "BudgetExceededError";
  }
}

export class ApprovalRequiredError extends ContractorError {
  constructor(message: string, details?: unknown) {
    super("approval_required", message, details);
    this.name = "ApprovalRequiredError";
  }
}

export class MarketToolError extends ContractorError {
  constructor(message: string, details?: unknown) {
    super("market_tool_error", message, details);
    this.name = "MarketToolError";
  }
}

export class VerificationError extends ContractorError {
  constructor(message: string, details?: unknown) {
    super("verification_failed", message, details);
    this.name = "VerificationError";
  }
}

export class NoQualifiedBidError extends ContractorError {
  constructor(message: string, details?: unknown) {
    super("no_qualified_bid", message, details);
    this.name = "NoQualifiedBidError";
  }
}
