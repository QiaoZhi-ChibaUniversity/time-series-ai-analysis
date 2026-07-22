import Papa from "papaparse";

export type ParsedTabularRow = Record<string, string>;

export type ParsedTabularFile = {
  rows: ParsedTabularRow[];
  columns: string[];
  encoding: "UTF-8" | "UTF-16LE" | "UTF-16BE" | "Shift_JIS/CP932";
  delimiter: string;
  warnings: string[];
};

function startsWith(bytes: Uint8Array, prefix: number[]) {
  return prefix.every((value, index) => bytes[index] === value);
}

function decodeBuffer(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);

  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) {
    return {
      text: new TextDecoder("utf-8").decode(bytes.subarray(3)),
      encoding: "UTF-8" as const,
    };
  }

  if (startsWith(bytes, [0xff, 0xfe])) {
    return {
      text: new TextDecoder("utf-16le").decode(bytes.subarray(2)),
      encoding: "UTF-16LE" as const,
    };
  }

  if (startsWith(bytes, [0xfe, 0xff])) {
    return {
      text: new TextDecoder("utf-16be").decode(bytes.subarray(2)),
      encoding: "UTF-16BE" as const,
    };
  }

  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      encoding: "UTF-8" as const,
    };
  } catch {
    return {
      text: new TextDecoder("shift_jis").decode(bytes),
      encoding: "Shift_JIS/CP932" as const,
    };
  }
}

export async function parseTabularFile(file: File): Promise<ParsedTabularFile> {
  const decoded = decodeBuffer(await file.arrayBuffer());
  const result = Papa.parse<ParsedTabularRow>(decoded.text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) => header.replace(/^\uFEFF/, "").trim(),
  });

  const columns = result.meta.fields ?? [];
  if (columns.length === 0 || result.data.length === 0) {
    throw new Error(result.errors[0]?.message || "No tabular data was found.");
  }

  if (columns.length === 1 && /[\t,;]/.test(decoded.text.split(/\r?\n/, 1)[0] ?? "")) {
    throw new Error("The delimiter could not be detected correctly.");
  }

  return {
    rows: result.data,
    columns,
    encoding: decoded.encoding,
    delimiter: result.meta.delimiter,
    warnings: Array.from(new Set(result.errors.map((error) => error.message))).slice(0, 5),
  };
}

export function delimiterLabel(delimiter: string) {
  if (delimiter === "\t") return "TSV (tab)";
  if (delimiter === ",") return "CSV (comma)";
  if (delimiter === ";") return "CSV (semicolon)";
  return JSON.stringify(delimiter);
}
