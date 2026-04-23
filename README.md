

Update Log
2026-04-23


Added a sample dataset (sample file) for quick testing and demonstration
Included a detailed column description document to help users better understand the data structure and variables
---

🌏 Time Series AI Analysis Platform

（Remote Sensing Data Analysis Demo）

🔗 Live Demo: https://time-series-ai-analysis.vercel.app

🧭 Overview

This project is a full-stack web application for time-series data analysis, designed for remote sensing and ecosystem studies.

It supports CSV-based data exploration, visualization, statistical modeling, and AI-assisted interpretation in an integrated workflow.

Unlike traditional analysis tools, this platform combines:

interactive visualization
on-the-fly data processing
model fitting and comparison
AI-driven explanation
🏗️ System Architecture
🔹 Frontend (Client-side)
Framework: Next.js (React)
Language: TypeScript / JavaScript
Visualization: Recharts
Data Handling: PapaParse

The frontend is responsible for:

CSV file upload and parsing
column detection and variable selection
data filtering and preprocessing
time-series and scatter plot rendering
model fitting (linear & nonlinear)
AIC-based model comparison

👉 Most data processing and analysis logic runs directly in the browser.

🔹 Backend (Server-side)
Framework: Next.js API Routes
Function: AI-assisted analysis

Backend responsibilities:

receive structured chart summaries
manage conversation history
call OpenAI API for analysis
return concise interpretation results

👉 Backend is lightweight, focused on AI interaction rather than data computation.

🔹 AI Integration
API: OpenAI API
Model Usage: structured prompt-based analysis

Features:

automatic interpretation of trends
explanation of model differences
ecological reasoning (e.g., saturation effects)

Input:

chart summary (statistics + sample points)
user query + context

Output:

concise natural language analysis (JA / EN / ZH)
🔹 Deployment
Platform: Vercel
Type: Serverless full-stack deployment


⚙️ Data Processing Pipeline
1. Data Input
CSV upload (client-side)
automatic column detection
2. Data Cleaning
remove:
empty values
NaN / null / None
invalid flags (±9999, -32768)
optional zero filtering
3. Time Filtering
user-defined date range
applied consistently to all analyses
📊 Modeling & Analysis
🔹 Linear Model
Ordinary Least Squares (OLS)
Outputs:
slope
intercept
R²
RMSE
AIC
🔹 Nonlinear Model (Saturating Exponential)

Model form:

y = a(1 - exp(-b·x)) + c

Characteristics:

captures saturation behavior
suitable for:
light-response curves
NIRvP–GPP relationships
🔹 Model Comparison
Akaike Information Criterion (AIC)
Akaike weights

Used for:

selecting best model
quantifying relative model performance
📈 Visualization
Time Series
temporal dynamics
trend and variability
missing data handling
Scatter Plot
variable relationships
optional:
linear fit
nonlinear fit
🤖 AI-Assisted Analysis

The system generates automatic interpretations based on:

statistical summaries
model fitting results
data distribution

Examples:

correlation strength
saturation effects
variability patterns

👉 Designed to reduce manual inspection effort.

🌱 Scientific Context

This tool is particularly useful for analyzing:

NIRvP – GPP relationships
Reflectance – Photosynthesis
Environmental drivers vs ecosystem response

Key insight:

Fine temporal scales → nonlinear saturation dominates
Aggregated data → relationship appears more linear
🧪 Typical Workflow
Upload CSV
Select columns
Apply filters
Generate plots
Fit models
Compare models (AIC)
Run AI analysis
⚙️ Technology Stack
Frontend: Next.js / React
Backend: Next.js API Routes
Visualization: Recharts
Data Processing: PapaParse
AI: OpenAI API
Deployment: Vercel
👨‍🔬 Author

Zhi Qiao
PhD Student, Remote Sensing
Chiba University (CEReS)

📄 License

MIT License
