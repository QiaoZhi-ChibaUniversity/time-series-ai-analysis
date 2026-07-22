export type RowData = Record<string, string>;

export type ColumnType =
  | "identifier"
  | "numeric"
  | "datetime"
  | "categorical"
  | "unknown";
export type ColumnRole =
  | "identifier"
  | "measure"
  | "dimension"
  | "time"
  | "geospatial"
  | "text";

export type StructureType = "general" | "timeseries";
export type DomainLabel = "unknown" | "environmental" | "remote_sensing";
export type DomainConfidence = "none" | "medium" | "high";

export type ColumnProfile = {
  name: string;
  type: ColumnType;
  role: ColumnRole;
  validCount: number;
  missingCount: number;
  missingRate: number;
  uniqueCount: number;
  uniqueRatio: number;
  highCardinality: boolean;
  sampleValues: string[];
  min?: number;
  max?: number;
  mean?: number;
};

export type DomainHint = {
  label: DomainLabel;
  confidence: DomainConfidence;
  score: number;
  reasons: string[];
};

export type DatasetProfile = {
  rowCount: number;
  columnCount: number;
  duplicateRows: number;
  structureType: StructureType;
  domainHint: DomainHint;
  columns: ColumnProfile[];
  cleaning: {
    empty: number;
    missingText: number;
    sentinel9999: number;
    sentinel32768: number;
  };
};

const MISSING_TEXT_VALUES = new Set(["nan", "na", "n/a", "none", "null"]);

const REMOTE_SIGNALS: Array<{ keywords: string[]; weight: number }> = [
  {
    keywords: ["nirvp", "nirv", "ndvi", "evi", "ndwi", "savi", "nbr"],
    weight: 3,
  },
  { keywords: ["reflectance", "spectral"], weight: 3 },
  {
    keywords: ["band", "cloudmask", "cloud_mask", "cloud_cover"],
    weight: 2,
  },
  { keywords: ["landsat", "sentinel", "modis"], weight: 3 },
];

const ENVIRONMENTAL_SIGNALS: Array<{ keywords: string[]; weight: number }> = [
  {
    keywords: [
      "precipitation",
      "rainfall",
      "soil_moisture",
      "降水",
      "降雨",
      "土壌水分",
    ],
    weight: 3,
  },
  {
    keywords: [
      "temperature",
      "humidity",
      "wind_speed",
      "気温",
      "水温",
      "湿度",
      "風速",
      "天候",
    ],
    weight: 2,
  },
  {
    keywords: [
      "air_quality",
      "water_quality",
      "radiation",
      "水質",
      "採水",
      "水深",
      "大気質",
      "放射",
    ],
    weight: 3,
  },
];

