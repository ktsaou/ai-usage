import { Hono } from "hono";
import { compress } from "hono/compress";
import { getRequestListener } from "@hono/node-server";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AppConfig, IngestPayload, ProviderConfig, UsageMetric } from "./types.js";
import { DB, type ValueColumn } from "./db.js";
import { Scheduler } from "./scheduler.js";
import { renderMetrics } from "./metrics.js";
import { buildMcpServer, type McpBackend } from "./mcp-server.js";
import type { ProviderRisk } from "./risk.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Attaches each metric's burn-rate risk, so a consumer never has to join them. */
function withRisk(metrics: UsageMetric[], risk: ProviderRisk | undefined) {
  return metrics.map((m) => ({ ...m, risk: risk?.metrics[m.name] ?? null }));
}

/** The rollup without the per-metric map, which is sent alongside the metrics. */
function providerLevelRisk({ metrics, ...rest }: ProviderRisk) {
  return rest;
}

export function buildProvidersPayload(config: AppConfig, scheduler: Scheduler) {
  const providers = config.providers.map((p) => {
    const health = scheduler.getHealth(p.id);
    const last = health.result ?? undefined;
    const risk = scheduler.getRisk(p.id);
    return {
      id: p.id,
      type: p.type,
      name: p.name,
      playwright: p.playwright || false,
      parked: p.parked || false,
      payg: p.payg || null,
      spendWindowDays: p.spendWindowDays ?? null,
      monthlyBudget: p.monthlyBudget ?? null,
      balanceWarnDays: p.balanceWarnDays ?? null,
      balanceCritDays: p.balanceCritDays ?? null,
      // The provider-level risk is the risk of whichever window binds first;
      // `metrics` carries it split out again per window.
      risk: risk ? providerLevelRisk(risk) : null,
      // `fetchedAt` is when these numbers were measured, which is not "now" once
      // a poll has failed — `state` and `error` say whether to trust them.
      lastFetch: last
        ? {
            fetchedAt: last.fetchedAt,
            state: health.state,
            error: health.error,
            failures: health.failures,
            plan: last.plan,
            subscription: last.subscription ?? null,
            metrics: withRisk(last.metrics, risk),
          }
        : health.error
          ? { fetchedAt: health.erroredAt, state: health.state, error: health.error, failures: health.failures, plan: null, subscription: null, metrics: [] }
          : null,
    };
  });
  return { service: config.service || {}, providers };
}

/** How many samples a card's sparkline draws. */
const SPARK_POINTS = 40;

/**
 * The most exhausted window, ignoring quotas that measure something else and
 * ones that are spent but covered by another pool — the same rule the dashboard
 * uses to pick a card's headline metric. Duplicated there because the dashboard
 * is a single static file with no build step and cannot import from here; keep
 * the two in step.
 */
function primaryMetric(metrics: UsageMetric[]): UsageMetric | null {
  if (!metrics?.length) return null;
  // Fall back to the full list rather than leave a card with no headline.
  const eligible = metrics.filter((m) => !m.secondary && !m.backstopped);
  const candidates = eligible.length ? eligible : metrics;
  const pct = candidates.filter((m) => m.percent !== null);
  if (pct.length) return pct.reduce((a, b) => ((b.percent as number) > (a.percent as number) ? b : a));
  return candidates[0];
}

/** Balances track what is left; spend and budget track what has gone. */
function valueColumn(p: ProviderConfig): ValueColumn {
  if (!p.payg) return "percent";
  return p.payg === "balance" ? "total" : "used";
}

/**
 * Everything the dashboard needs from history, and nothing else: a sparkline
 * series and the two samples a runway or spend figure is measured between.
 * Sending raw rows instead cost 47 MB per refresh over eight providers.
 */
