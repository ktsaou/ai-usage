import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DAEMON_URL = process.env.AI_USAGE_DAEMON_URL || "http://localhost:9199";
const API_KEY = process.env.AI_USAGE_INGEST_KEY || "";
const AGENT_NAME = process.env.AI_USAGE_AGENT_NAME || "unknown";
const INTERVAL = Number(process.env.AI_USAGE_AGENT_INTERVAL || "60") * 1000;

if (!API_KEY) {
  console.error("AI_USAGE_INGEST_KEY not set");
  process.exit(1);
}

interface TokenSource {
  name: string;
  paths: string[];
  extractToken: (content: string) => string | null;
  fetchUsage: (token: string) => Promise<any>;
}

const sources: TokenSource[] = [
  {
    name: "claude",
    paths: [
      join(homedir(), ".claude", ".credentials.json"),
      join(homedir(), ".claude", "credentials.json"),
    ],
    extractToken: (content) => {
      try {
        const data = JSON.parse(content);
        return data.accessToken || data.access_token || null;
      } catch { return null; }
    },
    fetchUsage: async (token) => {
      const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
          "User-Agent": "claude-code/1.0",
        },
      });
      if (!res.ok) return null;
      return res.json();
    },
  },
  {
    name: "codex",
    paths: [
      join(homedir(), ".codex", "auth.json"),
      join(homedir(), ".codex", ".credentials.json"),
      join(homedir(), ".config", "codex", "auth.json"),
    ],
    extractToken: (content) => {
      try {
        const data = JSON.parse(content);
        return data.accessToken || data.access_token || data.token || null;
      } catch { return null; }
    },
    fetchUsage: async (token) => {
      const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return null;
      return res.json();
    },
  },
];

function findToken(source: TokenSource): string | null {
  for (const p of source.paths) {
    if (existsSync(p)) {
      try {
        const content = readFileSync(p, "utf-8");
        const token = source.extractToken(content);
        if (token) return token;
      } catch {}
    }
  }
  return null;
}

function parseClaudeUsage(data: any): any[] {
  const metrics = [];
  if (data.five_hour) {
    metrics.push({
      name: "5h_quota",
      used: data.five_hour.utilization ?? null,
      total: 100,
      remaining: data.five_hour.utilization !== undefined ? 100 - data.five_hour.utilization : null,
      percent: data.five_hour.utilization ?? null,
      unit: "%",
      window: "5h",
      resetsAt: data.five_hour.resets_at ? new Date(data.five_hour.resets_at).getTime() : null,
    });
  }
  if (data.seven_day) {
    metrics.push({
      name: "weekly_quota",
      used: data.seven_day.utilization ?? null,
      total: 100,
      remaining: data.seven_day.utilization !== undefined ? 100 - data.seven_day.utilization : null,
      percent: data.seven_day.utilization ?? null,
      unit: "%",
      window: "weekly",
      resetsAt: data.seven_day.resets_at ? new Date(data.seven_day.resets_at).getTime() : null,
    });
  }
  return metrics;
}

function parseCodexUsage(data: any): any[] {
  const metrics = [];
  if (data.rate_limit || data.rateLimit) {
    const rl = data.rate_limit || data.rateLimit;
    metrics.push({
      name: "session_quota",
      used: rl.limit_reached || rl.limitReached ? 100 : 0,
      total: 100,
      remaining: null,
      percent: null,
      unit: "%",
      window: "session",
      resetsAt: null,
    });
  }
  return metrics;
}

async function collect(): Promise<void> {
  for (const source of sources) {
    const token = findToken(source);
    if (!token) continue;

    try {
      const data = await source.fetchUsage(token);
      if (!data) continue;

      const metrics = source.name === "claude" ? parseClaudeUsage(data) : parseCodexUsage(data);
      if (metrics.length === 0) continue;

      const res = await fetch(`${DAEMON_URL}/api/ingest`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
          agent: AGENT_NAME,
          provider: source.name,
          metrics,
          timestamp: Date.now(),
        }),
      });

      const result = await res.json();
      if (result.ok) {
        console.log(`[${new Date().toISOString()}] ${source.name}: ${metrics.length} metrics sent`);
      } else {
        console.error(`[${new Date().toISOString()}] ${source.name}: ingest failed: ${JSON.stringify(result)}`);
      }
    } catch (err: any) {
      console.error(`[${new Date().toISOString()}] ${source.name}: ${err.message}`);
    }
  }
}

console.log(`[agent] ${AGENT_NAME} → ${DAEMON_URL} (interval: ${INTERVAL / 1000}s)`);
collect();
setInterval(collect, INTERVAL);
