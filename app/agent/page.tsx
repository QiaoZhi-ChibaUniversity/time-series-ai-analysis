"use client";

import { useMemo, useState } from "react";
import Papa, { ParseResult } from "papaparse";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  ScatterChart,
  Scatter,
} from "recharts";

type RowData = Record<string, string>;

type TimeSeriesRow = {
  time: string;
  value: number;
  dateObj: Date;
};

type ScatterRow = {
  x: number;
  y: number;
  time: string;
  dateObj: Date | null;
};

type FitPoint = {
  x: number;
  linear?: number;
  nonlinear?: number;
};

type LinearFitResult = {
  slope: number;
  intercept: number;
  r2: number;
  aic: number;
  rmse: number;
  lineData: FitPoint[];
} | null;

type NonlinearFitResult = {
  a: number;
  b: number;
  c: number;
  r2: number;
  aic: number;
  rmse: number;
  lineData: FitPoint[];
} | null;

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type LanguageOption = "ja" | "zh" | "en";
type AnalysisType = "timeseries" | "scatter";

const TIME_CANDIDATES = [
  "date",
  "time",
  "timestamp",
  "datetime",
  "localtime",
  "hour_time",
  "timestamp_start",
];

function normalizeText(value: unknown) {
  return String(value ?? "").trim();
}

function isLikelyTimeColumn(name: string) {
  return TIME_CANDIDATES.includes(name.toLowerCase());
}

function parseDateValue(value: string): Date | null {
  const v = normalizeText(value);
  if (!v) return null;

  const d = new Date(v);
  if (!Number.isNaN(d.getTime())) return d;

  return null;
}

function formatDateForInput(date: Date) {
  return date.toISOString().slice(0, 10);
}

function calcR2(yTrue: number[], yPred: number[]) {
  if (yTrue.length === 0 || yTrue.length !== yPred.length) return NaN;

  const mean = yTrue.reduce((sum, v) => sum + v, 0) / yTrue.length;
  const ssTot = yTrue.reduce((sum, v) => sum + (v - mean) ** 2, 0);
  const ssRes = yTrue.reduce((sum, v, i) => sum + (v - yPred[i]) ** 2, 0);

  if (ssTot === 0) return NaN;
  return 1 - ssRes / ssTot;
}

function calcRMSE(yTrue: number[], yPred: number[]) {
  if (yTrue.length === 0 || yTrue.length !== yPred.length) return NaN;
  const mse =
    yTrue.reduce((sum, v, i) => sum + (v - yPred[i]) ** 2, 0) / yTrue.length;
  return Math.sqrt(mse);
}

function calcAIC(yTrue: number[], yPred: number[], k: number) {
  if (yTrue.length === 0 || yTrue.length !== yPred.length) return NaN;

  const n = yTrue.length;
  const rss = yTrue.reduce((sum, v, i) => sum + (v - yPred[i]) ** 2, 0);

  if (!Number.isFinite(rss) || rss <= 0 || n === 0) return NaN;

  return n * Math.log(rss / n) + 2 * k;
}

function fitLinearModel(data: ScatterRow[]): LinearFitResult {
  if (data.length < 2) return null;

  const xs = data.map((d) => d.x);
  const ys = data.map((d) => d.y);

  const xMean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const yMean = ys.reduce((a, b) => a + b, 0) / ys.length;

  let numerator = 0;
  let denominator = 0;

  for (let i = 0; i < xs.length; i++) {
    numerator += (xs[i] - xMean) * (ys[i] - yMean);
    denominator += (xs[i] - xMean) ** 2;
  }

  if (denominator === 0) return null;

  const slope = numerator / denominator;
  const intercept = yMean - slope * xMean;

  const yPred = xs.map((x) => slope * x + intercept);
  const r2 = calcR2(ys, yPred);
  const rmse = calcRMSE(ys, yPred);
  const aic = calcAIC(ys, yPred, 2);

  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const nLine = 100;
  const step = (maxX - minX) / Math.max(nLine - 1, 1);

  const lineData: FitPoint[] = [];
  for (let i = 0; i < nLine; i++) {
    const x = minX + i * step;
    lineData.push({
      x,
      linear: slope * x + intercept,
    });
  }

  return { slope, intercept, r2, aic, rmse, lineData };
}

function fitSaturatingExpModel(data: ScatterRow[]): NonlinearFitResult {
  if (data.length < 3) return null;

  const xs = data.map((d) => d.x);
  const ys = data.map((d) => d.y);

  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const yRange = maxY - minY || 1;

  let best:
    | {
        a: number;
        b: number;
        c: number;
        sse: number;
      }
    | null = null;

  const cMin = minY - 0.2 * yRange;
  const cMax = minY + 0.2 * yRange;

  const safeMaxX = Math.max(Math.abs(maxX), 1e-6);
  const bCandidates: number[] = [];

  for (let i = 0; i < 60; i++) {
    const t = i / 59;
    const b = Math.exp(Math.log(1e-4) * (1 - t) + Math.log(5 / safeMaxX) * t);
    bCandidates.push(b);
  }

  for (let ci = 0; ci < 50; ci++) {
    const c = cMin + (ci / 49) * (cMax - cMin);

    for (const b of bCandidates) {
      const phis = xs.map((x) => 1 - Math.exp(-b * x));

      let num = 0;
      let den = 0;
      for (let i = 0; i < xs.length; i++) {
        num += phis[i] * (ys[i] - c);
        den += phis[i] * phis[i];
      }

      if (den === 0) continue;

      const a = num / den;
      const yPred = xs.map((x) => a * (1 - Math.exp(-b * x)) + c);
      const sse = ys.reduce((sum, y, i) => sum + (y - yPred[i]) ** 2, 0);

      if (!best || sse < best.sse) {
        best = { a, b, c, sse };
      }
    }
  }

  if (!best) return null;

  const yPred = xs.map((x) => best!.a * (1 - Math.exp(-best!.b * x)) + best!.c);
  const r2 = calcR2(ys, yPred);
  const rmse = calcRMSE(ys, yPred);
  const aic = calcAIC(ys, yPred, 3);

  const nLine = 100;
  const step = (maxX - minX) / Math.max(nLine - 1, 1);
  const lineData: FitPoint[] = [];

  for (let i = 0; i < nLine; i++) {
    const x = minX + i * step;
    lineData.push({
      x,
      nonlinear: best.a * (1 - Math.exp(-best.b * x)) + best.c,
    });
  }

  return {
    a: best.a,
    b: best.b,
    c: best.c,
    r2,
    aic,
    rmse,
    lineData,
  };
}