export function buildSummaryPayload(config: AppConfig, db: DB, scheduler: Scheduler) {
  const providers = [];
  for (const p of config.providers) {
    const last = scheduler.getLastResult(p.id);
    if (!last || last.error) continue; // leave the client's cached values alone
    const prim = primaryMetric(last.metrics);
    if (!prim) continue;
    const value = valueColumn(p);
    providers.push({
      id: p.id,
      metric: prim.name,
      spark: db.sparkline(p.id, prim.name, value, SPARK_POINTS),
      payg: p.payg
        ? db.paygAnchors(p.id, prim.name, value, (p.spendWindowDays || 7) * 24 * 3600 * 1000)
        : null,
    });
  }
  return { providers };
}

export function buildInProcessBackend(config: AppConfig, scheduler: Scheduler): McpBackend {
  return {
    serviceName: config.service?.name || "ai-usage",
    listProviders: async () => buildProvidersPayload(config, scheduler),
    queryProvider: async (id: string) => {
      const r = await scheduler.queryNow(id);
      const parked = !!config.providers.find((p) => p.id === id)?.parked;
      const risk = scheduler.getRisk(id);
      const shape = (res: any, cachedAt: number | null, error: string | null) => ({
        ...res,
        metrics: withRisk(res.metrics, risk),
        risk: risk ? providerLevelRisk(risk) : null,
        cachedAt,
        error,
        parked,
      });
      if (!r.error) return shape(r, null, null);

      // The live call failed. Answering "error" while holding readings from a
      // minute ago is less useful than answering with them and their age — but
      // only while the scheduler still considers the provider alive.
      const health = scheduler.getHealth(id);
      if (health.result && health.state !== "down") {
        return shape(health.result, health.result.fetchedAt, r.error);
      }
      return shape(r, null, r.error);
    },
  };
}

