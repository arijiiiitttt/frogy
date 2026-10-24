import fs from "node:fs";
import { z } from "zod";
import { env } from "../shared/util.js";
import type { GatewayConfig } from "./types.js";

const Provider = z.object({ type: z.enum(["openai-compat", "anthropic", "gemini"]), baseUrl: z.string().url().optional(), keyEnv: z.string() });
const Schema = z.object({
  providers: z.record(z.string(), Provider),
  tiers: z.object({ cheap: z.array(z.string()).default([]), mid: z.array(z.string()).default([]), strong: z.array(z.string()).default([]) }),
  fallbackVia: z.string().optional(),
  aliases: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  prices: z.record(z.string(), z.object({ in: z.number().nonnegative(), out: z.number().nonnegative() })).optional(),
});

/** Load the gateway config. Returns null when no config file exists (LLM features stay disabled). */
export function loadGatewayConfig(): GatewayConfig | null {
  const file = env("FROGY_CONFIG", "./frogy.config.json")!;
  if (!fs.existsSync(file)) return null;
  const parsed = Schema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  return parsed as GatewayConfig;
}
