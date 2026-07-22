## Update Log — 2026-07-22

### Dataset Analysis Agent v2

This release expands the original remote-sensing time-series demo into a more general, evidence-grounded tabular data analysis agent.

#### New capabilities

- Added support for general tabular datasets while retaining remote-sensing and environmental use cases.
- Added browser-side import for CSV, TSV, TXT, and SQLite database files.
- Added automatic character-encoding detection, including UTF-8 and Japanese CP932 / Shift_JIS CSV files.
- Added dataset profiling for column types, field roles, missing values, duplicate rows, sentinel values, and dataset structure.
- Added automatic field-role inference (`identifier`, `measure`, `dimension`, `time`, `geospatial`, and `text`) with manual correction.
- Added specialized analysis tools for temporal aggregation, numeric distributions, outliers, group comparison, relationship ranking, and model comparison.
- Added a validated analysis-plan DSL for filtering, grouping, aggregation, sorting, and Top-N queries.
- Added a multi-step plan–execute–observe Agent loop that decides whether existing evidence is sufficient or another calculation is required.
- Added evidence IDs and a traceable evidence catalog so AI conclusions can reference the calculations that support them.
- Added Web Worker execution for generic analysis plans to keep heavy browser-side calculations from blocking the interface.
- Added adaptive schema-to-question field binding so the Agent can select and update chart fields from natural-language requests.
- Added Japanese, English, and Chinese interfaces and AI responses.
- Redesigned the AI Copilot as a fixed-height panel with independent scrolling and an always-accessible message composer.
- Added automated planner-routing evaluations covering temporal, grouping, relationship, outlier, and evidence-reuse scenarios.

#### Architecture update

The LLM is used as a planner and explanation layer rather than as the numerical calculation engine. Deterministic analysis runs in the browser, validated results are registered as evidence, and only compact summaries are sent to the server-side OpenAI integration.

The application is deployed on Vercel, and the root URL now redirects directly to the latest Dataset Analysis Agent interface.

---

## Update Log — 2026-04-23
Added a sample dataset (sample file) for quick testing and demonstration
Included a detailed column description document to help users better understand the data structure and variables
---

🌏 Time Series AI Analysis Platform
Remote Sensing Data Analysis Demo

🔗 Live Demo
https://time-series-ai-analysis.vercel.app

🧭 Overview

This project is a full-stack web application for time-series data analysis, designed for remote sensing and ecosystem studies.

It integrates:

data upload
interactive visualization
statistical modeling
AI-assisted interpretation

into a single workflow.

🏗️ System Architecture
🔹 Frontend
Next.js (React)
TypeScript / JavaScript
Recharts (visualization)
PapaParse (CSV parsing)

Responsibilities

CSV upload & parsing
column detection
data filtering & preprocessing
visualization (time series / scatter)
model fitting (linear / nonlinear)
AIC-based model comparison

👉 Most analysis logic runs in the browser.

🔹 Backend
Next.js API Routes

Responsibilities

receive chart summaries
manage chat context
call OpenAI API
return analysis results

👉 Lightweight server layer focused on AI integration.

🔹 AI Integration
OpenAI API

Features

trend explanation
model comparison interpretation
ecological insight generation

Input

chart summary
user query
conversation history

Output

concise natural language explanation (JA / EN / ZH)

🔹 Deployment
Vercel (serverless)
⚙️ Data Processing
1. Data Input
CSV upload
automatic column detection
2. Data Cleaning
remove NaN / null / invalid values
optional zero filtering
3. Time Filtering
user-defined time range

📊 Modeling
🔹 Linear Model

🔹 Nonlinear Model


Used for:
light-response curves
NIRvP–GPP analysis

🔹 Model Comparison

AIC
Akaike weights

📈 Visualization
Time Series
temporal trends
variability
missing values
Scatter Plot
relationship analysis
optional model fitting

🤖 AI-Assisted Analysis

Automatically generates:

correlation interpretation
saturation detection
variability explanation

👉 Helps users understand results without manual inspection.

🌱 Scientific Context

Typical use cases:

NIRvP – GPP
Reflectance – Photosynthesis
Environmental drivers vs ecosystem response

👨‍🔬 Author

Zhi Qiao
PhD Student, Remote Sensing
Chiba University (CEReS)

📄 License

MIT License
