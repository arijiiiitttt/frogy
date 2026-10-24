import { z } from "zod";

const noCrlf = (v: string) => !/[\r\n]/.test(v);
const emailAddr = z.string().max(254).email().refine(noCrlf, "no line breaks allowed");

export const EmailSendInput = z.object({
  to: z.preprocess(
    (v) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : v),
    z.array(emailAddr).min(1).max(20),
  ),
  subject: z.string().max(998).refine(noCrlf, "no line breaks allowed"),
  body: z.string().max(100_000),
  draft: z.preprocess((v) => (v === "true" ? true : v === "false" ? false : v), z.boolean().optional()),
});
export type EmailSendInputT = z.infer<typeof EmailSendInput>;

export const ScriptRunInput = z.object({
  name: z.string().regex(/^[a-z0-9._-]{1,64}$/i),
  args: z.preprocess(
    (v) => (typeof v === "string" ? v.split(" ").filter(Boolean) : v),
    z.array(z.string().max(200)).max(20).optional(),
  ),
});

export const InstagramUnfollowInput = z.object({ username: z.string().regex(/^[A-Za-z0-9._]{1,30}$/) });
export const LinkedinRemoveInput = z.object({
  profileUrl: z.string().url().regex(/^https:\/\/([a-z]+\.)?linkedin\.com\/in\//i),
});

export const SandboxExecInput = z.object({
  workspace: z.string().regex(/^[a-z0-9][a-z0-9-]{7,63}$/),
  command: z.string().min(1).max(4000),
});

export interface ActionDef {
  name: string;
  description: string;
  /** Short input description used by the intent parser (the only place AI sees action shapes). */
  hint: string;
  risk: "low" | "destructive";
  defaultDailyLimit: number;
  schema: z.ZodType<unknown>;
}

export const ACTIONS: Record<string, ActionDef> = {
  "email.send": {
    name: "email.send",
    description: "Send (or draft) an email from the connected Google account via the credential broker.",
    hint: '{"to": ["a@b.com"], "subject": "string", "body": "string", "draft": false}',
    risk: "low",
    defaultDailyLimit: 50,
    schema: EmailSendInput,
  },
  "script.run": {
    name: "script.run",
    description: "Run a pre-approved script by name on the host (allowlist in host config).",
    hint: '{"name": "script-name", "args": ["optional"]}',
    risk: "low",
    defaultDailyLimit: 200,
    schema: ScriptRunInput,
  },
  "sandbox.exec": {
    name: "sandbox.exec",
    description: "Run a shell command inside an isolated Docker sandbox (no network by default, persistent /workspace). Disabled unless enabled on the host.",
    hint: '{"workspace": "8-64 chars [a-z0-9-]", "command": "shell command"}',
    risk: "destructive",
    defaultDailyLimit: 200,
    schema: SandboxExecInput,
  },
  "instagram.unfollow": {
    name: "instagram.unfollow",
    description: "OPT-IN, DISABLED BY DEFAULT. Unfollow an Instagram account. Violates platform terms; may restrict your account.",
    hint: '{"username": "handle"}',
    risk: "destructive",
    defaultDailyLimit: 20,
    schema: InstagramUnfollowInput,
  },
  "linkedin.remove_connection": {
    name: "linkedin.remove_connection",
    description: "OPT-IN, DISABLED BY DEFAULT. Remove a LinkedIn connection. Violates platform terms; may restrict your account.",
    hint: '{"profileUrl": "https://www.linkedin.com/in/..."}',
    risk: "destructive",
    defaultDailyLimit: 10,
    schema: LinkedinRemoveInput,
  },
};

export const getAction = (name: string): ActionDef | undefined => ACTIONS[name];
export const listActions = (): ActionDef[] => Object.values(ACTIONS);

export function validateInput(name: string, input: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  const def = ACTIONS[name];
  if (!def) return { ok: false, error: `Unknown action: ${name}` };
  const r = def.schema.safeParse(input ?? {});
  if (!r.success) return { ok: false, error: r.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") };
  return { ok: true, value: r.data };
}
