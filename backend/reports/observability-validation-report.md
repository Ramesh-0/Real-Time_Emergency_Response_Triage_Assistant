# Observability Validation Report

Generated UTC: 2026-03-22T14:53:46.832Z
Base URL: http://127.0.0.1:5099
Validation request id: obs-validate-request-001

## Summary
- Total checks: 8
- Passed checks: 8
- Failed checks: 0
- Active alerts: p95_latency_breach, pruning_outage

## Check Results
| Check | Result | Details |
| --- | :---: | --- |
| Request ID propagates in response header and body | PASS | header=obs-validate-request-001, body=obs-validate-request-001 |
| Structured logs include request_id | PASS | request_completed log found with matching request_id |
| Metrics endpoint exposes required observability metrics | PASS | all required metric names found |
| Dashboard API is live with triage endpoint data | PASS | triage endpoint present in snapshot |
| Dashboard HTML page is live | PASS | dashboard title found in HTML payload |
| P95 latency breach alert triggers | PASS | p95_latency_breach is active |
| Pruning outage alert triggers | PASS | pruning_outage is active |
| External prune availability reflects outage | PASS | availability=0 |

## Dashboard Snapshot
```json
{
  "request_id": "da031381-28ee-4a1f-bdb5-a7223290f3f8",
  "generated_at": "2026-03-22T14:53:46.821Z",
  "started_at": "2026-03-22T14:53:46.461Z",
  "uptime_seconds": 1,
  "window_config": {
    "latency_window_size": 300,
    "error_rate_window_size": 300,
    "prune_ratio_window_size": 300,
    "external_prune_window_size": 200
  },
  "thresholds": {
    "p95_latency_threshold_ms": 1,
    "p95_min_samples": 3,
    "pruning_outage_min_attempts": 3,
    "pruning_outage_availability_threshold": 0
  },
  "endpoints": [
    {
      "endpoint": "/health",
      "request_count": 1,
      "server_error_count": 0,
      "latency_ms": {
        "count": 1,
        "avg": 17.13,
        "p50": 17.13,
        "p95": 17.13,
        "max": 17.13
      },
      "error_rate": 0,
      "prune_reduction_ratio": {
        "count": 0,
        "avg": 0,
        "p50": 0,
        "p95": 0,
        "max": 0
      }
    },
    {
      "endpoint": "/metrics",
      "request_count": 1,
      "server_error_count": 0,
      "latency_ms": {
        "count": 1,
        "avg": 16.89,
        "p50": 16.89,
        "p95": 16.89,
        "max": 16.89
      },
      "error_rate": 0,
      "prune_reduction_ratio": {
        "count": 0,
        "avg": 0,
        "p50": 0,
        "p95": 0,
        "max": 0
      }
    },
    {
      "endpoint": "/triage",
      "request_count": 6,
      "server_error_count": 0,
      "latency_ms": {
        "count": 6,
        "avg": 16.89,
        "p50": 11.73,
        "p95": 14.69,
        "max": 42.68
      },
      "error_rate": 0,
      "prune_reduction_ratio": {
        "count": 6,
        "avg": 0.4,
        "p50": 0.4,
        "p95": 0.4,
        "max": 0.4
      }
    }
  ],
  "external_prune": {
    "attempted_total": 6,
    "success_total": 0,
    "local_fallback_total": 6,
    "window_attempt_count": 6,
    "window_success_count": 0,
    "availability": 0
  },
  "alerts": {
    "p95_latency_breach": {
      "name": "p95_latency_breach",
      "active": true,
      "active_since": "2026-03-22T14:53:46.755Z",
      "last_evaluated_at": "2026-03-22T14:53:46.821Z",
      "details": {
        "threshold_ms": 1,
        "min_samples": 3,
        "sample_count": 6,
        "p95_latency_ms": 14.69
      }
    },
    "pruning_outage": {
      "name": "pruning_outage",
      "active": true,
      "active_since": "2026-03-22T14:53:46.754Z",
      "last_evaluated_at": "2026-03-22T14:53:46.821Z",
      "details": {
        "min_attempts": 3,
        "availability_threshold": 0,
        "attempt_count": 6,
        "availability": 0
      }
    }
  },
  "active_alerts": [
    "p95_latency_breach",
    "pruning_outage"
  ]
}
```

