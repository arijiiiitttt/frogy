import { env, requireEnv } from "../shared/util.js";

export class HostError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public data?: Record<string, unknown>,
  ) {
    super(message);
  }
}

async function hostFetch(path: string, init: RequestInit): Promise<Record<string, any>> {
  const base = requireEnv("HOST_URL").replace(/\/$/, "");
  const token = requireEnv("HOST_TOKEN");
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      ...init,
      headers: { ...(init.body === undefined ? {} : { "content-type": "application/json" }), authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(Number(env("HOST_TIMEOUT_MS", "90000"))),
    });
  } catch (e) {
    throw new HostError(0, "unreachable", `Host unreachable: ${(e as Error).message}`);
  }
  let json: Record<string, any> = {};
  try {
    json = (await res.json()) as Record<string, any>;
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) throw new HostError(res.status, String(json.error ?? "host_error"), String(json.message ?? `Host returned ${res.status}`), json);
  return json;
}

export interface ActionCall {
  input: unknown;
  dryRun: boolean;
  idempotencyKey: string;
  taskId: string;
}

export const callHostAction = (name: string, call: ActionCall) =>
  hostFetch(`/actions/${encodeURIComponent(name)}`, { method: "POST", body: JSON.stringify(call) });

export const hostStatus = () => hostFetch("/status", { method: "GET" });
