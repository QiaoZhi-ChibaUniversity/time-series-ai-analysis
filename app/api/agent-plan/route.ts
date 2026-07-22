import OpenAI from "openai";
import { NextRequest, NextResponse } from "next/server";
import { validateAnalysisPlan, type AnalysisPlan } from "@/lib/analysis-dsl";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

type Language = "ja" | "zh" | "en";
type ColumnKind = "numeric" | "datetime" | "categorical" | "identifier" | "unknown";

type ColumnInfo = {
  name: string;
  type: ColumnKind;
  role?: string;
  missingRate?: number;
  uniqueCount?: number;
};

type PlannerBody = {
  language?: unknown;
  goal?: unknown;
  columns?: unknown;
  currentContext?: unknown;
};

type AgentAction =
  | { type: "current"; analysisType: string; reason: string }
  | { type: "analysis_plan"; plan: AnalysisPlan; reason: string }
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
      granularity: "month" | "year";
      reason: string;
    }
  | { type: "group"; groupColumn: string; valueColumn: string; reason: string };

function parseLanguage(value: unknown): Language {
  return value === "zh" || value === "en" ? value : "ja";
}

function parseColumns(value: unknown): ColumnInfo[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null && !Array.isArray(item)
    )
    .map((item): ColumnInfo => {
      const type: ColumnKind =
        item.type === "numeric" ||
        item.type === "datetime" ||
        item.type === "categorical" ||
        item.type === "identifier"
          ? item.type
          : "unknown";

      return {
        name: typeof item.name === "string" ? item.name.slice(0, 200) : "",
        type,
        role: typeof item.role === "string" ? item.role.slice(0, 50) : undefined,
        missingRate:
          typeof item.missingRate === "number" ? item.missingRate : undefined,
        uniqueCount:
          typeof item.uniqueCount === "number" ? item.uniqueCount : undefined,
      };
    })
    .filter((item) => item.name)
    .slice(0, 200);
}

function sanitizeObservationValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") return value.slice(0, 300);
  if (depth >= 4) return "[omitted]";
  if (Array.isArray(value)) {
    return value
      .slice(0, 20)
      .map((item) => sanitizeObservationValue(item, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 40)
        .map(([key, item]) => [key.slice(0, 100), sanitizeObservationValue(item, depth + 1)])
    );
  }
  return String(value).slice(0, 300);
}

function parseEvidenceObservations(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null && !Array.isArray(item)
    )
    .slice(-8)
    .map((item) => ({
      id: typeof item.id === "string" ? item.id.slice(0, 30) : "",
      tool: typeof item.tool === "string" ? item.tool.slice(0, 60) : "",
      rowsUsed: typeof item.rowsUsed === "number" ? item.rowsUsed : null,
      summary: sanitizeObservationValue(item.summary),
    }))
    .filter((item) => item.id && item.tool);
}

function parseCurrentContext(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      activeAnalysisType: null as string | null,
      availableEvidence: [] as string[],
      evidenceObservations: [] as ReturnType<typeof parseEvidenceObservations>,
      agentStep: 1,
      selectedFields: {} as Record<string, string>,
    };
  }

  const record = value as Record<string, unknown>;
  const selectedFields =
    typeof record.selectedFields === "object" &&
    record.selectedFields !== null &&
    !Array.isArray(record.selectedFields)
      ? Object.fromEntries(
          Object.entries(record.selectedFields as Record<string, unknown>)
            .filter((entry): entry is [string, string] => typeof entry[1] === "string")
            .slice(0, 20)
        )
      : {};

  return {
    activeAnalysisType:
      typeof record.activeAnalysisType === "string"
        ? record.activeAnalysisType
        : null,
    availableEvidence: Array.isArray(record.availableEvidence)
      ? record.availableEvidence
          .filter((item): item is string => typeof item === "string")
          .slice(0, 20)
      : [],
    evidenceObservations: parseEvidenceObservations(record.evidenceObservations),
    agentStep:
      typeof record.agentStep === "number" && Number.isFinite(record.agentStep)
        ? Math.max(1, Math.min(3, Math.trunc(record.agentStep)))
        : 1,
    selectedFields,
  };
}