function calcAkaikeWeights(aicLinear: number, aicNonlinear: number) {
  if (!Number.isFinite(aicLinear) || !Number.isFinite(aicNonlinear)) {
    return null;
  }

  const aicMin = Math.min(aicLinear, aicNonlinear);
  const deltaLinear = aicLinear - aicMin;
  const deltaNonlinear = aicNonlinear - aicMin;

  const wLinearRaw = Math.exp(-deltaLinear / 2);
  const wNonlinearRaw = Math.exp(-deltaNonlinear / 2);
  const sum = wLinearRaw + wNonlinearRaw;

  if (sum === 0) return null;

  const wLinear = wLinearRaw / sum;
  const wNonlinear = wNonlinearRaw / sum;

  return {
    aicMin,
    deltaLinear,
    deltaNonlinear,
    wLinear,
    wNonlinear,
    bestModel: wNonlinear > wLinear ? "非線形" : "線形",
  };
}

function ScatterTooltipContent({
  active,
  payload,
  scatterXColumn,
  scatterYColumn,
}: {
  active?: boolean;
  payload?: Array<{
    payload?: ScatterRow;
  }>;
  scatterXColumn: string;
  scatterYColumn: string;
}) {
  if (!active || !payload || payload.length === 0) return null;

  const point = payload[0]?.payload;
  if (!point) return null;

  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm shadow-md">
      <p className="font-semibold text-slate-900">観測値</p>
      <p className="mt-1 text-slate-700">日時: {point.time || "-"}</p>
      <p className="text-slate-700">
        {scatterXColumn}: {Number.isFinite(point.x) ? point.x.toFixed(4) : "-"}
      </p>
      <p className="text-slate-700">
        {scatterYColumn}: {Number.isFinite(point.y) ? point.y.toFixed(4) : "-"}
      </p>
    </div>
  );
}

function languageLabel(lang: LanguageOption) {
  if (lang === "ja") return "日本語";
  if (lang === "zh") return "中文";
  return "English";
}

