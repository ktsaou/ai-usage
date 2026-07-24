import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildMcpServer, type McpBackend } from "./mcp-server.js";

const DAEMON_URL = process.env.AI_USAGE_DAEMON_URL || "http://localhost:9199";

async function fetchJson(path: string, init?: RequestInit): Promise<any> {
  const r = await fetch(`${DAEMON_URL}${path}`, init);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${path}`);
  return r.json();
}

async function fetchMeta(): Promise<{ name: string; ids: string }> {
  for (let i = 0; i < 8; i++) {
    try {
      const d = await fetchJson("/api/providers");
      const svc = d.service || {};
      return {
        name: svc.name || "ai-usage",
        ids: (d.providers || []).filter((p: any) => !p.parked).map((p: any) => p.id).join(", "),
      };
    } catch {
      await new Promise((res) => setTimeout(res, 1000));
    }
  }
  return { name: "ai-usage", ids: "" };
}

const meta = await fetchMeta();

const backend: McpBackend = {
  serviceName: meta.name,
  listProviders: () => fetchJson("/api/providers"),
  queryProvider: (id) => fetchJson(`/api/query/${encodeURIComponent(id)}`, { method: "POST" }),
};

const server = buildMcpServer({ name: meta.name, idHint: meta.ids, backend });
const transport = new StdioServerTransport();
await server.connect(transport);
