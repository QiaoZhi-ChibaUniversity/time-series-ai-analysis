import OpenAI from "openai";
import { NextRequest, NextResponse } from "next/server";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function POST(req: NextRequest) {
  try {
    let body: any;

    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid or empty JSON body." },
        { status: 400 }
      );
    }

    const {
      analysisType = "scatter",
      language = "ja",
      chartSummary = {},
      messages = [],
      userMessage = "現在の散布図を簡潔に分析してください。",
    } = body;

    const languageInstruction =
      language === "ja"
        ? "必ず簡潔な日本語で回答してください。2〜4文程度で短くまとめてください。"
        : language === "zh"
        ? "请务必用简短中文回答，控制在2到4句。"
        : "Please answer in concise English in 2 to 4 sentences.";

    const typeInstruction =
      analysisType === "timeseries"
        ? "これは時系列グラフです。主に全体傾向、ピーク、変動、欠測の可能性について述べてください。"
        : "これは散布図です。主に相関傾向、ばらつき、飽和傾向の可能性について述べてください。";

    const prompt = `
${languageInstruction}
${typeInstruction}

以下は現在の図の要約情報です：
${JSON.stringify(chartSummary, null, 2)}

これまでの会話：
${messages
  .map((m: { role: string; content: string }) => `${m.role}: ${m.content}`)
  .join("\n")}

ユーザーの質問：
${userMessage}
`;

    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      input: prompt,
    });

    return NextResponse.json({
      reply: response.output_text || "No response.",
    });
  } catch (error: any) {
    console.error("analyze-chat error:", error);
    return NextResponse.json(
      {
        error: "Failed to analyze chart.",
        detail: String(error?.message || error),
      },
      { status: 500 }
    );
  }
}