export default function Page() {
  const [columns, setColumns] = useState<string[]>([]);
  const [rawData, setRawData] = useState<RowData[]>([]);
  const [dataPreview, setDataPreview] = useState<RowData[]>([]);
  const [fileName, setFileName] = useState("");

  const [timeColumn, setTimeColumn] = useState("");
  const [timeValueColumn, setTimeValueColumn] = useState("");

  const [scatterXColumn, setScatterXColumn] = useState("");
  const [scatterYColumn, setScatterYColumn] = useState("");

  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const [showTimeSeries, setShowTimeSeries] = useState(true);
  const [showScatter, setShowScatter] = useState(true);
  const [showLinearFit, setShowLinearFit] = useState(true);
  const [showNonlinearFit, setShowNonlinearFit] = useState(true);

  const [removeEmpty, setRemoveEmpty] = useState(true);
  const [removeNaNText, setRemoveNaNText] = useState(true);
  const [removeNoneNull, setRemoveNoneNull] = useState(true);
  const [remove9999, setRemove9999] = useState(true);
  const [remove32768, setRemove32768] = useState(true);
  const [removeZero, setRemoveZero] = useState(false);

  const [language, setLanguage] = useState<LanguageOption>("ja");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [activeAnalysisType, setActiveAnalysisType] = useState<AnalysisType | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [chatError, setChatError] = useState("");

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);

    Papa.parse<RowData>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results: ParseResult<RowData>) => {
        const cols = results.meta.fields || [];
        const rows = results.data;

        setColumns(cols);
        setRawData(rows);
        setDataPreview(rows.slice(0, 5));

        const autoTime =
          cols.find((c) => isLikelyTimeColumn(c)) || cols[0] || "";

        const numericCandidates = cols.filter((c) => !isLikelyTimeColumn(c));

        const autoTimeValue = numericCandidates[0] || "";
        const autoScatterX = numericCandidates[0] || "";
        const autoScatterY = numericCandidates[1] || numericCandidates[0] || "";

        setTimeColumn(autoTime);
        setTimeValueColumn(autoTimeValue);
        setScatterXColumn(autoScatterX);
        setScatterYColumn(autoScatterY);

        if (autoTime) {
          const validDates = rows
            .map((row) => parseDateValue(row[autoTime]))
            .filter((d): d is Date => d !== null)
            .sort((a, b) => a.getTime() - b.getTime());

          if (validDates.length > 0) {
            setStartDate(formatDateForInput(validDates[0]));
            setEndDate(formatDateForInput(validDates[validDates.length - 1]));
          } else {
            setStartDate("");
            setEndDate("");
          }
        } else {
          setStartDate("");
          setEndDate("");
        }

        setChatMessages([]);
        setChatInput("");
        setChatError("");
        setActiveAnalysisType(null);
      },
    });
  };

  const isInvalidTextValue = (value: string) => {
    const v = normalizeText(value);
    const lower = v.toLowerCase();

    if (removeEmpty && v === "") return true;
    if (removeNaNText && (lower === "nan" || lower === "na" || lower === "n/a"))
      return true;
    if (removeNoneNull && (lower === "none" || lower === "null")) return true;

    return false;
  };

  const isInvalidNumericValue = (num: number) => {
    if (Number.isNaN(num)) return true;
    if (remove9999 && (num === -9999 || num === 9999)) return true;
    if (remove32768 && num === -32768) return true;
    if (removeZero && num === 0) return true;
    return false;
  };

  const timeSeriesData = useMemo(() => {
    if (!timeColumn || !timeValueColumn || rawData.length === 0) return [];

    const start = startDate ? new Date(startDate) : null;
    const end = endDate ? new Date(endDate) : null;

    return rawData
      .map((row) => {
        const timeRaw = normalizeText(row[timeColumn]);
        const valueRaw = normalizeText(row[timeValueColumn]);

        if (isInvalidTextValue(timeRaw)) return null;
        if (isInvalidTextValue(valueRaw)) return null;

        const dateObj = parseDateValue(timeRaw);
        if (!dateObj) return null;

        const numericValue = Number(valueRaw);
        if (isInvalidNumericValue(numericValue)) return null;

        if (start && dateObj < start) return null;
        if (end) {
          const endInclusive = new Date(end);
          endInclusive.setHours(23, 59, 59, 999);
          if (dateObj > endInclusive) return null;
        }

        return {
          time: timeRaw,
          value: numericValue,
          dateObj,
        };
      })
      .filter((item): item is TimeSeriesRow => item !== null)
      .sort((a, b) => a.dateObj.getTime() - b.dateObj.getTime());
  }, [
    rawData,
    timeColumn,
    timeValueColumn,
    startDate,
    endDate,
    removeEmpty,
    removeNaNText,
    removeNoneNull,
    remove9999,
    remove32768,
    removeZero,
  ]);

  const scatterData = useMemo(() => {
    if (!scatterXColumn || !scatterYColumn || rawData.length === 0) return [];

    const start = startDate ? new Date(startDate) : null;
    const end = endDate ? new Date(endDate) : null;

    return rawData
      .map((row) => {
        const xRaw = normalizeText(row[scatterXColumn]);
        const yRaw = normalizeText(row[scatterYColumn]);

        if (isInvalidTextValue(xRaw)) return null;
        if (isInvalidTextValue(yRaw)) return null;

        let timeRaw = "";
        let dateObj: Date | null = null;

        if (timeColumn) {
          timeRaw = normalizeText(row[timeColumn]);
          if (isInvalidTextValue(timeRaw)) return null;

          dateObj = parseDateValue(timeRaw);
          if (!dateObj) return null;

          if (start && dateObj < start) return null;
          if (end) {
            const endInclusive = new Date(end);
            endInclusive.setHours(23, 59, 59, 999);
            if (dateObj > endInclusive) return null;
          }
        }

        const x = Number(xRaw);
        const y = Number(yRaw);

        if (isInvalidNumericValue(x)) return null;
        if (isInvalidNumericValue(y)) return null;

        return { x, y, time: timeRaw, dateObj };
      })
      .filter((item): item is ScatterRow => item !== null);
  }, [
    rawData,
    scatterXColumn,
    scatterYColumn,
    timeColumn,
    startDate,
    endDate,
    removeEmpty,
    removeNaNText,
    removeNoneNull,
    remove9999,
    remove32768,
    removeZero,
  ]);

  const stats = useMemo(() => {
    if (timeSeriesData.length === 0) return null;

    const values = timeSeriesData.map((d) => d.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;

    return {
      count: values.length,
      min,
      max,
      mean,
    };
  }, [timeSeriesData]);

  const numericColumns = useMemo(() => {
    return columns.filter((c) => !isLikelyTimeColumn(c));
  }, [columns]);

  const linearFit = useMemo(() => {
    if (!showLinearFit) return null;
    return fitLinearModel(scatterData);
  }, [scatterData, showLinearFit]);

  const nonlinearFit = useMemo(() => {
    if (!showNonlinearFit) return null;
    return fitSaturatingExpModel(scatterData);
  }, [scatterData, showNonlinearFit]);

  const akaikeInfo = useMemo(() => {
    if (!linearFit || !nonlinearFit) return null;
    return calcAkaikeWeights(linearFit.aic, nonlinearFit.aic);
  }, [linearFit, nonlinearFit]);

  const fitLines = useMemo(() => {
    const linearMap = new Map<number, FitPoint>();

    if (linearFit) {
      for (const p of linearFit.lineData) {
        linearMap.set(p.x, { x: p.x, linear: p.linear });
      }
    }

    if (nonlinearFit) {
      for (const p of nonlinearFit.lineData) {
        const old = linearMap.get(p.x);
        if (old) {
          old.nonlinear = p.nonlinear;
        } else {
          linearMap.set(p.x, { x: p.x, nonlinear: p.nonlinear });
        }
      }
    }

    return Array.from(linearMap.values()).sort((a, b) => a.x - b.x);
  }, [linearFit, nonlinearFit]);

  const timeSeriesSummary = useMemo(() => {
    if (!timeSeriesData.length) return null;

    const values = timeSeriesData.map((d) => d.value);

    return {
      chartType: "timeseries",
      timeColumn,
      valueColumn: timeValueColumn,
      startDate,
      endDate,
      pointCount: timeSeriesData.length,
      min: Math.min(...values),
      max: Math.max(...values),
      mean: values.reduce((a, b) => a + b, 0) / values.length,
      samplePoints: timeSeriesData.slice(0, 20).map((d) => ({
        time: d.time,
        value: d.value,
      })),
    };
  }, [timeSeriesData, timeColumn, timeValueColumn, startDate, endDate]);

  const scatterSummary = useMemo(() => {
    if (!scatterData.length) return null;

    const xs = scatterData.map((d) => d.x);
    const ys = scatterData.map((d) => d.y);

    return {
      chartType: "scatter",
      xColumn: scatterXColumn,
      yColumn: scatterYColumn,
      startDate,
      endDate,
      pointCount: scatterData.length,
      xMin: Math.min(...xs),
      xMax: Math.max(...xs),
      xMean: xs.reduce((a, b) => a + b, 0) / xs.length,
      yMin: Math.min(...ys),
      yMax: Math.max(...ys),
      yMean: ys.reduce((a, b) => a + b, 0) / ys.length,
      linearFit: linearFit
        ? {
            slope: linearFit.slope,
            intercept: linearFit.intercept,
            r2: linearFit.r2,
            aic: linearFit.aic,
            rmse: linearFit.rmse,
          }
        : null,
      nonlinearFit: nonlinearFit
        ? {
            a: nonlinearFit.a,
            b: nonlinearFit.b,
            c: nonlinearFit.c,
            r2: nonlinearFit.r2,
            aic: nonlinearFit.aic,
            rmse: nonlinearFit.rmse,
          }
        : null,
      akaikeInfo,
      samplePoints: scatterData.slice(0, 30).map((d) => ({
        time: d.time,
        x: d.x,
        y: d.y,
      })),
    };
  }, [
    scatterData,
    scatterXColumn,
    scatterYColumn,
    startDate,
    endDate,
    linearFit,
    nonlinearFit,
    akaikeInfo,
  ]);

  async function requestAnalysis(
    analysisType: AnalysisType,
    userMessage: string,
    visibleUserMessage?: string
  ) {
    const chartSummary =
      analysisType === "timeseries" ? timeSeriesSummary : scatterSummary;

    if (!chartSummary) {
      setChatError(
        language === "ja"
          ? "分析対象のデータがありません。"
          : language === "zh"
          ? "当前没有可分析的数据。"
          : "No chart data is available for analysis."
      );
      return;
    }

    const newUserMessage: ChatMessage | null = visibleUserMessage
      ? { role: "user", content: visibleUserMessage }
      : null;

    const nextMessages = newUserMessage
      ? [...chatMessages, newUserMessage]
      : [...chatMessages];

    if (newUserMessage) {
      setChatMessages(nextMessages);
    }

    setChatError("");
    setIsAnalyzing(true);
    setActiveAnalysisType(analysisType);

    try {
      const res = await fetch("/api/analyze-chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          analysisType,
          language,
          chartSummary,
          messages: nextMessages,
          userMessage,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data?.detail || data?.error || "Request failed.");
      }

      const replyText = String(data?.reply || "").trim();

      setChatMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content:
            replyText ||
            (language === "ja"
              ? "応答がありませんでした。"
              : language === "zh"
              ? "没有返回分析结果。"
              : "No response was returned."),
        },
      ]);
    } catch (error: any) {
      setChatError(
        String(
          error?.message ||
            (language === "ja"
              ? "AI分析に失敗しました。"
              : language === "zh"
              ? "AI分析失败。"
              : "AI analysis failed.")
        )
      );
    } finally {
      setIsAnalyzing(false);
    }
  }

  function handleAnalyzeTimeSeries() {
    const defaultPrompt =
      language === "ja"
        ? "現在の時系列グラフを簡潔に分析してください。"
        : language === "zh"
        ? "请简要分析当前的时间序列图。"
        : "Please briefly analyze the current time-series chart.";

    const visibleText =
      language === "ja"
        ? "時系列を分析してください。"
        : language === "zh"
        ? "请分析时序图。"
        : "Please analyze the time-series chart.";

    void requestAnalysis("timeseries", defaultPrompt, visibleText);
  }

  function handleAnalyzeScatter() {
    const defaultPrompt =
      language === "ja"
        ? "現在の散布図を簡潔に分析してください。"
        : language === "zh"
        ? "请简要分析当前的散点图。"
        : "Please briefly analyze the current scatter plot.";

    const visibleText =
      language === "ja"
        ? "散布図を分析してください。"
        : language === "zh"
        ? "请分析散点图。"
        : "Please analyze the scatter plot.";

    void requestAnalysis("scatter", defaultPrompt, visibleText);
  }

  function handleSendChat() {
    const trimmed = chatInput.trim();
    if (!trimmed || isAnalyzing) return;

    const analysisType: AnalysisType | null =
      activeAnalysisType ??
      (scatterSummary ? "scatter" : timeSeriesSummary ? "timeseries" : null);

    if (!analysisType) {
      setChatError(
        language === "ja"
          ? "先に図を読み込み、分析対象を選んでください。"
          : language === "zh"
          ? "请先加载图表并选择分析对象。"
          : "Please load a chart and choose an analysis target first."
      );
      return;
    }

    setChatInput("");
    void requestAnalysis(analysisType, trimmed, trimmed);
  }

  return (
    <main className="min-h-screen bg-slate-100 px-4 py-8 lg:px-6 lg:py-10">
      <div className="mx-auto max-w-[1600px]">
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
          <div>
            <div className="mb-10">
              <h1 className="text-4xl font-bold text-slate-900">
                リモートセンシング解析デモ
              </h1>
              <p className="mt-3 text-slate-600">
                CSVデータを読み込み、カラム選択・期間指定・無効値除外を行ったうえで時系列および散布図を可視化し、
                線形・非線形の関係とAIC比較を簡易解析するウェブアプリケーション
              </p>
            </div>

            <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
              <h2 className="text-xl font-semibold text-slate-900">
                データアップロード
              </h2>

              <div className="mt-4">
                <label className="inline-block cursor-pointer rounded-xl bg-slate-900 px-4 py-2 text-white transition hover:bg-slate-700">
                  CSVファイルを選択
                  <input
                    type="file"
                    accept=".csv"
                    onChange={handleFileUpload}
                    className="hidden"
                  />
                </label>

                {fileName && (
                  <p className="mt-3 text-sm text-slate-600">
                    選択されたファイル: {fileName}
                  </p>
                )}
              </div>
            </div>

            {columns.length > 0 && (
              <div className="mt-6 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
                <h2 className="text-xl font-semibold text-slate-900">
                  検出されたカラム
                </h2>

                <div className="mt-4 flex flex-wrap gap-2">
                  {columns.map((col) => (
                    <span
                      key={col}
                      className="rounded-lg bg-slate-200 px-3 py-1 text-sm text-slate-800"
                    >
                      {col}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {columns.length > 0 && (
              <div className="mt-6 grid gap-6 lg:grid-cols-2">
                <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
                  <h2 className="text-xl font-semibold text-slate-900">
                    図の表示設定
                  </h2>

                  <div className="mt-4 space-y-3">
                    <label className="flex items-center gap-2 text-sm text-slate-700">
                      <input
                        type="checkbox"
                        checked={showTimeSeries}
                        onChange={(e) => setShowTimeSeries(e.target.checked)}
                      />
                      時系列グラフを表示する
                    </label>

                    <label className="flex items-center gap-2 text-sm text-slate-700">
                      <input
                        type="checkbox"
                        checked={showScatter}
                        onChange={(e) => setShowScatter(e.target.checked)}
                      />
                      散布図を表示する
                    </label>

                    <label className="flex items-center gap-2 text-sm text-slate-700">
                      <input
                        type="checkbox"
                        checked={showLinearFit}
                        onChange={(e) => setShowLinearFit(e.target.checked)}
                      />
                      線形フィットを表示する
                    </label>

                    <label className="flex items-center gap-2 text-sm text-slate-700">
                      <input
                        type="checkbox"
                        checked={showNonlinearFit}
                        onChange={(e) => setShowNonlinearFit(e.target.checked)}
                      />
                      非線形フィットを表示する
                    </label>
                  </div>
                </div>

                <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
                  <h2 className="text-xl font-semibold text-slate-900">
                    無効値除外設定
                  </h2>

                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <label className="flex items-center gap-2 text-sm text-slate-700">
                      <input
                        type="checkbox"
                        checked={removeEmpty}
                        onChange={(e) => setRemoveEmpty(e.target.checked)}
                      />
                      空値を除外
                    </label>

                    <label className="flex items-center gap-2 text-sm text-slate-700">
                      <input
                        type="checkbox"
                        checked={removeNaNText}
                        onChange={(e) => setRemoveNaNText(e.target.checked)}
                      />
                      NaN / NA を除外
                    </label>

                    <label className="flex items-center gap-2 text-sm text-slate-700">
                      <input
                        type="checkbox"
                        checked={removeNoneNull}
                        onChange={(e) => setRemoveNoneNull(e.target.checked)}
                      />
                      None / null を除外
                    </label>

                    <label className="flex items-center gap-2 text-sm text-slate-700">
                      <input
                        type="checkbox"
                        checked={remove9999}
                        onChange={(e) => setRemove9999(e.target.checked)}
                      />
                      ±9999 を除外
                    </label>

                    <label className="flex items-center gap-2 text-sm text-slate-700">
                      <input
                        type="checkbox"
                        checked={remove32768}
                        onChange={(e) => setRemove32768(e.target.checked)}
                      />
                      -32768 を除外
                    </label>

                    <label className="flex items-center gap-2 text-sm text-slate-700">
                      <input
                        type="checkbox"
                        checked={removeZero}
                        onChange={(e) => setRemoveZero(e.target.checked)}
                      />
                      0 を除外
                    </label>
                  </div>
                </div>
              </div>
            )}

            {columns.length > 0 && (
              <div className="mt-6 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
                <h2 className="text-xl font-semibold text-slate-900">
                  解析設定
                </h2>

                <div className="mt-6 grid gap-6 lg:grid-cols-2">
                  <div className="space-y-4">
                    <h3 className="text-lg font-semibold text-slate-800">
                      時系列グラフ設定
                    </h3>

                    <div>
                      <label className="mb-2 block text-sm font-medium text-slate-700">
                        時間カラム
                      </label>
                      <select
                        value={timeColumn}
                        onChange={(e) => setTimeColumn(e.target.value)}
                        className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-slate-800 outline-none focus:border-slate-500"
                      >
                        <option value="">選択してください</option>
                        {columns.map((col) => (
                          <option key={col} value={col}>
                            {col}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="mb-2 block text-sm font-medium text-slate-700">
                        数値カラム
                      </label>
                      <select
                        value={timeValueColumn}
                        onChange={(e) => setTimeValueColumn(e.target.value)}
                        className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-slate-800 outline-none focus:border-slate-500"
                      >
                        <option value="">選択してください</option>
                        {numericColumns.map((col) => (
                          <option key={col} value={col}>
                            {col}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <label className="mb-2 block text-sm font-medium text-slate-700">
                          開始日
                        </label>
                        <input
                          type="date"
                          value={startDate}
                          onChange={(e) => setStartDate(e.target.value)}
                          className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-slate-800 outline-none focus:border-slate-500"
                        />
                      </div>

                      <div>
                        <label className="mb-2 block text-sm font-medium text-slate-700">
                          終了日
                        </label>
                        <input
                          type="date"
                          value={endDate}
                          onChange={(e) => setEndDate(e.target.value)}
                          className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-slate-800 outline-none focus:border-slate-500"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <h3 className="text-lg font-semibold text-slate-800">
                      散布図設定
                    </h3>

                    <div>
                      <label className="mb-2 block text-sm font-medium text-slate-700">
                        X カラム
                      </label>
                      <select
                        value={scatterXColumn}
                        onChange={(e) => setScatterXColumn(e.target.value)}
                        className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-slate-800 outline-none focus:border-slate-500"
                      >
                        <option value="">選択してください</option>
                        {numericColumns.map((col) => (
                          <option key={col} value={col}>
                            {col}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="mb-2 block text-sm font-medium text-slate-700">
                        Y カラム
                      </label>
                      <select
                        value={scatterYColumn}
                        onChange={(e) => setScatterYColumn(e.target.value)}
                        className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-slate-800 outline-none focus:border-slate-500"
                      >
                        <option value="">選択してください</option>
                        {numericColumns.map((col) => (
                          <option key={col} value={col}>
                            {col}
                          </option>
                        ))}
                      </select>
                    </div>

                    <p className="text-sm text-slate-600">
                      散布図も同じ時間範囲でフィルタリングされます。
                    </p>
                  </div>
                </div>
              </div>
            )}

            {showTimeSeries && stats && (
              <div className="mt-6 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
                <h2 className="text-xl font-semibold text-slate-900">
                  基礎統計（時系列グラフの対象データ）
                </h2>

                <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="rounded-xl bg-slate-50 p-4">
                    <p className="text-sm text-slate-500">有効データ数</p>
                    <p className="mt-2 text-2xl font-bold text-slate-900">
                      {stats.count}
                    </p>
                  </div>

                  <div className="rounded-xl bg-slate-50 p-4">
                    <p className="text-sm text-slate-500">平均値</p>
                    <p className="mt-2 text-2xl font-bold text-slate-900">
                      {stats.mean.toFixed(4)}
                    </p>
                  </div>

                  <div className="rounded-xl bg-slate-50 p-4">
                    <p className="text-sm text-slate-500">最小値</p>
                    <p className="mt-2 text-2xl font-bold text-slate-900">
                      {stats.min.toFixed(4)}
                    </p>
                  </div>

                  <div className="rounded-xl bg-slate-50 p-4">
                    <p className="text-sm text-slate-500">最大値</p>
                    <p className="mt-2 text-2xl font-bold text-slate-900">
                      {stats.max.toFixed(4)}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {showTimeSeries && timeSeriesData.length > 0 && (
              <div className="mt-6 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-xl font-semibold text-slate-900">
                      時系列グラフ
                    </h2>
                    <p className="mt-2 text-sm text-slate-600">
                      横軸: {timeColumn} ／ 縦軸: {timeValueColumn}
                    </p>
                  </div>

                  <button
                    onClick={handleAnalyzeTimeSeries}
                    disabled={isAnalyzing}
                    className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isAnalyzing && activeAnalysisType === "timeseries"
                      ? "分析中..."
                      : "時系列を分析"}
                  </button>
                </div>

                <div className="mt-6 h-[420px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={timeSeriesData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="time" minTickGap={30} />
                      <YAxis />
                      <Tooltip />
                      <Legend />
                      <Line
                        type="monotone"
                        dataKey="value"
                        name={timeValueColumn}
                        stroke="#2563eb"
                        strokeWidth={2}
                        dot={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {showScatter && scatterData.length > 0 && (
              <div className="mt-6 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-xl font-semibold text-slate-900">
                      散布図とモデル比較
                    </h2>
                    <p className="mt-2 text-sm text-slate-600">
                      X 軸: {scatterXColumn} ／ Y 軸: {scatterYColumn}
                    </p>
                  </div>

                  <button
                    onClick={handleAnalyzeScatter}
                    disabled={isAnalyzing}
                    className="rounded-xl bg-violet-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isAnalyzing && activeAnalysisType === "scatter"
                      ? "分析中..."
                      : "散布図を分析"}
                  </button>
                </div>

                <div className="mt-4 grid gap-4 lg:grid-cols-4">
                  <div className="rounded-xl bg-slate-50 p-4">
                    <p className="text-sm text-slate-500">散布図の点数</p>
                    <p className="mt-2 text-2xl font-bold text-slate-900">
                      {scatterData.length}
                    </p>
                  </div>

                  <div className="rounded-xl bg-slate-50 p-4">
                    <p className="text-sm text-slate-500">線形モデル R²</p>
                    <p className="mt-2 text-2xl font-bold text-slate-900">
                      {linearFit && !Number.isNaN(linearFit.r2)
                        ? linearFit.r2.toFixed(4)
                        : "-"}
                    </p>
                    {linearFit && (
                      <p className="mt-2 text-xs leading-6 text-slate-600">
                        y = {linearFit.slope.toFixed(4)}x +{" "}
                        {linearFit.intercept.toFixed(4)}
                      </p>
                    )}
                  </div>

                  <div className="rounded-xl bg-slate-50 p-4">
                    <p className="text-sm text-slate-500">非線形モデル R²</p>
                    <p className="mt-2 text-2xl font-bold text-slate-900">
                      {nonlinearFit && !Number.isNaN(nonlinearFit.r2)
                        ? nonlinearFit.r2.toFixed(4)
                        : "-"}
                    </p>
                    {nonlinearFit && (
                      <p className="mt-2 text-xs leading-6 text-slate-600">
                        y = {nonlinearFit.a.toFixed(4)}
                        (1 - exp(-{nonlinearFit.b.toFixed(4)}x)) +{" "}
                        {nonlinearFit.c.toFixed(4)}
                      </p>
                    )}
                  </div>

                  <div className="rounded-xl bg-slate-50 p-4">
                    <p className="text-sm text-slate-500">BEST_MODEL</p>
                    <p className="mt-2 text-2xl font-bold text-slate-900">
                      {akaikeInfo ? akaikeInfo.bestModel : "-"}
                    </p>
                    {akaikeInfo && (
                      <p className="mt-2 text-xs leading-6 text-slate-600">
                        ΔAIC(線形) = {akaikeInfo.deltaLinear.toFixed(2)}
                        <br />
                        ΔAIC(非線形) = {akaikeInfo.deltaNonlinear.toFixed(2)}
                      </p>
                    )}
                  </div>
                </div>

                {linearFit && nonlinearFit && akaikeInfo && (
                  <div className="mt-4 grid gap-4 lg:grid-cols-2">
                    <div className="rounded-xl bg-slate-50 p-4">
                      <h3 className="text-sm font-semibold text-slate-800">
                        AIC / Akaike weight
                      </h3>
                      <div className="mt-3 space-y-2 text-sm text-slate-700">
                        <p>Linear AIC: {linearFit.aic.toFixed(4)}</p>
                        <p>Nonlinear AIC: {nonlinearFit.aic.toFixed(4)}</p>
                        <p>Linear weight: {akaikeInfo.wLinear.toFixed(4)}</p>
                        <p>Nonlinear weight: {akaikeInfo.wNonlinear.toFixed(4)}</p>
                      </div>
                    </div>

                    <div className="rounded-xl bg-slate-50 p-4">
                      <h3 className="text-sm font-semibold text-slate-800">
                        係数の簡単な説明
                      </h3>
                      <div className="mt-3 space-y-2 text-sm leading-6 text-slate-700">
                        <p>
                          <span className="font-semibold">線形 slope</span>：
                          x が 1 増えたときの y の平均的な増加量
                        </p>
                        <p>
                          <span className="font-semibold">線形 intercept</span>：
                          x = 0 のときの推定 y
                        </p>
                        <p>
                          <span className="font-semibold">非線形 a</span>：
                          飽和したときの増加幅の大きさ
                        </p>
                        <p>
                          <span className="font-semibold">非線形 b</span>：
                          飽和に近づく速さ
                        </p>
                        <p>
                          <span className="font-semibold">非線形 c</span>：
                          基本水準・オフセット
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                <div className="mt-6 h-[460px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <ScatterChart>
                      <CartesianGrid />
                      <XAxis type="number" dataKey="x" name={scatterXColumn} />
                      <YAxis type="number" dataKey="y" name={scatterYColumn} />
                      <Tooltip
                        content={
                          <ScatterTooltipContent
                            scatterXColumn={scatterXColumn}
                            scatterYColumn={scatterYColumn}
                          />
                        }
                      />
                      <Legend />
                      <Scatter
                        data={scatterData}
                        name="観測値"
                        fill="#334155"
                      />
                      {showLinearFit && linearFit && (
                        <Line
                          type="monotone"
                          data={fitLines}
                          dataKey="linear"
                          name="線形フィット"
                          dot={false}
                          stroke="#2563eb"
                          strokeWidth={2.5}
                        />
                      )}
                      {showNonlinearFit && nonlinearFit && (
                        <Line
                          type="monotone"
                          data={fitLines}
                          dataKey="nonlinear"
                          name="非線形フィット"
                          dot={false}
                          stroke="#dc2626"
                          strokeWidth={2.5}
                        />
                      )}
                    </ScatterChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {dataPreview.length > 0 && (
              <div className="mt-6 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
                <h2 className="text-xl font-semibold text-slate-900">
                  データプレビュー（先頭5行）
                </h2>

                <div className="mt-4 overflow-auto rounded-lg border border-slate-200">
                  <table className="min-w-full border-collapse bg-white text-sm">
                    <thead className="bg-slate-100">
                      <tr>
                        {columns.map((col) => (
                          <th
                            key={col}
                            className="border-b border-slate-200 px-4 py-3 text-left font-semibold text-slate-700"
                          >
                            {col}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {dataPreview.map((row, rowIndex) => (
                        <tr key={rowIndex} className="odd:bg-white even:bg-slate-50">
                          {columns.map((col) => (
                            <td
                              key={`${rowIndex}-${col}`}
                              className="border-b border-slate-100 px-4 py-3 text-slate-700"
                            >
                              {row[col] ?? ""}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          <aside className="h-fit rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200 xl:sticky xl:top-6">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold text-slate-900">
                  AIチャット
                </h2>
                <p className="mt-1 text-sm text-slate-600">
                  現在の図をもとに簡単な分析を行います。
                </p>
              </div>
            </div>

            <div className="mt-4 space-y-4">
              <div>
                <label className="mb-2 block text-sm font-medium text-slate-700">
                  言語 / Language
                </label>
                <select
                  value={language}
                  onChange={(e) => setLanguage(e.target.value as LanguageOption)}
                  className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-slate-800 outline-none focus:border-slate-500"
                >
                  <option value="ja">日本語</option>
                  <option value="zh">中文</option>
                  <option value="en">English</option>
                </select>
              </div>

              <div className="rounded-xl bg-slate-50 p-4 text-sm text-slate-700">
                <p>
                  {language === "ja"
                    ? "現在の分析対象："
                    : language === "zh"
                    ? "当前分析对象："
                    : "Current analysis target: "}
                  <span className="font-semibold">
                    {activeAnalysisType === "timeseries"
                      ? language === "ja"
                        ? "時系列"
                        : language === "zh"
                        ? "时序图"
                        : "Time-series"
                      : activeAnalysisType === "scatter"
                      ? language === "ja"
                        ? "散布図"
                        : language === "zh"
                        ? "散点图"
                        : "Scatter"
                      : language === "ja"
                      ? "未選択"
                      : language === "zh"
                      ? "未选择"
                      : "Not selected"}
                  </span>
                </p>
              </div>

              <div className="h-[460px] overflow-y-auto rounded-xl border border-slate-200 bg-slate-50 p-4">
                {chatMessages.length === 0 ? (
                  <div className="text-sm leading-6 text-slate-500">
                    {language === "ja"
                      ? "右側の「時系列を分析」「散布図を分析」ボタンを押すと、ここにAI分析結果が表示されます。その後は続けて質問できます。"
                      : language === "zh"
                      ? "点击左侧图表上的“分析”按钮后，这里会显示 AI 的分析结果。之后可以继续追问。"
                      : "Click one of the analysis buttons on the charts. The AI response will appear here, and you can continue asking follow-up questions."}
                  </div>
                ) : (
                  <div className="space-y-3">
                    {chatMessages.map((msg, idx) => (
                      <div
                        key={`${msg.role}-${idx}`}
                        className={`rounded-2xl px-4 py-3 text-sm leading-6 ${
                          msg.role === "user"
                            ? "ml-6 bg-slate-900 text-white"
                            : "mr-6 bg-white text-slate-800 ring-1 ring-slate-200"
                        }`}
                      >
                        <div className="mb-1 text-xs font-semibold opacity-70">
                          {msg.role === "user"
                            ? language === "ja"
                              ? "あなた"
                              : language === "zh"
                              ? "你"
                              : "You"
                            : "AI"}
                        </div>
                        <div className="whitespace-pre-wrap break-words">
                          {msg.content}
                        </div>
                      </div>
                    ))}

                    {isAnalyzing && (
                      <div className="mr-6 rounded-2xl bg-white px-4 py-3 text-sm text-slate-600 ring-1 ring-slate-200">
                        {language === "ja"
                          ? "AIが分析中です..."
                          : language === "zh"
                          ? "AI 正在分析..."
                          : "AI is analyzing..."}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {chatError && (
                <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                  {chatError}
                </div>
              )}

              <div className="space-y-3">
                <textarea
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  rows={4}
                  placeholder={
                    language === "ja"
                      ? "分析結果について続けて質問してください。"
                      : language === "zh"
                      ? "可以继续追问分析结果。"
                      : "Ask a follow-up question about the current analysis."
                  }
                  className="w-full resize-none rounded-xl border border-slate-300 bg-white px-4 py-3 text-slate-800 outline-none focus:border-slate-500"
                />

                <div className="flex gap-3">
                  <button
                    onClick={handleSendChat}
                    disabled={isAnalyzing || !chatInput.trim()}
                    className="flex-1 rounded-xl bg-slate-900 px-4 py-3 text-sm font-medium text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {language === "ja"
                      ? "送信"
                      : language === "zh"
                      ? "发送"
                      : "Send"}
                  </button>

                  <button
                    onClick={() => {
                      setChatMessages([]);
                      setChatInput("");
                      setChatError("");
                      setActiveAnalysisType(null);
                    }}
                    disabled={isAnalyzing}
                    className="rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {language === "ja"
                      ? "クリア"
                      : language === "zh"
                      ? "清空"
                      : "Clear"}
                  </button>
                </div>

                <p className="text-xs text-slate-500">
                  {language === "ja"
                    ? `現在の出力言語：${languageLabel(language)}`
                    : language === "zh"
                    ? `当前输出语言：${languageLabel(language)}`
                    : `Current output language: ${languageLabel(language)}`}
                </p>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </main>
  );
}