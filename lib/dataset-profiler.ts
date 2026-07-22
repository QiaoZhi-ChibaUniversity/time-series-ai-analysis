export type RowData = Record<string, string>;

export type ColumnType =
  | "numeric"
  | "datetime"
  | "categorical"
  | "unknown";

export type DatasetType =
  | "general"
  | "timeseries"
  | "environmental"
  | "remote_sensing";

export type ColumnProfile = {
  name: string;
  type: ColumnType;
  validCount: number;
  missingCount: number;
  missingRate: number;
  uniqueCount: number;
  sampleValues: string[];
  min?: number;
  max?: number;
  mean?: number;
};

export type DatasetProfile = {
  rowCount: number;
  columnCount: number;
  duplicateRows: number;
  datasetType: DatasetType;
  columns: ColumnProfile[];
  cleaning: {
    empty: number;
    missingText: number;
    sentinel9999: number;
    sentinel32768: number;
  };
};

const MISSING_TEXT_VALUES = new Set([
  "nan",
  "na",
  "n/a",
  "none",
  "null",
]);

const REMOTE_SENSING_KEYWORDS = [
  "ndvi",
  "evi",
  "ndwi",
  "savi",
  "lst",
  "reflectance",
  "band",
  "latitude",
  "longitude",
];

const ENVIRONMENTAL_KEYWORDS = [
  "temperature",
  "humidity",
  "precipitation",
  "rainfall",
  "soil",
  "moisture",
  "radiation",
  "wind",
];

function normalizeValue(value: unknown) {
  return String(value ?? "").trim();
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
  if (value === "") return false;
  return Number.isFinite(Number(value));
}

function isDateValue(value: string) {
  if (!value) return false;

  // 避免把普通数字误判成日期。
  if (!/[-/:T]/.test(value)) return false;

  return !Number.isNaN(Date.parse(value));
}

function inferColumnType(values: string[]): ColumnType {
  const validValues = values.filter((value) => !isMissingValue(value));

  if (validValues.length === 0) return "unknown";

  const numericCount = validValues.filter(isNumericValue).length;
  const dateCount = validValues.filter(isDateValue).length;

  const numericRatio = numericCount / validValues.length;
  const dateRatio = dateCount / validValues.length;

  if (numericRatio >= 0.8) return "numeric";
  if (dateRatio >= 0.8) return "datetime";

  return "categorical";
}

function profileColumn(
  rows: RowData[],
  columnName: string
): ColumnProfile {
  const values = rows.map((row) =>
    normalizeValue(row[columnName])
  );

  const validValues = values.filter(
    (value) => !isMissingValue(value)
  );

  const missingCount = values.length - validValues.length;
  const type = inferColumnType(values);

  const uniqueValues = Array.from(new Set(validValues));

  const profile: ColumnProfile = {
    name: columnName,
    type,
    validCount: validValues.length,
    missingCount,
    missingRate:
      values.length === 0 ? 0 : missingCount / values.length,
    uniqueCount: uniqueValues.length,
    sampleValues: uniqueValues.slice(0, 5),
  };

  if (type === "numeric") {
    const numbers = validValues
      .map(Number)
      .filter(Number.isFinite);

    if (numbers.length > 0) {
      let min = numbers[0];
      let max = numbers[0];
      let sum = 0;

      for (const number of numbers) {
        min = Math.min(min, number);
        max = Math.max(max, number);
        sum += number;
      }

      profile.min = min;
      profile.max = max;
      profile.mean = sum / numbers.length;
    }
  }

  return profile;
}

function detectDatasetType(
  columns: ColumnProfile[],
  cleaning: DatasetProfile["cleaning"]
): DatasetType {
  const columnNames = columns.map((column) =>
    column.name.toLowerCase()
  );

  const hasRemoteSensingColumn = columnNames.some((name) =>
    REMOTE_SENSING_KEYWORDS.some((keyword) =>
      name.includes(keyword)
    )
  );

  if (hasRemoteSensingColumn) {
    return "remote_sensing";
  }

  const hasEnvironmentalColumn = columnNames.some((name) =>
    ENVIRONMENTAL_KEYWORDS.some((keyword) =>
      name.includes(keyword)
    )
  );

  if (
    hasEnvironmentalColumn ||
    cleaning.sentinel9999 > 0 ||
    cleaning.sentinel32768 > 0
  ) {
    return "environmental";
  }

  const hasDateColumn = columns.some(
    (column) => column.type === "datetime"
  );

  const hasNumericColumn = columns.some(
    (column) => column.type === "numeric"
  );

  if (hasDateColumn && hasNumericColumn) {
    return "timeseries";
  }

  return "general";
}

export function profileDataset(
  rows: RowData[],
  columns: string[]
): DatasetProfile {
  const cleaning = {
    empty: 0,
    missingText: 0,
    sentinel9999: 0,
    sentinel32768: 0,
  };

  for (const row of rows) {
    for (const column of columns) {
      const value = normalizeValue(row[column]);

      if (value === "") {
        cleaning.empty += 1;
      } else if (isMissingText(value)) {
        cleaning.missingText += 1;
      } else if (isSentinel9999(value)) {
        cleaning.sentinel9999 += 1;
      } else if (isSentinel32768(value)) {
        cleaning.sentinel32768 += 1;
      }
    }
  }

  const duplicateRows =
    rows.length -
    new Set(
      rows.map((row) =>
        JSON.stringify(
          columns.map((column) =>
            normalizeValue(row[column])
          )
        )
      )
    ).size;

  const columnProfiles = columns.map((column) =>
    profileColumn(rows, column)
  );

  return {
    rowCount: rows.length,
    columnCount: columns.length,
    duplicateRows,
    datasetType: detectDatasetType(
      columnProfiles,
      cleaning
    ),
    columns: columnProfiles,
    cleaning,
  };
}