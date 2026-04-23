# 🌏 Time Series AI Analysis Platform  
（リモートセンシング解析デモ）

🔗 Live Demo: https://time-series-ai-analysis.vercel.app

Update Log
2026-04-23

EN

Added a sample dataset (sample file) for quick testing and demonstration
Included a detailed column description document to help users better understand the data structure and variables
---

## 🧭 Overview

This web application provides an interactive platform for analyzing time series data, with a focus on remote sensing and ecosystem studies.

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
Suitable for:
- Light-response curves  
- NIRvP–GPP relationships  

Captures saturation effects at high input levels.

---

### 📉 Model Comparison
- AIC (Akaike Information Criterion)  
- Quantitative comparison between linear and nonlinear models  
- Model selection support  

---

### 🤖 AI-Assisted Interpretation
- Automatic explanation of trends  
- Interpretation of model differences  
- Ecological insight generation  

Helps users understand complex relationships without manual inspection.

---

## 🌱 Scientific Context

This platform is designed for analyzing relationships such as:

- NIRvP – GPP  
- Reflectance – Photosynthesis  
- Environmental drivers vs ecosystem response  

At fine temporal scales, nonlinear saturation effects (e.g., light saturation in photosynthesis) are often dominant, while aggregated data may appear more linear.

This tool enables direct exploration of these scale-dependent behaviors.

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
7. Run AI analysis  

---

## ⚙️ Technology Stack

- **Next.js** — full-stack framework  
- **Vercel** — cloud deployment platform  
- **Visualization Library** — for interactive plotting  
- **OpenAI API** — AI-assisted analysis  

---

## 🔐 Environment Configuration

AI-powered features rely on a secure API integration.

Required environment variable:
OPENAI_API_KEY

This key is configured securely in the deployment environment and is not exposed in the source code.

---

## 👨‍🔬 Author

Zhi Qiao  
PhD Student, Remote Sensing  
Chiba University (CEReS)

---

## 📄 License

MIT License
