# 🏥 Real-Time Emergency Triage Assistant

AI-powered system that analyzes patient data in real-time and recommends the next best medical action using **Intelligent Context Pruning**.

---

## 🚨 Problem Statement

In emergency situations, doctors must make rapid decisions using large, unstructured patient histories.
Traditional systems are slow and include irrelevant data, increasing response time.

---

## 💡 Solution

We built a **real-time triage assistant** that:

* Accepts patient symptoms via text/voice
* Retrieves relevant medical history
* Uses **Scaledown API** for intelligent context pruning
* Generates fast, actionable recommendations

---

## ⚙️ Architecture

Frontend (React UI)
↓
Backend API (Node.js)
↓
Context Retrieval (JSON dataset)
↓
Scaledown API (Pruning Layer)
↓
Decision Engine (LLM / Rule-based)
↓
Response (Diagnosis + Action + Severity)

---

## 🧠 Key Feature: Intelligent Context Pruning

We use **Scaledown API** to:

* Remove irrelevant patient history (e.g., old dental records)
* Keep only critical, recent, condition-specific data
* Reduce token size significantly

---

## ⚡ Performance Improvements

| Metric      | Before Pruning | After Pruning |
| ----------- | -------------- | ------------- |
| Tokens Sent | ~1200          | ~300          |
| Latency     | ~2.0s          | ~0.4s         |
| Cost        | High           | Reduced       |

---

## 🖥️ Frontend Features

* 📝 Text input for symptoms
* 🎤 Voice input (optional)
* 📂 JSON upload (optional)
* 🚀 Analyze button
* ⏳ Loading indicator
* 🚨 Severity badge (HIGH / MEDIUM / LOW)
* 📌 Explanation ("Why this decision")

---

## 🔧 Backend Features

* Patient data stored in JSON format
* Keyword + metadata-based retrieval
* Scaledown API integration
* Rule-based decision engine
* Fast API response (<500ms target)

---

## ⏱️ Latency SLA Benchmark

Benchmark script now measures triage latency in two views:

* **Cold start (separate):** process startup + first triage request
* **Warm sustained traffic:** warm-up phase followed by concurrent load and p95 checks

Per-triage stage timings and budgets are included in the API response and benchmark report:

* `retrieve`
* `prune`
* `decide`
* `response`

Run benchmark:

```bash
cd backend
npm run benchmark:triage
```

Report output:

* `backend/reports/triage-latency-report.md`

SLA rule enforced by benchmark:

* Warm traffic **p95 < 500 ms** (non-zero exit code on failure)

---

## 📈 Observability

Backend observability is now live with:

* Structured JSON logs for every request lifecycle event
* Request correlation via `x-request-id` (accepted from client or auto-generated)
* Prometheus-style metrics endpoint for:

   * latency (rolling avg/p95 by endpoint)
   * prune reduction ratio
   * error rate
   * external prune availability
* Alert states for:

   * p95 latency breach (`p95_latency_breach`)
   * external pruning outage (`pruning_outage`)

Live endpoints:

* `GET /metrics`
* `GET /observability/dashboard`
* `GET /observability/alerts`
* `GET /observability/dashboard.html`

Run observability validation and generate submission report:

```bash
cd backend
npm run validate:observability
```

Validation report output:

* `backend/reports/observability-validation-report.md`

---

## 🧪 Evaluation Harness

Reproducible triage evaluation harness now includes:

* Versioned labeled test set: `backend/evaluation/labeled-triage-prompts.json`
* 60 prompts across cardiac, fever, dental, and mixed-noise scenarios
* Tracked metrics:

   * diagnosis accuracy
   * severity correctness
   * noise suppression and leakage-free rate

Run evaluation harness:

```bash
cd backend
npm run evaluate:triage
```

Outputs:

* `backend/reports/triage-evaluation-report.md`
* `backend/reports/triage-evaluation-results.json`

---

## ✅ Critical Regression Tests

Critical-case regression coverage includes:

* cardiac emergency prompt
* fever prompt
* dental abscess prompt
* mixed-noise prompt (must still return correct diagnosis/severity and keep leakage at zero)

Run regression tests:

```bash
cd backend
npm test
```

---

## 📂 Project Structure

```
project/
│
├── backend/
│   ├── server.js
│   ├── data.json
│
├── frontend/
│   ├── src/
│   ├── components/
│
└── README.md
```

---

## 🚀 How to Run

### 1. Clone Repository

```bash
git clone <repo-link>
cd project
```

### 2. Run Backend

```bash
cd backend
npm install
node server.js
```

### 3. Run Frontend

```bash
cd frontend
npm install
npm run dev
```

---

## 🎯 Demo Flow

1. Enter symptoms (e.g., chest pain, sweating)
2. System retrieves relevant patient data
3. Scaledown API prunes unnecessary context
4. Output:

   * Diagnosis
   * Recommended action
   * Severity level

---

## 🧪 Dataset

Simulated dataset including:

* Cardiology records
* General medical history
* Irrelevant data (for pruning demonstration)

---

## 🌍 Real-World Impact

* Faster emergency response
* Reduced cognitive load for doctors
* Works in low-resource environments
* Scalable for hospitals and disaster zones

---

## 👥 Team

* Ramesh – Backend + AI
* Sarthak – Frontend
* Aditi – Data + Metrics

---

## 🔮 Future Improvements

* Real hospital database integration
* Advanced ML diagnosis
* Multi-patient triage
* Offline deployment

---

## 🏁 Conclusion

This project demonstrates how intelligent context pruning can significantly improve speed and efficiency in critical healthcare scenarios.
