export type DataRow = Record<string, string>;

const INVALID_TEXT = new Set(["", "nan", "na", "n/a", "none", "null"]);
const INVALID_NUMBERS = new Set([9999, -9999, -32768]);

function numericValue(value: unknown): number | null {
  const text = String(value ?? "").trim();
  if (INVALID_TEXT.has(text.toLowerCase())) return null;
  const number = Number(text);
  return Number.isFinite(number) && !INVALID_NUMBERS.has(number) ? number : null;
}

function quantile(sorted: number[], probability: number) {
  if (sorted.length === 0) return NaN;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function pearson(xs: number[], ys: number[]) {
  if (xs.length < 3 || xs.length !== ys.length) return null;
  const xMean = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const yMean = ys.reduce((sum, value) => sum + value, 0) / ys.length;
  let numerator = 0;
  let xDenominator = 0;
  let yDenominator = 0;

  for (let index = 0; index < xs.length; index += 1) {
    const xDiff = xs[index] - xMean;
    const yDiff = ys[index] - yMean;
    numerator += xDiff * yDiff;
    xDenominator += xDiff ** 2;
    yDenominator += yDiff ** 2;
  }

  const denominator = Math.sqrt(xDenominator * yDenominator);
  return denominator > 0 ? numerator / denominator : null;
}

function ranks(values: number[]) {
  const indexed = values.map((value, index) => ({ value, index }));
  indexed.sort((a, b) => a.value - b.value);
  const result = new Array<number>(values.length);

  for (let start = 0; start < indexed.length; ) {
    let end = start + 1;
    while (end < indexed.length && indexed[end].value === indexed[start].value) {
      end += 1;
    }
    const rank = (start + end - 1) / 2 + 1;
    for (let index = start; index < end; index += 1) {
      result[indexed[index].index] = rank;
    }
    start = end;
  }

  return result;
}

export type RelationshipRanking = {
  targetColumn: string;
  rowsScanned: number;
  candidateCount: number;
  method: "max_absolute_pearson_or_spearman";
  results: Array<{
    column: string;
    validPairs: number;
    pearsonR: number | null;
    spearmanRho: number | null;
    score: number;
  }>;
};

export function rankRelationships(
  rows: DataRow[],
  numericColumns: string[],
  targetColumn: string
): RelationshipRanking {
  const results = numericColumns
    .filter((column) => column !== targetColumn)
    .map((column) => {
      const xs: number[] = [];
      const ys: number[] = [];

      for (const row of rows) {
        const x = numericValue(row[column]);
        const y = numericValue(row[targetColumn]);
        if (x === null || y === null) continue;
        xs.push(x);
        ys.push(y);
      }

      const pearsonR = pearson(xs, ys);
      const spearmanRho = pearson(ranks(xs), ranks(ys));
      return {
        column,
        validPairs: xs.length,
        pearsonR,
        spearmanRho,
        score: Math.max(Math.abs(pearsonR ?? 0), Math.abs(spearmanRho ?? 0)),
      };
    })
    .filter((result) => result.validPairs >= 3)
    .sort((a, b) => b.score - a.score);

  return {
    targetColumn,
    rowsScanned: rows.length,
    candidateCount: results.length,
    method: "max_absolute_pearson_or_spearman",
    results,
  };
}

export type OutlierAnalysis = {
  column: string;
  method: "iqr_1_5";
  rowsScanned: number;
  validCount: number;
  missingCount: number;
  q1: number;
  q3: number;
  iqr: number;
  lowerFence: number;
  upperFence: number;
  outlierCount: number;
  outlierRate: number;
  lowOutlierCount: number;
  highOutlierCount: number;
  sampleOutliers: number[];
};

export function detectOutliers(rows: DataRow[], column: string): OutlierAnalysis | null {
  const values = rows
    .map((row) => numericValue(row[column]))
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);

  if (values.length < 4) return null;

  const q1 = quantile(values, 0.25);
  const q3 = quantile(values, 0.75);
  const iqr = q3 - q1;
  const lowerFence = q1 - 1.5 * iqr;
  const upperFence = q3 + 1.5 * iqr;
  const low = values.filter((value) => value < lowerFence);
  const high = values.filter((value) => value > upperFence);
  const outlierCount = low.length + high.length;

  return {
    column,
    method: "iqr_1_5",
    rowsScanned: rows.length,
    validCount: values.length,
    missingCount: rows.length - values.length,
    q1,
    q3,
    iqr,
    lowerFence,
    upperFence,
    outlierCount,
    outlierRate: outlierCount / values.length,
    lowOutlierCount: low.length,
    highOutlierCount: high.length,
    sampleOutliers: [...low.slice(0, 5), ...high.slice(-5)],
  };
}