function normalizeFieldReference(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/(?:°c|℃|度c)/g, "")
    .replace(/[\s_\-./・]+/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function goalMentionsColumn(goal: string, columnName: string) {
  const normalizedGoal = normalizeFieldReference(goal);
  const normalizedColumn = normalizeFieldReference(columnName);
  return normalizedColumn.length > 0 && normalizedGoal.includes(normalizedColumn);
}

function plannerTools(
  columns: ColumnInfo[],
  currentContext: ReturnType<typeof parseCurrentContext>,
  goal: string
): OpenAI.Responses.Tool[] {
  const numeric = columns.some((column) => column.type === "numeric");
  const datetime = columns.some((column) => column.type === "datetime");
  const categorical = columns.some((column) => column.type === "categorical");
  const mentionedCategoricalColumn = columns.find(
    (column) => column.type === "categorical" && goalMentionsColumn(goal, column.name)
  );
  const mentionedNumericColumn = columns.find(
    (column) => column.type === "numeric" && goalMentionsColumn(goal, column.name)
  );
  const complexPlanIntent =
    /(sort|top\s*\d*|filter|where|ascending|descending|排序|从高|从低|前\s*\d+|筛选|过滤|昇順|降順|上位)/i.test(
      goal
    );
  const outlierIntent =
    /(outlier|anomal(?:y|ies)|abnormal|异常值?|离群值?|外れ値|異常値)/i.test(goal);
  const structuralGroupingIntent =
    /(different.+(?:under|by|across)|by\s+[^,，]+|group(?:ed)?\s+by|across\s+[^,，]+|不同.+(?:下|之间)|按(?:照)?[^,，]+|根据[^,，]+|各[^,，]+別|[^,，]+ごと)/i.test(
      goal
    );
  const groupingIntent =
    categorical &&
    !complexPlanIntent &&
    (Boolean(mentionedCategoricalColumn) || structuralGroupingIntent);
  const monthlyTemporalIntent =
    datetime &&
    /(monthly|seasonal|month|season|月度|每月|季节|月別|季節)/i.test(goal);
  const yearlyTemporalIntent =
    datetime &&
    /(trend|annual|yearly|long[ -]?term|over\s*time|趋势|变化|年度|每年|年际|长期|傾向|変化|推移|年別|長期)/i.test(goal);
  const rawTemporalIntent =
    datetime && /(time\s*series|raw\s*series|时序|时间序列|原始序列|時系列|生データ)/i.test(goal);
  const temporalMode: "month" | "year" | "series" | null = groupingIntent
    ? null
    : monthlyTemporalIntent
    ? "month"
    : yearlyTemporalIntent
    ? "year"
    : rawTemporalIntent
    ? "series"
    : null;
  const temporalIntent = temporalMode !== null;
  const hasRequiredGroupingEvidence = currentContext.evidenceObservations.some(
    (evidence) => {
      if (evidence.tool !== "group") return false;
      if (!evidence.summary || typeof evidence.summary !== "object") return false;
      const summary = evidence.summary as Record<string, unknown>;
      return (
        summary.groupColumn === mentionedCategoricalColumn?.name &&
        (!mentionedNumericColumn || summary.valueColumn === mentionedNumericColumn.name)
      );
    }
  );
  const answerEvidenceTypes = groupingIntent
    ? hasRequiredGroupingEvidence && currentContext.availableEvidence.includes("group")
      ? ["group"]
      : []
    : temporalIntent
    ? currentContext.availableEvidence.filter(
        (item) =>
          item === (temporalMode === "series" ? "timeseries" : "temporal_aggregate")
      )
    : currentContext.availableEvidence;
  const tools: OpenAI.Responses.Tool[] = [
    {
      type: "function",
      name: "inspect_dataset_overview",
      description:
        "Choose this for data quality, schema, missing-value, or general next-step questions that do not require configuring a specific chart.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string" },
        },
        required: ["reason"],
        additionalProperties: false,
      },
      strict: true,
    },
  ];

  if (answerEvidenceTypes.length > 0) {
    tools.unshift({
      type: "function",
      name: "answer_from_current_evidence",
      description:
        "Finish the plan and answer from already computed evidence when the evidence observations directly contain the statistics required by the user's question. Prefer this over repeating an analysis with the same type, fields, grouping, filters, and granularity.",
      parameters: {
        type: "object",
        properties: {
          analysisType: {
            type: "string",
            enum: answerEvidenceTypes,
          },
          reason: { type: "string" },
        },
        required: ["analysisType", "reason"],
        additionalProperties: false,
      },
      strict: true,
    });
  }

  if (!temporalIntent) tools.push({
    type: "function",
    name: "execute_analysis_plan",
    description:
      "Create a generic validated analysis plan for requests involving filters, one or two group-by dimensions, multiple aggregations, sorting, or top-N results. Prefer specialized tools for correlations, outliers, and temporal seasonality.",
    parameters: {
      type: "object",
      properties: {
        plan: {
          type: "object",
          properties: {
            filters: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  column: { type: "string" },
                  operator: { type: "string", enum: ["eq", "gt", "lt", "contains"] },
                  value: { type: "string" },
                },
                required: ["column", "operator", "value"],
                additionalProperties: false,
              },
            },
            groupBy: { type: "array", items: { type: "string" } },
            metrics: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  column: { type: "string" },
                  operation: {
                    type: "string",
                    enum: ["count", "sum", "mean", "min", "max"],
                  },
                },
                required: ["column", "operation"],
                additionalProperties: false,
              },
            },
            sort: {
              type: "object",
              properties: {
                key: { type: "string" },
                direction: { type: "string", enum: ["asc", "desc"] },
              },
              required: ["key", "direction"],
              additionalProperties: false,
            },
            limit: { type: "number" },
            visualization: { type: "string", enum: ["table", "bar", "line"] },
          },
          required: ["filters", "groupBy", "metrics", "sort", "limit", "visualization"],
          additionalProperties: false,
        },
        reason: { type: "string" },
      },
      required: ["plan", "reason"],
      additionalProperties: false,
    },
    strict: true,
  });

  if (numeric) {
    tools.push({
      type: "function",
      name: "profile_numeric_column",
      description:
        "Select one numeric column for distribution, spread, missing-value, or outlier-oriented exploration.",
      parameters: {
        type: "object",
        properties: {
          column: { type: "string" },
          reason: { type: "string" },
        },
        required: ["column", "reason"],
        additionalProperties: false,
      },
      strict: true,
    });

    tools.push({
      type: "function",
      name: "detect_outliers",
      description:
        "Select one numeric column for an explicit IQR-based outlier scan. Use for anomaly, extreme-value, unusual-value, or outlier questions.",
      parameters: {
        type: "object",
        properties: {
          column: { type: "string" },
          reason: { type: "string" },
        },
        required: ["column", "reason"],
        additionalProperties: false,
      },
      strict: true,
    });

    if (columns.filter((column) => column.type === "numeric").length >= 2) {
      tools.push({
        type: "function",
        name: "rank_relationships",
        description:
          "Select a numeric target column and compare it with every other numeric column. Use when the user asks which variable is most related, most influential, or the best candidate predictor.",
        parameters: {
          type: "object",
          properties: {
            targetColumn: { type: "string" },
            reason: { type: "string" },
          },
          required: ["targetColumn", "reason"],
          additionalProperties: false,
        },
        strict: true,
      });
    }
  }

  if (columns.filter((column) => column.type === "numeric").length >= 2) {
    tools.push({
      type: "function",
      name: "configure_relationship",
      description:
        "Select two different numeric columns for correlation, scatter-plot, or model-comparison analysis.",
      parameters: {
        type: "object",
        properties: {
          xColumn: { type: "string" },
          yColumn: { type: "string" },
          reason: { type: "string" },
        },
        required: ["xColumn", "yColumn", "reason"],
        additionalProperties: false,
      },
      strict: true,
    });
  }

  if (numeric && datetime && (!temporalIntent || temporalMode === "series")) {
    tools.push({
      type: "function",
      name: "configure_time_series",
      description:
        "Select a datetime column and numeric value column for trends, peaks, change, seasonality, or gaps.",
      parameters: {
        type: "object",
        properties: {
          timeColumn: { type: "string" },
          valueColumn: { type: "string" },
          reason: { type: "string" },
        },
        required: ["timeColumn", "valueColumn", "reason"],
        additionalProperties: false,
      },
      strict: true,
    });

  }

  if (numeric && datetime && (!temporalIntent || temporalMode === "month" || temporalMode === "year")) {
    tools.push({
      type: "function",
      name: "aggregate_time",
      description:
        "Aggregate a numeric value by calendar month or year. Use for seasonality, monthly patterns, annual change, year-over-year comparisons, or long-term trend questions.",
      parameters: {
        type: "object",
        properties: {
          timeColumn: { type: "string" },
          valueColumn: { type: "string" },
          granularity: {
            type: "string",
            enum:
              temporalMode === "month"
                ? ["month"]
                : temporalMode === "year"
                ? ["year"]
                : ["month", "year"],
          },
          reason: { type: "string" },
        },
        required: ["timeColumn", "valueColumn", "granularity", "reason"],
        additionalProperties: false,
      },
      strict: true,
    });
  }

  if (numeric && categorical) {
    tools.push({
      type: "function",
      name: "configure_group_comparison",
      description:
        "Select a categorical column and numeric value column for comparing group means, ranges, and sample sizes.",
      parameters: {
        type: "object",
        properties: {
          groupColumn: mentionedCategoricalColumn
            ? { type: "string", enum: [mentionedCategoricalColumn.name] }
            : { type: "string" },
          valueColumn: mentionedNumericColumn
            ? { type: "string", enum: [mentionedNumericColumn.name] }
            : { type: "string" },
          reason: { type: "string" },
        },
        required: ["groupColumn", "valueColumn", "reason"],
        additionalProperties: false,
      },
      strict: true,
    });
  }

  if (outlierIntent) {
    return tools.filter(
      (tool) => "name" in tool && tool.name === "detect_outliers"
    );
  }

  if (temporalIntent) {
    const requiredTool = temporalMode === "series" ? "configure_time_series" : "aggregate_time";
    const hasRequiredEvidence = currentContext.evidenceObservations.some((evidence) => {
      if (temporalMode === "series") return evidence.tool === "timeseries";
      if (evidence.tool !== "temporal_aggregate") return false;
      if (!evidence.summary || typeof evidence.summary !== "object") return false;
      return (evidence.summary as Record<string, unknown>).granularity === temporalMode;
    });
    return tools.filter(
      (tool) =>
        "name" in tool &&
        (tool.name === requiredTool ||
          (tool.name === "answer_from_current_evidence" && hasRequiredEvidence))
    );
  }

  if (groupingIntent) {
    return tools.filter(
      (tool) =>
        "name" in tool &&
        (hasRequiredGroupingEvidence
          ? tool.name === "answer_from_current_evidence"
          : tool.name === "configure_group_comparison")
    );
  }

  return tools;
}

function parseArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function textArg(args: Record<string, unknown>, key: string) {
  return typeof args[key] === "string" ? args[key].trim() : "";
}

function createAction(
  name: string,
  args: Record<string, unknown>,
  columns: ColumnInfo[],
  currentContext: ReturnType<typeof parseCurrentContext>
): AgentAction | null {
  const namesByType = (type: ColumnKind) =>
    new Set(columns.filter((column) => column.type === type).map((column) => column.name));
  const numeric = namesByType("numeric");
  const datetime = namesByType("datetime");
  const categorical = namesByType("categorical");
  const reason = textArg(args, "reason") || "Selected by the analysis planner.";

  if (name === "answer_from_current_evidence") {
    const analysisType = textArg(args, "analysisType");
    return currentContext.availableEvidence.includes(analysisType)
      ? { type: "current", analysisType, reason }
      : null;
  }

  if (name === "execute_analysis_plan") {
    const rawPlan = args.plan;
    if (typeof rawPlan !== "object" || rawPlan === null || Array.isArray(rawPlan)) {
      return null;
    }
    try {
      const record = rawPlan as Record<string, unknown>;
      const sortRecord =
        typeof record.sort === "object" && record.sort !== null
          ? (record.sort as Record<string, unknown>)
          : {};
      const plan = validateAnalysisPlan(
        {
          filters: Array.isArray(record.filters) ? (record.filters as AnalysisPlan["filters"]) : [],
          groupBy: Array.isArray(record.groupBy) ? (record.groupBy as string[]) : [],
          metrics: Array.isArray(record.metrics) ? (record.metrics as AnalysisPlan["metrics"]) : [],
          sort: textArg(sortRecord, "key")
            ? {
                key: textArg(sortRecord, "key"),
                direction: textArg(sortRecord, "direction") === "asc" ? "asc" : "desc",
              }
            : undefined,
          limit: typeof record.limit === "number" ? record.limit : 20,
          visualization:
            record.visualization === "bar" || record.visualization === "line"
              ? record.visualization
              : "table",
        },
        columns.map((column) => column.name)
      );
      return { type: "analysis_plan", plan, reason };
    } catch {
      return null;
    }
  }

  if (name === "inspect_dataset_overview") {
    return { type: "overview", reason };
  }

  if (name === "profile_numeric_column") {
    const column = textArg(args, "column");
    return numeric.has(column) ? { type: "distribution", column, reason } : null;
  }

  if (name === "detect_outliers") {
    const column = textArg(args, "column");
    return numeric.has(column) ? { type: "outliers", column, reason } : null;
  }

  if (name === "rank_relationships") {
    const targetColumn = textArg(args, "targetColumn");
    return numeric.has(targetColumn)
      ? { type: "rank_relationships", targetColumn, reason }
      : null;
  }

  if (name === "configure_relationship") {
    const xColumn = textArg(args, "xColumn");
    const yColumn = textArg(args, "yColumn");
    return numeric.has(xColumn) && numeric.has(yColumn) && xColumn !== yColumn
      ? { type: "relationship", xColumn, yColumn, reason }
      : null;
  }

  if (name === "configure_time_series") {
    const timeColumn = textArg(args, "timeColumn");
    const valueColumn = textArg(args, "valueColumn");
    return datetime.has(timeColumn) && numeric.has(valueColumn)
      ? { type: "timeseries", timeColumn, valueColumn, reason }
      : null;
  }

  if (name === "aggregate_time") {
    const timeColumn = textArg(args, "timeColumn");
    const valueColumn = textArg(args, "valueColumn");
    const granularity = textArg(args, "granularity");
    return datetime.has(timeColumn) &&
      numeric.has(valueColumn) &&
      (granularity === "month" || granularity === "year")
      ? {
          type: "temporal_aggregate",
          timeColumn,
          valueColumn,
          granularity,
          reason,
        }
      : null;
  }

  if (name === "configure_group_comparison") {
    const groupColumn = textArg(args, "groupColumn");
    const valueColumn = textArg(args, "valueColumn");
    return categorical.has(groupColumn) && numeric.has(valueColumn)
      ? { type: "group", groupColumn, valueColumn, reason }
      : null;
  }

  return null;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as PlannerBody;
    const language = parseLanguage(body.language);
    const goal =
      typeof body.goal === "string" ? body.goal.trim().slice(0, 2000) : "";
    const columns = parseColumns(body.columns);
    const currentContext = parseCurrentContext(body.currentContext);

    if (!goal || columns.length === 0) {
      return NextResponse.json(
        { error: "A goal and dataset columns are required." },
        { status: 400 }
      );
    }

    const languageRule =
      language === "zh"
        ? "Write the reason in concise Chinese."
        : language === "en"
        ? "Write the reason in concise English."
        : "Write the reason in concise Japanese.";

    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      temperature: 0,
      instructions: `You are an adaptive dataset analysis planner in a plan-execute-observe loop. Choose exactly one tool. Treat evidenceObservations as actual results from earlier steps, not merely as a list of available charts. First inspect their fields, aggregations, values, trends, and evidence IDs. If they directly support the user's goal, finish with answer_from_current_evidence. If essential evidence is missing, select one computation that adds genuinely new information. Never repeat a computation whose analysis type, columns, filters, grouping, metrics, and temporal granularity are already represented in evidenceObservations; finish from that evidence instead. A new step is justified only when its output could change or materially strengthen the conclusion. Resolve user concepts against the current schema semantically, including abbreviations and cross-language wording, but return the exact schema column names in tool arguments. Select only columns listed in the schema, prefer interpretable non-identifier columns, and do not invent columns. ${languageRule}`,
      input: [
        {
          role: "user",
          content: `Goal: ${goal}\n\nCurrent context:\n${JSON.stringify(currentContext, null, 2)}\n\nDataset schema:\n${JSON.stringify(columns, null, 2)}`,
        },
      ],
      tools: plannerTools(columns, currentContext, goal),
      tool_choice: "required",
    });

    for (const item of response.output) {
      if (item.type !== "function_call") continue;
      const action = createAction(
        item.name,
        parseArguments(item.arguments),
        columns,
        currentContext
      );
      if (action) {
        return NextResponse.json({ action });
      }
    }

    return NextResponse.json(
      { error: "The planner did not return a valid dataset action." },
      { status: 422 }
    );
  } catch (error: unknown) {
    console.error("agent-plan error:", error);
    return NextResponse.json(
      {
        error: "Failed to plan the dataset analysis.",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
