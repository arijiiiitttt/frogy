import type { ChatMessage, ChatRequest, ChatResult, Tier, ToolDef } from "../gateway/types.js";

export interface AgentState {
  messages: ChatMessage[];
  step: number;
  tokensUsed: number;
  tier: Tier;
  escalatedUntil: number;
  escalations: number;
  recent: string[];
  consecutiveErrors: number;
  wantPlan: boolean;
  planned: boolean;
  /** Ask a second (mid-tier) model to review the final result once; send the agent back if it is wrong. */
  verify: boolean;
  verified: boolean;
  /** Free-form state tools may persist across waits (e.g. when a question was asked). */
  meta: Record<string, unknown>;
}

export interface ToolCtx {
  toolCallId: string;
  meta: Record<string, unknown>;
  /** True once this run has read untrusted content (web pages, MCP output, suspicious text, tainted sub-agents). */
  tainted: boolean;
  /** Side-effecting tools call this before acting. When the run is tainted and the policy is "approve", it waits for the owner (throws Wait) or throws if denied. */
  approve(summary: string): Promise<void>;
}
export interface AgentTool {
  /** Reading this tool's output taints the run. */
  taints?: boolean;
  def: ToolDef;
  run(args: Record<string, unknown>, ctx: ToolCtx): Promise<string>;
}

export interface AgentLimits {
  maxSteps: number;
  maxTokens: number;
  compactAtChars: number;
  keepLast: number;
}

export interface AgentDeps {
  chat(req: ChatRequest): Promise<ChatResult>;
  tools: Record<string, AgentTool>;
  save(state: AgentState): Promise<void>;
  isStopped(): Promise<boolean>;
  event(type: string, payload: Record<string, unknown>): Promise<void>;
  limits: AgentLimits;
  /** approve: tainted runs need owner approval for side effects. flag: only record the taint. off: nothing. Default off. */
  taintPolicy?: "approve" | "flag" | "off";
  approval?(call: { toolCallId: string; name: string }, summary: string): Promise<"approved" | "pending" | "denied">;
}

export type AgentOutcome = { status: "done"; result: string } | { status: "failed"; error: string } | { status: "stopped" };