export type TemporalGranularity = "month" | "year";

export type TemporalAggregation = {
  timeColumn: string;
  valueColumn: string;
  granularity: TemporalGranularity;
  operation: "mean";
  rowsScanned: number;
  validCount: number;
  excludedCount: number;
  groups: Array<{
    period: string;
    count: number;
    mean: number;
    median: number;
    min: number;
    max: number;
  }>;
  trend:
    | {
        slopePerPeriod: number;
        r2: number | null;
        direction: "increasing" | "decreasing" | "flat";
      }
    | null;
};

export function aggregateTemporal(
  rows: DataRow[],
  timeColumn: string,
  valueColumn: string,
  granularity: TemporalGranularity
): TemporalAggregation {
  const groups = new Map<string, number[]>();
  let validCount = 0;

  for (const row of rows) {
    const date = new Date(String(row[timeColumn] ?? "").trim());
    const value = numericValue(row[valueColumn]);
    if (Number.isNaN(date.getTime()) || value === null) continue;
    const period =
      granularity === "year"
        ? String(date.getFullYear())
        : String(date.getMonth() + 1).padStart(2, "0");
    const values = groups.get(period) ?? [];
    values.push(value);
    groups.set(period, values);
    validCount += 1;
  }

  const aggregated = Array.from(groups.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, values]) => {
      values.sort((a, b) => a - b);
      return {
        period,
        count: values.length,
        mean: values.reduce((sum, value) => sum + value, 0) / values.length,
        median: quantile(values, 0.5),
        min: values[0],
        max: values[values.length - 1],
      };
    });

  let trend: TemporalAggregation["trend"] = null;
  if (granularity === "year" && aggregated.length >= 2) {
    const xs = aggregated.map((_, index) => index);
    const ys = aggregated.map((group) => group.mean);
    const xMean = xs.reduce((sum, value) => sum + value, 0) / xs.length;
    const yMean = ys.reduce((sum, value) => sum + value, 0) / ys.length;
    const denominator = xs.reduce((sum, value) => sum + (value - xMean) ** 2, 0);
    const slopePerPeriod =
      denominator === 0
        ? 0
        : xs.reduce(
            (sum, value, index) =>
              sum + (value - xMean) * (ys[index] - yMean),
            0
          ) / denominator;
    const predicted = xs.map((value) => yMean + slopePerPeriod * (value - xMean));
    const r2 = pearson(ys, predicted);
    const scale = Math.max(...ys) - Math.min(...ys);
    const threshold = scale === 0 ? 0 : scale * 0.005;
    trend = {
      slopePerPeriod,
      r2: r2 === null ? null : r2 ** 2,
      direction:
        Math.abs(slopePerPeriod) <= threshold
          ? "flat"
          : slopePerPeriod > 0
          ? "increasing"
          : "decreasing",
    };
  }

  return {
    timeColumn,
    valueColumn,
    granularity,
    operation: "mean",
    rowsScanned: rows.length,
    validCount,
    excludedCount: rows.length - validCount,
    groups: aggregated,
    trend,
  };
}
