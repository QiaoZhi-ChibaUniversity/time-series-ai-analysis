export type AnalysisFilter = {
  column: string;
  operator: "eq" | "gt" | "lt" | "between" | "contains";
  value: string | number | [number, number];
};

export type AnalysisMetric = {
  column: string;
  operation: "count" | "sum" | "mean" | "min" | "max";
};

export type AnalysisPlan = {
  filters: AnalysisFilter[];
  groupBy: string[];
  metrics: AnalysisMetric[];
  sort?: { key: string; direction: "asc" | "desc" };
  limit: number;
  visualization: "table" | "bar" | "line";
};

export type AnalysisPlanResult = {
  plan: AnalysisPlan;
  rowsScanned: number;
  rowsMatched: number;
  groups: Array<Record<string, string | number | null>>;
};

function numberValue(value: unknown) {
  const parsed = Number(String(value ?? "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

export function validateAnalysisPlan(
  input: AnalysisPlan,
  columns: string[]
): AnalysisPlan {
  const allowed = new Set(columns);
  if (input.groupBy.length > 2) throw new Error("At most two group-by columns are allowed.");
  for (const column of input.groupBy) {
    if (!allowed.has(column)) throw new Error(`Unknown group-by column: ${column}`);
  }
  for (const filter of input.filters) {
    if (!allowed.has(filter.column)) throw new Error(`Unknown filter column: ${filter.column}`);
  }
  for (const metric of input.metrics) {
    if (!allowed.has(metric.column)) throw new Error(`Unknown metric column: ${metric.column}`);
  }
  if (input.metrics.length === 0 || input.metrics.length > 4) {
    throw new Error("One to four metrics are required.");
  }

  return {
    ...input,
    filters: input.filters.slice(0, 5),
    groupBy: input.groupBy.slice(0, 2),
    metrics: input.metrics.slice(0, 4),
    limit: Math.min(100, Math.max(1, Math.trunc(input.limit || 20))),
  };
}

function matchesFilter(row: Record<string, string>, filter: AnalysisFilter) {
  const raw = String(row[filter.column] ?? "");
  if (filter.operator === "eq") return raw === String(filter.value);
  if (filter.operator === "contains") {
    return raw.toLowerCase().includes(String(filter.value).toLowerCase());
  }
  const numeric = numberValue(raw);
  if (numeric === null) return false;
  if (filter.operator === "gt") return numeric > Number(filter.value);
  if (filter.operator === "lt") return numeric < Number(filter.value);
  return (
    Array.isArray(filter.value) &&
    numeric >= Number(filter.value[0]) &&
    numeric <= Number(filter.value[1])
  );
}

export function executeAnalysisPlan(
  rows: Array<Record<string, string>>,
  columns: string[],
  input: AnalysisPlan
): AnalysisPlanResult {
  const plan = validateAnalysisPlan(input, columns);
  const matched = rows.filter((row) =>
    plan.filters.every((filter) => matchesFilter(row, filter))
  );
  const grouped = new Map<string, Array<Record<string, string>>>();

  for (const row of matched) {
    const keyValues = plan.groupBy.map((column) => String(row[column] ?? ""));
    const key = JSON.stringify(keyValues);
    const group = grouped.get(key) ?? [];
    group.push(row);
    grouped.set(key, group);
  }

  if (plan.groupBy.length === 0) grouped.set("[]", matched);

  const results = Array.from(grouped.entries()).map(([key, groupRows]) => {
    const keyValues = JSON.parse(key) as string[];
    const result: Record<string, string | number | null> = {};
    plan.groupBy.forEach((column, index) => {
      result[column] = keyValues[index];
    });

    for (const metric of plan.metrics) {
      const outputKey = `${metric.column}_${metric.operation}`;
      const values = groupRows
        .map((row) => numberValue(row[metric.column]))
        .filter((value): value is number => value !== null);
      if (metric.operation === "count") result[outputKey] = values.length;
      else if (values.length === 0) result[outputKey] = null;
      else if (metric.operation === "sum") result[outputKey] = values.reduce((a, b) => a + b, 0);
      else if (metric.operation === "mean") result[outputKey] = values.reduce((a, b) => a + b, 0) / values.length;
      else if (metric.operation === "min") result[outputKey] = Math.min(...values);
      else result[outputKey] = Math.max(...values);
    }
    return result;
  });

  if (plan.sort) {
    const direction = plan.sort.direction === "desc" ? -1 : 1;
    results.sort((left, right) => {
      const a = left[plan.sort!.key];
      const b = right[plan.sort!.key];
      return (Number(a ?? 0) - Number(b ?? 0)) * direction;
    });
  }

  return {
    plan,
    rowsScanned: rows.length,
    rowsMatched: matched.length,
    groups: results.slice(0, plan.limit),
  };
}
