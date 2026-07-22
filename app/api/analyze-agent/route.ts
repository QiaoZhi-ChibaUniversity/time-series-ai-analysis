import OpenAI from "openai";
import { NextRequest, NextResponse } from "next/server";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

type Language = "ja" | "zh" | "en";

type AgentRequestBody = {
  language?: unknown;
  userMessage?: unknown;
  messages?: unknown;
  datasetProfile?: unknown;
  timeSeriesSummary?: unknown;
  scatterSummary?: unknown;
};

type ToolName =
  | "inspect_data_quality"
  | "analyze_time_series"
  | "analyze_relationship";

type AgentTraceItem = {
  tool: ToolName;
  label: string;
  status: "completed";
};

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
      analyze_time_series: "時系列傾向を分析",
      analyze_relationship: "変数関係と候補モデルを分析",
    },
    zh: {
      inspect_data_quality: "检查数据质量",
      analyze_time_series: "分析时间序列",
      analyze_relationship: "分析变量关系和候选模型",
    },
    en: {
      inspect_data_quality: "Inspect data quality",
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
Start by inspecting data quality when that tool is available.
Use additional tools only when relevant to the user's question.
If the evidence is insufficient, state that clearly.
${languageInstruction(language)}
`;

    let input: OpenAI.Responses.ResponseInput = [
      ...conversationMessages,
      {
        role: "user",
        content: userMessage,
      },
    ];

    let response = await client.responses.create({
      model: "gpt-4.1-mini",
      instructions,
      input,
      tools,
      tool_choice: "required",
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
        instructions,
        input,
        tools,
        tool_choice: "auto",
      });
    }

    if (response.output.some((item) => item.type === "function_call")) {
      input.push(
        ...(response.output as unknown as OpenAI.Responses.ResponseInput)
      );

      response = await client.responses.create({
        model: "gpt-4.1-mini",
        instructions,
        input,
        tools,
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
