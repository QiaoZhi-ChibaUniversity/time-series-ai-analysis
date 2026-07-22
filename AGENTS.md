<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Project: Dataset Analysis Agent

This repository contains a general-purpose, evidence-grounded tabular data analysis agent built with Next.js. Remote sensing and ecosystem data are important use cases, but new features must remain useful for general datasets.

## Main architecture

- `app/agent/page.tsx`: client-side application, dataset controls, visualizations, Agent loop, and evidence UI.
- `app/agent/data-agent.worker.ts`: browser Web Worker for validated generic analysis plans.
- `app/api/agent-plan/route.ts`: server-side LLM planner that selects validated analysis actions.
- `app/api/analyze-agent/route.ts`: server-side evidence-based explanation and tool-calling loop.
- `lib/dataset-profiler.ts`: dataset structure, quality, domain hints, column types, and field roles.
- `lib/data-agent-tools.ts`: deterministic temporal, distribution, outlier, group, and relationship computations.
- `lib/analysis-dsl.ts`: validation and execution contract for generic filter/group/aggregate/sort plans.
- `lib/tabular-file.ts`: CSV, TSV, TXT, encoding, and tabular file parsing support.

## Design boundaries

- Treat the LLM as a planner and explanation layer, not as the numerical calculation engine.
- Keep deterministic calculations in application code and register their results as traceable evidence.
- Never let an LLM-provided column name or DSL operation execute before validating it against the current schema.
- Prefer schema-based semantic field binding over hard-coded business vocabulary or dataset-specific aliases.
- Do not send full uploaded CSV or SQLite files to the OpenAI API. Send schema information and compact evidence summaries only.
- Keep `OPENAI_API_KEY` server-side. Never rename it with a `NEXT_PUBLIC_` prefix or expose it to client code.
- Preserve manual field-role and column-selection controls as a fallback for ambiguous natural-language requests.
- Avoid duplicate calculations: reuse evidence when analysis type, fields, filters, grouping, metrics, and granularity match.

## Supported behavior

- Inputs: CSV, TSV, TXT, and browser-parsed SQLite files.
- Text encodings include UTF-8 and Japanese CP932 / Shift_JIS.
- Interfaces and AI responses support Japanese, English, and Chinese.
- Specialized analyses include time series, monthly/yearly aggregation, distributions, IQR outliers, group comparisons, relationship ranking, and candidate-model comparison.
- Generic table questions use the validated analysis DSL and Web Worker execution.
- The root route redirects to `/agent` for the deployed application.

## Verification commands

Run these checks in proportion to the change:

```powershell
npx tsc --noEmit
npm run lint
npm run build
```

Planner evaluation requires a running local application and `OPENAI_API_KEY`:

```powershell
npm run dev
npm run eval:agent
```

When changing planner routing, schema binding, evidence reuse, or tool selection, add or update a scenario in `scripts/agent-eval.mjs` and verify the full evaluation suite.
