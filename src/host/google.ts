import http from "node:http";
import crypto from "node:crypto";
import { Vault } from "./vault.js";

const GMAIL_API = (process.env.GMAIL_API_BASE ?? "https://gmail.googleapis.com").replace(/\/$/, "");
const TOKEN_URL = process.env.GOOGLE_TOKEN_URL ?? "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const REVOKE_URL = process.env.GOOGLE_REVOKE_URL ?? "https://oauth2.googleapis.com/revoke";

export const SCOPE_SEND = "https://www.googleapis.com/auth/gmail.send";
export const SCOPE_COMPOSE = "https://www.googleapis.com/auth/gmail.compose"; // needed only for drafts

let cached: { token: string; exp: number } | null = null;
export const clearTokenCache = () => {
  cached = null;
};

export class GoogleError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 502,
  ) {
    super(message);
  }
}

export async function getAccessToken(vault: Vault): Promise<string> {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const d = vault.read();
  if (!d.google || !d.oauthClient) throw new GoogleError("not_connected", "Google account is not connected. Run: frogy-host auth-google", 409);
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: d.oauthClient.clientId,
      client_secret: d.oauthClient.clientSecret,
      refresh_token: d.google.refreshToken,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !j.access_token) {
    // invalid_grant => token revoked/expired. Do NOT retry forever; caller pauses and alerts.
    throw new GoogleError(j.error === "invalid_grant" ? "token_invalid" : "token_refresh_failed", `Google token refresh failed (${j.error ?? res.status})`, 502);
  }
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return cached.token;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const encodeHeader = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);

/** Build an RFC 2822 message. Rejects header injection (CR/LF in header values). */
export function buildMime(msg: { to: string[]; subject: string; body: string }): string {
  for (const v of [...msg.to, msg.subject]) if (/[\r\n]/.test(v)) throw new GoogleError("invalid_input", "Line breaks are not allowed in headers", 400);
  const bodyB64 = Buffer.from(msg.body, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
  return [
    `To: ${msg.to.join(", ")}`,
    `Subject: ${encodeHeader(msg.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    bodyB64,
  ].join("\r\n");
}

async function gmail(vault: Vault, path: string, body: unknown): Promise<{ id: string; threadId?: string }> {
  const token = await getAccessToken(vault);
  const res = await fetch(`${GMAIL_API}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const j = (await res.json().catch(() => ({}))) as { id?: string; threadId?: string; error?: { message?: string } };
  if (!res.ok || !j.id) {
    if (res.status === 401) cached = null;
    throw new GoogleError("gmail_error", `Gmail API error ${res.status}: ${j.error?.message ?? "unknown"}`, res.status >= 500 ? 502 : 400);
  }
  return { id: j.id, threadId: j.threadId };
}

export const sendEmail = (vault: Vault, msg: { to: string[]; subject: string; body: string }) =>
  gmail(vault, "/gmail/v1/users/me/messages/send", { raw: b64url(buildMime(msg)) });

export const createDraft = (vault: Vault, msg: { to: string[]; subject: string; body: string }) =>
  gmail(vault, "/gmail/v1/users/me/drafts", { message: { raw: b64url(buildMime(msg)) } });

export async function revokeGoogle(vault: Vault): Promise<void> {
  const d = vault.read();
  if (d.google) {
    await fetch(`${REVOKE_URL}?token=${encodeURIComponent(d.google.refreshToken)}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(15_000),
    }).catch(() => undefined);
  }
  vault.update((x) => {
    delete x.google;
  });
  clearTokenCache();
}

// ---------------- OAuth loopback flow (runs on the host, inside the serve process) ----------------
export interface OAuthSession {
  state: "waiting" | "done" | "error";
  message?: string;
}
let active: { server: http.Server; timer: NodeJS.Timeout } | null = null;
export const oauthStatus: OAuthSession = { state: "done" };

export function startOAuthFlow(vault: Vault, opts: { drafts: boolean; port: number }): string {
  const d = vault.read();
  if (!d.oauthClient) throw new GoogleError("no_client", "Set the OAuth client first: frogy-host set-oauth-client", 409);
  if (active) {
    clearTimeout(active.timer);
    active.server.close();
    active = null;
  }
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const state = crypto.randomBytes(16).toString("hex");
  const redirect = `http://127.0.0.1:${opts.port}/callback`;
  const scopes = [SCOPE_SEND, ...(opts.drafts ? [SCOPE_COMPOSE] : [])];

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", redirect);
    if (u.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const finish = (ok: boolean, msg: string) => {
      oauthStatus.state = ok ? "done" : "error";
      oauthStatus.message = msg;
      res.writeHead(ok ? 200 : 400, { "content-type": "text/plain" }).end(ok ? "Connected. You can close this tab." : `Failed: ${msg}`);
      if (active) {
        clearTimeout(active.timer);
        active.server.close();
        active = null;
      }
    };
    try {
      if (u.searchParams.get("state") !== state) return finish(false, "state mismatch");
      const code = u.searchParams.get("code");
      if (!code) return finish(false, u.searchParams.get("error") ?? "no code");
      const cur = vault.read();
      const tr = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: cur.oauthClient!.clientId,
          client_secret: cur.oauthClient!.clientSecret,
          redirect_uri: redirect,
          grant_type: "authorization_code",
          code_verifier: verifier,
        }),
      });
      const tj = (await tr.json()) as { refresh_token?: string; scope?: string; error?: string };
      if (!tr.ok || !tj.refresh_token) return finish(false, tj.error ?? "no refresh token returned (revoke app access and retry)");
      vault.update((x) => {
        x.google = { refreshToken: tj.refresh_token!, scopes: (tj.scope ?? scopes.join(" ")).split(" "), connectedAt: new Date().toISOString() };
      });
      clearTokenCache();
      finish(true, "connected");
    } catch (e) {
      finish(false, (e as Error).message);
    }
  });
  server.listen(opts.port, "127.0.0.1");
  const timer = setTimeout(() => {
    oauthStatus.state = "error";
    oauthStatus.message = "timed out";
    server.close();
    active = null;
  }, 5 * 60_000);
  active = { server, timer };
  oauthStatus.state = "waiting";
  oauthStatus.message = undefined;

  const q = new URLSearchParams({
    client_id: d.oauthClient.clientId,
    redirect_uri: redirect,
    response_type: "code",
    scope: scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  return `${AUTH_URL}?${q.toString()}`;
}
