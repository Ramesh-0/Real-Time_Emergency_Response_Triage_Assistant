# Real-Time Emergency Response Triage Assistant

A voice-or-text-enabled triage assistant that helps emergency teams get the next best action from large, messy medical histories or disaster protocols in real time.

## Problem Statement

In emergency rooms and disaster zones, staff cannot read hundreds of pages of unstructured history before acting.

This project addresses that by building a triage assistant that:
- accepts text or voice transcript input,
- retrieves relevant context from a large protocol/history repository,
- removes irrelevant noise before reasoning,
- returns diagnosis, severity, and recommended action quickly.

## Core Constraints and How This System Handles Them

### 1) Latency is primary (< 500 ms)
- Uses a hybrid in-memory chunk index for fast candidate retrieval.
- Uses intelligent pruning to reduce downstream context size before decision logic.
- Measures stage-level timings (`retrieve`, `prune`, `decide`, `response`) on every triage call.

### 2) Noise reduction is mandatory
- Applies recency filtering and type filtering before and after pruning.
- Uses strict type filtering for critical queries (for example, cardiac events).
- Prevents stale or unrelated records from leaking into final context.

### Required Technique: Intelligent Context Pruning
- The system prunes non-essential retrieved context so fewer tokens are processed.
- It can use an external pruning service when configured, with local fallback when unavailable.

## Supporting Numbers (Latest Local Runs: 2026-03-22)

### Scale and Retrieval
| Metric | Result |
| --- | --- |
| Indexed chunks benchmarked | 12,000 |
| Required chunk goal | 10,000 (met) |
| Search latency (p95) | 18.17 ms |
| Search latency (avg) | 13.95 ms |
| Query runs | 120 |

### End-to-End Triage Latency
| Metric | Result |
| --- | --- |
| SLA target | p95 < 500 ms |
| Warm traffic p95 | 198.72 ms (SLA met) |
| Warm traffic load | 240 requests, concurrency 6 |
| Warm traffic failures | 0 |
| Cold first triage (client latency) | 265.88 ms |

Warm stage p95:
- retrieve: 0.27 ms
- prune: 185.96 ms
- decide: 0.10 ms
- response: 0.02 ms

### Noise Reduction and Triage Quality
| Metric | Result |
| --- | --- |
| Noise evaluation checks passed | 6/6 |
| Unrelated leakage count | 0 |
| Stale leakage count | 0 |
| Noisy-case suppression | 100% (15/15) |
| Avg context reduction ratio (all cases) | 0.3142 |
| Avg context reduction ratio (noisy cases) | 0.3528 |
| Diagnosis accuracy | 100% (60/60) |
| Severity correctness | 100% (60/60) |
| Leakage-free rate | 100% (60/60) |

## Architecture (Simple View)

Input (text or voice transcript)
-> Retrieval from indexed protocol/history chunks
-> Intelligent context pruning (noise removal)
-> Triage decision (diagnosis + severity + action)
-> Response

## API Endpoints

- `POST /triage` - text triage
- `POST /triage/voice` - voice transcript triage
- `POST /retrieve` - retrieve candidate context
- `POST /search/chunks` - direct chunk search
- `POST /ingest/unstructured` - ingest PDF/DOCX/TXT/MD/RTF content
- `GET /health` - service health
- `GET /metrics` - observability metrics

Example text request:

```json
{
  "query": "severe chest pain with sweating and left arm pressure",
  "limit": 5
}
```

Example voice request:

```json
{
  "transcript": "severe chest pain with sweating and left arm pressure",
  "limit": 8
}
```

## Quick Start

```bash
npm --prefix backend install
npm --prefix frontend install
npm --prefix backend start
npm --prefix frontend run dev
```

## Reproduce the Numbers

```bash
npm --prefix backend run benchmark:index
npm --prefix backend run benchmark:triage
npm --prefix backend run evaluate:noise
npm --prefix backend run evaluate:triage
npm --prefix backend run validate:observability
npm --prefix backend test
```

Report files:
- `backend/reports/triage-latency-report.md`
- `backend/reports/noise-reduction-evaluation.md`
- `backend/reports/triage-evaluation-report.md`
- `backend/reports/triage-evaluation-results.json`
- `backend/reports/observability-validation-report.md`

## Note

Performance numbers can vary by machine, but this project is designed to keep warm p95 triage latency under the 500 ms target while suppressing irrelevant clinical noise.