function normalizeValue(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeColumnName(value: string) {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function isMissingText(value: string) {
  return MISSING_TEXT_VALUES.has(value.toLowerCase());
}

function isSentinel9999(value: string) {
  const number = Number(value);
  return number === -9999 || number === 9999;
}

function isSentinel32768(value: string) {
  return Number(value) === -32768;
}

function isMissingValue(value: string) {
  return (
    value === "" ||
    isMissingText(value) ||
    isSentinel9999(value) ||
    isSentinel32768(value)
  );
}

function isNumericValue(value: string) {
  return value !== "" && Number.isFinite(Number(value));
}

function isDateValue(value: string) {
  if (!value || !/[-/:T]/.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

function isIdentifierName(columnName: string) {
  const name = normalizeColumnName(columnName);
  return (
    /^(id|uuid|guid|key|index|row_number)$/.test(name) ||
    /(^|_)(id|uuid|guid|key)$/.test(name)
  );
}

function inferColumnType(columnName: string, validValues: string[]): ColumnType {
  if (validValues.length === 0) return "unknown";
  if (isIdentifierName(columnName)) return "identifier";

  const numericCount = validValues.filter(isNumericValue).length;
  const dateCount = validValues.filter(isDateValue).length;
  const numericRatio = numericCount / validValues.length;
  const dateRatio = dateCount / validValues.length;

  if (numericRatio >= 0.8) return "numeric";
  if (dateRatio >= 0.8) return "datetime";
  return "categorical";
}

function inferColumnRole(
  columnName: string,
  type: ColumnType,
  uniqueRatio: number,
  uniqueCount: number
): ColumnRole {
  const name = normalizeColumnName(columnName);
  if (type === "identifier") return "identifier";
  if (type === "datetime") return "time";
  if (/^(lat|latitude|lon|lng|longitude)$/.test(name)) return "geospatial";
  if (type === "numeric") return "measure";
  if (type === "categorical" && uniqueCount > 50 && uniqueRatio > 0.8) {
    return "text";
  }
  return "dimension";
}

function profileColumn(rows: RowData[], columnName: string): ColumnProfile {
  const values = rows.map((row) => normalizeValue(row[columnName]));
  const validValues = values.filter((value) => !isMissingValue(value));
  const uniqueValues = Array.from(new Set(validValues));
  const type = inferColumnType(columnName, validValues);
  const missingCount = values.length - validValues.length;
  const uniqueRatio =
    validValues.length === 0 ? 0 : uniqueValues.length / validValues.length;

  const profile: ColumnProfile = {
    name: columnName,
    type,
    role: inferColumnRole(columnName, type, uniqueRatio, uniqueValues.length),
    validCount: validValues.length,
    missingCount,
    missingRate: values.length === 0 ? 0 : missingCount / values.length,
    uniqueCount: uniqueValues.length,
    uniqueRatio,
    highCardinality:
      (type === "categorical" || type === "identifier") &&
      uniqueValues.length > 20 &&
      uniqueRatio > 0.5,
    sampleValues: uniqueValues.slice(0, 5),
  };

  if (type === "numeric") {
    const numbers = validValues.map(Number).filter(Number.isFinite);
    if (numbers.length > 0) {
      profile.min = Math.min(...numbers);
      profile.max = Math.max(...numbers);
      profile.mean = numbers.reduce((sum, number) => sum + number, 0) / numbers.length;
    }
  }

  return profile;
}

function detectStructureType(columns: ColumnProfile[]): StructureType {
  const hasDate = columns.some((column) => column.type === "datetime");
  const hasNumeric = columns.some((column) => column.type === "numeric");
  return hasDate && hasNumeric ? "timeseries" : "general";
}

function scoreSignals(
  columnNames: string[],
  signals: Array<{ keywords: string[]; weight: number }>
) {
  let score = 0;
  const reasons = new Set<string>();

  for (const name of columnNames) {
    for (const signal of signals) {
      const keyword = signal.keywords.find((candidate) => name.includes(candidate));
      if (keyword) {
        score += signal.weight;
        reasons.add(`${name} (${keyword})`);
        break;
      }
    }
  }

  return { score, reasons: Array.from(reasons) };
}

function detectDomainHint(columns: ColumnProfile[]): DomainHint {
  const names = columns.map((column) => normalizeColumnName(column.name));
  const remote = scoreSignals(names, REMOTE_SIGNALS);
  const environmental = scoreSignals(names, ENVIRONMENTAL_SIGNALS);

  if (names.includes("latitude") && names.includes("longitude")) {
    remote.score += 2;
    remote.reasons.push("latitude + longitude");
  }

  if (names.includes("lat") && names.includes("lon")) {
    remote.score += 2;
    remote.reasons.push("lat + lon");
  }

  const numberedBands = names.filter((name) => /^b\d+$/.test(name));
  if (numberedBands.length >= 3) {
    remote.score += 3;
    remote.reasons.push(`${numberedBands.length} numbered spectral bands`);
  }

  const best = remote.score >= environmental.score
    ? { label: "remote_sensing" as const, ...remote }
    : { label: "environmental" as const, ...environmental };

  if (best.score < 4) {
    return { label: "unknown", confidence: "none", score: best.score, reasons: [] };
  }

  return {
    label: best.label,
    confidence: best.score >= 7 ? "high" : "medium",
    score: best.score,
    reasons: best.reasons,
  };
}

export function profileDataset(rows: RowData[], columns: string[]): DatasetProfile {
  const cleaning = {
    empty: 0,
    missingText: 0,
    sentinel9999: 0,
    sentinel32768: 0,
  };

  for (const row of rows) {
    for (const column of columns) {
      const value = normalizeValue(row[column]);
      if (value === "") cleaning.empty += 1;
      else if (isMissingText(value)) cleaning.missingText += 1;
      else if (isSentinel9999(value)) cleaning.sentinel9999 += 1;
      else if (isSentinel32768(value)) cleaning.sentinel32768 += 1;
    }
  }

  const duplicateRows =
    rows.length -
    new Set(
      rows.map((row) =>
        JSON.stringify(columns.map((column) => normalizeValue(row[column])))
      )
    ).size;

  const columnProfiles = columns.map((column) => profileColumn(rows, column));

  return {
    rowCount: rows.length,
    columnCount: columns.length,
    duplicateRows,
    structureType: detectStructureType(columnProfiles),
    domainHint: detectDomainHint(columnProfiles),
    columns: columnProfiles,
    cleaning,
  };
}
