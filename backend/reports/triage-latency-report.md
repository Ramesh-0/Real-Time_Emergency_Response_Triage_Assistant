# Triage Latency Benchmark Report

Generated UTC: 2026-03-22T13:51:20.858Z
Base URL: http://127.0.0.1:5077

## SLA Result
- Warm traffic target: p95 < 500 ms
- Warm traffic measured p95: 214.87 ms
- SLA met: YES

## Cold Start (separate)
- Startup to healthy endpoint: 1385.08 ms
- First triage request (cold) client latency: 314.19 ms
- Cold start total: 1699.27 ms
- First triage server latency: 270.79 ms
- First triage stage latencies: retrieve=5.64ms, prune=263.73ms, decide=0.83ms, response=0.39ms

## Warm Traffic (sustained)
- Warm-up requests: 40
- Sustained requests: 240
- Concurrency: 6
- Successful requests: 240
- Failed requests: 0

| Metric | Avg (ms) | P50 (ms) | P95 (ms) | Max (ms) |
| --- | ---: | ---: | ---: | ---: |
| Client latency | 199.79 | 200.29 | 214.87 | 239.01 |
| Server latency | 186.57 | 185.76 | 195.03 | 211.52 |

## Stage Budget Check (warm p95)
| Stage | Budget (ms) | Warm p95 (ms) | Met |
| --- | ---: | ---: | :---: |
| retrieve | 140 | 0.57 | YES |
| prune | 220 | 194.47 | YES |
| decide | 100 | 0.3 | YES |
| response | 40 | 0.04 | YES |
