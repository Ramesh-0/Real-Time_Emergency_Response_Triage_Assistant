const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const { performance } = require("perf_hooks");
const axios = require("axios");

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

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

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function toEpoch(dateValue) {
	const parsed = Date.parse(dateValue);
	return Number.isNaN(parsed) ? 0 : parsed;
}

function calculateAgeDays(dateValue, nowEpoch) {
	const epoch = toEpoch(dateValue);

	if (epoch === 0) {
		return null;
	}

	return Math.floor((nowEpoch - epoch) / ONE_DAY_MS);
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

async function postJson(baseUrl, endpoint, body, timeoutMs) {
	const response = await axios.post(`${baseUrl}/${endpoint}`, body, {
		headers: {
			"Content-Type": "application/json"
		},
		timeout: timeoutMs,
		validateStatus: () => true
	});

	if (response.status >= 400) {
		const errorMessage = response.data && response.data.error ? response.data.error : `HTTP ${response.status}`;
		const error = new Error(errorMessage);
		error.status = response.status;
		error.payload = response.data;
		throw error;
	}

	return response.data;
}

function summarizeDoc(doc, nowEpoch) {
	return {
		id: doc.id || null,
		type: doc.type || null,
		date: doc.date || null,
		age_days: calculateAgeDays(doc.date, nowEpoch)
	};
}

function evaluateContextDocs(contextDocs, expectedTypes, maxAgeDays, nowEpoch) {
	const expectedTypeSet = new Set(expectedTypes.map((type) => String(type).toLowerCase()));
	const unrelatedDocs = [];
	const staleDocs = [];

	for (const doc of contextDocs) {
		const docType = String(doc.type || "").toLowerCase();

		if (expectedTypeSet.size > 0 && (!docType || !expectedTypeSet.has(docType))) {
			unrelatedDocs.push(summarizeDoc(doc, nowEpoch));
		}

		const ageDays = calculateAgeDays(doc.date, nowEpoch);

		if (Number.isFinite(maxAgeDays) && maxAgeDays > 0 && ageDays !== null && ageDays > maxAgeDays) {
			staleDocs.push(summarizeDoc(doc, nowEpoch));
		}
	}

	return {
		unrelatedDocs,
		staleDocs
	};
}

function buildCaseOutput(caseInput) {
	const {
		endpoint,
		scenario,
		payload,
		nowEpoch,
		maxAgeDays
	} = caseInput;
	const contextDocs = Array.isArray(payload.pruned_context) ? payload.pruned_context : [];
	const leakage = evaluateContextDocs(contextDocs, scenario.expected_types, maxAgeDays, nowEpoch);
	const retrievalChecks = payload.retrieval_filter_meta && payload.retrieval_filter_meta.checks_applied
		? payload.retrieval_filter_meta.checks_applied
		: {};
	const postPruneChecks = payload.post_prune_filter_meta && payload.post_prune_filter_meta.checks_applied
		? payload.post_prune_filter_meta.checks_applied
		: {};
	const checksApplied = {
		retrieval_recency: Boolean(retrievalChecks.recency),
		retrieval_type: scenario.expected_types.length > 0 ? Boolean(retrievalChecks.type) : true,
		post_prune_recency: Boolean(postPruneChecks.recency),
		post_prune_type: scenario.expected_types.length > 0 ? Boolean(postPruneChecks.type) : true
	};
	const allChecksApplied = Object.values(checksApplied).every(Boolean);
	const hasContext = contextDocs.length > 0;
	const leakageFree = leakage.unrelatedDocs.length === 0 && leakage.staleDocs.length === 0;

	return {
		endpoint,
		scenario_id: scenario.id,
		query: scenario.query,
		expected_types: scenario.expected_types,
		context_count: contextDocs.length,
		checks_applied: checksApplied,
		all_checks_applied: allChecksApplied,
		leakage_free: leakageFree,
		has_context: hasContext,
		pass: hasContext && leakageFree && allChecksApplied,
		unrelated_docs: leakage.unrelatedDocs,
		stale_docs: leakage.staleDocs,
		retrieval_filter_meta: payload.retrieval_filter_meta || null,
		post_prune_filter_meta: payload.post_prune_filter_meta || null
	};
}

function buildMarkdownReport(reportInput) {
	const {
		generatedAt,
		baseUrl,
		criticalRecencyDays,
		summary,
		results,
		noiseFilterConfig
	} = reportInput;
	const tableRows = results.map((result) => {
		return `| ${result.endpoint} | ${result.scenario_id} | ${result.context_count} | ${result.unrelated_docs.length} | ${result.stale_docs.length} | ${result.all_checks_applied ? "YES" : "NO"} | ${result.pass ? "PASS" : "FAIL"} |`;
	});

	const failedRows = results
		.filter((result) => !result.pass)
		.map((result) => {
			const reasons = [];

			if (!result.has_context) {
				reasons.push("empty_context");
			}

			if (!result.all_checks_applied) {
				reasons.push("missing_checks");
			}

			if (result.unrelated_docs.length > 0) {
				reasons.push("unrelated_category_leakage");
			}

			if (result.stale_docs.length > 0) {
				reasons.push("stale_record_leakage");
			}

			return `- ${result.endpoint}/${result.scenario_id}: ${reasons.join(", ") || "unknown_failure"}`;
		});

	const lines = [
		"# Noise Reduction Evaluation Report",
		"",
		`Generated UTC: ${generatedAt}`,
		`Base URL: ${baseUrl}`,
		`Critical recency window (days): ${criticalRecencyDays}`,
		"",
		"## Summary",
		`- Total checks: ${summary.total_checks}`,
		`- Passed checks: ${summary.passed_checks}`,
		`- Failed checks: ${summary.failed_checks}`,
		`- Unrelated leakage count: ${summary.unrelated_leakage_count}`,
		`- Stale leakage count: ${summary.stale_leakage_count}`,
		`- Missing-check count: ${summary.missing_check_count}`,
		`- Empty-context count: ${summary.empty_context_count}`,
		`- Leakage gate met (critical scenarios): ${summary.leakage_gate_met ? "YES" : "NO"}`,
		"",
		"## Effective Noise Filter Config",
		"```json",
		JSON.stringify(noiseFilterConfig || null, null, 2),
		"```",
		"",
		"## Per-Scenario Results",
		"| Endpoint | Scenario | Context Docs | Unrelated | Stale | Checks Applied | Result |",
		"| --- | --- | ---: | ---: | ---: | :---: | :---: |",
		...tableRows
	];

	if (failedRows.length > 0) {
		lines.push("", "## Failures", ...failedRows);
	}

	return `${lines.join("\n")}\n`;
}

async function run() {
	const backendRoot = path.resolve(__dirname, "..");
	const evalPort = parsePositiveInteger(process.env.EVAL_PORT, 5089);
	const baseUrl = process.env.EVAL_BASE_URL || `http://127.0.0.1:${evalPort}`;
	const requestTimeoutMs = parsePositiveInteger(process.env.EVAL_REQUEST_TIMEOUT_MS, 4000);
	const healthTimeoutMs = parsePositiveInteger(process.env.EVAL_HEALTH_TIMEOUT_MS, 45000);
	const criticalRecencyDays = parsePositiveInteger(process.env.EVAL_CRITICAL_RECENCY_DAYS, 365);
	const nonCriticalRecencyDays = parsePositiveInteger(
		process.env.EVAL_NON_CRITICAL_RECENCY_DAYS,
		Math.max(criticalRecencyDays, 3650)
	);
	const reportPath = path.resolve(
		backendRoot,
		process.env.EVAL_REPORT_PATH || "reports/noise-reduction-evaluation.md"
	);

	const scenarios = [
		{
			id: "critical-cardiology-chest",
			query: "severe chest pain and sweating",
			expected_types: ["cardiology"]
		},
		{
			id: "critical-cardiology-ecg",
			query: "acute chest pressure with ECG change",
			expected_types: ["cardiology"]
		},
		{
			id: "critical-dental-abscess",
			query: "severe tooth pain and jaw swelling",
			expected_types: ["dental"]
		}
	];

	const endpointTargets = ["triage", "retrieve"];
	const serverLogs = [];
	let serverProcess = null;

	try {
		serverProcess = spawn(process.execPath, ["server.js"], {
			cwd: backendRoot,
			env: {
				...process.env,
				PORT: String(evalPort),
				RATE_LIMIT_MAX: "3000",
				RATE_LIMIT_WINDOW_MS: "60000",
				SCALEDOWN_API_URL: "",
				SCALEDOWN_API_KEY: "",
				SCALEDOWN_FORCE_REMOTE: "false",
				DOC_RECENCY_FILTER_ENABLED: "true",
				DOC_TYPE_FILTER_ENABLED: "true",
				DOC_STRICT_TYPE_FILTER_ON_CRITICAL: "true",
				DOC_CRITICAL_RECENCY_DAYS: String(criticalRecencyDays),
				DOC_NON_CRITICAL_RECENCY_DAYS: String(nonCriticalRecencyDays)
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

			if (serverLogs.length > 120) {
				serverLogs.splice(0, serverLogs.length - 120);
			}
		};

		serverProcess.stdout.on("data", appendServerLog);
		serverProcess.stderr.on("data", appendServerLog);

		const startupMs = await waitForServerHealth(baseUrl, healthTimeoutMs);

		const todayIso = new Date().toISOString().slice(0, 10);
		const fixtures = {
			items: [
				{
					id: "eval-old-cardiology-2010",
					type: "cardiology",
					date: "2010-02-15",
					source: "eval/noise",
					section: "Historical",
					title: "Old cardiology history",
					text: "Historical chest pain and sweating record from years ago with no current emergency context."
				},
				{
					id: "eval-old-dental-2011",
					type: "dental",
					date: "2011-08-21",
					source: "eval/noise",
					section: "Historical",
					title: "Old dental history",
					text: "Historical severe tooth pain and jaw swelling record from many years ago."
				},
				{
					id: "eval-recent-general-noise",
					type: "general",
					date: todayIso,
					source: "eval/noise",
					section: "General",
					title: "General note with overlapping terms",
					text: "General follow-up note mentioning pain and sweating, non-cardiology and non-dental context."
				},
				{
					id: "eval-recent-cardiology-noise",
					type: "cardiology",
					date: todayIso,
					source: "eval/noise",
					section: "Cardiology",
					title: "Cardiology note with dental wording",
					text: "Cardiology note repeating jaw and tooth pain wording to challenge type leakage checks."
				}
			],
			chunking: {
				chunk_size_words: 120,
				chunk_overlap_words: 20
			},
			persist: false
		};

		await postJson(baseUrl, "ingest/unstructured", fixtures, requestTimeoutMs);

		const indexStatsResponse = await axios.get(`${baseUrl}/index/stats`, {
			timeout: requestTimeoutMs,
			validateStatus: () => true
		});

		if (indexStatsResponse.status >= 400) {
			throw new Error(`index stats request failed with status ${indexStatsResponse.status}`);
		}

		const noiseFilterConfig = indexStatsResponse.data ? indexStatsResponse.data.noise_filter_config : null;
		const nowEpoch = Date.now();
		const results = [];

		for (const endpoint of endpointTargets) {
			for (const scenario of scenarios) {
				const payload = await postJson(
					baseUrl,
					endpoint,
					{
						query: scenario.query,
						limit: 8
					},
					requestTimeoutMs
				);

				results.push(
					buildCaseOutput({
						endpoint,
						scenario,
						payload,
						nowEpoch,
						maxAgeDays: criticalRecencyDays
					})
				);
			}
		}

		const failed = results.filter((result) => !result.pass);
		const summary = {
			total_checks: results.length,
			passed_checks: results.length - failed.length,
			failed_checks: failed.length,
			unrelated_leakage_count: results.reduce((sum, result) => sum + result.unrelated_docs.length, 0),
			stale_leakage_count: results.reduce((sum, result) => sum + result.stale_docs.length, 0),
			missing_check_count: results.filter((result) => !result.all_checks_applied).length,
			empty_context_count: results.filter((result) => !result.has_context).length,
			leakage_gate_met: failed.length === 0
		};

		const reportMarkdown = buildMarkdownReport({
			generatedAt: new Date().toISOString(),
			baseUrl,
			criticalRecencyDays,
			summary,
			results,
			noiseFilterConfig
		});

		await fs.mkdir(path.dirname(reportPath), { recursive: true });
		await fs.writeFile(reportPath, reportMarkdown, "utf8");

		const output = {
			report_path: reportPath,
			startup_ms: startupMs,
			base_url: baseUrl,
			noise_filter_config: noiseFilterConfig,
			summary,
			results
		};

		console.log(JSON.stringify(output, null, 2));

		if (!summary.leakage_gate_met) {
			process.exitCode = 1;
		}
	} catch (error) {
		console.error("Noise reduction evaluation failed:", error.message);

		if (serverLogs.length > 0) {
			console.error("Recent backend logs:");

			for (const line of serverLogs.slice(-30)) {
				console.error(line);
			}
		}

		process.exitCode = 1;
	} finally {
		await stopServerProcess(serverProcess);
	}
}

run();