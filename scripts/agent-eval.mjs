const baseUrl = process.env.AGENT_EVAL_BASE_URL || "http://localhost:3000";

const columns = [
  { name: "TIMESTAMP", type: "datetime", role: "time" },
  { name: "GPP", type: "numeric", role: "measure" },
  { name: "SW_IN_F", type: "numeric", role: "measure" },
  { name: "TA_F", type: "numeric", role: "measure" },
  { name: "SITE", type: "categorical", role: "dimension" },
];

const cases = [
  { goal: "进一步分析GPP季节变化", expected: "temporal_aggregate" },
  { goal: "分析GPP年度变化", expected: "temporal_aggregate" },
  { goal: "哪个变量与GPP关系最强", expected: "rank_relationships" },
  { goal: "检测GPP异常值", expected: "outliers" },
  { goal: "按SITE比较GPP平均值并从高到低排序", expected: "analysis_plan" },
  {
    goal: "当前散点图的R²是什么意思",
    expected: "current",
    context: {
      activeAnalysisType: "scatter",
      availableEvidence: ["overview", "scatter"],
      evidenceObservations: [
        {
          id: "view_scatter",
          tool: "scatter",
          rowsUsed: 7300,
          summary: {
            xColumn: "SW_IN_F",
            yColumn: "GPP",
            pearsonR: 0.58,
            bestModel: { name: "linear", r2: 0.34 },
          },
        },
      ],
      selectedFields: { scatterXColumn: "SW_IN_F", scatterYColumn: "GPP" },
    },
  },
  {
    goal: "Does the existing annual evidence show an upward or downward trend?",
    expected: "current",
    context: {
      activeAnalysisType: "temporal_aggregate",
      availableEvidence: ["overview", "temporal_aggregate"],
      evidenceObservations: [
        {
          id: "ev_001",
          tool: "temporal_aggregate",
          rowsUsed: 7300,
          summary: {
            timeColumn: "TIMESTAMP",
            valueColumn: "GPP",
            granularity: "year",
            trend: { direction: "increasing", slopePerPeriod: 0.08, r2: 0.62 },
            groups: [
              { period: "2020", mean: 4.2 },
              { period: "2021", mean: 4.4 },
            ],
          },
        },
      ],
      selectedFields: { timeColumn: "TIMESTAMP", timeValueColumn: "GPP" },
    },
  },
  {
    goal: "Analyze annual GPP change rather than only the raw time series.",
    expected: "temporal_aggregate",
    context: {
      activeAnalysisType: "timeseries",
      availableEvidence: ["overview", "timeseries"],
      evidenceObservations: [
        {
          id: "ev_001",
          tool: "timeseries",
          rowsUsed: 7300,
          summary: {
            timeColumn: "TIMESTAMP",
            valueColumn: "GPP",
            pointCount: 7300,
            min: 0.1,
            max: 16,
            mean: 4.8,
          },
        },
      ],
      selectedFields: { timeColumn: "TIMESTAMP", timeValueColumn: "GPP" },
    },
  },
  {
    goal: "GPPの変化傾向を分析してください",
    expected: "temporal_aggregate",
    expectedGranularity: "year",
  },
  {
    goal: "GPPの季節変化を分析してください",
    expected: "temporal_aggregate",
    expectedGranularity: "month",
  },
  {
    goal: "不同天气下的水温变化",
    expected: "group",
    expectedGroupColumn: "天候",
    expectedValueColumn: "水温 (℃)",
    columns: [
      { name: "採水月日", type: "datetime", role: "time" },
      { name: "天候", type: "categorical", role: "dimension" },
      { name: "水温 (℃)", type: "numeric", role: "measure" },
      { name: "気温 (℃)", type: "numeric", role: "measure" },
    ],
    context: {
      activeAnalysisType: "group",
      availableEvidence: ["overview", "group"],
      evidenceObservations: [
        {
          id: "view_group",
          tool: "group",
          rowsUsed: 307,
          summary: { groupColumn: "天候", valueColumn: "気温 (℃)", groups: [] },
        },
      ],
      selectedFields: { groupColumn: "天候", groupValueColumn: "気温 (℃)" },
    },
  },
  {
    goal: "不同天候下的水温变化",
    expected: "current",
    columns: [
      { name: "採水月日", type: "datetime", role: "time" },
      { name: "天候", type: "categorical", role: "dimension" },
      { name: "水温 (℃)", type: "numeric", role: "measure" },
    ],
    context: {
      activeAnalysisType: "group",
      availableEvidence: ["overview", "group"],
      evidenceObservations: [
        {
          id: "ev_001",
          tool: "group",
          rowsUsed: 307,
          summary: { groupColumn: "天候", valueColumn: "水温 (℃)", groups: [] },
        },
      ],
      selectedFields: { groupColumn: "天候", groupValueColumn: "水温 (℃)" },
    },
  },
];

let passed = 0;
for (const test of cases) {
  const response = await fetch(`${baseUrl}/api/agent-plan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      language: "zh",
      goal: test.goal,
      columns: test.columns || columns,
      currentContext: test.context || {
        activeAnalysisType: "overview",
        availableEvidence: ["overview"],
        selectedFields: {},
      },
    }),
  });
  const body = await response.json();
  const actual = body?.action?.type || `HTTP_${response.status}`;
  const actualGranularity = body?.action?.granularity;
  const ok =
    actual === test.expected &&
    (!test.expectedGranularity || actualGranularity === test.expectedGranularity) &&
    (!test.expectedGroupColumn || body?.action?.groupColumn === test.expectedGroupColumn) &&
    (!test.expectedValueColumn || body?.action?.valueColumn === test.expectedValueColumn);
  if (ok) passed += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} | ${test.goal} | expected=${test.expected}` +
      `${test.expectedGranularity ? `/${test.expectedGranularity}` : ""} actual=${actual}` +
      `${actualGranularity ? `/${actualGranularity}` : ""}`
  );
}

console.log(`\n${passed}/${cases.length} planner evaluations passed.`);
if (passed !== cases.length) process.exitCode = 1;
