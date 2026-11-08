import { existsSync } from "node:fs";
import { join } from "node:path";

export interface AppConfig {
  marketBaseUrl: string;
  marketMcpToken?: string;
  marketMcpProToken?: string;
  llmApiKey?: string;
  llmBaseUrl: string;
  llmModel: string;
  googleapikey?: string;
  googlebaseurl: string;
  googlemodel: string;
  nearAccountId?: string;
  nearPrivateKey?: string;
  nearRpcUrl: string;
  nearNetwork: string;
  nearIntentsApiKey?: string;
  bidWindowMs: number;
  counterWindowMs: number;
  pollMs: number;
}

export function loadConfig(): AppConfig {
  const envPath = join(process.cwd(), ".env");
  if (existsSync(envPath) && typeof process.loadEnvFile === "function") {
    try {
      process.loadEnvFile(envPath);
    } catch {
      // ignore malformed env files; explicit environment variables still work
    }
  }

  return {
    marketBaseUrl: (process.env.MARKET_BASE_URL ?? "https://market.near.ai").replace(/\/+$/, ""),
    marketMcpToken: process.env.MARKET_MCP_TOKEN,
    marketMcpProToken: process.env.MARKET_MCP_PRO_TOKEN,
    llmApiKey: process.env.LLM_API_KEY,
    llmBaseUrl: (process.env.LLM_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, ""),
    llmModel: process.env.LLM_MODEL ?? "gpt-4.1-mini",
    nearAccountId: process.env.NEAR_ACCOUNT_ID,
    nearPrivateKey: process.env.NEAR_PRIVATE_KEY,
    nearRpcUrl: process.env.NEAR_RPC_URL ?? "https://rpc.mainnet.fastnear.com",
    nearNetwork: process.env.NEAR_NETWORK ?? "mainnet",
    nearIntentsApiKey: process.env.NEAR_INTENTS_API_KEY,
    bidWindowMs: numberEnv("DEFAULT_BID_WINDOW_MS", 120_000),
    counterWindowMs: numberEnv("DEFAULT_COUNTER_WINDOW_MS", 300_000),
    pollMs: numberEnv("DEFAULT_POLL_MS", 10_000),
    googleapikey: process.env.GOOGLE_API_KEY,
    googlebaseurl: process.env.GOOGLE_BASE_URL ?? "https://generativelanguage.googleapis.com",
    googlemodel: process.env.GOOGLE_MODEL ?? "gemini-3.5-flash-lite"
  };
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
