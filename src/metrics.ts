import { DB } from "./db.js";

export function renderMetrics(db: DB): string {
  const rows = db.allLatest();
  const lines: string[] = [];

  lines.push("# HELP ai_usage_percent Usage percentage (0-100)");
  lines.push("# TYPE ai_usage_percent gauge");
  lines.push("# HELP ai_usage_used Used amount");
  lines.push("# TYPE ai_usage_used gauge");
  lines.push("# HELP ai_usage_total Total allowance");
  lines.push("# TYPE ai_usage_total gauge");
  lines.push("# HELP ai_usage_remaining Remaining allowance");
  lines.push("# TYPE ai_usage_remaining gauge");

  for (const row of rows) {
    const labels = `provider="${row.provider_id}",name="${row.provider_name}",metric="${row.metric_name}",unit="${row.unit}",window="${row.window || ""}"`;

    if (row.percent !== null) {
      lines.push(`ai_usage_percent{${labels}} ${row.percent}`);
    }
    if (row.used !== null) {
      lines.push(`ai_usage_used{${labels}} ${row.used}`);
    }
    if (row.total !== null) {
      lines.push(`ai_usage_total{${labels}} ${row.total}`);
    }
    if (row.remaining !== null) {
      lines.push(`ai_usage_remaining{${labels}} ${row.remaining}`);
    }
  }

  return lines.join("\n") + "\n";
}
