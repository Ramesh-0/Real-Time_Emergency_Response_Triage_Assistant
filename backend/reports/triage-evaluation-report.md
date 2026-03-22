# Triage Evaluation Harness Report

Generated UTC: 2026-03-22T14:52:33.583Z
Base URL: http://127.0.0.1:5108
Dataset: X:\Real-Time_Emergency_Response_Triage_Assistant\backend\evaluation\labeled-triage-prompts.json
Raw JSON output: X:\Real-Time_Emergency_Response_Triage_Assistant\backend\reports\triage-evaluation-results.json

## Completion Criteria
- Labeled dataset size (50-100): YES (60)
- Reproducible run (isolated backend + pinned env): YES
- Results documented (markdown + json): YES

## Summary Metrics
- Startup to healthy: 684.35 ms
- Request failures: 0
- Diagnosis accuracy: 100.00% (60/60)
- Severity correctness: 100.00% (60/60)
- Noise suppression rate (noisy subset): 100.00% (15/15)
- Leakage-free rate: 100.00% (60/60)
- Average reduction ratio (all cases): 0.3142
- Average reduction ratio (noisy subset): 0.3528

## Gate Checks
| Gate | Metric | Threshold | Result |
| --- | ---: | ---: | :---: |
| Diagnosis accuracy | 100.00% | 85.00% | PASS |
| Severity correctness | 100.00% | 90.00% | PASS |
| Noise suppression (noisy set) | 100.00% | 70.00% | PASS |
| Leakage free rate | 100.00% | 95.00% | PASS |
- Overall gate status: PASS

## Category Breakdown
| Category | Cases | Diagnosis Accuracy | Severity Correctness | Leakage Free Rate | Avg Reduction Ratio | Noisy Cases | Noisy Suppression Rate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| cardiac | 15 | 100.00% | 100.00% | 100.00% | 0.2667 | 0 | 0.00% |
| dental | 15 | 100.00% | 100.00% | 100.00% | 0.3344 | 0 | 0.00% |
| fever | 15 | 100.00% | 100.00% | 100.00% | 0.3028 | 0 | 0.00% |
| mixed-noise | 15 | 100.00% | 100.00% | 100.00% | 0.3528 | 15 | 100.00% |

## Reproducibility Config
```json
{
  "port": 5108,
  "request_timeout_ms": 4000,
  "health_timeout_ms": 45000,
  "request_limit": 8,
  "pinned_env": {
    "scaledown_api_url": "",
    "scaledown_force_remote": false,
    "doc_recency_filter_enabled": true,
    "doc_type_filter_enabled": true,
    "doc_strict_type_filter_on_critical": true,
    "doc_critical_recency_days": 365,
    "doc_non_critical_recency_days": 3650
  }
}
```

## Noise Suppression Context
```json
{
  "seed": {
    "ingested_item_count": 4,
    "ingested_chunk_count": 4,
    "total_searchable_chunks": 18
  },
  "noise_filter_config": {
    "recency_filter_enabled": true,
    "type_filter_enabled": true,
    "strict_type_filter_on_critical": true,
    "critical_recency_days": 365,
    "non_critical_recency_days": 3650,
    "max_doc_age_days": 3650
  }
}
```