export function createServer(config: AppConfig, db: DB, scheduler: Scheduler) {
  const app = new Hono();

  // The dashboard is served over residential uplinks; nothing proxies this port.
  app.use(compress());

  app.get("/", (c) => {
    const html = readFileSync(resolve(__dirname, "dashboard.html"), "utf-8");
    return c.html(html);
  });

  app.get("/api/status", (c) => {
    return c.json({
      service: "ai-usage",
      providers: config.providers.map((p) => ({ id: p.id, type: p.type, name: p.name })),
      uptime: process.uptime(),
    });
  });

  app.get("/api/providers", (c) => c.json(buildProvidersPayload(config, scheduler)));

  app.get("/api/providers/:id", (c) => {
    const id = c.req.param("id");
    const last = scheduler.getLastResult(id);
    if (!last) return c.json({ error: "not found or not yet fetched" }, 404);
    return c.json(last);
  });

  app.post("/api/query/:id", async (c) => {
    const id = c.req.param("id");
    const result = await scheduler.queryNow(id);
    const parked = !!config.providers.find((p) => p.id === id)?.parked;
    return c.json({ ...result, parked });
  });

  app.post("/api/query", async (c) => {
    const body = await c.req.json<{ provider?: string }>();
    if (body.provider) {
      const result = await scheduler.queryNow(body.provider);
      return c.json(result);
    }
    const results = [];
    for (const p of config.providers) {
      results.push(await scheduler.queryNow(p.id));
    }
    return c.json({ results });
  });

  app.get("/api/summary", (c) => c.json(buildSummaryPayload(config, db, scheduler)));

  app.get("/api/history/:id", (c) => {
    const id = c.req.param("id");
    const days = Number(c.req.query("days") || "30");
    const data = db.history(id, days);
    return c.json({ providerId: id, days, count: data.length, data });
  });

  app.post("/api/ingest", async (c) => {
    const authHeader = c.req.header("authorization") || "";
    const token = authHeader.replace("Bearer ", "");

    const agentName = Object.entries(config.ingest.apiKeys).find(
      ([, key]) => key === token
    )?.[0];

    if (!agentName) return c.json({ error: "unauthorized" }, 401);

    const payload = await c.req.json<IngestPayload>();
    const result = {
      providerId: `${agentName}/${payload.provider}`,
      providerType: payload.provider,
      name: `${agentName} - ${payload.provider}`,
      plan: null,
      metrics: payload.metrics,
      fetchedAt: payload.timestamp || Date.now(),
      error: null,
    };
    db.store(result);
    return c.json({ ok: true, stored: payload.metrics.length });
  });

  app.get("/metrics", (c) => {
    const body = renderMetrics(db, (id) => scheduler.getRisk(id), (id) => scheduler.getHealth(id).state);
    return c.text(body, 200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
  });

  return app;
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8").trim();
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function isInitializeBody(body: unknown): boolean {
  if (Array.isArray(body)) return body.some((m) => m && (m as any).method === "initialize");
  return !!body && typeof body === "object" && (body as any).method === "initialize";
}

function sendJsonRpcError(res: ServerResponse, httpStatus: number, message: string) {
  res.statusCode = httpStatus;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

export async function startServer(config: AppConfig, db: DB, scheduler: Scheduler) {
  const app = createServer(config, db, scheduler);
  const backend = buildInProcessBackend(config, scheduler);
  const idHint = config.providers.filter((p) => !p.parked).map((p) => p.id).join(", ");
  const mcpName = backend.serviceName;

  type Session = { transport: StreamableHTTPServerTransport; server: ReturnType<typeof buildMcpServer> };
  const sessions = new Map<string, Session>();

  function createSession(): Session {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
    });
    const server = buildMcpServer({ name: mcpName, idHint, backend });
    transport.onerror = (err) => console.error("[mcp] transport error:", err.message);
    // server.close() closes the transport, and transport.close() re-fires onclose;
    // without the guard the two recurse until the stack overflows.
    let closing = false;
    transport.onclose = () => {
      if (closing) return;
      closing = true;
      const sid = transport.sessionId;
      if (sid) sessions.delete(sid);
      server.close().catch(() => {});
    };
    return { transport, server };
  }

  const honoListener = getRequestListener(app.fetch.bind(app));
  const httpServer = createHttpServer(async (req, res) => {
    const pathname = (req.url || "/").split("?")[0];
    if (pathname !== "/mcp" && pathname !== "/mcp/") {
      honoListener(req, res);
      return;
    }
    try {
      const sid = (req.headers["mcp-session-id"] as string | undefined) || undefined;
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        if (sid) {
          const session = sessions.get(sid);
          if (!session) return sendJsonRpcError(res, 404, "Not Found: unknown session id");
          await session.transport.handleRequest(req, res, body);
        } else if (isInitializeBody(body)) {
          const session = createSession();
          await session.server.connect(session.transport);
          await session.transport.handleRequest(req, res, body);
          const newSid = session.transport.sessionId;
          if (newSid) sessions.set(newSid, session);
        } else {
          sendJsonRpcError(res, 400, "Bad Request: missing session id (send initialize first)");
        }
      } else {
        const session = sid ? sessions.get(sid) : undefined;
        if (!session) {
          res.statusCode = 404;
          res.end();
          return;
        }
        await session.transport.handleRequest(req, res);
      }
    } catch (err: any) {
      console.error("[mcp] handleRequest failed:", err?.message || err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      }
    }
  });

  httpServer.listen(config.port, () => {
    console.log(`[server] listening on http://localhost:${config.port}`);
    console.log(`[server] dashboard: http://localhost:${config.port}/`);
    console.log(`[server] metrics:   http://localhost:${config.port}/metrics`);
    console.log(`[server] mcp:       POST http://localhost:${config.port}/mcp  (streamable http, per-session)`);
  });

  const closeMcp = async () => {
    for (const s of sessions.values()) {
      await s.transport.close().catch(() => {});
      await s.server.close().catch(() => {});
    }
    sessions.clear();
  };

  return { httpServer, closeMcp };
}
