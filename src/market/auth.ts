import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { contractorHome, readJson, writeJson } from "../storage.js";

interface StoredAuth {
  baseUrl: string;
  clientId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
}

interface OAuthMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  scopes_supported?: string[];
}

function base64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function authPath(): string {
  return join(contractorHome(), "market-auth.json");
}

export class MarketAuth {
  private readonly baseUrl: string;
  private stored: StoredAuth | undefined;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.stored = readJson<StoredAuth | undefined>(authPath(), undefined);
    if (this.stored && this.stored.baseUrl !== this.baseUrl) {
      this.stored = undefined;
    }
  }

  static fromEnvironment(baseUrl: string, token?: string): MarketAuth {
    const auth = new MarketAuth(baseUrl);
    if (token) auth.stored = { baseUrl, clientId: "environment", accessToken: token };
    return auth;
  }

  hasStoredAuth(): boolean {
    return Boolean(this.stored?.accessToken);
  }

  async accessToken(): Promise<string> {
    if (!this.stored?.accessToken) {
      throw new Error("not logged in to Agent Market; run `npm run dev -- login` or set MARKET_MCP_TOKEN");
    }
    if (this.stored.expiresAt && this.stored.expiresAt <= Date.now() + 60_000 && this.stored.refreshToken) {
      await this.refresh();
    }
    return this.stored.accessToken;
  }

  async login(options: { port?: number; scope?: string } = {}): Promise<StoredAuth> {
    const metadata = await this.discover();
    const port = options.port ?? Number(process.env.OAUTH_PORT ?? 8787);
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    const registration = metadata.registration_endpoint
      ? await this.register(metadata.registration_endpoint, redirectUri)
      : { client_id: "contractor-agent" };
    const clientId = registration.client_id;
    const { verifier, challenge } = pkce();
    const state = base64url(randomBytes(24));
    const scope = options.scope ?? "mcp hiring";

    const authorizationUrl = new URL(metadata.authorization_endpoint);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("client_id", clientId);
    authorizationUrl.searchParams.set("redirect_uri", redirectUri);
    authorizationUrl.searchParams.set("scope", scope);
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("code_challenge", challenge);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    authorizationUrl.searchParams.set("resource", `${this.baseUrl}/mcp`);

    const code = await new Promise<string>((resolve, reject) => {
      const server = createServer((request, response) => {
        const url = new URL(request.url ?? "/", redirectUri);
        if (url.pathname !== "/callback") {
          response.writeHead(404).end("not found");
          return;
        }
        const returnedState = url.searchParams.get("state");
        const error = url.searchParams.get("error");
        if (error) {
          response.writeHead(400, { "content-type": "text/plain" });
          response.end(`Authorization failed: ${error}`);
          server.close();
          reject(new Error(`authorization failed: ${error}`));
          return;
        }
        if (returnedState !== state) {
          response.writeHead(400, { "content-type": "text/plain" });
          response.end("State mismatch");
          server.close();
          reject(new Error("oauth state mismatch"));
          return;
        }
        const received = url.searchParams.get("code");
        if (!received) {
          response.writeHead(400, { "content-type": "text/plain" });
          response.end("Missing code");
          server.close();
          reject(new Error("oauth response had no code"));
          return;
        }
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<h2>Agent Market connected</h2><p>You can close this window.</p>");
        server.close();
        resolve(received);
      });
      server.on("error", reject);
      server.listen(port, "127.0.0.1", async () => {
        process.stdout.write(`Open this URL to authorize Agent Market:\n\n${authorizationUrl.toString()}\n\n`);
        await openBrowser(authorizationUrl.toString());
      });
      setTimeout(() => {
        server.close();
        reject(new Error("timed out waiting for OAuth callback"));
      }, 5 * 60_000).unref();
    });

    const token = await this.exchangeCode({
      tokenEndpoint: metadata.token_endpoint,
      clientId,
      code,
      redirectUri,
      verifier,
    });
    this.stored = {
      baseUrl: this.baseUrl,
      clientId,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : undefined,
      scope: token.scope,
    };
    writeJson(authPath(), this.stored);
    return this.stored;
  }

  private async refresh(): Promise<void> {
    if (!this.stored?.refreshToken) return;
    const metadata = await this.discover();
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.stored.refreshToken,
      client_id: this.stored.clientId,
    });
    const response = await fetch(metadata.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) {
      throw new Error(`could not refresh Agent Market token: ${response.status} ${await response.text()}`);
    }
    const token = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
    this.stored = {
      ...this.stored,
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? this.stored.refreshToken,
      expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : undefined,
      scope: token.scope ?? this.stored.scope,
    };
    writeJson(authPath(), this.stored);
  }

  private async discover(): Promise<OAuthMetadata> {
    const response = await fetch(`${this.baseUrl}/.well-known/oauth-authorization-server`);
    if (!response.ok) throw new Error(`could not discover OAuth server: ${response.status}`);
    const data = await response.json();
    console.log(data)
    return (data) as OAuthMetadata;
  }

  private async register(registrationEndpoint: string, redirectUri: string): Promise<{ client_id: string }> {
    const response = await fetch(registrationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "contractor-agent",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    if (!response.ok) throw new Error(`could not register OAuth client: ${response.status} ${await response.text()}`);
    return (await response.json()) as { client_id: string };
  }

  private async exchangeCode(input: {
    tokenEndpoint: string;
    clientId: string;
    code: string;
    redirectUri: string;
    verifier: string;
  }): Promise<{ access_token: string; refresh_token?: string; expires_in?: number; scope?: string }> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
      code_verifier: input.verifier,
    });
    const response = await fetch(input.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) throw new Error(`token exchange failed: ${response.status} ${await response.text()}`);
    return (await response.json()) as { access_token: string; refresh_token?: string; expires_in?: number; scope?: string };
  }
}

async function openBrowser(url: string): Promise<void> {
  if (process.env.CONTRACTOR_NO_BROWSER === "1") return;
  const command =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    const child = spawn(command[0] as string, command[1] as string[], { stdio: "ignore", detached: true });
    child.unref();
  } catch {
    // the URL is already printed for manual opening
  }
}
