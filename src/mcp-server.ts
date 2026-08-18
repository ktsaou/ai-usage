import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface McpBackend {
  serviceName: string;
  listProviders(): Promise<{ service?: { name?: string }; providers: any[] }>;
  queryProvider(id: string): Promise<any>;
}

const RANK: Record<string, number> = { ok: 0, warn: 1, crit: 2 };
const LABEL: Record<string, string> = { ok: "ok", warn: "elevated", crit: "at risk" };

function toRfc3339(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * The plan's own deadline. Worth a line of its own: a plan that ends without
 * renewing takes every quota on it, however healthy those look.
 */
function planLine(risk: any): string | null {
  const s = risk?.subscription;
  if (!s || (!s.endsAt && !s.status)) return null;
  const parts: string[] = [];
  if (s.endsAt) {
    const cd = countdown(s.endsAt - Date.now());
    parts.push(`plan ends ${toRfc3339(s.endsAt)} (in ${cd})`);
  }
  if (s.autoRenew === true) parts.push("auto-renews");
  else if (s.autoRenew === false) parts.push("auto-renewal OFF");
  if (s.status && s.status !== "VALID") parts.push(`status ${s.status}`);
  // The provider's level is the worse of its binding window and its plan. When
  // the plan is the worse one, no quota line shows it, so say it here.
  if (risk.binding && RANK[s.level] > RANK[risk.binding.level]) {
    parts.push(`this puts the provider at ${LABEL[s.level] || s.level}`);
  }
  return parts.join(" · ");
}

/** The one duration format, from a figure already measured in hours. */
function hours(h: number | null | undefined): string | null {
  if (h === null || h === undefined || !Number.isFinite(h)) return null;
  return countdown(h * 3600000);
}

/**
 * How long the burn ratio is measured against. Only needed where the reset time
 * is not already on the line.
 */
function deadline(risk: any): string {
  if (!risk) return "";
  if (risk.rolling) return " (trailing window, no reset)";
  const h = hours(risk.horizonHours);
  if (!h) return "";
  // A pool covering a spent window does not reset; it has to reach the moment
  // that window does, and saying "resets in" would claim the opposite.
  return risk.bridging ? ` (must last ${h}, until the spent window resets)` : ` (resets in ${h})`;
}

/** A rate that rounds to zero is not zero, and saying "0.0%/h" claims it is. */
function rate(r: number): string {
  return r > 0 && r < 0.05 ? "<0.1%/h" : `${r.toFixed(1)}%/h`;
}

/**
 * The burn figures, in the order a caller needs them: how fast it is going, how
 * long that leaves, and whether that beats the reset. Stated as measurements,
 * never as advice — what a caller should do with a quota depends on what they
 * are about to run, which this server cannot know.
 */
function burnSummary(risk: any): string | null {
  if (!risk) return null;
  const parts: string[] = [`risk ${LABEL[risk.level] || risk.level}`];

  const now = risk.ratePerHour;
  const peak = risk.peakRatePerHour;
  if (now === 0) parts.push("idle");
  else if (now !== null && now !== undefined) parts.push(`burn ${rate(now)}`);
  if (peak > 0 && peak > now) parts.push(`peak 24h ${rate(peak)}`);

  const head = risk.headroomHours > 0 ? hours(risk.headroomHours) : null;
  if (head) parts.push(`headroom ${head}`);
  // The peak-rate headroom is only worth stating when a resumed burst would
  // actually beat the deadline; otherwise it is a large number about nothing.
  const peakHead = hours(risk.peakHeadroomHours);
  if (peakHead && risk.peakHeadroomHours > 0 && risk.horizonHours && risk.peakHeadroomHours < risk.horizonHours) {
    parts.push(`${peakHead} at peak pace`);
  }
  if (risk.burnRatio !== null && risk.burnRatio !== undefined) {
    parts.push(`burn ratio ${risk.burnRatio.toFixed(2)}x`);
  }
  return parts.join(" · ");
}

/**
 * Every duration this project prints, in one format: at most two units, largest
 * first. There used to be a second, decimal one (`1.8h`, `2.4d`) for derived
 * figures, which meant a reader comparing "empty in 1.8h" against "resets in
 * 1h 28m" had to convert one of them — at exactly the moment those two numbers
 * are worth comparing. Mirrored by fmtCountdown() in src/dashboard.html.
 */
export function countdown(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function buildMcpServer(opts: { name: string; idHint: string; backend: McpBackend }): McpServer {
  const { name, idHint, backend } = opts;
  const server = new McpServer({ name, version: "1.0.0" });

  server.tool(
    "list_providers",
    `${name}: list the model providers this monitor tracks, whether each is a subscription quota or a pay-as-you-go balance, and how fast each is being consumed — burn ratio and remaining headroom in hours. Call this first to discover valid provider ids for ${name}.`,
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
        // The binding window's burn figures: the provider's risk is whichever
        // of its windows runs out first, so that is the one worth listing.
        const burn = lf && !lf.error ? burnSummary(p.risk?.binding) : null;
        const detail = burn ? `\n    ${p.risk.metric}${deadline(p.risk.binding)}: ${burn}` : "";
        const plan = lf && !lf.error ? planLine(p.risk) : null;
        return `- ${p.id} (${p.name}): ${state}${detail}${plan ? `\n    ${plan}` : ""}`;
      });
      const legend =
        "burn ratio = current pace / the pace this quota can afford until its deadline (its reset, or for a pool covering a spent window, that window's reset); above 1 means it runs out first. headroom = time until exhausted at the current pace.";
      return {
        content: [
          { type: "text", text: `# ${name} — monitored providers\n${lines.join("\n")}\n\n${legend}` },
        ],
      };
    }
  );

  server.tool(
    "query_provider",
    `${name} models remaining usage report: fetch the current remaining subscription quota (or pay-as-you-go balance / recent spend) for one provider tracked by ${name}. Returns used/total/remaining, percent, reset time, plan, and per window how fast it is being consumed — burn rate, peak rate of the last 24h, headroom in hours and burn ratio. Valid provider ids: ${idHint || "call list_providers"}.`,
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
        // Some allowances expire instead of resetting — nothing comes back after.
        const exp = toRfc3339(m.expiresAt);
        const expCd = typeof m.expiresAt === "number" ? countdown(m.expiresAt - Date.now()) : null;
        const reset = rfc
          ? ` resets ${rfc}${cd ? ` (in ${cd})` : ""}`
          : exp
            ? ` expires ${exp}${expCd ? ` (in ${expCd})` : ""}`
            : "";

        // Callers otherwise guess what a quota measures from its name alone.
        const extra: string[] = [];
        const burn = burnSummary(m.risk);
        // A bridging pool's ratio is measured against the covered window's reset,
        // which appears nowhere else on this line — the only date here is the
        // pack expiry, so without this the ratio reads against the wrong horizon.
        if (burn) extra.push(`      ${burn}${m.risk?.bridging ? deadline(m.risk) : ""}`);
        if (m.note) extra.push(`      what this measures: ${m.note}`);
        if (m.breakdown && Object.keys(m.breakdown).length > 0) {
          const parts = Object.entries(m.breakdown)
            .map(([k, v]) => `${k} ${Number(v).toLocaleString()}`)
            .join(", ");
          extra.push(`      breakdown: ${parts}`);
        }
        const suffix = extra.length > 0 ? `\n${extra.join("\n")}` : "";

        if (m.unit === "%") {
          return `  ${m.name}${m.window ? ` [${m.window}]` : ""}: ${m.used}% used, ${m.remaining}% remaining${reset}${suffix}`;
        }
        const unit = m.unit ? ` ${m.unit}` : "";
        if (m.used === null && m.remaining === null && m.total !== null) {
          return `  ${m.name}${m.window ? ` [${m.window}]` : ""}: ${m.total.toLocaleString()}${unit} available${reset}${suffix}`;
        }
        const pct = m.percent !== null ? ` (${m.percent.toFixed(1)}%)` : "";
        const used = m.used !== null ? m.used.toLocaleString() : "?";
        const total = m.total !== null ? m.total.toLocaleString() : "?";
        const remaining = m.remaining !== null ? m.remaining.toLocaleString() : "?";
        return `  ${m.name}${m.window ? ` [${m.window}]` : ""}: ${used}/${total} used, ${remaining} remaining${unit}${pct}${reset}${suffix}`;
      });
      const head = `${data.name} (${data.providerType})${data.plan ? " — plan " + data.plan : ""}`;
      const plan = planLine(data.risk);
      return {
        content: [
          {
            type: "text",
            text: `# ${name} — remaining usage\n${head}${plan ? `\n  ${plan}` : ""}\n${lines.join("\n") || "  (no metrics)"}`,
          },
        ],
      };
    }
  );

  return server;
}
