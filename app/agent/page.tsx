"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Database } from "sql.js";
import { profileDataset, type ColumnRole } from "@/lib/dataset-profiler";
import { analyzeRelationship } from "@/lib/relationship-analysis";
import {
  analyzeGroupedMetric,
  analyzeNumericDistribution,
} from "@/lib/general-analysis";
import {
  aggregateTemporal,
  detectOutliers,
  rankRelationships,
  type OutlierAnalysis,
  type RelationshipRanking,
  type TemporalAggregation,
  type TemporalGranularity,
} from "@/lib/data-agent-tools";
import type { AnalysisPlan, AnalysisPlanResult } from "@/lib/analysis-dsl";
import {
  openSQLiteFile,
  readSQLiteTable,
  SQLITE_ONLINE_FILE_LIMIT_BYTES,
  SQLITE_TABLE_ROW_LIMIT,
} from "@/lib/sqlite-browser";
import { delimiterLabel, parseTabularFile } from "@/lib/tabular-file";
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
  BarChart,
  Bar,
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

type AgentTraceItem = {
  tool: string;
  label: string;
  status: "completed";
};

type LanguageOption = "ja" | "zh" | "en";
type AnalysisType =
  | "overview"
  | "distribution"
  | "outliers"
  | "ranking"
  | "temporal_aggregate"
  | "plan"
  | "group"
  | "timeseries"
  | "scatter";

type AgentPlanAction =
  | { type: "current"; analysisType: AnalysisType; reason: string }
  | { type: "overview"; reason: string }
  | { type: "distribution"; column: string; reason: string }
  | { type: "outliers"; column: string; reason: string }
  | { type: "rank_relationships"; targetColumn: string; reason: string }
  | { type: "relationship"; xColumn: string; yColumn: string; reason: string }
  | { type: "timeseries"; timeColumn: string; valueColumn: string; reason: string }
  | {
      type: "temporal_aggregate";
      timeColumn: string;
      valueColumn: string;
      granularity: TemporalGranularity;
      reason: string;
    }
  | { type: "analysis_plan"; plan: AnalysisPlan; reason: string }
  | { type: "group"; groupColumn: string; valueColumn: string; reason: string };

type PendingAgentRun = {
  analysisType: AnalysisType;
  goal: string;
  expected: Record<string, string>;
  trace: AgentTraceItem[];
  step: number;
};

type EvidenceRecord = {
  id: string;
  tool: string;
  rowsUsed: number | null;
  createdAt: string;
  summary: unknown;
};

function matchEvidenceToAction(
  action: AgentPlanAction,
  evidence: EvidenceRecord[]
): { record: EvidenceRecord; analysisType: AnalysisType } | null {
  if (action.type === "current" || action.type === "overview") return null;

  const match = evidence.find((record) => {
    if (!record.summary || typeof record.summary !== "object") return false;
    const summary = record.summary as Record<string, unknown>;
    if (action.type === "timeseries") {
      return record.tool === "timeseries" &&
        summary.timeColumn === action.timeColumn &&
        summary.valueColumn === action.valueColumn;
    }
    if (action.type === "temporal_aggregate") {
      return record.tool === "temporal_aggregate" &&
        summary.timeColumn === action.timeColumn &&
        summary.valueColumn === action.valueColumn &&
        summary.granularity === action.granularity;
    }
    if (action.type === "distribution" || action.type === "outliers") {
      return record.tool === action.type && summary.column === action.column;
    }
    if (action.type === "rank_relationships") {
      return record.tool === "ranking" &&
        summary.targetColumn === action.targetColumn;
    }
    if (action.type === "relationship") {
      return record.tool === "scatter" &&
        summary.xColumn === action.xColumn &&
        summary.yColumn === action.yColumn;
    }
    if (action.type === "group") {
      return record.tool === "group" &&
        summary.groupColumn === action.groupColumn &&
        summary.valueColumn === action.valueColumn;
    }
    if (action.type === "analysis_plan") {
      return record.tool === "plan" &&
        JSON.stringify(summary.plan) === JSON.stringify(action.plan);
    }
    return false;
  });

  if (!match) return null;
  const analysisType: AnalysisType =
    action.type === "rank_relationships"
      ? "ranking"
      : action.type === "relationship"
      ? "scatter"
      : action.type === "analysis_plan"
      ? "plan"
      : action.type;
  return { record: match, analysisType };
}

function compactPlannerValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") return value.slice(0, 240);
  if (depth >= 4) return "[nested value omitted]";
  if (Array.isArray(value)) {
    if (value.length <= 12) {
      return value.map((item) => compactPlannerValue(item, depth + 1));
    }
    return {
      itemCount: value.length,
      firstItems: value
        .slice(0, 6)
        .map((item) => compactPlannerValue(item, depth + 1)),
      lastItems: value
        .slice(-3)
        .map((item) => compactPlannerValue(item, depth + 1)),
    };
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 30)
        .map(([key, item]) => [key, compactPlannerValue(item, depth + 1)])
    );
  }
  return String(value).slice(0, 240);
}

function plannerEvidence(records: EvidenceRecord[]) {
  return records.slice(-8).map((record) => ({
    id: record.id,
    tool: record.tool,
    rowsUsed: record.rowsUsed,
    summary: compactPlannerValue(record.summary),
  }));
}

function plannerEvidenceWithCurrent(
  records: EvidenceRecord[],
  current: Array<{ tool: string; rowsUsed: number | null; summary: unknown }>
) {
  const result = plannerEvidence(records);
  for (const item of current) {
    if (result.some((record) => record.tool === item.tool)) continue;
    result.push({
      id: `view_${item.tool}`,
      tool: item.tool,
      rowsUsed: item.rowsUsed,
      summary: compactPlannerValue(item.summary),
    });
  }
  return result.slice(-8);
}

const GROUP_CHART_LIMIT = 12;
const GROUP_TABLE_PAGE_SIZE = 20;

