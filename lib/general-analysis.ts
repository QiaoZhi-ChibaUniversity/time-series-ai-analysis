export type GeneralRow = Record<string, string>;

export type NumericDistribution = {
  column: string;
  count: number;
  missingCount: number;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  mean: number;
  standardDeviation: number;
};

export type GroupMetric = {
  category: string;
  rowCount: number;
  validCount: number;
  mean: number | null;
  min: number | null;
  max: number | null;
};

const MISSING_TEXT = new Set(["", "nan", "na", "n/a", "none", "null"]);

function normalize(value: unknown) {
  return String(value ?? "").trim();
}

function toValidNumber(value: unknown) {
  const text = normalize(value);
  if (MISSING_TEXT.has(text.toLowerCase())) return null;

  const number = Number(text);
  if (!Number.isFinite(number)) return null;
  if (number === -9999 || number === 9999 || number === -32768) return null;

  return number;
}

function quantile(sorted: number[], probability: number) {
  if (sorted.length === 1) return sorted[0];

  const position = (sorted.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const weight = position - lowerIndex;

  return sorted[lowerIndex] * (1 - weight) + sorted[upperIndex] * weight;
}

export function analyzeNumericDistribution(
  rows: GeneralRow[],
  column: string
): NumericDistribution | null {
  if (!column || rows.length === 0) return null;

  const values = rows
    .map((row) => toValidNumber(row[column]))
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);

  if (values.length === 0) return null;

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    values.length;

  return {
    column,
    count: values.length,
    missingCount: rows.length - values.length,
    min: values[0],
    q1: quantile(values, 0.25),
    median: quantile(values, 0.5),
    q3: quantile(values, 0.75),
    max: values[values.length - 1],
    mean,
    standardDeviation: Math.sqrt(variance),
  };
}

export function analyzeGroupedMetric(
  rows: GeneralRow[],
  categoryColumn: string,
  numericColumn: string
): GroupMetric[] {
  if (!categoryColumn || !numericColumn || rows.length === 0) return [];

  const groups = new Map<string, { rowCount: number; values: number[] }>();

  for (const row of rows) {
    const categoryText = normalize(row[categoryColumn]);
    const category = MISSING_TEXT.has(categoryText.toLowerCase())
      ? "(Missing)"
      : categoryText;
    const current = groups.get(category) ?? { rowCount: 0, values: [] };
    current.rowCount += 1;

    const numericValue = toValidNumber(row[numericColumn]);
    if (numericValue !== null) current.values.push(numericValue);

    groups.set(category, current);
  }

  return Array.from(groups.entries())
    .map(([category, group]) => ({
      category,
      rowCount: group.rowCount,
      validCount: group.values.length,
      mean:
        group.values.length === 0
          ? null
          : group.values.reduce((sum, value) => sum + value, 0) /
            group.values.length,
      min: group.values.length === 0 ? null : Math.min(...group.values),
      max: group.values.length === 0 ? null : Math.max(...group.values),
    }))
    .sort(
      (a, b) =>
        b.rowCount - a.rowCount || a.category.localeCompare(b.category)
    );
}
