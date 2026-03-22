# Noise Reduction Evaluation Report

Generated UTC: 2026-03-22T14:51:23.268Z
Base URL: http://127.0.0.1:5089
Critical recency window (days): 365

## Summary
- Total checks: 6
- Passed checks: 6
- Failed checks: 0
- Unrelated leakage count: 0
- Stale leakage count: 0
- Missing-check count: 0
- Empty-context count: 0
- Leakage gate met (critical scenarios): YES

## Effective Noise Filter Config
```json
{
  "recency_filter_enabled": true,
  "type_filter_enabled": true,
  "strict_type_filter_on_critical": true,
  "critical_recency_days": 365,
  "non_critical_recency_days": 3650,
  "max_doc_age_days": 3650
}
```

## Per-Scenario Results
| Endpoint | Scenario | Context Docs | Unrelated | Stale | Checks Applied | Result |
| --- | --- | ---: | ---: | ---: | :---: | :---: |
| triage | critical-cardiology-chest | 3 | 0 | 0 | YES | PASS |
| triage | critical-cardiology-ecg | 3 | 0 | 0 | YES | PASS |
| triage | critical-dental-abscess | 2 | 0 | 0 | YES | PASS |
| retrieve | critical-cardiology-chest | 3 | 0 | 0 | YES | PASS |
| retrieve | critical-cardiology-ecg | 3 | 0 | 0 | YES | PASS |
| retrieve | critical-dental-abscess | 2 | 0 | 0 | YES | PASS |