const ZH_UI: Record<string, string> = {
  "ブラウザ内解析": "浏览器内分析",
  "データ探索ワークスペース": "数据探索工作台",
  "CSV・SQLite の構造と品質を自動把握し、データに適した可視化とAI分析を行います。": "自动识别 CSV 与 SQLite 的结构和质量，并根据数据特点生成可视化与 AI 分析。",
  "データを読み込む": "加载数据集",
  "ファイルはブラウザ内で読み込まれ、選択したデータだけが分析に使われます。": "文件在浏览器中读取，只有所选数据会用于分析。",
  "CSV / TSV / SQLite を選択": "选择 CSV / TSV / SQLite",
  "オンラインSQLite: 最大": "在线 SQLite：最大",
  "1テーブル最大": "每张表最多",
  "行": "行",
  "ファイルを読み込んでいます...": "正在读取文件……",
  "選択中": "已选择",
  "分析するSQLiteテーブル": "要分析的 SQLite 表",
  "データソースの行数": "数据源行数",
  "データセット概要": "数据集概览",
  "構造・分野・欠損を自動診断した結果です。まずここでデータを理解します。": "自动诊断数据结构、领域特征和缺失情况，先从这里理解数据。",
  "データ構造": "数据结构",
  "分野ヒント": "领域提示",
  "行数": "行数",
  "列数": "列数",
  "重複行": "重复行",
  "分野推定の根拠": "领域判断依据",
  "空欄": "空值",
  "カラムプロファイル": "列概览",
  "カラム": "列",
  "タイプ": "类型",
  "有効数": "有效数",
  "欠損率": "缺失率",
  "ユニーク数 / 率": "唯一值数 / 比例",
  "範囲 / サンプル": "范围 / 示例",
  "検出されたカラム": "检测到的列",
  "表示する分析": "显示的分析",
  "時系列グラフを表示": "显示时间序列图",
  "散布図を表示": "显示散点图",
  "線形フィットを表示": "显示线性拟合",
  "非線形フィットを表示": "显示非线性拟合",
  "日付カラムがないため、時系列分析は表示されません。": "未检测到日期列，因此不显示时间序列分析。",
  "欠損・無効値の処理": "缺失值与无效值处理",
  "空値を除外": "排除空值",
  "NaN / NA を除外": "排除 NaN / NA",
  "None / null を除外": "排除 None / null",
  "±9999 を除外": "排除 ±9999",
  "-32768 を除外": "排除 -32768",
  "0 を除外": "排除 0",
  "可視化の設定": "可视化设置",
  "時系列": "时间序列",
  "一般テーブル": "通用表格",
  "リモートセンシング": "遥感数据",
  "環境データ": "环境数据",
  "汎用データ": "通用数据",
  "時間カラム": "时间列",
  "数値カラム": "数值列",
  "選択してください": "请选择列",
  "開始日": "开始日期",
  "終了日": "结束日期",
  "変数間の関係": "变量关系",
  "X カラム": "X 列",
  "Y カラム": "Y 列",
  "日付を指定した場合、散布図にも同じ期間フィルターを適用します。": "指定日期后，散点图也会使用相同的时间范围筛选。",
  "探索分析の設定": "探索性分析",
  "数値の分布とグループ間の違いを、データ型に合わせて確認できます。": "根据检测到的数据类型查看数值分布和组间差异。",
  "分布を調べる数値カラム": "要查看分布的数值列",
  "グループ化するカテゴリ": "分组列",
  "比較する数値カラム": "比较指标",
  "数値分布": "数值分布",
  "対象カラム": "目标列",
  "四分位数と標準偏差から、値の中心・ばらつき・外れ値の可能性を確認します。": "通过四分位数和标准差了解数据中心、离散程度及潜在异常值。",
  "除外・欠損": "缺失 / 已排除",
  "平均": "平均值",
  "標準偏差": "标准差",
  "最小値": "最小值",
  "第1四分位": "第一四分位数",
  "中央値": "中位数",
  "第3四分位": "第三四分位数",
  "最大値": "最大值",
  "グループ別比較": "分组比较",
  "棒は各グループの平均値です。下の表で件数・最小値・最大値も確認できます。": "柱形表示各组平均值，下方表格可查看样本数、最小值和最大值。",
  "平均値": "平均值",
  "カテゴリ": "类别",
  "最小": "最小值",
  "最大": "最大值",
  "グループ": "组",
  "前へ": "上一页",
  "次へ": "下一页",
  "時系列の基本統計": "时间序列基本统计",
  "有効データ数": "有效数据点",
  "時系列トレンド": "时间序列趋势",
  "横軸": "横轴",
  "縦軸": "纵轴",
  "全体傾向、ピーク、急な変化、欠測の可能性を確認します。": "用于观察整体趋势、峰值、突变和潜在缺测。",
  "分析中...": "分析中……",
  "AIで時系列を分析": "使用 AI 分析时间序列",
  "関係性とモデル比較": "变量关系与模型比较",
  "相関と候補モデルを比較し、変数間の関係が直線的か非線形かを確認します。": "比较相关性和候选模型，判断变量关系更接近线性还是非线性。",
  "AIで関係を分析": "使用 AI 分析变量关系",
  "有効な点数": "有效数据点",
  "線形関係の強さ": "线性关系强度",
  "単調関係の強さ": "单调关系强度",
  "推奨モデル": "推荐模型",
  "指標の読み方": "指标说明",
  "高いほど、モデルがデータの変動をよく説明します。": "数值越高，模型对数据变化的解释能力越强。",
  "低いほど、未知データへの予測誤差が小さい傾向です。": "数值越低，模型对未知数据的预测误差通常越小。",
  "低いほど、当てはまりとモデルの複雑さのバランスが良いと評価されます。": "数值越低，拟合效果与模型复杂度之间的平衡通常越好。",
  "推奨モデルは、最小CV RMSEから5%以内の候補のうち、最も単純なモデルを選びます。": "推荐规则是在 CV RMSE 距离最优值 5% 以内的候选模型中，选择最简单的模型。",
  "観測値": "观测值",
  "線形フィット": "线性拟合",
  "非線形フィット": "非线性拟合",
  "データプレビュー（先頭5行）": "数据预览（前 5 行）",
  "分析アシスタント": "分析助手",
  "計算済みの指標と現在の図を根拠に回答します。": "根据已计算的指标和当前图表进行回答。",
  "現在の分析対象：": "当前分析对象：",
  "未選択": "未选择",
  "Agent 実行履歴": "Agent 执行记录",
  "グラフの「AIで分析」ボタンを押すと、計算済みの統計を使った説明がここに表示されます。その後は続けて質問できます。": "点击图表中的“使用 AI 分析”按钮后，这里会显示基于已计算统计指标的解释，之后还可以继续提问。",
};

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
  language,
}: {
  active?: boolean;
  payload?: Array<{
    payload?: ScatterRow;
  }>;
  scatterXColumn: string;
  scatterYColumn: string;
  language: LanguageOption;
}) {
  if (!active || !payload || payload.length === 0) return null;

  const point = payload[0]?.payload;
  if (!point) return null;

  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm shadow-md">
      <p className="font-semibold text-slate-900">
        {language === "en" ? "Observed" : language === "zh" ? "观测值" : "観測値"}
      </p>
      <p className="mt-1 text-slate-700">
        {language === "en" ? "Time" : language === "zh" ? "时间" : "日時"}: {point.time || "-"}
      </p>
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
  const [dataSource, setDataSource] = useState<"csv" | "sqlite" | null>(null);
  const [sqliteTables, setSqliteTables] = useState<string[]>([]);
  const [selectedSqliteTable, setSelectedSqliteTable] = useState("");
  const [sourceRowCount, setSourceRowCount] = useState<number | null>(null);
  const [sourceNotice, setSourceNotice] = useState("");
  const [fileError, setFileError] = useState("");
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const sqliteDatabaseRef = useRef<Database | null>(null);
  const dataWorkerRef = useRef<Worker | null>(null);
  const workerRequestsRef = useRef(
    new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  );

  const [timeColumn, setTimeColumn] = useState("");
  const [timeValueColumn, setTimeValueColumn] = useState("");

  const [scatterXColumn, setScatterXColumn] = useState("");
  const [scatterYColumn, setScatterYColumn] = useState("");
  const [distributionColumn, setDistributionColumn] = useState("");
  const [groupColumn, setGroupColumn] = useState("");
  const [groupValueColumn, setGroupValueColumn] = useState("");
  const [groupPage, setGroupPage] = useState(0);
  const [columnRoleOverrides, setColumnRoleOverrides] = useState<Record<string, ColumnRole>>({});
  const [outlierColumn, setOutlierColumn] = useState("");
  const [relationshipTargetColumn, setRelationshipTargetColumn] = useState("");
  const [temporalAggregateConfig, setTemporalAggregateConfig] = useState<{
    timeColumn: string;
    valueColumn: string;
    granularity: TemporalGranularity;
  } | null>(null);
  const [analysisPlanResult, setAnalysisPlanResult] = useState<AnalysisPlanResult | null>(null);

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
  const t = (ja: string, en: string, zh?: string) =>
    language === "en" ? en : language === "zh" ? zh ?? ZH_UI[ja] ?? ja : ja;
  const structureLabel = (value: string) =>
    value === "timeseries"
      ? t("時系列", "Time series")
      : t("一般テーブル", "General table");
  const domainLabel = (value: string) =>
    value === "remote_sensing"
      ? t("リモートセンシング", "Remote sensing")
      : value === "environmental"
      ? t("環境データ", "Environmental")
      : t("汎用データ", "General dataset");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [activeAnalysisType, setActiveAnalysisType] = useState<AnalysisType | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isPlanning, setIsPlanning] = useState(false);
  const [pendingAgentRun, setPendingAgentRun] = useState<PendingAgentRun | null>(null);
  const [chatError, setChatError] = useState("");
  const [agentTrace, setAgentTrace] = useState<AgentTraceItem[]>([]);
  const [evidenceRecords, setEvidenceRecords] = useState<EvidenceRecord[]>([]);
  const evidenceCounterRef = useRef(0);
  const agentScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const panel = agentScrollRef.current;
      if (panel) panel.scrollTop = panel.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [chatMessages, isAnalyzing, agentTrace.length, evidenceRecords.length]);

  const datasetProfile = useMemo(() => {
    if (rawData.length === 0 || columns.length === 0) {
      return null;
    }

    return profileDataset(rawData, columns);
  }, [rawData, columns]);

  const includeSaturationModel =
    datasetProfile?.domainHint.label === "remote_sensing" ||
    datasetProfile?.domainHint.label === "environmental";

  useEffect(() => {
    return () => {
      sqliteDatabaseRef.current?.close();
      sqliteDatabaseRef.current = null;
    };
  }, []);

  useEffect(() => {
    const workerRequests = workerRequestsRef.current;
    const worker = new Worker(new URL("./data-agent.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (event: MessageEvent<{ id: string; ok: boolean; result?: unknown; error?: string }>) => {
      const request = workerRequests.get(event.data.id);
      if (!request) return;
      workerRequests.delete(event.data.id);
      if (event.data.ok) request.resolve(event.data.result);
      else request.reject(new Error(event.data.error || "Worker task failed."));
    };
    dataWorkerRef.current = worker;
    return () => {
      worker.terminate();
      dataWorkerRef.current = null;
      workerRequests.clear();
    };
  }, []);

  function runWorkerTask<T>(task: Record<string, unknown>) {
    return new Promise<T>((resolve, reject) => {
      const worker = dataWorkerRef.current;
      if (!worker) {
        reject(new Error("Data worker is not ready."));
        return;
      }
      const id = `worker_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      workerRequestsRef.current.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      worker.postMessage({ id, ...task });
    });
  }

  function loadDatasetRows(rows: RowData[], cols: string[]) {
    setColumns(cols);
    setRawData(rows);
    setDataPreview(rows.slice(0, 5));

    const uploadedProfile = profileDataset(rows, cols);
    const datetimeCandidates = uploadedProfile.columns
      .filter((column) => column.type === "datetime")
      .map((column) => column.name);
    const numericCandidates = uploadedProfile.columns
      .filter((column) => column.type === "numeric")
      .map((column) => column.name);
    const categoricalCandidates = uploadedProfile.columns
      .filter((column) => column.type === "categorical")
      .map((column) => column.name);
    const preferredGroupColumn =
      uploadedProfile.columns.find(
        (column) =>
          column.type === "categorical" &&
          column.uniqueCount > 1 &&
          column.uniqueCount <= Math.min(20, Math.max(2, rows.length * 0.5))
      )?.name || categoricalCandidates[0] || "";

    const autoTime =
      datetimeCandidates.find((column) => isLikelyTimeColumn(column)) ||
      datetimeCandidates[0] ||
      "";
    const autoTimeValue = numericCandidates[0] || "";
    const autoScatterX = numericCandidates[0] || "";
    const autoScatterY = numericCandidates[1] || "";

    setTimeColumn(autoTime);
    setTimeValueColumn(autoTimeValue);
    setScatterXColumn(autoScatterX);
    setScatterYColumn(autoScatterY);
    setDistributionColumn(numericCandidates[0] || "");
    setGroupColumn(preferredGroupColumn);
    setGroupValueColumn(numericCandidates[0] || "");
    setGroupPage(0);
    setColumnRoleOverrides({});
    setOutlierColumn("");
    setRelationshipTargetColumn("");
    setTemporalAggregateConfig(null);
    setAnalysisPlanResult(null);
    setPendingAgentRun(null);
    setShowTimeSeries(Boolean(autoTime && autoTimeValue));
    setShowScatter(Boolean(autoScatterX && autoScatterY));

    if (autoTime) {
      const validDates = rows
        .map((row) => parseDateValue(row[autoTime]))
        .filter((date): date is Date => date !== null)
        .sort((left, right) => left.getTime() - right.getTime());
      setStartDate(validDates.length > 0 ? formatDateForInput(validDates[0]) : "");
      setEndDate(
        validDates.length > 0
          ? formatDateForInput(validDates[validDates.length - 1])
          : ""
      );
    } else {
      setStartDate("");
      setEndDate("");
    }

    setChatMessages([]);
    setAgentTrace([]);
    setEvidenceRecords([]);
    evidenceCounterRef.current = 0;
    setChatInput("");
    setChatError("");
    setActiveAnalysisType("overview");
  }

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);
    setFileError("");
    setSourceNotice("");
    setIsLoadingFile(true);

    try {
      const extension = file.name.split(".").pop()?.toLowerCase();

      if (extension === "csv" || extension === "tsv" || extension === "txt") {
        sqliteDatabaseRef.current?.close();
        sqliteDatabaseRef.current = null;
        setSqliteTables([]);
        setSelectedSqliteTable("");
        setDataSource("csv");

        const parsed = await parseTabularFile(file);
        loadDatasetRows(parsed.rows, parsed.columns);
        setSourceRowCount(parsed.rows.length);
        setSourceNotice(
          `${parsed.encoding} · ${delimiterLabel(parsed.delimiter)} · ${parsed.rows.length.toLocaleString()} rows${
            parsed.warnings.length > 0
              ? ` · ${parsed.warnings.join("; ")}`
              : ""
          }`
        );
        return;
      }

      if (extension === "db" || extension === "sqlite" || extension === "sqlite3") {
        sqliteDatabaseRef.current?.close();
        sqliteDatabaseRef.current = null;
        const { database, tables } = await openSQLiteFile(file);
        sqliteDatabaseRef.current = database;
        setDataSource("sqlite");
        setSqliteTables(tables);
        setSelectedSqliteTable(tables[0]);

        const tableData = readSQLiteTable(database, tables[0]);
        loadDatasetRows(tableData.rows, tableData.columns);
        setSourceRowCount(tableData.totalRowCount);
        setSourceNotice(
          tableData.truncated
            ? `Loaded ${tableData.loadedRowCount.toLocaleString()} of ${tableData.totalRowCount.toLocaleString()} rows for browser analysis.`
            : `Loaded all ${tableData.loadedRowCount.toLocaleString()} rows from table ${tables[0]}.`
        );
        return;
      }

      throw new Error("Please select a CSV, TSV, TXT, or SQLite (.db/.sqlite/.sqlite3) file.");
    } catch (error) {
      setFileError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoadingFile(false);
      e.target.value = "";
    }
  };

  function handleSQLiteTableChange(tableName: string) {
    const database = sqliteDatabaseRef.current;
    if (!database) return;

    try {
      setFileError("");
      const tableData = readSQLiteTable(database, tableName);
      setSelectedSqliteTable(tableName);
      loadDatasetRows(tableData.rows, tableData.columns);
      setSourceRowCount(tableData.totalRowCount);
      setSourceNotice(
        tableData.truncated
          ? `Loaded ${tableData.loadedRowCount.toLocaleString()} of ${tableData.totalRowCount.toLocaleString()} rows for browser analysis.`
          : `Loaded all ${tableData.loadedRowCount.toLocaleString()} rows from table ${tableName}.`
      );
    } catch (error) {
      setFileError(error instanceof Error ? error.message : String(error));
    }
  }

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
    return (
      datasetProfile?.columns
        .filter((column) => column.type === "numeric")
        .map((column) => column.name) ?? []
    );
  }, [datasetProfile]);

  const datetimeColumns = useMemo(() => {
    return (
      datasetProfile?.columns
        .filter((column) => column.type === "datetime")
        .map((column) => column.name) ?? []
    );
  }, [datasetProfile]);

  const categoricalColumns = useMemo(() => {
    return (
      datasetProfile?.columns
        .filter((column) => column.type === "categorical")
        .map((column) => column.name) ?? []
    );
  }, [datasetProfile]);

  const numericDistribution = useMemo(
    () => analyzeNumericDistribution(rawData, distributionColumn),
    [rawData, distributionColumn]
  );

  const groupedMetrics = useMemo(
    () => analyzeGroupedMetric(rawData, groupColumn, groupValueColumn),
    [rawData, groupColumn, groupValueColumn]
  );

  const distributionSummary = numericDistribution
    ? {
        chartType: "distribution",
        ...numericDistribution,
      }
    : null;

  const groupSummary = groupedMetrics.length
    ? {
        chartType: "group",
        groupColumn,
        valueColumn: groupValueColumn,
        groupCount: groupedMetrics.length,
        groups: groupedMetrics.slice(0, 100),
      }
    : null;

  const outlierSummary: OutlierAnalysis | null = useMemo(
    () => (outlierColumn ? detectOutliers(rawData, outlierColumn) : null),
    [rawData, outlierColumn]
  );

  const relationshipRankingSummary: RelationshipRanking | null = useMemo(
    () =>
      relationshipTargetColumn
        ? rankRelationships(rawData, numericColumns, relationshipTargetColumn)
        : null,
    [rawData, numericColumns, relationshipTargetColumn]
  );

  const temporalAggregationSummary: TemporalAggregation | null = useMemo(
    () =>
      temporalAggregateConfig
        ? aggregateTemporal(
            rawData,
            temporalAggregateConfig.timeColumn,
            temporalAggregateConfig.valueColumn,
            temporalAggregateConfig.granularity
          )
        : null,
    [rawData, temporalAggregateConfig]
  );

  const chartGroupedMetrics = groupedMetrics.slice(0, GROUP_CHART_LIMIT);
  const groupPageCount = Math.max(
    1,
    Math.ceil(groupedMetrics.length / GROUP_TABLE_PAGE_SIZE)
  );
  const visibleGroupedMetrics = groupedMetrics.slice(
    groupPage * GROUP_TABLE_PAGE_SIZE,
    (groupPage + 1) * GROUP_TABLE_PAGE_SIZE
  );

  const linearFit = useMemo(() => {
    if (!showLinearFit) return null;
    return fitLinearModel(scatterData);
  }, [scatterData, showLinearFit]);

  const nonlinearFit = useMemo(() => {
    if (!showNonlinearFit || !includeSaturationModel) return null;
    return fitSaturatingExpModel(scatterData);
  }, [scatterData, showNonlinearFit, includeSaturationModel]);

  const akaikeInfo = useMemo(() => {
    if (!linearFit || !nonlinearFit) return null;
    return calcAkaikeWeights(linearFit.aic, nonlinearFit.aic);
  }, [linearFit, nonlinearFit]);

  const relationshipAnalysis = useMemo(() => {
    return analyzeRelationship(scatterData, {
      includeSaturation: includeSaturationModel,
    });
  }, [scatterData, includeSaturationModel]);

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
      relationshipAnalysis,
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
    relationshipAnalysis,
  ]);

  async function requestAnalysis(
    analysisType: AnalysisType,
    userMessage: string,
    visibleUserMessage?: string,
    prefixTrace: AgentTraceItem[] = [],
    evidenceForRequest: EvidenceRecord[] = evidenceRecords
  ) {
    const chartSummary =
      analysisType === "timeseries"
        ? timeSeriesSummary
        : analysisType === "scatter"
        ? scatterSummary
        : analysisType === "distribution"
        ? distributionSummary
        : analysisType === "outliers"
        ? outlierSummary
        : analysisType === "ranking"
        ? relationshipRankingSummary
        : analysisType === "temporal_aggregate"
        ? temporalAggregationSummary
        : analysisType === "plan"
        ? analysisPlanResult
        : analysisType === "group"
        ? groupSummary
        : datasetProfile;

    if (!chartSummary) {
      setChatError(
        language === "ja"
          ? "分析対象のデータがありません。"
          : language === "zh"
          ? "当前没有可分析的数据。"
          : "No dataset is available for analysis."
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
    setAgentTrace(prefixTrace);
    setIsAnalyzing(true);
    setActiveAnalysisType(analysisType);

    try {
      const res = await fetch("/api/analyze-agent", {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          language,
          analysisType,
          datasetProfile,
          timeSeriesSummary,
          scatterSummary,
          distributionSummary,
          groupSummary,
          outlierSummary,
          relationshipRankingSummary,
          temporalAggregationSummary,
          analysisPlanResult,
          evidenceRecords: evidenceForRequest,
          messages: chatMessages,
          userMessage,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data?.detail || data?.error || "Request failed.");
      }

      const replyText = String(data?.reply || "").trim();

      if (Array.isArray(data?.trace)) {
        setAgentTrace([
          ...prefixTrace,
          ...data.trace.filter(
            (item: unknown): item is AgentTraceItem =>
              typeof item === "object" &&
              item !== null &&
              "tool" in item &&
              "label" in item &&
              "status" in item &&
              typeof item.tool === "string" &&
              typeof item.label === "string" &&
              item.status === "completed"
          ),
        ]);
      }

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
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : "";
      setChatError(
        String(
          errorMessage ||
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

  async function runGoalAgent(
    goalOverride?: string,
    options: {
      appendUser?: boolean;
      prefixTrace?: AgentTraceItem[];
      step?: number;
      evidence?: EvidenceRecord[];
      internal?: boolean;
    } = {}
  ) {
    const goal = (goalOverride ?? chatInput).trim();
    if (
      !goal ||
      !datasetProfile ||
      isAnalyzing ||
      isPlanning ||
      (!options.internal && pendingAgentRun)
    ) {
      return;
    }

    setChatError("");
    setIsPlanning(true);
    const appendUser = options.appendUser ?? true;
    const step = options.step ?? 0;
    const prefixTrace = options.prefixTrace ?? [];
    setAgentTrace(prefixTrace);

    try {
      const evidenceForPlanning = options.evidence ?? evidenceRecords;
      const response = await fetch("/api/agent-plan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          language,
          goal,
          columns: datasetProfile.columns.map((column) => ({
            name: column.name,
            type: column.type,
            role: columnRoleOverrides[column.name] ?? column.role,
            missingRate: column.missingRate,
            uniqueCount: column.uniqueCount,
          })),
          currentContext: {
            activeAnalysisType,
            agentStep: step + 1,
            availableEvidence: [
              "overview",
              ...(distributionSummary ? ["distribution"] : []),
              ...(outlierSummary ? ["outliers"] : []),
              ...(relationshipRankingSummary ? ["ranking"] : []),
              ...(temporalAggregationSummary ? ["temporal_aggregate"] : []),
              ...(analysisPlanResult ? ["plan"] : []),
              ...(groupSummary ? ["group"] : []),
              ...(timeSeriesSummary ? ["timeseries"] : []),
              ...(scatterSummary ? ["scatter"] : []),
            ],
            evidenceObservations: plannerEvidenceWithCurrent(
              evidenceForPlanning,
              [
                ...(scatterSummary
                  ? [{ tool: "scatter", rowsUsed: rawData.length, summary: scatterSummary }]
                  : []),
                ...(timeSeriesSummary
                  ? [{ tool: "timeseries", rowsUsed: rawData.length, summary: timeSeriesSummary }]
                  : []),
                ...(temporalAggregationSummary
                  ? [{ tool: "temporal_aggregate", rowsUsed: rawData.length, summary: temporalAggregationSummary }]
                  : []),
                ...(distributionSummary
                  ? [{ tool: "distribution", rowsUsed: rawData.length, summary: distributionSummary }]
                  : []),
                ...(outlierSummary
                  ? [{ tool: "outliers", rowsUsed: rawData.length, summary: outlierSummary }]
                  : []),
                ...(relationshipRankingSummary
                  ? [{ tool: "ranking", rowsUsed: rawData.length, summary: relationshipRankingSummary }]
                  : []),
                ...(groupSummary
                  ? [{ tool: "group", rowsUsed: rawData.length, summary: groupSummary }]
                  : []),
                ...(analysisPlanResult
                  ? [{ tool: "plan", rowsUsed: rawData.length, summary: analysisPlanResult }]
                  : []),
              ]
            ),
            selectedFields: {
              timeColumn,
              timeValueColumn,
              scatterXColumn,
              scatterYColumn,
              distributionColumn,
              groupColumn,
              groupValueColumn,
              outlierColumn,
              relationshipTargetColumn,
            },
          },
        }),
      });

      const data = await response.json();
      if (!response.ok || !data?.action) {
        throw new Error(data?.detail || data?.error || "Planning failed.");
      }

      const action = data.action as AgentPlanAction;
      const planningTrace: AgentTraceItem[] = [
        ...prefixTrace,
        {
          tool: "plan_dataset_analysis",
          label: t(
            `分析ステップ ${step + 1} を計画`,
            `Plan analysis step ${step + 1}`,
            `规划分析步骤 ${step + 1}`
          ),
          status: "completed",
        },
        {
          tool: `configure_${action.type}`,
          label: action.reason,
          status: "completed",
        },
      ];

      if (appendUser) setChatInput("");

      const evidenceForRun = evidenceForPlanning;
      const reusableEvidence = matchEvidenceToAction(action, evidenceForRun);
      if (reusableEvidence) {
        const reuseTrace: AgentTraceItem[] = [
          ...planningTrace.slice(0, -1),
          {
            tool: "reuse_evidence",
            label: t(
              `既存の根拠 ${reusableEvidence.record.id} を再利用`,
              `Reuse existing evidence ${reusableEvidence.record.id}`,
              `复用已有证据 ${reusableEvidence.record.id}`
            ),
            status: "completed",
          },
        ];
        void requestAnalysis(
          reusableEvidence.analysisType,
          goal,
          appendUser ? goal : undefined,
          reuseTrace,
          evidenceForRun
        );
        return;
      }

      if (action.type === "current") {
        void requestAnalysis(
          action.analysisType,
          goal,
          appendUser ? goal : undefined,
          planningTrace,
          options.evidence ?? evidenceRecords
        );
        return;
      }

      if (action.type === "overview") {
        void requestAnalysis(
          "overview",
          goal,
          appendUser ? goal : undefined,
          planningTrace,
          options.evidence ?? evidenceRecords
        );
        return;
      }

      if (appendUser) {
        setChatMessages((previous) => [
          ...previous,
          { role: "user", content: goal },
        ]);
      }
      setAgentTrace(planningTrace);

      if (action.type === "analysis_plan") {
        const result = await runWorkerTask<AnalysisPlanResult>({
          type: "execute_plan",
          rows: rawData,
          columns,
          plan: action.plan,
        });
        setAnalysisPlanResult(result);
        setPendingAgentRun({
          analysisType: "plan",
          goal,
          expected: { plan: JSON.stringify(result.plan) },
          trace: planningTrace,
          step,
        });
      } else if (action.type === "distribution") {
        setDistributionColumn(action.column);
        setPendingAgentRun({
          analysisType: "distribution",
          goal,
          expected: { column: action.column },
          trace: planningTrace,
          step,
        });
      } else if (action.type === "outliers") {
        setOutlierColumn(action.column);
        setDistributionColumn(action.column);
        setPendingAgentRun({
          analysisType: "outliers",
          goal,
          expected: { column: action.column },
          trace: planningTrace,
          step,
        });
      } else if (action.type === "rank_relationships") {
        setRelationshipTargetColumn(action.targetColumn);
        setPendingAgentRun({
          analysisType: "ranking",
          goal,
          expected: { targetColumn: action.targetColumn },
          trace: planningTrace,
          step,
        });
      } else if (action.type === "relationship") {
        setScatterXColumn(action.xColumn);
        setScatterYColumn(action.yColumn);
        setShowScatter(true);
        setPendingAgentRun({
          analysisType: "scatter",
          goal,
          expected: { xColumn: action.xColumn, yColumn: action.yColumn },
          trace: planningTrace,
          step,
        });
      } else if (action.type === "timeseries") {
        setTimeColumn(action.timeColumn);
        setTimeValueColumn(action.valueColumn);
        setShowTimeSeries(true);
        setPendingAgentRun({
          analysisType: "timeseries",
          goal,
          expected: {
            timeColumn: action.timeColumn,
            valueColumn: action.valueColumn,
          },
          trace: planningTrace,
          step,
        });
      } else if (action.type === "temporal_aggregate") {
        setTimeColumn(action.timeColumn);
        setTimeValueColumn(action.valueColumn);
        setShowTimeSeries(true);
        setTemporalAggregateConfig({
          timeColumn: action.timeColumn,
          valueColumn: action.valueColumn,
          granularity: action.granularity,
        });
        setPendingAgentRun({
          analysisType: "temporal_aggregate",
          goal,
          expected: {
            timeColumn: action.timeColumn,
            valueColumn: action.valueColumn,
            granularity: action.granularity,
          },
          trace: planningTrace,
          step,
        });
      } else if (action.type === "group") {
        setGroupColumn(action.groupColumn);
        setGroupValueColumn(action.valueColumn);
        setGroupPage(0);
        setPendingAgentRun({
          analysisType: "group",
          goal,
          expected: {
            groupColumn: action.groupColumn,
            valueColumn: action.valueColumn,
          },
          trace: planningTrace,
          step,
        });
      }
    } catch (error: unknown) {
      setChatError(
        error instanceof Error
          ? error.message
          : t("Agentの計画に失敗しました。", "Agent planning failed.", "Agent 规划失败。")
      );
    } finally {
      setIsPlanning(false);
    }
  }

  useEffect(() => {
    if (!pendingAgentRun || isAnalyzing) return;

    const ready =
      pendingAgentRun.analysisType === "scatter"
        ? scatterSummary?.xColumn === pendingAgentRun.expected.xColumn &&
          scatterSummary?.yColumn === pendingAgentRun.expected.yColumn
        : pendingAgentRun.analysisType === "timeseries"
        ? timeSeriesSummary?.timeColumn === pendingAgentRun.expected.timeColumn &&
          timeSeriesSummary?.valueColumn === pendingAgentRun.expected.valueColumn
        : pendingAgentRun.analysisType === "distribution"
        ? distributionSummary?.column === pendingAgentRun.expected.column
        : pendingAgentRun.analysisType === "outliers"
        ? outlierSummary?.column === pendingAgentRun.expected.column
        : pendingAgentRun.analysisType === "ranking"
        ? relationshipRankingSummary?.targetColumn ===
            pendingAgentRun.expected.targetColumn &&
          relationshipRankingSummary.results.length > 0
        : pendingAgentRun.analysisType === "temporal_aggregate"
        ? temporalAggregationSummary?.timeColumn ===
            pendingAgentRun.expected.timeColumn &&
          temporalAggregationSummary?.valueColumn ===
            pendingAgentRun.expected.valueColumn &&
          temporalAggregationSummary?.granularity ===
            pendingAgentRun.expected.granularity
        : pendingAgentRun.analysisType === "plan"
        ? JSON.stringify(analysisPlanResult?.plan) === pendingAgentRun.expected.plan
        : pendingAgentRun.analysisType === "group"
        ? groupSummary?.groupColumn === pendingAgentRun.expected.groupColumn &&
          groupSummary?.valueColumn === pendingAgentRun.expected.valueColumn
        : false;

    if (!ready) return;

    const run = pendingAgentRun;
    if (run.analysisType === "ranking" && relationshipRankingSummary) {
      const best = relationshipRankingSummary.results[0];
      if (best) {
        queueMicrotask(() => {
          setScatterXColumn(best.column);
          setScatterYColumn(relationshipRankingSummary.targetColumn);
          setShowScatter(true);
        });
      }
    }
    const executionTrace: AgentTraceItem[] = [
      ...run.trace,
      {
        tool: "execute_browser_analysis",
        label: t(
          "ブラウザで分析を実行し、図を更新",
          "Run the analysis in the browser and update the chart",
          "在浏览器中执行分析并更新图表"
        ),
        status: "completed",
      },
    ];

    const summary: unknown =
      run.analysisType === "scatter"
        ? scatterSummary
        : run.analysisType === "ranking"
        ? relationshipRankingSummary
        : run.analysisType === "timeseries"
        ? timeSeriesSummary
        : run.analysisType === "temporal_aggregate"
        ? temporalAggregationSummary
        : run.analysisType === "plan"
        ? analysisPlanResult
        : run.analysisType === "distribution"
        ? distributionSummary
        : run.analysisType === "outliers"
        ? outlierSummary
        : groupSummary;
    const evidenceSignature = JSON.stringify({
      tool: run.analysisType,
      summary,
    });
    const existingEvidence = evidenceRecords.find(
      (record) =>
        JSON.stringify({ tool: record.tool, summary: record.summary }) ===
        evidenceSignature
    );
    if (!existingEvidence) evidenceCounterRef.current += 1;
    const evidence: EvidenceRecord = existingEvidence ?? {
      id: `ev_${String(evidenceCounterRef.current).padStart(3, "0")}`,
      tool: run.analysisType,
      rowsUsed:
        summary && typeof summary === "object" && "rowsScanned" in summary
          ? Number((summary as { rowsScanned?: unknown }).rowsScanned) || null
          : summary && typeof summary === "object" && "pointCount" in summary
          ? Number((summary as { pointCount?: unknown }).pointCount) || null
          : null,
      createdAt: new Date().toISOString(),
      summary,
    };
    const nextEvidence = existingEvidence
      ? evidenceRecords
      : [...evidenceRecords, evidence].slice(-12);
    setEvidenceRecords(nextEvidence);
    executionTrace.push({
      tool: "register_evidence",
      label: t(
        `根拠 ${evidence.id} を登録`,
        `Register evidence ${evidence.id}`,
        `登记证据 ${evidence.id}`
      ),
      status: "completed",
    });

    setPendingAgentRun(null);
    const targetId =
      run.analysisType === "scatter"
        ? "analysis-scatter"
        : run.analysisType === "ranking"
        ? "analysis-ranking"
        : run.analysisType === "timeseries"
        ? "analysis-timeseries"
        : run.analysisType === "temporal_aggregate"
        ? "analysis-temporal-aggregate"
        : run.analysisType === "plan"
        ? "analysis-plan"
        : run.analysisType === "distribution"
        ? "analysis-distribution"
        : run.analysisType === "outliers"
        ? "analysis-outliers"
        : "analysis-group";
    window.requestAnimationFrame(() => {
      document.getElementById(targetId)?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
    if (!existingEvidence && run.step < 2) {
      void runGoalAgent(run.goal, {
        appendUser: false,
        prefixTrace: executionTrace,
        step: run.step + 1,
        evidence: nextEvidence,
        internal: true,
      });
    } else {
      void requestAnalysis(
        run.analysisType,
        run.goal,
        undefined,
        executionTrace,
        nextEvidence
      );
    }
  }, [
    pendingAgentRun,
    isAnalyzing,
    scatterSummary,
    timeSeriesSummary,
    distributionSummary,
    groupSummary,
    outlierSummary,
    relationshipRankingSummary,
    temporalAggregationSummary,
    analysisPlanResult,
    evidenceRecords,
  ]);

  function handleSendChat() {
    const trimmed = chatInput.trim();
    if (!trimmed || isAnalyzing || isPlanning || pendingAgentRun) return;

    if (!datasetProfile) {
      setChatError(
        language === "ja"
          ? "先にデータセットを読み込んでください。"
          : language === "zh"
          ? "请先加载数据集。"
          : "Please load a dataset first."
      );
      return;
    }

    void runGoalAgent(trimmed);
  }

  const quickQuestions: Array<{
    type: AnalysisType;
    label: string;
  }> = datasetProfile
    ? [
        {
          type: "overview",
          label: t(
            "このデータの品質上の注意点は？",
            "What data-quality issues should I know about?",
            "这个数据集有哪些质量问题？"
          ),
        },
        {
          type: "overview",
          label: t(
            "次に何を分析するべき？",
            "What should I analyze next?",
            "下一步应该分析什么？"
          ),
        },
        ...(timeSeriesSummary
          ? [
              {
                type: "timeseries" as const,
                label: t(
                  "最も重要な時系列傾向は？",
                  "What is the most important time-series trend?",
                  "最重要的时间序列趋势是什么？"
                ),
              },
            ]
          : []),
        ...(scatterSummary
          ? [
              {
                type: "scatter" as const,
                label: t(
                  "2つの変数にはどんな関係がある？",
                  "How are the two selected variables related?",
                  "当前选择的两个变量有什么关系？"
                ),
              },
            ]
          : []),
      ]
    : [];

  return (
    <main className="min-h-screen bg-slate-100 px-4 py-5 lg:px-6 lg:py-7">
      <div className="mx-auto max-w-[1600px]">
        <header className="mb-6 overflow-hidden rounded-3xl bg-slate-950 px-6 py-7 text-white shadow-xl shadow-slate-200 lg:px-9 lg:py-9">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-4xl">
              <div className="mb-4 flex flex-wrap gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-300">
                <span className="rounded-full border border-white/15 bg-white/10 px-3 py-1.5">CSV</span>
                <span className="rounded-full border border-white/15 bg-white/10 px-3 py-1.5">TSV</span>
                <span className="rounded-full border border-white/15 bg-white/10 px-3 py-1.5">SQLite</span>
                <span className="rounded-full border border-emerald-300/20 bg-emerald-300/10 px-3 py-1.5 text-emerald-200">
                  {t("ブラウザ内解析", "Browser-based analysis")}
                </span>
              </div>
              <p className="text-sm font-semibold tracking-wide text-blue-300">
                {t("データ探索ワークスペース", "DATA EXPLORATION WORKSPACE")}
              </p>
              <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl lg:text-5xl">
                Dataset Insight Agent
              </h1>
              <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-300 sm:text-base">
                {t(
                  "CSV・SQLite の構造と品質を自動把握し、データに適した可視化とAI分析を行います。",
                  "Profile CSV and SQLite datasets, explore adaptive visualizations, and ask an AI agent for evidence-based insights."
                )}
              </p>
            </div>

            <div className="flex w-fit rounded-xl border border-white/15 bg-white/10 p-1" aria-label="Language">
              {(["ja", "zh", "en"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setLanguage(option)}
                  className={`rounded-lg px-4 py-2 text-sm font-semibold transition ${
                    language === option
                      ? "bg-white text-slate-950 shadow-sm"
                      : "text-slate-300 hover:text-white"
                  }`}
                >
                  {option === "ja" ? "日本語" : option === "zh" ? "中文" : "English"}
                </button>
              ))}
            </div>
          </div>
        </header>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
          <div>
            <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-slate-200 lg:p-7">
              <div className="flex items-start gap-4">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-blue-50 text-lg font-bold text-blue-700">1</div>
                <div>
              <h2 className="text-xl font-semibold text-slate-900">
                {t("データを読み込む", "Load your dataset")}
              </h2>
                  <p className="mt-1 text-sm leading-6 text-slate-600">
                    {t("ファイルはブラウザ内で読み込まれ、選択したデータだけが分析に使われます。", "Files are read in your browser; only the selected data is used for analysis.")}
                  </p>
                </div>
              </div>

              <div className="mt-5 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-5">
                <label className="inline-flex cursor-pointer items-center rounded-xl bg-blue-600 px-5 py-3 font-semibold text-white shadow-sm transition hover:bg-blue-700">
                  {t("CSV / TSV / SQLite を選択", "Choose CSV / TSV / SQLite")}
                  <input
                    type="file"
                    accept=".csv,.tsv,.txt,.db,.sqlite,.sqlite3"
                    onChange={handleFileUpload}
                    className="hidden"
                  />
                </label>

                <p className="mt-3 text-sm text-slate-500">
                  {t("オンラインSQLite: 最大", "Online SQLite: up to")} {Math.round(
                    SQLITE_ONLINE_FILE_LIMIT_BYTES / 1024 / 1024
                  )} MB · {t("1テーブル最大", "up to")} {SQLITE_TABLE_ROW_LIMIT.toLocaleString()} {t("行", "rows per table")}
                </p>

                {isLoadingFile && (
                  <p className="mt-3 text-sm font-medium text-blue-700">
                    {t("ファイルを読み込んでいます...", "Loading file...")}
                  </p>
                )}

                {fileName && (
                  <p className="mt-3 text-sm text-slate-600">
                    {t("選択中", "Selected")}: {fileName}
                    {dataSource ? `（${dataSource}）` : ""}
                  </p>
                )}

                {fileError && (
                  <p className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                    {fileError}
                  </p>
                )}

                {dataSource === "sqlite" && sqliteTables.length > 0 && (
                  <div className="mt-4 max-w-xl">
                    <label className="mb-2 block text-sm font-medium text-slate-700">
                      {t("分析するSQLiteテーブル", "SQLite table to analyze")}
                    </label>
                    <select
                      value={selectedSqliteTable}
                      onChange={(event) =>
                        handleSQLiteTableChange(event.target.value)
                      }
                      className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-slate-800 outline-none focus:border-slate-500"
                    >
                      {sqliteTables.map((table) => (
                        <option key={table} value={table}>
                          {table}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {sourceNotice && (
                  <p className="mt-3 rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
                    {sourceNotice}
                  </p>
                )}

                {sourceRowCount !== null && (
                  <p className="mt-2 text-sm text-slate-500">
                    {t("データソースの行数", "Source rows")}: {sourceRowCount.toLocaleString()}
                  </p>
                )}
              </div>
            </section>

            {datasetProfile && (
              <section className="mt-6 rounded-3xl bg-white p-6 shadow-sm ring-1 ring-slate-200 lg:p-7">
                <h2 className="text-xl font-semibold text-slate-900">
                  {t("データセット概要", "Dataset overview")}
                </h2>

                <p className="mt-2 text-sm text-slate-600">
                  {t("構造・分野・欠損を自動診断した結果です。まずここでデータを理解します。", "An automatic diagnostic of structure, domain signals, and missing values—the starting point for understanding the data.")}
                </p>

                <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
                  <div className="rounded-xl bg-slate-50 p-4">
                    <p className="text-sm text-slate-500">{t("データ構造", "Structure")}</p>
                    <p className="mt-2 text-lg font-bold text-slate-900">
                      {structureLabel(datasetProfile.structureType)}
                    </p>
                  </div>

                  <div className="rounded-xl bg-slate-50 p-4">
                    <p className="text-sm text-slate-500">{t("分野ヒント", "Domain hint")}</p>
                    <p className="mt-2 text-lg font-bold text-slate-900">
                      {domainLabel(datasetProfile.domainHint.label)}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      confidence: {datasetProfile.domainHint.confidence}
                    </p>
                  </div>

                  <div className="rounded-xl bg-slate-50 p-4">
                    <p className="text-sm text-slate-500">{t("行数", "Rows")}</p>
                    <p className="mt-2 text-2xl font-bold text-slate-900">
                      {datasetProfile.rowCount}
                    </p>
                  </div>

                  <div className="rounded-xl bg-slate-50 p-4">
                    <p className="text-sm text-slate-500">{t("列数", "Columns")}</p>
                    <p className="mt-2 text-2xl font-bold text-slate-900">
                      {datasetProfile.columnCount}
                    </p>
                  </div>

                  <div className="rounded-xl bg-slate-50 p-4">
                    <p className="text-sm text-slate-500">{t("重複行", "Duplicate rows")}</p>
                    <p className="mt-2 text-2xl font-bold text-slate-900">
                      {datasetProfile.duplicateRows}
                    </p>
                  </div>
                </div>

                {datasetProfile.domainHint.reasons.length > 0 && (
                  <p className="mt-3 text-sm text-slate-600">
                    {t("分野推定の根拠", "Domain evidence")}: {datasetProfile.domainHint.reasons.join(", ")}
                  </p>
                )}

                <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
                    <p className="text-sm text-amber-700">{t("空欄", "Empty")}</p>
                    <p className="mt-2 text-xl font-bold text-amber-900">
                      {datasetProfile.cleaning.empty}
                    </p>
                  </div>

                  <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
                    <p className="text-sm text-amber-700">NaN / null</p>
                    <p className="mt-2 text-xl font-bold text-amber-900">
                      {datasetProfile.cleaning.missingText}
                    </p>
                  </div>

                  <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
                    <p className="text-sm text-amber-700">±9999</p>
                    <p className="mt-2 text-xl font-bold text-amber-900">
                      {datasetProfile.cleaning.sentinel9999}
                    </p>
                  </div>

                  <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
                    <p className="text-sm text-amber-700">-32768</p>
                    <p className="mt-2 text-xl font-bold text-amber-900">
                      {datasetProfile.cleaning.sentinel32768}
                    </p>
                  </div>
                </div>

                <div className="mt-6">
                  <h3 className="text-base font-semibold text-slate-900">
                    {t("カラムプロファイル", "Column profile")}
                  </h3>

                  <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200">
                    <table className="min-w-full border-collapse bg-white text-sm">
                      <thead className="bg-slate-100">
                        <tr>
                          <th className="px-4 py-3 text-left font-semibold text-slate-700">
                            {t("カラム", "Column")}
                          </th>
                          <th className="px-4 py-3 text-left font-semibold text-slate-700">
                            {t("タイプ", "Type")}
                          </th>
                          <th className="px-4 py-3 text-left font-semibold text-slate-700">
                            {t("役割", "Role", "字段角色")}
                          </th>
                          <th className="px-4 py-3 text-right font-semibold text-slate-700">
                            {t("有効数", "Valid")}
                          </th>
                          <th className="px-4 py-3 text-right font-semibold text-slate-700">
                            {t("欠損率", "Missing rate")}
                          </th>
                          <th className="px-4 py-3 text-right font-semibold text-slate-700">
                            {t("ユニーク数 / 率", "Unique / ratio")}
                          </th>
                          <th className="px-4 py-3 text-left font-semibold text-slate-700">
                            {t("範囲 / サンプル", "Range / sample")}
                          </th>
                        </tr>
                      </thead>

                      <tbody>
                        {datasetProfile.columns.map((column) => (
                          <tr
                            key={column.name}
                            className="border-t border-slate-200 odd:bg-white even:bg-slate-50"
                          >
                            <td className="whitespace-nowrap px-4 py-3 font-medium text-slate-900">
                              {column.name}
                            </td>
                            <td className="whitespace-nowrap px-4 py-3">
                              <span
                                className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                                  column.type === "identifier"
                                    ? "bg-violet-50 text-violet-700"
                                    : "bg-blue-50 text-blue-700"
                                }`}
                              >
                                {column.type}
                              </span>
                              {column.highCardinality && (
                                <span className="ml-2 rounded-full bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-700">
                                  high-cardinality
                                </span>
                              )}
                            </td>
                            <td className="whitespace-nowrap px-4 py-3">
                              <select
                                value={columnRoleOverrides[column.name] ?? column.role}
                                onChange={(event) =>
                                  setColumnRoleOverrides((previous) => ({
                                    ...previous,
                                    [column.name]: event.target.value as ColumnRole,
                                  }))
                                }
                                className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-700"
                              >
                                {(["identifier", "measure", "dimension", "time", "geospatial", "text"] as ColumnRole[]).map((role) => (
                                  <option key={role} value={role}>{role}</option>
                                ))}
                              </select>
                            </td>
                            <td className="px-4 py-3 text-right text-slate-700">
                              {column.validCount}
                            </td>
                            <td className="px-4 py-3 text-right text-slate-700">
                              {(column.missingRate * 100).toFixed(1)}%
                            </td>
                            <td className="px-4 py-3 text-right text-slate-700">
                              {column.uniqueCount} / {(column.uniqueRatio * 100).toFixed(1)}%
                            </td>
                            <td className="min-w-56 px-4 py-3 text-slate-700">
                              {column.type === "numeric" &&
                              column.min !== undefined &&
                              column.max !== undefined
                                ? `${column.min.toFixed(4)} ～ ${column.max.toFixed(4)}${
                                    column.mean !== undefined
                                      ? t(
                                          `（平均 ${column.mean.toFixed(4)}）`,
                                          ` (mean ${column.mean.toFixed(4)})`,
                                          `（平均值 ${column.mean.toFixed(4)}）`
                                        )
                                      : ""
                                  }`
                                : column.sampleValues.join(", ") || "-"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </section>
            )}

            {columns.length > 0 && (
              <div className="mt-6 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
                <h2 className="text-xl font-semibold text-slate-900">
                  {t("検出されたカラム", "Detected columns")}
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
                    {t("表示する分析", "Visible analyses")}
                  </h2>

                  <div className="mt-4 space-y-3">
                    {datetimeColumns.length > 0 && (
                      <label className="flex items-center gap-2 text-sm text-slate-700">
                        <input
                          type="checkbox"
                          checked={showTimeSeries}
                          onChange={(e) => setShowTimeSeries(e.target.checked)}
                        />
                        {t("時系列グラフを表示", "Show time-series chart")}
                      </label>
                    )}

                    {numericColumns.length >= 2 && (
                      <>
                        <label className="flex items-center gap-2 text-sm text-slate-700">
                          <input
                            type="checkbox"
                            checked={showScatter}
                            onChange={(e) => setShowScatter(e.target.checked)}
                          />
                          {t("散布図を表示", "Show scatter plot")}
                        </label>

                        <label className="flex items-center gap-2 text-sm text-slate-700">
                          <input
                            type="checkbox"
                            checked={showLinearFit}
                            onChange={(e) => setShowLinearFit(e.target.checked)}
                          />
                          {t("線形フィットを表示", "Show linear fit")}
                        </label>

                        <label className="flex items-center gap-2 text-sm text-slate-700">
                          <input
                            type="checkbox"
                            checked={showNonlinearFit}
                            onChange={(e) => setShowNonlinearFit(e.target.checked)}
                          />
                          {t("非線形フィットを表示", "Show nonlinear fit")}
                        </label>
                      </>
                    )}

                    {datetimeColumns.length === 0 && (
                      <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800">
                        {t("日付カラムがないため、時系列分析は表示されません。", "No date column was detected, so time-series analysis is hidden.")}
                      </p>
                    )}
                  </div>
                </div>

                <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
                  <h2 className="text-xl font-semibold text-slate-900">
                    {t("欠損・無効値の処理", "Missing and invalid values")}
                  </h2>

                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <label className="flex items-center gap-2 text-sm text-slate-700">
                      <input
                        type="checkbox"
                        checked={removeEmpty}
                        onChange={(e) => setRemoveEmpty(e.target.checked)}
                      />
                      {t("空値を除外", "Exclude empty values")}
                    </label>

                    <label className="flex items-center gap-2 text-sm text-slate-700">
                      <input
                        type="checkbox"
                        checked={removeNaNText}
                        onChange={(e) => setRemoveNaNText(e.target.checked)}
                      />
                      {t("NaN / NA を除外", "Exclude NaN / NA")}
                    </label>

                    <label className="flex items-center gap-2 text-sm text-slate-700">
                      <input
                        type="checkbox"
                        checked={removeNoneNull}
                        onChange={(e) => setRemoveNoneNull(e.target.checked)}
                      />
                      {t("None / null を除外", "Exclude None / null")}
                    </label>

                    <label className="flex items-center gap-2 text-sm text-slate-700">
                      <input
                        type="checkbox"
                        checked={remove9999}
                        onChange={(e) => setRemove9999(e.target.checked)}
                      />
                      {t("±9999 を除外", "Exclude ±9999")}
                    </label>

                    <label className="flex items-center gap-2 text-sm text-slate-700">
                      <input
                        type="checkbox"
                        checked={remove32768}
                        onChange={(e) => setRemove32768(e.target.checked)}
                      />
                      {t("-32768 を除外", "Exclude -32768")}
                    </label>

                    <label className="flex items-center gap-2 text-sm text-slate-700">
                      <input
                        type="checkbox"
                        checked={removeZero}
                        onChange={(e) => setRemoveZero(e.target.checked)}
                      />
                      {t("0 を除外", "Exclude zero")}
                    </label>
                  </div>
                </div>
              </div>
            )}

            {columns.length > 0 && (
              <div className="mt-6 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
                <h2 className="text-xl font-semibold text-slate-900">
                  {t("可視化の設定", "Visualization settings")}
                </h2>

                <div className="mt-6 grid gap-6 lg:grid-cols-2">
                  <div
                    className={
                      datetimeColumns.length > 0 ? "space-y-4" : "hidden"
                    }
                  >
                    <h3 className="text-lg font-semibold text-slate-800">
                      {t("時系列", "Time series")}
                    </h3>

                    <div>
                      <label className="mb-2 block text-sm font-medium text-slate-700">
                        {t("時間カラム", "Time column")}
                      </label>
                      <select
                        value={timeColumn}
                        onChange={(e) => setTimeColumn(e.target.value)}
                        className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-slate-800 outline-none focus:border-slate-500"
                      >
                        <option value="">{t("選択してください", "Select a column")}</option>
                        {datetimeColumns.map((col) => (
                          <option key={col} value={col}>
                            {col}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="mb-2 block text-sm font-medium text-slate-700">
                        {t("数値カラム", "Numeric column")}
                      </label>
                      <select
                        value={timeValueColumn}
                        onChange={(e) => setTimeValueColumn(e.target.value)}
                        className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-slate-800 outline-none focus:border-slate-500"
                      >
                        <option value="">{t("選択してください", "Select a column")}</option>
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
                          {t("開始日", "Start date")}
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
                          {t("終了日", "End date")}
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

                  <div
                    className={
                      numericColumns.length >= 2 ? "space-y-4" : "hidden"
                    }
                  >
                    <h3 className="text-lg font-semibold text-slate-800">
                      {t("変数間の関係", "Variable relationship")}
                    </h3>

                    <div>
                      <label className="mb-2 block text-sm font-medium text-slate-700">
                        {t("X カラム", "X column")}
                      </label>
                      <select
                        value={scatterXColumn}
                        onChange={(e) => setScatterXColumn(e.target.value)}
                        className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-slate-800 outline-none focus:border-slate-500"
                      >
                        <option value="">{t("選択してください", "Select a column")}</option>
                        {numericColumns.map((col) => (
                          <option key={col} value={col}>
                            {col}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="mb-2 block text-sm font-medium text-slate-700">
                        {t("Y カラム", "Y column")}
                      </label>
                      <select
                        value={scatterYColumn}
                        onChange={(e) => setScatterYColumn(e.target.value)}
                        className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-slate-800 outline-none focus:border-slate-500"
                      >
                        <option value="">{t("選択してください", "Select a column")}</option>
                        {numericColumns.map((col) => (
                          <option key={col} value={col}>
                            {col}
                          </option>
                        ))}
                      </select>
                    </div>

                    <p className="text-sm text-slate-600">
                      {t("日付を指定した場合、散布図にも同じ期間フィルターを適用します。", "When dates are selected, the same date filter is applied to the scatter plot.")}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {numericColumns.length > 0 && (
              <div className="mt-6 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
                <h2 className="text-xl font-semibold text-slate-900">
                  {t("探索分析の設定", "Exploratory analysis")}
                </h2>
                <p className="mt-2 text-sm text-slate-600">
                  {t("数値の分布とグループ間の違いを、データ型に合わせて確認できます。", "Inspect numeric distributions and differences between groups based on detected data types.")}
                </p>

                <div className="mt-5 grid gap-5 lg:grid-cols-3">
                  <div>
                    <label className="mb-2 block text-sm font-medium text-slate-700">
                      {t("分布を調べる数値カラム", "Numeric distribution column")}
                    </label>
                    <select
                      value={distributionColumn}
                      onChange={(event) =>
                        setDistributionColumn(event.target.value)
                      }
                      className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-slate-800 outline-none focus:border-slate-500"
                    >
                      {numericColumns.map((column) => (
                        <option key={column} value={column}>
                          {column}
                        </option>
                      ))}
                    </select>
                  </div>

                  {categoricalColumns.length > 0 && (
                    <>
                      <div>
                        <label className="mb-2 block text-sm font-medium text-slate-700">
                          {t("グループ化するカテゴリ", "Group by")}
                        </label>
                        <select
                          value={groupColumn}
                          onChange={(event) => {
                            setGroupColumn(event.target.value);
                            setGroupPage(0);
                          }}
                          className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-slate-800 outline-none focus:border-slate-500"
                        >
                          {categoricalColumns.map((column) => (
                            <option key={column} value={column}>
                              {column}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="mb-2 block text-sm font-medium text-slate-700">
                          {t("比較する数値カラム", "Metric to compare")}
                        </label>
                        <select
                          value={groupValueColumn}
                          onChange={(event) =>
                            setGroupValueColumn(event.target.value)
                          }
                          className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-slate-800 outline-none focus:border-slate-500"
                        >
                          {numericColumns.map((column) => (
                            <option key={column} value={column}>
                              {column}
                            </option>
                          ))}
                        </select>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}

            {analysisPlanResult && (
              <div id="analysis-plan" className="mt-6 scroll-mt-6 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-xl font-semibold text-slate-900">
                      {t("汎用分析プラン", "Generic analysis plan", "通用分析计划")}
                    </h2>
                    <p className="mt-2 text-sm text-slate-600">
                      {t("走査", "Scanned", "扫描")}: {analysisPlanResult.rowsScanned.toLocaleString()} · {t("一致", "Matched", "匹配")}: {analysisPlanResult.rowsMatched.toLocaleString()}
                    </p>
                  </div>
                </div>
                <details className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <summary className="cursor-pointer text-sm font-semibold text-slate-700">
                    {t("技術詳細", "Technical details", "技术详情")}
                  </summary>
                  <p className="mt-3 text-xs text-slate-500">
                    {t(
                      "この分析はブラウザのバックグラウンドスレッド（Web Worker）で実行されました。",
                      "This analysis ran in a browser background thread (Web Worker).",
                      "这项分析在浏览器后台线程（Web Worker）中运行。"
                    )}
                  </p>
                  <pre className="mt-3 max-h-64 overflow-auto rounded-xl bg-slate-950 p-4 text-xs leading-5 text-slate-200">{JSON.stringify(analysisPlanResult.plan, null, 2)}</pre>
                </details>
                <div className="mt-4 max-h-96 overflow-auto rounded-xl border border-slate-200">
                  <table className="min-w-full text-sm">
                    <thead className="bg-slate-100">
                      <tr>
                        {Object.keys(analysisPlanResult.groups[0] ?? {}).map((key) => (
                          <th key={key} className="px-4 py-3 text-left text-slate-700">{key}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {analysisPlanResult.groups.slice(0, 5).map((row, index) => (
                        <tr key={index} className="border-t border-slate-200">
                          {Object.keys(analysisPlanResult.groups[0] ?? {}).map((key) => (
                            <td key={key} className="px-4 py-3 text-slate-700">{String(row[key] ?? "-")}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {analysisPlanResult.groups.length > 5 && (
                  <p className="mt-2 text-xs text-slate-500">
                    {t(
                      `最初の5件を表示（全${analysisPlanResult.groups.length.toLocaleString()}件）`,
                      `Showing the first 5 of ${analysisPlanResult.groups.length.toLocaleString()} results.`,
                      `显示前5条，共${analysisPlanResult.groups.length.toLocaleString()}条结果。`
                    )}
                  </p>
                )}
              </div>
            )}

            {temporalAggregationSummary && (
              <div id="analysis-temporal-aggregate" className="mt-6 scroll-mt-6 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
                <h2 className="text-xl font-semibold text-slate-900">
                  {t("時間集計", "Temporal aggregation", "时间聚合")}
                </h2>
                <p className="mt-2 text-sm text-slate-600">
                  {temporalAggregationSummary.valueColumn} · {t(
                    temporalAggregationSummary.granularity === "year" ? "年別平均" : "月別平均",
                    temporalAggregationSummary.granularity === "year" ? "Annual mean" : "Monthly mean",
                    temporalAggregationSummary.granularity === "year" ? "年度平均值" : "月度平均值"
                  )}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  {t("有効データ", "Valid rows", "有效数据")}: {temporalAggregationSummary.validCount.toLocaleString()} · {t("除外", "Excluded", "已排除")}: {temporalAggregationSummary.excludedCount.toLocaleString()}
                </p>

                {temporalAggregationSummary.trend && (
                  <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
                    {t("年度平均の傾き", "Annual-mean slope", "年度均值斜率")}: {temporalAggregationSummary.trend.slopePerPeriod.toFixed(4)} / {t("年", "year", "年")} · R² {temporalAggregationSummary.trend.r2?.toFixed(3) ?? "-"}
                  </div>
                )}

                <div className="mt-5 h-[340px] min-h-[340px] min-w-0 w-full">
                  <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={340} initialDimension={{ width: 640, height: 340 }}>
                    <BarChart data={temporalAggregationSummary.groups}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="period" minTickGap={20} />
                      <YAxis />
                      <Tooltip formatter={(value) => typeof value === "number" ? value.toFixed(4) : "-"} />
                      <Bar dataKey="mean" name={t("平均値", "Mean", "平均值")} fill="#0f766e" radius={[5, 5, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {relationshipRankingSummary && relationshipRankingSummary.results.length > 0 && (
              <div id="analysis-ranking" className="mt-6 scroll-mt-6 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
                <h2 className="text-xl font-semibold text-slate-900">
                  {t("変数関係ランキング", "Relationship ranking", "变量关系排名")}
                </h2>
                <p className="mt-2 text-sm text-slate-600">
                  {t("対象変数", "Target", "目标变量")}: {relationshipRankingSummary.targetColumn} · {t("候補", "Candidates", "候选变量")}: {relationshipRankingSummary.candidateCount}
                </p>
                <p className="mt-1 text-xs leading-5 text-slate-500">
                  {t("PearsonまたはSpearmanの絶対値が大きい順です。相関は因果関係を意味しません。", "Ranked by the larger absolute Pearson or Spearman coefficient. Correlation does not imply causation.", "按照 Pearson 或 Spearman 相关系数绝对值的较大者排序；相关性不代表因果关系。")}
                </p>
                <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200">
                  <table className="min-w-full text-sm">
                    <thead className="bg-slate-100 text-slate-700">
                      <tr>
                        <th className="px-4 py-3 text-left">#</th>
                        <th className="px-4 py-3 text-left">{t("変数", "Variable", "变量")}</th>
                        <th className="px-4 py-3 text-right">{t("有効ペア", "Valid pairs", "有效数据对")}</th>
                        <th className="px-4 py-3 text-right">Pearson r</th>
                        <th className="px-4 py-3 text-right">Spearman ρ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {relationshipRankingSummary.results.slice(0, 10).map((result, index) => (
                        <tr key={result.column} className="border-t border-slate-200">
                          <td className="px-4 py-3 text-slate-500">{index + 1}</td>
                          <td className="px-4 py-3 font-medium text-slate-900">{result.column}</td>
                          <td className="px-4 py-3 text-right">{result.validPairs.toLocaleString()}</td>
                          <td className="px-4 py-3 text-right">{result.pearsonR?.toFixed(4) ?? "-"}</td>
                          <td className="px-4 py-3 text-right">{result.spearmanRho?.toFixed(4) ?? "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {outlierSummary && (
              <div id="analysis-outliers" className="mt-6 scroll-mt-6 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
                <h2 className="text-xl font-semibold text-slate-900">
                  {t("IQR外れ値検出", "IQR outlier detection", "IQR 异常值检测")}
                </h2>
                <p className="mt-2 text-sm text-slate-600">{t("対象カラム", "Column", "目标列")}: {outlierSummary.column}</p>
                <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  {[
                    [t("有効数", "Valid", "有效数"), outlierSummary.validCount.toLocaleString()],
                    [t("外れ値数", "Outliers", "异常值数"), outlierSummary.outlierCount.toLocaleString()],
                    [t("外れ値率", "Outlier rate", "异常值比例"), `${(outlierSummary.outlierRate * 100).toFixed(2)}%`],
                    [t("下限", "Lower fence", "下界"), outlierSummary.lowerFence.toFixed(4)],
                    [t("上限", "Upper fence", "上界"), outlierSummary.upperFence.toFixed(4)],
                    [t("低側 / 高側", "Low / high", "低端 / 高端"), `${outlierSummary.lowOutlierCount} / ${outlierSummary.highOutlierCount}`],
                  ].map(([label, value]) => (
                    <div key={label} className="rounded-xl bg-slate-50 p-4">
                      <p className="text-sm text-slate-500">{label}</p>
                      <p className="mt-2 text-xl font-bold text-slate-900">{value}</p>
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-xs leading-5 text-slate-500">
                  {t("IQRの1.5倍を超える値を統計的候補として検出します。業務上の異常を断定するものではありません。", "Values beyond 1.5×IQR are flagged as statistical candidates; this does not by itself prove a domain anomaly.", "将超出1.5倍IQR范围的值标记为统计异常候选，但这并不等同于业务异常。")}
                </p>
              </div>
            )}

            {numericDistribution && (
              <div id="analysis-distribution" className="mt-6 scroll-mt-6 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
                <div>
                  <h2 className="text-xl font-semibold text-slate-900">
                    {t("数値分布", "Numeric distribution")}
                  </h2>
                  <p className="mt-1 text-sm text-slate-600">
                    {t("対象カラム", "Column")}: {numericDistribution.column}
                  </p>
                  <p className="mt-2 text-xs leading-5 text-slate-500">
                    {t("四分位数と標準偏差から、値の中心・ばらつき・外れ値の可能性を確認します。", "Use quartiles and standard deviation to understand the center, spread, and potential outliers.")}
                  </p>
                </div>

                <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  {[
                    [t("有効数", "Valid"), numericDistribution.count.toLocaleString()],
                    [t("除外・欠損", "Missing / excluded"), numericDistribution.missingCount.toLocaleString()],
                    [t("平均", "Mean"), numericDistribution.mean.toFixed(2)],
                    [t("標準偏差", "Std. deviation"), numericDistribution.standardDeviation.toFixed(2)],
                    [t("最小値", "Minimum"), numericDistribution.min.toFixed(2)],
                    [t("第1四分位", "First quartile"), numericDistribution.q1.toFixed(2)],
                    [t("中央値", "Median"), numericDistribution.median.toFixed(2)],
                    [t("第3四分位", "Third quartile"), numericDistribution.q3.toFixed(2)],
                    [t("最大値", "Maximum"), numericDistribution.max.toFixed(2)],
                  ].map(([label, value]) => (
                    <div key={label} className="rounded-xl bg-slate-50 p-4">
                      <p className="text-sm text-slate-500">{label}</p>
                      <p className="mt-2 text-xl font-bold text-slate-900">
                        {value}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {groupedMetrics.length > 0 && (
              <div id="analysis-group" className="mt-6 scroll-mt-6 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
                <div>
                  <h2 className="text-xl font-semibold text-slate-900">
                    {t("グループ別比較", "Group comparison")}
                  </h2>
                  <p className="mt-1 text-sm text-slate-600">
                    {t(
                      `${groupColumn} ごとの ${groupValueColumn} 平均`,
                      `Mean ${groupValueColumn} by ${groupColumn}`,
                      `按 ${groupColumn} 分组的 ${groupValueColumn} 平均值`
                    )}
                  </p>
                  <p className="mt-2 text-xs leading-5 text-slate-500">
                    {t("棒は各グループの平均値です。下の表で件数・最小値・最大値も確認できます。", "Bars show group means. Use the table below to compare sample size, minimum, and maximum values.")}
                  </p>
                  {groupedMetrics.length > GROUP_CHART_LIMIT && (
                    <p className="mt-1 text-sm text-amber-700">
                      {t(
                        `グラフは全 ${groupedMetrics.length} グループ中、件数の多い上位 ${GROUP_CHART_LIMIT} グループを表示しています。表では全グループを確認できます。`,
                        `The chart shows the ${GROUP_CHART_LIMIT} largest groups by sample size out of ${groupedMetrics.length}. The table includes every group.`,
                        `图表显示 ${groupedMetrics.length} 个分组中样本数最多的前 ${GROUP_CHART_LIMIT} 组；下方表格包含全部分组。`
                      )}
                    </p>
                  )}
                </div>

                <div className="mt-6 h-[340px] min-h-[340px] min-w-0 w-full">
                  <ResponsiveContainer
                    width="100%"
                    height="100%"
                    minWidth={0}
                    minHeight={340}
                    initialDimension={{ width: 640, height: 340 }}
                  >
                    <BarChart data={chartGroupedMetrics}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="category" />
                      <YAxis />
                      <Tooltip
                        formatter={(value) =>
                          typeof value === "number" ? value.toFixed(2) : "-"
                        }
                      />
                      <Bar dataKey="mean" name={t("平均値", "Mean")} fill="#2563eb" radius={[6, 6, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                <div className="mt-5 overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead className="bg-slate-100 text-slate-700">
                      <tr>
                        <th className="px-4 py-3 text-left">{t("カテゴリ", "Category")}</th>
                        <th className="px-4 py-3 text-right">{t("行数", "Rows")}</th>
                        <th className="px-4 py-3 text-right">{t("有効数", "Valid")}</th>
                        <th className="px-4 py-3 text-right">{t("平均", "Mean")}</th>
                        <th className="px-4 py-3 text-right">{t("最小", "Min")}</th>
                        <th className="px-4 py-3 text-right">{t("最大", "Max")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleGroupedMetrics.map((group) => (
                        <tr key={group.category} className="border-t border-slate-200">
                          <td className="px-4 py-3 font-medium text-slate-900">
                            {group.category}
                          </td>
                          <td className="px-4 py-3 text-right">{group.rowCount}</td>
                          <td className="px-4 py-3 text-right">{group.validCount}</td>
                          <td className="px-4 py-3 text-right">
                            {group.mean?.toFixed(2) ?? "-"}
                          </td>
                          <td className="px-4 py-3 text-right">
                            {group.min?.toFixed(2) ?? "-"}
                          </td>
                          <td className="px-4 py-3 text-right">
                            {group.max?.toFixed(2) ?? "-"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {groupedMetrics.length > GROUP_TABLE_PAGE_SIZE && (
                  <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-sm text-slate-600">
                      {groupPage * GROUP_TABLE_PAGE_SIZE + 1}–
                      {Math.min(
                        (groupPage + 1) * GROUP_TABLE_PAGE_SIZE,
                        groupedMetrics.length
                      )}{" "}
                      / {groupedMetrics.length} {t("グループ", "groups")}
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          setGroupPage((page) => Math.max(0, page - 1))
                        }
                        disabled={groupPage === 0}
                        className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {t("前へ", "Previous")}
                      </button>
                      <span className="px-3 py-2 text-sm text-slate-600">
                        {groupPage + 1} / {groupPageCount}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setGroupPage((page) =>
                            Math.min(groupPageCount - 1, page + 1)
                          )
                        }
                        disabled={groupPage >= groupPageCount - 1}
                        className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {t("次へ", "Next")}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {showTimeSeries && stats && (
              <div className="mt-6 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
                <h2 className="text-xl font-semibold text-slate-900">
                  {t("時系列の基本統計", "Time-series summary")}
                </h2>

                <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="rounded-xl bg-slate-50 p-4">
                    <p className="text-sm text-slate-500">{t("有効データ数", "Valid points")}</p>
                    <p className="mt-2 text-2xl font-bold text-slate-900">
                      {stats.count}
                    </p>
                  </div>

                  <div className="rounded-xl bg-slate-50 p-4">
                    <p className="text-sm text-slate-500">{t("平均値", "Mean")}</p>
                    <p className="mt-2 text-2xl font-bold text-slate-900">
                      {stats.mean.toFixed(4)}
                    </p>
                  </div>

                  <div className="rounded-xl bg-slate-50 p-4">
                    <p className="text-sm text-slate-500">{t("最小値", "Minimum")}</p>
                    <p className="mt-2 text-2xl font-bold text-slate-900">
                      {stats.min.toFixed(4)}
                    </p>
                  </div>

                  <div className="rounded-xl bg-slate-50 p-4">
                    <p className="text-sm text-slate-500">{t("最大値", "Maximum")}</p>
                    <p className="mt-2 text-2xl font-bold text-slate-900">
                      {stats.max.toFixed(4)}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {showTimeSeries && timeSeriesData.length > 0 && (
              <div id="analysis-timeseries" className="mt-6 scroll-mt-6 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-xl font-semibold text-slate-900">
                      {t("時系列トレンド", "Time-series trend")}
                    </h2>
                    <p className="mt-2 text-sm text-slate-600">
                      {t("横軸", "X-axis")}: {timeColumn} · {t("縦軸", "Y-axis")}: {timeValueColumn}
                    </p>
                    <p className="mt-1 text-xs leading-5 text-slate-500">
                      {t("全体傾向、ピーク、急な変化、欠測の可能性を確認します。", "Inspect overall trends, peaks, abrupt changes, and possible gaps.")}
                    </p>
                  </div>

                  <button
                    onClick={handleAnalyzeTimeSeries}
                    disabled={isAnalyzing}
                    className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isAnalyzing && activeAnalysisType === "timeseries"
                      ? t("分析中...", "Analyzing...")
                      : t("AIで時系列を分析", "Analyze trend with AI")}
                  </button>
                </div>

                <div className="mt-6 h-[420px] min-h-[420px] min-w-0 w-full">
                  <ResponsiveContainer
                    width="100%"
                    height="100%"
                    minWidth={0}
                    minHeight={420}
                    initialDimension={{ width: 640, height: 420 }}
                  >
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
              <div id="analysis-scatter" className="mt-6 scroll-mt-6 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-xl font-semibold text-slate-900">
                      {t("関係性とモデル比較", "Relationship explorer")}
                    </h2>
                    <p className="mt-2 text-sm text-slate-600">
                      X: {scatterXColumn} · Y: {scatterYColumn}
                    </p>
                    <p className="mt-1 text-xs leading-5 text-slate-500">
                      {t("相関と候補モデルを比較し、変数間の関係が直線的か非線形かを確認します。", "Compare correlation and candidate models to see whether the relationship is linear or nonlinear.")}
                    </p>
                  </div>

                  <button
                    onClick={handleAnalyzeScatter}
                    disabled={isAnalyzing}
                    className="rounded-xl bg-violet-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isAnalyzing && activeAnalysisType === "scatter"
                      ? t("分析中...", "Analyzing...")
                      : t("AIで関係を分析", "Analyze relationship with AI")}
                  </button>
                </div>

                <div className="mt-4 grid gap-4 lg:grid-cols-4">
                  <div className="rounded-xl bg-slate-50 p-4">
                    <p className="text-sm text-slate-500">{t("有効な点数", "Valid points")}</p>
                    <p className="mt-2 text-2xl font-bold text-slate-900">
                      {scatterData.length}
                    </p>
                  </div>

                  <div className="rounded-xl bg-slate-50 p-4">
                    <p className="text-sm text-slate-500">Pearson r</p>
                    <p className="mt-2 text-2xl font-bold text-slate-900">
                      {relationshipAnalysis.pearsonR !== null
                        ? relationshipAnalysis.pearsonR.toFixed(4)
                        : "-"}
                    </p>
                    <p className="mt-2 text-xs leading-6 text-slate-600">
                      {t("線形関係の強さ", "Strength of linear association")}
                    </p>
                  </div>

                  <div className="rounded-xl bg-slate-50 p-4">
                    <p className="text-sm text-slate-500">Spearman ρ</p>
                    <p className="mt-2 text-2xl font-bold text-slate-900">
                      {relationshipAnalysis.spearmanRho !== null
                        ? relationshipAnalysis.spearmanRho.toFixed(4)
                        : "-"}
                    </p>
                    <p className="mt-2 text-xs leading-6 text-slate-600">
                      {t("単調関係の強さ", "Strength of monotonic association")}
                    </p>
                  </div>

                  <div className="rounded-xl bg-slate-50 p-4">
                    <p className="text-sm text-slate-500">{t("推奨モデル", "Recommended model")}</p>
                    <p className="mt-2 break-words text-lg font-bold text-slate-900">
                      {relationshipAnalysis.recommendedModel ?? "-"}
                    </p>
                    <p className="mt-2 text-xs leading-6 text-slate-600">
                      {relationshipAnalysis.relationshipType}
                    </p>
                  </div>
                </div>

                <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200">
                  <table className="min-w-full border-collapse bg-white text-sm">
                    <thead className="bg-slate-100">
                      <tr>
                        <th className="px-4 py-3 text-left font-semibold text-slate-700">
                          Model
                        </th>
                        <th className="px-4 py-3 text-right font-semibold text-slate-700">
                          R²
                        </th>
                        <th className="px-4 py-3 text-right font-semibold text-slate-700">
                          RMSE
                        </th>
                        <th className="px-4 py-3 text-right font-semibold text-slate-700">
                          CV RMSE
                        </th>
                        <th className="px-4 py-3 text-right font-semibold text-slate-700">
                          AICc
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {relationshipAnalysis.candidateModels.map((model) => (
                        <tr
                          key={model.name}
                          className={`border-t border-slate-200 ${
                            model.name === relationshipAnalysis.recommendedModel
                              ? "bg-emerald-50"
                              : "bg-white"
                          }`}
                        >
                          <td className="px-4 py-3 font-medium text-slate-900">
                            {model.name}
                            {model.name === relationshipAnalysis.recommendedModel
                              ? " ✓"
                              : ""}
                          </td>
                          <td className="px-4 py-3 text-right text-slate-700">
                            {model.r2 !== null ? model.r2.toFixed(4) : "-"}
                          </td>
                          <td className="px-4 py-3 text-right text-slate-700">
                            {model.rmse.toFixed(4)}
                          </td>
                          <td className="px-4 py-3 text-right text-slate-700">
                            {model.cvRmse !== null
                              ? model.cvRmse.toFixed(4)
                              : "-"}
                          </td>
                          <td className="px-4 py-3 text-right text-slate-700">
                            {model.aicc !== null ? model.aicc.toFixed(2) : "-"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <p className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm leading-6 text-emerald-900">
                  {t(
                    `推奨: ${relationshipAnalysis.recommendedModel ?? "-"}。最小CV RMSEから5%以内の候補では、過度に複雑でないモデルを優先しています。`,
                    relationshipAnalysis.recommendationReason,
                    `推荐：${relationshipAnalysis.recommendedModel ?? "-"}。在 CV RMSE 距离最优值 5% 以内的候选模型中，优先选择不过度复杂的模型。`
                  )}
                </p>

                <div className="mt-4 rounded-xl bg-slate-50 p-4">
                  <h3 className="text-sm font-semibold text-slate-800">
                    {t("指標の読み方", "How to read the metrics")}
                  </h3>
                  <div className="mt-3 grid gap-3 text-xs leading-5 text-slate-600 sm:grid-cols-3">
                    <p><span className="font-semibold text-slate-800">R²</span><br />{t("高いほど、モデルがデータの変動をよく説明します。", "Higher values mean the model explains more variation.")}</p>
                    <p><span className="font-semibold text-slate-800">CV RMSE</span><br />{t("低いほど、未知データへの予測誤差が小さい傾向です。", "Lower values indicate better predictive performance on unseen data.")}</p>
                    <p><span className="font-semibold text-slate-800">AICc</span><br />{t("低いほど、当てはまりとモデルの複雑さのバランスが良いと評価されます。", "Lower values indicate a better balance between fit and model complexity.")}</p>
                  </div>
                  <p className="mt-3 border-t border-slate-200 pt-3 text-xs leading-5 text-slate-500">
                    {t("推奨モデルは、最小CV RMSEから5%以内の候補のうち、最も単純なモデルを選びます。", "The recommendation chooses the simplest model within 5% of the lowest cross-validated RMSE.")}
                  </p>
                </div>

                <div className="mt-6 h-[460px] min-h-[460px] min-w-0 w-full">
                  <ResponsiveContainer
                    width="100%"
                    height="100%"
                    minWidth={0}
                    minHeight={460}
                    initialDimension={{ width: 640, height: 460 }}
                  >
                    <ScatterChart>
                      <CartesianGrid />
                      <XAxis type="number" dataKey="x" name={scatterXColumn} />
                      <YAxis type="number" dataKey="y" name={scatterYColumn} />
                      <Tooltip
                        content={
                          <ScatterTooltipContent
                            scatterXColumn={scatterXColumn}
                            scatterYColumn={scatterYColumn}
                            language={language}
                          />
                        }
                      />
                      <Legend />
                      <Scatter
                        data={scatterData}
                        name={t("観測値", "Observed")}
                        fill="#334155"
                      />
                      {showLinearFit && linearFit && (
                        <Line
                          type="monotone"
                          data={fitLines}
                          dataKey="linear"
                          name={t("線形フィット", "Linear fit")}
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
                          name={t("非線形フィット", "Nonlinear fit")}
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
                  {t("データプレビュー（先頭5行）", "Data preview (first 5 rows)")}
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

          <aside className="flex h-fit flex-col rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200 xl:sticky xl:top-6 xl:h-[calc(100vh-3rem)] xl:overflow-hidden">
            <div className="shrink-0 flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-violet-600">AI COPILOT</p>
                <h2 className="text-xl font-semibold text-slate-900">
                  {t("分析アシスタント", "Analysis assistant")}
                </h2>
                <p className="mt-1 text-sm text-slate-600">
                  {t("計算済みの指標と現在の図を根拠に回答します。", "Answers are grounded in the computed metrics and current chart.")}
                </p>
              </div>
            </div>

            <div className="mt-4 flex min-h-0 flex-1 flex-col gap-4">
              <div className="rounded-xl bg-slate-50 p-4 text-sm text-slate-700">
                <p>
                  {t("現在の分析対象：", "Current analysis target: ")}
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
                      : activeAnalysisType === "overview"
                      ? language === "ja"
                        ? "データセット概要"
                        : language === "zh"
                        ? "数据集概览"
                        : "Dataset overview"
                      : activeAnalysisType === "distribution"
                      ? t("数値分布", "Numeric distribution", "数值分布")
                      : activeAnalysisType === "outliers"
                      ? t("外れ値検出", "Outlier detection", "异常值检测")
                      : activeAnalysisType === "ranking"
                      ? t("関係ランキング", "Relationship ranking", "关系排名")
                      : activeAnalysisType === "temporal_aggregate"
                      ? t("時間集計", "Temporal aggregation", "时间聚合")
                      : activeAnalysisType === "plan"
                      ? t("汎用分析プラン", "Generic analysis plan", "通用分析计划")
                      : activeAnalysisType === "group"
                      ? t("グループ比較", "Group comparison", "分组比较")
                      : t("未選択", "Not selected")}
                  </span>
                </p>
              </div>

              {quickQuestions.length > 0 && (
                <div>
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-slate-800">
                      {t("クイック質問", "Quick questions", "快速提问")}
                    </p>
                    <span className="text-xs text-slate-400">
                      {t("クリックで実行", "Run in one click", "点击即可运行")}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {quickQuestions.map((question) => (
                      <button
                        key={`${question.type}-${question.label}`}
                        type="button"
                        disabled={isAnalyzing || isPlanning || Boolean(pendingAgentRun)}
                        onClick={() => void runGoalAgent(question.label)}
                        className="rounded-full border border-violet-200 bg-violet-50 px-3 py-2 text-left text-xs font-medium leading-5 text-violet-800 transition hover:border-violet-300 hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {question.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div ref={agentScrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
              {agentTrace.length > 0 && (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                  <p className="text-sm font-semibold text-emerald-900">
                    {t("Agent 実行履歴", "Agent trace")}
                  </p>
                  <div className="mt-2 space-y-2">
                    {agentTrace.map((item, index) => (
                      <div
                        key={`${item.tool}-${index}`}
                        className="flex items-center gap-2 text-sm text-emerald-800"
                      >
                        <span aria-hidden="true">✓</span>
                        <span>{item.label}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {evidenceRecords.length > 0 && (
                <details className="rounded-xl border border-cyan-200 bg-cyan-50 p-4">
                  <summary className="cursor-pointer text-sm font-semibold text-cyan-950">
                    {t("根拠カタログ", "Evidence catalog", "证据目录")}
                  </summary>
                  <div className="mt-2 space-y-2">
                    {evidenceRecords.map((record) => (
                      <details key={record.id} className="rounded-lg bg-white p-2 text-xs text-slate-700 ring-1 ring-cyan-100">
                        <summary className="cursor-pointer font-semibold text-cyan-800">
                          {record.id} · {record.tool}{record.rowsUsed ? ` · ${record.rowsUsed.toLocaleString()} rows` : ""}
                        </summary>
                        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all text-[11px] leading-5 text-slate-600">{JSON.stringify(record.summary, null, 2)}</pre>
                      </details>
                    ))}
                  </div>
                </details>
              )}

              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                {chatMessages.length === 0 ? (
                  <div className="text-sm leading-6 text-slate-500">
                    {t(
                      "グラフの「AIで分析」ボタンを押すと、計算済みの統計を使った説明がここに表示されます。その後は続けて質問できます。",
                      "Choose an AI analysis button on a chart. The response will use the computed statistics, and you can ask follow-up questions here."
                    )}
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
              </div>

              <div className="shrink-0 space-y-3 border-t border-slate-200 bg-white pt-4">
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
                    disabled={isAnalyzing || isPlanning || Boolean(pendingAgentRun) || !chatInput.trim() || !datasetProfile}
                    className="flex-1 rounded-xl bg-violet-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isPlanning || pendingAgentRun
                      ? t("Agentが計画・実行中...", "Agent is planning and running...", "Agent 正在规划并执行……")
                      : t("✦ Agentに送信", "✦ Send to Agent", "✦ 发送给 Agent")}
                  </button>

                  <button
                    onClick={() => {
                      setChatMessages([]);
                      setAgentTrace([]);
                      setEvidenceRecords([]);
                      evidenceCounterRef.current = 0;
                      setChatInput("");
                      setChatError("");
                      setActiveAnalysisType(null);
                    }}
                    disabled={isAnalyzing || isPlanning || Boolean(pendingAgentRun)}
                    className="rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {language === "ja"
                      ? "クリア"
                      : language === "zh"
                      ? "清空"
                      : "Clear"}
                  </button>
                </div>

                <p className="text-xs leading-5 text-slate-500">
                  {t(
                    "Agentが現在の根拠で回答できるかを判断し、不足する場合は新しい分析を自動実行します。",
                    "The agent checks whether current evidence is sufficient and automatically runs a new analysis when needed.",
                    "Agent 会先判断当前证据是否足够；如果不足，将自动运行新的数据分析。"
                  )}
                </p>

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