## Alerts Snapshot
```json
{
  "request_id": "3808cd17-67ab-43c9-bcdd-f4be2c7e4525",
  "generated_at": "2026-03-22T14:53:46.824Z",
  "active_alerts": [
    "p95_latency_breach",
    "pruning_outage"
  ],
  "alerts": {
    "p95_latency_breach": {
      "name": "p95_latency_breach",
      "active": true,
      "active_since": "2026-03-22T14:53:46.755Z",
      "last_evaluated_at": "2026-03-22T14:53:46.824Z",
      "details": {
        "threshold_ms": 1,
        "min_samples": 3,
        "sample_count": 6,
        "p95_latency_ms": 14.69
      }
    },
    "pruning_outage": {
      "name": "pruning_outage",
      "active": true,
      "active_since": "2026-03-22T14:53:46.754Z",
      "last_evaluated_at": "2026-03-22T14:53:46.824Z",
      "details": {
        "min_attempts": 3,
        "availability_threshold": 0,
        "attempt_count": 6,
        "availability": 0
      }
    }
  }
}
```

## Metrics Excerpt
```text
# HELP triage_http_requests_total Total observed HTTP requests by endpoint, method, and status code.
# TYPE triage_http_requests_total counter
triage_http_requests_total{endpoint="/health",method="GET",status_code="200"} 1
triage_http_requests_total{endpoint="/triage",method="POST",status_code="200"} 6
# HELP triage_http_latency_ms_avg Rolling average HTTP latency in milliseconds by endpoint.
# TYPE triage_http_latency_ms_avg gauge
# HELP triage_http_latency_ms_p95 Rolling p95 HTTP latency in milliseconds by endpoint.
# TYPE triage_http_latency_ms_p95 gauge
# HELP triage_http_error_rate Rolling server error rate by endpoint (0 to 1).
# TYPE triage_http_error_rate gauge
# HELP triage_prune_reduction_ratio_avg Rolling average prune reduction ratio by endpoint (0 to 1).
# TYPE triage_prune_reduction_ratio_avg gauge
triage_http_latency_ms_avg{endpoint="/health"} 17.13
triage_http_latency_ms_p95{endpoint="/health"} 17.13
triage_http_error_rate{endpoint="/health"} 0
triage_prune_reduction_ratio_avg{endpoint="/health"} 0
triage_http_latency_ms_avg{endpoint="/triage"} 16.89
triage_http_latency_ms_p95{endpoint="/triage"} 14.69
triage_http_error_rate{endpoint="/triage"} 0
triage_prune_reduction_ratio_avg{endpoint="/triage"} 0.4
# HELP triage_external_prune_attempts_total Total external pruning attempts.
# TYPE triage_external_prune_attempts_total counter
triage_external_prune_attempts_total 6
# HELP triage_external_prune_success_total Total successful external pruning operations.
# TYPE triage_external_prune_success_total counter
triage_external_prune_success_total 0
# HELP triage_external_prune_local_fallback_total Total local fallback pruning operations.
# TYPE triage_external_prune_local_fallback_total counter
triage_external_prune_local_fallback_total 6
# HELP triage_external_prune_availability Rolling availability of external pruning service (0 to 1).
# TYPE triage_external_prune_availability gauge
triage_external_prune_availability 0
# HELP triage_alert_state Active alert state (1=active, 0=inactive).
# TYPE triage_alert_state gauge
triage_alert_state{alert="p95_latency_breach"} 1
triage_alert_state{alert="pruning_outage"} 1

```
