import OpenAI from "openai";
import { NextRequest, NextResponse } from "next/server";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

type Language = "ja" | "zh" | "en";

type AgentRequestBody = {
  language?: unknown;
  analysisType?: unknown;
  userMessage?: unknown;
  messages?: unknown;
  datasetProfile?: unknown;
  timeSeriesSummary?: unknown;
  scatterSummary?: unknown;
  distributionSummary?: unknown;
  groupSummary?: unknown;
  outlierSummary?: unknown;
  relationshipRankingSummary?: unknown;
  temporalAggregationSummary?: unknown;
  analysisPlanResult?: unknown;
  evidenceRecords?: unknown;
};

type ToolName =
  | "inspect_data_quality"
  | "analyze_distribution"
  | "detect_outliers"
  | "rank_relationships"
  | "analyze_temporal_aggregation"
  | "inspect_analysis_plan"
  | "inspect_evidence_catalog"
  | "compare_groups"
  | "analyze_time_series"
  | "analyze_relationship";

type AgentTraceItem = {
  tool: ToolName;
  label: string;
  status: "completed";
};

function requestedToolName(value: unknown): ToolName | null {
  if (value === "overview") return "inspect_data_quality";
  if (value === "timeseries") return "analyze_time_series";
  if (value === "temporal_aggregate") return "analyze_temporal_aggregation";
  if (value === "distribution") return "analyze_distribution";
  if (value === "outliers") return "detect_outliers";
  if (value === "ranking") return "rank_relationships";
  if (value === "scatter") return "analyze_relationship";
  if (value === "group") return "compare_groups";
  if (value === "plan") return "inspect_analysis_plan";
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLanguage(value: unknown): Language {
  return value === "zh" || value === "en" ? value : "ja";
}

function parseUserMessage(value: unknown) {
  if (typeof value !== "string") return "Analyze this dataset.";
  return value.trim().slice(0, 2000) || "Analyze this dataset.";
}

function toolLabel(name: ToolName, language: Language) {
  const labels: Record<Language, Record<ToolName, string>> = {
    ja: {
      inspect_data_quality: "データ品質を確認",
      analyze_distribution: "数値分布を分析",
      detect_outliers: "IQR外れ値を検出",
      rank_relationships: "全数値列の関係をランキング",
      analyze_temporal_aggregation: "月別・年別集計を分析",
      inspect_analysis_plan: "汎用分析プランの結果を確認",
      inspect_evidence_catalog: "根拠カタログを確認",
      compare_groups: "グループ間の差を比較",
      analyze_time_series: "時系列傾向を分析",
      analyze_relationship: "変数関係と候補モデルを分析",
    },
    zh: {
      inspect_data_quality: "检查数据质量",
      analyze_distribution: "分析数值分布",
      detect_outliers: "检测IQR异常值",
      rank_relationships: "对全部数值列关系进行排名",
      analyze_temporal_aggregation: "分析月度或年度聚合",
      inspect_analysis_plan: "检查通用分析计划结果",
      inspect_evidence_catalog: "检查证据目录",
      compare_groups: "比较组间差异",
      analyze_time_series: "分析时间序列",
      analyze_relationship: "分析变量关系和候选模型",
    },
    en: {
      inspect_data_quality: "Inspect data quality",
      analyze_distribution: "Analyze numeric distribution",
      detect_outliers: "Detect IQR outliers",
      rank_relationships: "Rank relationships across numeric columns",
      analyze_temporal_aggregation: "Analyze monthly or annual aggregation",
      inspect_analysis_plan: "Inspect generic analysis-plan results",
      inspect_evidence_catalog: "Inspect evidence catalog",
      compare_groups: "Compare groups",
      analyze_time_series: "Analyze time-series trend",
      analyze_relationship: "Analyze relationships and candidate models",
    },
  };

  return labels[language][name];
}

function languageInstruction(language: Language) {
  if (language === "zh") {
    return "使用简洁中文回答。明确区分结论、数值证据、限制和建议。";
  }

  if (language === "en") {
    return "Answer in concise English. Separate findings, numerical evidence, limitations, and recommendations.";
  }

  return "簡潔な日本語で回答してください。結論、数値的根拠、制約、提案を明確に分けてください。";
}

function parseMessages(value: unknown): OpenAI.Responses.ResponseInput {
  if (!Array.isArray(value)) return [];

  return value
    .filter(
      (item): item is { role: "user" | "assistant"; content: string } =>
        isRecord(item) &&
        (item.role === "user" || item.role === "assistant") &&
        typeof item.content === "string"
    )
    .slice(-8)
    .map((item) => ({
      role: item.role,
      content: item.content.slice(0, 2000),
    }));
}

function buildTools(body: AgentRequestBody): OpenAI.Responses.Tool[] {
  const tools: OpenAI.Responses.Tool[] = [];

  if (isRecord(body.datasetProfile)) {
    tools.push({
      type: "function",
      name: "inspect_data_quality",
      description:
        "Inspect the dataset profile, inferred column types, missing values, sentinel values, and duplicate rows. Use this before making claims about the dataset.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      strict: true,
    });
  }

  if (isRecord(body.timeSeriesSummary)) {
    tools.push({
      type: "function",
      name: "analyze_time_series",
      description:
        "Retrieve deterministic time-series statistics, including point count, range, mean, dates, and sampled observations. Use for questions about trends or temporal change.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      strict: true,
    });
  }

  if (isRecord(body.distributionSummary)) {
    tools.push({
      type: "function",
      name: "analyze_distribution",
      description:
        "Retrieve deterministic distribution statistics for the selected numeric column, including count, missing count, quartiles, mean, standard deviation, minimum, and maximum.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      strict: true,
    });
  }

  if (isRecord(body.groupSummary)) {
    tools.push({
      type: "function",
      name: "compare_groups",
      description:
        "Retrieve deterministic grouped statistics for the selected categorical and numeric columns, including group counts, means, minima, and maxima.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      strict: true,
    });
  }

  if (isRecord(body.outlierSummary)) {
    tools.push({
      type: "function",
      name: "detect_outliers",
      description:
        "Retrieve deterministic IQR outlier evidence, including fences, counts, rate, low/high split, coverage, and sample outlier values.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      strict: true,
    });
  }

  if (isRecord(body.relationshipRankingSummary)) {
    tools.push({
      type: "function",
      name: "rank_relationships",
      description:
        "Retrieve a deterministic ranking of every numeric candidate against a target column using Pearson and Spearman coefficients and valid-pair counts.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      strict: true,
    });
  }

  if (isRecord(body.temporalAggregationSummary)) {
    tools.push({
      type: "function",
      name: "analyze_temporal_aggregation",
      description:
        "Retrieve deterministic monthly or annual aggregates, including count, mean, median, minimum, maximum, coverage, and annual trend slope when available.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      strict: true,
    });
  }

  if (isRecord(body.analysisPlanResult)) {
    tools.push({
      type: "function",
      name: "inspect_analysis_plan",
      description:
        "Retrieve the validated generic analysis plan and its browser-executed filtered, grouped, aggregated, sorted, and limited result.",
      parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
      strict: true,
    });
  }

  if (Array.isArray(body.evidenceRecords) && body.evidenceRecords.length > 0) {
    tools.push({
      type: "function",
      name: "inspect_evidence_catalog",
      description:
        "Retrieve traceable evidence records with evidence IDs, tool names, row coverage, timestamps, and structured summaries. Cite relevant IDs in the final answer.",
      parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
      strict: true,
    });
  }

  if (isRecord(body.scatterSummary)) {
    tools.push({
      type: "function",
      name: "analyze_relationship",
      description:
        "Retrieve deterministic relationship analysis, including Pearson and Spearman correlations, linear and quadratic candidates, optional domain-specific saturation model, cross-validated errors, AICc, and the automatically recommended model.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      strict: true,
    });
  }

  return tools;
}

function executeTool(name: string, body: AgentRequestBody) {
  if (name === "inspect_data_quality" && isRecord(body.datasetProfile)) {
    return body.datasetProfile;
  }

  if (name === "analyze_time_series" && isRecord(body.timeSeriesSummary)) {
    return body.timeSeriesSummary;
  }

  if (name === "analyze_distribution" && isRecord(body.distributionSummary)) {
    return body.distributionSummary;
  }

  if (name === "compare_groups" && isRecord(body.groupSummary)) {
    return body.groupSummary;
  }

  if (name === "detect_outliers" && isRecord(body.outlierSummary)) {
    return body.outlierSummary;
  }

  if (
    name === "rank_relationships" &&
    isRecord(body.relationshipRankingSummary)
  ) {
    return body.relationshipRankingSummary;
  }

  if (
    name === "analyze_temporal_aggregation" &&
    isRecord(body.temporalAggregationSummary)
  ) {
    return body.temporalAggregationSummary;
  }

  if (name === "inspect_analysis_plan" && isRecord(body.analysisPlanResult)) {
    return body.analysisPlanResult;
  }

  if (name === "inspect_evidence_catalog" && Array.isArray(body.evidenceRecords)) {
    return body.evidenceRecords.slice(-12);
  }

  if (name === "analyze_relationship" && isRecord(body.scatterSummary)) {
    return body.scatterSummary;
  }

  return {
    error: "The requested analysis result is not available for this dataset.",
  };
}

function isToolName(value: string): value is ToolName {
  return (
    value === "inspect_data_quality" ||
    value === "analyze_distribution" ||
    value === "detect_outliers" ||
    value === "rank_relationships" ||
    value === "analyze_temporal_aggregation" ||
    value === "inspect_analysis_plan" ||
    value === "inspect_evidence_catalog" ||
    value === "compare_groups" ||
    value === "analyze_time_series" ||
    value === "analyze_relationship"
  );
}

export async function POST(req: NextRequest) {
  try {
    const contentLength = Number(req.headers.get("content-length") || 0);

    if (contentLength > 250_000) {
      return NextResponse.json(
        { error: "Request body is too large." },
        { status: 413 }
      );
    }

    let body: AgentRequestBody;

    try {
      body = (await req.json()) as AgentRequestBody;
    } catch {
      return NextResponse.json(
        { error: "Invalid or empty JSON body." },
        { status: 400 }
      );
    }

    if (!isRecord(body)) {
      return NextResponse.json(
        { error: "JSON body must be an object." },
        { status: 400 }
      );
    }

    const language = parseLanguage(body.language);
    const userMessage = parseUserMessage(body.userMessage);
    const conversationMessages = parseMessages(body.messages);
    const tools = buildTools(body);

    if (tools.length === 0) {
      return NextResponse.json(
        { error: "No analysis data is available." },
        { status: 400 }
      );
    }

    const instructions = `
You are a tabular dataset analysis agent.
Use the provided tools to obtain numerical evidence before answering.
Never invent columns, statistics, trends, correlations, or model results.
The application selected analysis type ${String(body.analysisType ?? "unknown")}. Use the matching analysis tool first and do not replace it with the dataset overview.
Use additional tools only when relevant to the user's question.
If the evidence is insufficient, state that clearly.
Treat sampled observations as examples only, never as proof of a full-period trend.
Do not infer monthly, seasonal, annual, or year-over-year patterns from overall minimum, maximum, mean, date range, or a small sample. Such claims require temporal aggregation evidence.
Do not claim that one variable is the strongest relationship unless relationship-ranking evidence is available.
Do not claim outliers exist unless an outlier tool result or explicit distribution evidence supports it.
When evidence records are available, cite supporting evidence IDs in square brackets such as [ev_001]. Do not cite an evidence ID that does not support the claim.
${languageInstruction(language)}
`;

    const input: OpenAI.Responses.ResponseInput = [
      ...conversationMessages,
      {
        role: "user",
        content: userMessage,
      },
    ];

    const requestedTool = requestedToolName(body.analysisType);
    const requestedToolAvailable =
      requestedTool !== null &&
      tools.some((tool) => "name" in tool && tool.name === requestedTool);
    const activeTools = requestedToolAvailable
      ? tools.filter(
          (tool) =>
            "name" in tool &&
            (tool.name === requestedTool || tool.name === "inspect_evidence_catalog")
        )
      : tools;

    let response = await client.responses.create({
      model: "gpt-4.1-mini",
      temperature: 0,
      instructions,
      input,
      tools: activeTools,
      tool_choice: requestedToolAvailable
        ? { type: "function", name: requestedTool }
        : "required",
    });

    const trace: AgentTraceItem[] = [];

    for (let iteration = 0; iteration < 3; iteration += 1) {
      const functionCalls = response.output.filter(
        (item) => item.type === "function_call"
      );

      if (functionCalls.length === 0) break;

      input.push(
        ...(response.output as unknown as OpenAI.Responses.ResponseInput)
      );

      for (const call of functionCalls) {
        const output = executeTool(call.name, body);

        input.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(output),
        });

        if (isToolName(call.name)) {
          trace.push({
            tool: call.name,
            label: toolLabel(call.name, language),
            status: "completed",
          });
        }
      }

      response = await client.responses.create({
        model: "gpt-4.1-mini",
        temperature: 0,
        instructions,
        input,
        tools: activeTools,
        tool_choice: "auto",
      });
    }

    if (response.output.some((item) => item.type === "function_call")) {
      const remainingFunctionCalls = response.output.filter(
        (item) => item.type === "function_call"
      );
      input.push(
        ...(response.output as unknown as OpenAI.Responses.ResponseInput)
      );

      for (const call of remainingFunctionCalls) {
        const output = executeTool(call.name, body);
        input.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(output),
        });
        if (isToolName(call.name)) {
          trace.push({
            tool: call.name,
            label: toolLabel(call.name, language),
            status: "completed",
          });
        }
      }

      response = await client.responses.create({
        model: "gpt-4.1-mini",
        temperature: 0,
        instructions,
        input,
        tools: activeTools,
        tool_choice: "none",
      });
    }

    return NextResponse.json({
      reply: response.output_text || "No response was returned.",
      trace,
    });
  } catch (error: unknown) {
    console.error("analyze-agent error:", error);

    return NextResponse.json(
      { error: "Failed to analyze the dataset." },
      { status: 500 }
    );
  }
}
