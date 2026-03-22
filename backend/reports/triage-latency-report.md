# Triage Latency Benchmark Report

Generated UTC: 2026-03-22T14:50:43.499Z
Base URL: http://127.0.0.1:5077

## SLA Result
- Warm traffic target: p95 < 500 ms
- Warm traffic measured p95: 198.72 ms
- SLA met: YES

## Cold Start (separate)
- Startup to healthy endpoint: 669.72 ms
- First triage request (cold) client latency: 265.88 ms
- Cold start total: 935.6 ms
- First triage server latency: 247.82 ms
- First triage stage latencies: retrieve=2.04ms, prune=245.11ms, decide=0.45ms, response=0.16ms

## Warm Traffic (sustained)
- Warm-up requests: 40
- Sustained requests: 240
- Concurrency: 6
- Successful requests: 240
- Failed requests: 0

| Metric | Avg (ms) | P50 (ms) | P95 (ms) | Max (ms) |
| --- | ---: | ---: | ---: | ---: |
| Client latency | 188.24 | 187.53 | 198.72 | 201.31 |
| Server latency | 180.64 | 179.61 | 186.16 | 195.15 |

## Stage Budget Check (warm p95)
| Stage | Budget (ms) | Warm p95 (ms) | Met |
| --- | ---: | ---: | :---: |
| retrieve | 140 | 0.27 | YES |
| prune | 220 | 185.96 | YES |
| decide | 100 | 0.1 | YES |
| response | 40 | 0.02 | YES |
