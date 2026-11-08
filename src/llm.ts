import { ContractorError } from "./errors.js";

export abstract class LlmClient {

  protected readonly baseUrl: string;
  protected readonly apiKey?: string;
  protected readonly model: string;

  constructor(options: { baseUrl: string; apiKey?: string; model: string }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model;

  }

  abstract complete(input: { system: string; user: string; temperature?: number }, round?: number): Promise<string>;
}

export class OpenAiCompatibleLlm extends LlmClient {

  async complete(input: { system: string; user: string; temperature?: number }): Promise<string> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        temperature: input.temperature ?? 0.2,
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.user },
        ],
      }),
    });
    if (!response.ok) {
      throw new ContractorError(
        "llm_request_failed",
        `LLM request failed: ${response.status} ${await response.text()}`,
      );
    }
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new ContractorError("llm_empty_response", "LLM returned no content");
    return content;
  }
}

export class GoogleCompatibleLlm extends LlmClient {

  async complete(input: { system: string; user: string; temperature?: number }): Promise<string> {
    const response = await fetch(`${this.baseUrl}/v1beta/models/${this.model}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-goog-api-key": this.apiKey,
      },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [{ text: `${input.system}\n\n${input.user}` }],
        }],
        generationConfig: {
          temperature: input.temperature ?? 0.2,
        },
      }),
    });
    if (!response.ok) {
      throw new ContractorError(
        "llm_request_failed",
        `LLM request failed: ${response.status} ${await response.text()}`,
      );
    }
    const payload = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const content = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
    if (!content) throw new ContractorError("llm_empty_response", "LLM returned no content");
    return content;
  }
}
export function extractJson<T>(text: string): T {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) return JSON.parse(fenced[1]) as T;
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1)) as T;
    throw new ContractorError("invalid_json", `could not parse JSON from model output: ${trimmed.slice(0, 300)}`);
  }
}
