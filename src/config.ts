import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import "dotenv/config";
import type { AppConfig } from "./types.js";

function interpolateEnv(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] || "");
}

function interpolateDeep(obj: unknown): unknown {
  if (typeof obj === "string") return interpolateEnv(obj);
  if (Array.isArray(obj)) return obj.map(interpolateDeep);
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = interpolateDeep(v);
    return out;
  }
  return obj;
}

export function resolveEnvVar(envKey: string): string {
  return process.env[envKey] || "";
}

export function loadConfig(configPath?: string): AppConfig {
  const p = resolve(configPath || process.env.AI_USAGE_CONFIG || "config.json");
  const raw = JSON.parse(readFileSync(p, "utf-8"));
  return interpolateDeep(raw) as AppConfig;
}
