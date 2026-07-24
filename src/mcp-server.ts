import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface McpBackend {
  serviceName: string;
  listProviders(): Promise<{ service?: { name?: string }; providers: any[] }>;
  queryProvider(id: string): Promise<any>;
}

function toRfc3339(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function countdown(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (sec || parts.length === 0) parts.push(`${sec}s`);
  return parts.join(" ");
}

export function buildMcpServer(opts: { name: string; idHint: string; backend: McpBackend }): McpServer {
  const { name, idHint, backend } = opts;
  const server = new McpServer({ name, version: "1.0.0" });

  server.tool(
    "list_providers",
    `${name}: list the model providers this monitor tracks and whether each is a subscription quota or a pay-as-you-go balance. Call this first to discover valid provider ids for ${name}.`,
    {},
    async () => {
      const data = await backend.listProviders();
      const lines = (data.providers || []).filter((p: any) => !p.parked).map((p: any) => {
        const lf = p.lastFetch;
        const state = p.parked
          ? "PARKED (needs browser session)"
          : !lf
            ? "pending"
            : lf.error
              ? `ERROR ${lf.error}`
              : `${lf.metrics.length} metrics${lf.plan ? " · plan " + lf.plan : ""}${p.payg ? " · payg:" + p.payg : ""}`;
        return `- ${p.id} (${p.name}): ${state}`;
      });
      return { content: [{ type: "text", text: `# ${name} — monitored providers\n${lines.join("\n")}` }] };
    }
  );

  server.tool(
    "query_provider",
    `${name} models remaining usage report: fetch the current remaining subscription quota (or pay-as-you-go balance / recent spend) for one provider tracked by ${name}. Returns used/total/remaining, percent, reset time and plan. Valid provider ids: ${idHint || "call list_providers"}.`,
    {
      provider: z.string().describe(
        `Provider id as listed by list_providers (${idHint || "e.g. zai, minimax, kimi, deepseek, openrouter"}).`
      ),
    },
    async ({ provider }) => {
      const data = await backend.queryProvider(provider);
      if (data.error) {
        return { content: [{ type: "text", text: `# ${name} — ${provider}\nError: ${data.error}` }] };
      }
      if (data.parked) {
        return {
          content: [{ type: "text", text: `# ${name} — ${provider}\nParked: this provider is not actively monitored (it requires a live browser session). It is excluded from list_providers and has no queryable usage.` }],
        };
      }
      const lines = (data.metrics || []).map((m: any) => {
        const rfc = toRfc3339(m.resetsAt);
        const cd = typeof m.resetsAt === "number" ? countdown(m.resetsAt - Date.now()) : null;
        const reset = rfc ? ` resets ${rfc}${cd ? ` (in ${cd})` : ""}` : "";

        // Callers otherwise guess what a quota measures from its name alone.
        const extra: string[] = [];
        if (m.note) extra.push(`      what this measures: ${m.note}`);
        if (m.breakdown && Object.keys(m.breakdown).length > 0) {
          const parts = Object.entries(m.breakdown)
            .map(([k, v]) => `${k} ${Number(v).toLocaleString()}`)
            .join(", ");
          extra.push(`      breakdown: ${parts}`);
        }
        const suffix = extra.length > 0 ? `\n${extra.join("\n")}` : "";

        if (m.unit === "%") {
          return `  ${m.name} [${m.window || "n/a"}]: ${m.used}% used, ${m.remaining}% remaining${reset}${suffix}`;
        }
        const unit = m.unit ? ` ${m.unit}` : "";
        if (m.used === null && m.remaining === null && m.total !== null) {
          return `  ${m.name} [${m.window || "n/a"}]: ${m.total.toLocaleString()}${unit} available${reset}${suffix}`;
        }
        const pct = m.percent !== null ? ` (${m.percent.toFixed(1)}%)` : "";
        const used = m.used !== null ? m.used.toLocaleString() : "?";
        const total = m.total !== null ? m.total.toLocaleString() : "?";
        const remaining = m.remaining !== null ? m.remaining.toLocaleString() : "?";
        return `  ${m.name} [${m.window || "n/a"}]: ${used}/${total} used, ${remaining} remaining${unit}${pct}${reset}${suffix}`;
      });
      const head = `${data.name} (${data.providerType})${data.plan ? " — plan " + data.plan : ""}`;
      return {
        content: [{ type: "text", text: `# ${name} — remaining usage\n${head}\n${lines.join("\n") || "  (no metrics)"}` }],
      };
    }
  );

  return server;
}
