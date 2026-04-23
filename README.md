

Update Log
2026-04-23


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
