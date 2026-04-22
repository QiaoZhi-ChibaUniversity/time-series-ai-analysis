This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

# 🌏 Time Series AI Analysis Platform  
（リモートセンシング解析デモ）

🔗 Live Demo: https://time-series-ai-analysis.vercel.app

---

## 🧭 Overview

This web application provides an interactive platform for analyzing time series data with a focus on remote sensing and ecosystem studies.  

It enables users to upload CSV datasets, visualize temporal dynamics, explore variable relationships, and perform both statistical and AI-assisted model interpretation.

本ツールは、時系列データ（特にリモートセンシング・生態系データ）の解析・可視化・モデル比較・AI解釈を統合したWebアプリケーションです。

---

## 🎯 Key Capabilities

### 📂 Data Input
- Upload CSV datasets
- Automatic column detection
- Flexible variable selection

---

### 📈 Visualization

#### Time Series
- Plot temporal variation
- Custom time range filtering
- Missing values handled gracefully

#### Scatter Analysis
- Variable relationship exploration
- Time-filtered scatter plots
- Dual-variable comparison

---

### 🧹 Data Cleaning

- Remove NaN values
- Optional exclusion of zero values
- Custom filtering options for invalid data

---

### 📊 Model Analysis

#### Linear Model
- Simple regression fitting
- Baseline comparison

#### Nonlinear Model (Saturating Response)
- Suitable for:
  - Light-response curves
  - NIRvP–GPP relationships
- Captures saturation effects at high input levels

---

### 📉 Model Comparison

- AIC (Akaike Information Criterion)
- Quantitative comparison:
  - Linear vs Nonlinear performance
- Model selection support

---

### 🤖 AI-Assisted Interpretation

- Automatic explanation of:
  - Trends
  - Model differences
  - Ecological implications
- Helps interpret complex relationships without manual inspection

---

## 🌱 Scientific Context

This tool is particularly designed for analyzing relationships such as:

- NIRvP – GPP  
- Reflectance – Photosynthesis  
- Environmental drivers vs ecosystem response  

At fine temporal scales, nonlinear saturation effects often dominate (e.g., light saturation in photosynthesis), while aggregated scales may appear more linear.  

This platform enables direct exploration of these scale-dependent behaviors.

---

## 🧪 Typical Workflow

1. Upload CSV file  
2. Select time column and variables  
3. Apply filters (optional)  
4. Generate plots:
   - Time series
   - Scatter plots  
5. Enable model fitting:
   - Linear
   - Nonlinear  
6. Compare models (AIC)  
7. Run AI analysis for interpretation  

---

## ⚙️ Technology Stack

- Frontend & Backend: Next.js  
- Deployment: Vercel  
- Visualization: (Chart.js / Recharts)  
- AI Integration: OpenAI API  

le AI features:
