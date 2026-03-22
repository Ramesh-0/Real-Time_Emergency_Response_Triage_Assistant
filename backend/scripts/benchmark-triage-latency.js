const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const { performance } = require("perf_hooks");
const axios = require("axios");

function parsePositiveInteger(value, fallback) {
	const parsed = Number.parseInt(value, 10);
	return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

function roundLatencyMs(value) {
	if (!Number.isFinite(value)) {
		return 0;
	}

	return Number(value.toFixed(2));
}

function percentile(values, ratio) {
	if (!Array.isArray(values) || values.length === 0) {
		return 0;
	}

	const sorted = [...values].sort((left, right) => left - right);
	const position = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio));
	return sorted[position];
}

function summarize(values) {
	if (!Array.isArray(values) || values.length === 0) {
		return {
			count: 0,
			avg: 0,
			p50: 0,
			p95: 0,
			max: 0
		};
	}

	const average = values.reduce((sum, value) => sum + value, 0) / values.length;

	return {
		count: values.length,
		avg: roundLatencyMs(average),
		p50: roundLatencyMs(percentile(values, 0.5)),
		p95: roundLatencyMs(percentile(values, 0.95)),
		max: roundLatencyMs(Math.max(...values))
	};
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getDefaultStageBudgets(targetLatencyMs) {
	const retrieve = Math.max(1, Math.round(targetLatencyMs * 0.28));
	const prune = Math.max(1, Math.round(targetLatencyMs * 0.44));
	const decide = Math.max(1, Math.round(targetLatencyMs * 0.2));
	const response = Math.max(1, targetLatencyMs - retrieve - prune - decide);

	return { retrieve, prune, decide, response };
}

function normalizeStageBudgets(candidate, fallback) {
	const resolveBudget = (key) => {
		const rawValue = candidate && Object.prototype.hasOwnProperty.call(candidate, key) ? candidate[key] : null;
		return parsePositiveInteger(rawValue, fallback[key]);
	};

	return {
		retrieve: resolveBudget("retrieve"),
		prune: resolveBudget("prune"),
		decide: resolveBudget("decide"),
		response: resolveBudget("response")
	};
}

async function waitForServerHealth(baseUrl, timeoutMs) {
	const startedAt = performance.now();
	let lastError = null;

	while (performance.now() - startedAt <= timeoutMs) {
		try {
			const response = await axios.get(`${baseUrl}/health`, {
				timeout: 1000,
				validateStatus: () => true
			});

			if (response.status === 200) {
				return roundLatencyMs(performance.now() - startedAt);
			}

			lastError = new Error(`health returned status ${response.status}`);
		} catch (error) {
			lastError = error;
		}

		await sleep(200);
	}

	throw new Error(
		`Timed out waiting for backend health at ${baseUrl} after ${timeoutMs} ms${
			lastError ? ` (${lastError.message})` : ""
		}`
	);
}

async function requestTriage(baseUrl, query, limit, timeoutMs) {
	const startedAt = performance.now();
	const response = await axios.post(
		`${baseUrl}/triage`,
		{ query, limit },
		{
			headers: {
				"Content-Type": "application/json"
			},
			timeout: timeoutMs,
			validateStatus: () => true
		}
	);
	const clientLatencyMs = roundLatencyMs(performance.now() - startedAt);

	if (response.status >= 400) {
		const errorMessage = response.data && response.data.error ? response.data.error : `HTTP ${response.status}`;
		const error = new Error(errorMessage);
		error.status = response.status;
		error.payload = response.data;
		throw error;
	}

	return {
		clientLatencyMs,
		response: response.data
	};
}

function createLoadWorker(options) {
	const {
		results,
		baseUrl,
		queries,
		totalRequests,
		limit,
		requestTimeoutMs,
		nextIndex
	} = options;

	return async () => {
		while (true) {
			const currentIndex = nextIndex.value;
			nextIndex.value += 1;

			if (currentIndex >= totalRequests) {
				return;
			}

			const query = queries[currentIndex % queries.length];

			try {
				const run = await requestTriage(baseUrl, query, limit, requestTimeoutMs);
				results[currentIndex] = {
					ok: true,
					query,
					clientLatencyMs: run.clientLatencyMs,
					response: run.response
				};
			} catch (error) {
				results[currentIndex] = {
					ok: false,
					query,
					error: error.message,
					status: error.status || null
				};
			}
		}
	};
}

async function stopServerProcess(serverProcess) {
	if (!serverProcess || serverProcess.exitCode !== null) {
		return;
	}

	await new Promise((resolve) => {
		const hardStop = setTimeout(() => {
			serverProcess.kill("SIGKILL");
			resolve();
		}, 4000);

		serverProcess.once("exit", () => {
			clearTimeout(hardStop);
			resolve();
		});

		serverProcess.kill("SIGTERM");
	});
}

function formatStageLatency(latencies) {
	if (!latencies || typeof latencies !== "object") {
		return "unavailable";
	}

	return `retrieve=${roundLatencyMs(latencies.retrieve || 0)}ms, prune=${roundLatencyMs(latencies.prune || 0)}ms, decide=${roundLatencyMs(latencies.decide || 0)}ms, response=${roundLatencyMs(latencies.response || 0)}ms`;
}

function buildReport(reportInput) {
	const {
		generatedAt,
		baseUrl,
		targetLatencyMs,
		coldStart,
		warmTraffic,
		stageBudgets,
		stageSummary,
		slaMet
	} = reportInput;

	const stageRows = ["retrieve", "prune", "decide", "response"].map((stage) => {
		const summary = stageSummary[stage] || { p95: 0 };
		const budget = stageBudgets[stage];
		const met = summary.p95 <= budget ? "YES" : "NO";
		return `| ${stage} | ${budget} | ${summary.p95} | ${met} |`;
	});

	const failedSamples = warmTraffic.failedSamples.slice(0, 5).map((sample) => {
		return `- query="${sample.query}" status=${sample.status || "n/a"} error=${sample.error}`;
	});

	const lines = [
		"# Triage Latency Benchmark Report",
		"",
		`Generated UTC: ${generatedAt}`,
		`Base URL: ${baseUrl}`,
		"",
		"## SLA Result",
		`- Warm traffic target: p95 < ${targetLatencyMs} ms`,
		`- Warm traffic measured p95: ${warmTraffic.clientSummary.p95} ms`,
		`- SLA met: ${slaMet ? "YES" : "NO"}`,
		"",
		"## Cold Start (separate)",
		`- Startup to healthy endpoint: ${coldStart.startupMs} ms`,
		`- First triage request (cold) client latency: ${coldStart.firstRequestMs} ms`,
		`- Cold start total: ${coldStart.totalMs} ms`,
		`- First triage server latency: ${coldStart.serverLatencyMs} ms`,
		`- First triage stage latencies: ${formatStageLatency(coldStart.stageLatencies)}`,
		"",
		"## Warm Traffic (sustained)",
		`- Warm-up requests: ${warmTraffic.warmupRequests}`,
		`- Sustained requests: ${warmTraffic.totalRequests}`,
		`- Concurrency: ${warmTraffic.concurrency}`,
		`- Successful requests: ${warmTraffic.successfulRequests}`,
		`- Failed requests: ${warmTraffic.failedRequests}`,
		"",
		"| Metric | Avg (ms) | P50 (ms) | P95 (ms) | Max (ms) |",
		"| --- | ---: | ---: | ---: | ---: |",
		`| Client latency | ${warmTraffic.clientSummary.avg} | ${warmTraffic.clientSummary.p50} | ${warmTraffic.clientSummary.p95} | ${warmTraffic.clientSummary.max} |`,
		`| Server latency | ${warmTraffic.serverSummary.avg} | ${warmTraffic.serverSummary.p50} | ${warmTraffic.serverSummary.p95} | ${warmTraffic.serverSummary.max} |`,
		"",
		"## Stage Budget Check (warm p95)",
		"| Stage | Budget (ms) | Warm p95 (ms) | Met |",
		"| --- | ---: | ---: | :---: |",
		...stageRows
	];

	if (failedSamples.length > 0) {
		lines.push("", "## Failed Request Samples", ...failedSamples);
	}

	return `${lines.join("\n")}\n`;
}

async function run() {
	const backendRoot = path.resolve(__dirname, "..");
	const latencyTargetMs = parsePositiveInteger(process.env.LATENCY_TARGET_MS, 500);
	const warmupRequests = parsePositiveInteger(process.env.BENCH_WARMUP_REQUESTS, 40);
	const sustainedRequests = parsePositiveInteger(process.env.BENCH_SUSTAINED_REQUESTS, 240);
	const concurrency = parsePositiveInteger(process.env.BENCH_CONCURRENCY, 6);
	const requestLimit = parsePositiveInteger(process.env.BENCH_LIMIT, 5);
	const requestTimeoutMs = parsePositiveInteger(process.env.BENCH_REQUEST_TIMEOUT_MS, 3000);
	const healthTimeoutMs = parsePositiveInteger(process.env.BENCH_HEALTH_TIMEOUT_MS, 45000);
	const benchmarkPort = parsePositiveInteger(process.env.BENCH_PORT, 5077);
	const benchmarkRateLimitMax = parsePositiveInteger(
		process.env.BENCH_RATE_LIMIT_MAX,
		Math.max(1000, warmupRequests + sustainedRequests + 100)
	);
	const benchmarkRateLimitWindowMs = parsePositiveInteger(process.env.BENCH_RATE_LIMIT_WINDOW_MS, 60000);
	const baseUrl = process.env.BENCH_BASE_URL || `http://127.0.0.1:${benchmarkPort}`;
	const reportPath = path.resolve(
		backendRoot,
		process.env.BENCH_REPORT_PATH || "reports/triage-latency-report.md"
	);
	const benchmarkQueries = [
		"severe chest pain and sweating",
		"tooth pain and jaw swelling",
		"fever cough headache general fatigue",
		"speech slur facial droop unilateral weakness",
		"shortness of breath low oxygen saturation"
	];
	const coldQuery = process.env.BENCH_COLD_QUERY || benchmarkQueries[0];
	const defaultStageBudgets = getDefaultStageBudgets(latencyTargetMs);
	const serverLogs = [];
	let serverProcess = null;

	try {
		serverProcess = spawn(process.execPath, ["server.js"], {
			cwd: backendRoot,
			env: {
				...process.env,
				PORT: String(benchmarkPort),
				RATE_LIMIT_MAX: String(benchmarkRateLimitMax),
				RATE_LIMIT_WINDOW_MS: String(benchmarkRateLimitWindowMs)
			},
			stdio: ["ignore", "pipe", "pipe"]
		});

		const appendServerLog = (chunk) => {
			const lines = String(chunk)
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter(Boolean);

			for (const line of lines) {
				serverLogs.push(line);
			}

			if (serverLogs.length > 80) {
				serverLogs.splice(0, serverLogs.length - 80);
			}
		};

		serverProcess.stdout.on("data", appendServerLog);
		serverProcess.stderr.on("data", appendServerLog);

		const startupMs = await waitForServerHealth(baseUrl, healthTimeoutMs);
		const coldRequest = await requestTriage(baseUrl, coldQuery, requestLimit, requestTimeoutMs);
		const coldTotalMs = roundLatencyMs(startupMs + coldRequest.clientLatencyMs);
		const coldStart = {
			startupMs,
			firstRequestMs: coldRequest.clientLatencyMs,
			totalMs: coldTotalMs,
			serverLatencyMs: roundLatencyMs(coldRequest.response?.latency_ms || 0),
			stageLatencies: coldRequest.response?.stage_latencies_ms || null
		};

		for (let index = 0; index < warmupRequests; index += 1) {
			const query = benchmarkQueries[index % benchmarkQueries.length];
			await requestTriage(baseUrl, query, requestLimit, requestTimeoutMs);
		}

		const results = new Array(sustainedRequests);
		const nextIndex = { value: 0 };
		const workers = Array.from({ length: concurrency }, () => {
			return createLoadWorker({
				results,
				baseUrl,
				queries: benchmarkQueries,
				totalRequests: sustainedRequests,
				limit: requestLimit,
				requestTimeoutMs,
				nextIndex
			})();
		});

		await Promise.all(workers);

		const successful = results.filter((item) => item && item.ok);
		const failed = results.filter((item) => item && !item.ok);
		const clientLatencies = successful.map((item) => item.clientLatencyMs);
		const serverLatencies = successful
			.map((item) => Number(item.response?.latency_ms))
			.filter((value) => Number.isFinite(value));
		const stageValues = {
			retrieve: [],
			prune: [],
			decide: [],
			response: []
		};

		for (const sample of successful) {
			const stageLatencies = sample.response?.stage_latencies_ms;

			if (!stageLatencies || typeof stageLatencies !== "object") {
				continue;
			}

			for (const stage of Object.keys(stageValues)) {
				const stageLatency = Number(stageLatencies[stage]);
				if (Number.isFinite(stageLatency)) {
					stageValues[stage].push(stageLatency);
				}
			}
		}

		const discoveredBudgets = successful.find((sample) => {
			return sample.response && sample.response.stage_budget_ms;
		})?.response?.stage_budget_ms;
		const stageBudgets = normalizeStageBudgets(discoveredBudgets, defaultStageBudgets);
		const stageSummary = {
			retrieve: summarize(stageValues.retrieve),
			prune: summarize(stageValues.prune),
			decide: summarize(stageValues.decide),
			response: summarize(stageValues.response)
		};
		const warmTraffic = {
			warmupRequests,
			totalRequests: sustainedRequests,
			concurrency,
			successfulRequests: successful.length,
			failedRequests: failed.length,
			failedSamples: failed.slice(0, 20),
			clientSummary: summarize(clientLatencies),
			serverSummary: summarize(serverLatencies)
		};
		const slaMet =
			warmTraffic.failedRequests === 0 &&
			warmTraffic.clientSummary.count === sustainedRequests &&
			warmTraffic.clientSummary.p95 < latencyTargetMs;

		const reportMarkdown = buildReport({
			generatedAt: new Date().toISOString(),
			baseUrl,
			targetLatencyMs: latencyTargetMs,
			coldStart,
			warmTraffic,
			stageBudgets,
			stageSummary,
			slaMet
		});

		await fs.mkdir(path.dirname(reportPath), { recursive: true });
		await fs.writeFile(reportPath, reportMarkdown, "utf8");

		const output = {
			report_path: reportPath,
			target_latency_ms: latencyTargetMs,
			sla_met: slaMet,
			cold_start: coldStart,
			warm_traffic: warmTraffic,
			stage_budget_ms: stageBudgets,
			stage_summary_ms: stageSummary
		};

		console.log(JSON.stringify(output, null, 2));

		if (!slaMet) {
			if (failed.length > 0) {
				console.error("Warm benchmark had failed requests.");
			}
			process.exitCode = 1;
		}
	} catch (error) {
		console.error("Triage latency benchmark failed:", error.message);
		if (serverLogs.length > 0) {
			console.error("Recent backend logs:");
			for (const line of serverLogs.slice(-20)) {
				console.error(line);
			}
		}
		process.exitCode = 1;
	} finally {
		await stopServerProcess(serverProcess);
	}
}

run();
