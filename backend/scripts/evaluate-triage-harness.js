const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const { performance } = require("perf_hooks");
const axios = require("axios");

const dataset = require("../data.json");

function parsePositiveInteger(value, fallback) {
	const parsed = Number.parseInt(value, 10);
	return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

function parseRatio(value, fallback) {
	if (value === undefined || value === null || value === "") {
		return fallback;
	}

	const parsed = Number.parseFloat(value);

	if (!Number.isFinite(parsed)) {
		return fallback;
	}

	return Math.max(0, Math.min(parsed, 1));
}

function roundNumber(value, digits = 4) {
	if (!Number.isFinite(value)) {
		return 0;
	}

	return Number(value.toFixed(digits));
}

function normalizeText(value) {
	if (typeof value !== "string") {
		return "";
	}

	return value.trim().toLowerCase();
}

function normalizeSeverity(value) {
	if (typeof value !== "string") {
		return "";
	}

	return value.trim().toUpperCase();
}

function toPercentString(value) {
	return `${(Math.max(0, Math.min(value, 1)) * 100).toFixed(2)}%`;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServerHealth(baseUrl, timeoutMs) {
	const startedAt = performance.now();
	let lastError = null;

	while (performance.now() - startedAt <= timeoutMs) {
		try {
			const response = await axios.get(`${baseUrl}/health`, {
				timeout: 1200,
				validateStatus: () => true
			});

			if (response.status === 200) {
				return roundNumber(performance.now() - startedAt, 2);
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
		const message = response.data && response.data.error
			? response.data.error
			: `HTTP ${response.status}`;
		const error = new Error(message);
		error.status = response.status;
		error.payload = response.data;
		throw error;
	}

	return response.data;
}

function average(values) {
	if (!Array.isArray(values) || values.length === 0) {
		return 0;
	}

	const total = values.reduce((sum, value) => sum + value, 0);
	return total / values.length;
}

function safeNumber(value, fallback = 0) {
	return Number.isFinite(value) ? value : fallback;
}

function safeLeakageCount(meta) {
	if (!meta || typeof meta !== "object") {
		return 0;
	}

	return safeNumber(meta.unrelated_type_leakage_count, 0) + safeNumber(meta.stale_record_leakage_count, 0);
}

function buildCaseResult(caseInput) {
	const {
		testCase,
		expectedCase,
		payload,
		requestError,
		requestLatencyMs
	} = caseInput;
	const requestFailed = Boolean(requestError);
	const resultObject = payload && payload.result ? payload.result : {};
	const expectedDiagnosis = expectedCase ? String(expectedCase.diagnosis || "") : "";
	const actualDiagnosis = String(resultObject.diagnosis || "");
	const expectedSeverity = expectedCase ? String(expectedCase.severity || "") : "";
	const actualSeverity = String(resultObject.severity || "");
	const acceptedDiagnoses = Array.isArray(testCase.accepted_diagnoses)
		? testCase.accepted_diagnoses.map((diagnosis) => normalizeText(diagnosis))
		: [];
	const diagnosisCorrect = !requestFailed && (
		normalizeText(actualDiagnosis) === normalizeText(expectedDiagnosis)
		|| acceptedDiagnoses.includes(normalizeText(actualDiagnosis))
	);
	const severityCorrect = !requestFailed && normalizeSeverity(actualSeverity) === normalizeSeverity(expectedSeverity);

	const returnedRetrievedCount = safeNumber(payload?.returned_retrieved_count, 0);
	const prunedCount = safeNumber(payload?.pruned_count, 0);
	const reductionRatio = returnedRetrievedCount > 0
		? Math.max(0, (returnedRetrievedCount - prunedCount) / returnedRetrievedCount)
		: 0;
	const postPruneLeakageCount = safeLeakageCount(payload?.post_prune_filter_meta);
	const retrievalLeakageCount = safeLeakageCount(payload?.retrieval_filter_meta);
	const leakageFree = !requestFailed && postPruneLeakageCount === 0;
	const reductionObserved = !requestFailed && returnedRetrievedCount > 0 && prunedCount < returnedRetrievedCount;
	const noisySuppressed = testCase.is_noisy
		? reductionObserved && leakageFree
		: leakageFree;

	return {
		id: testCase.id,
		category: testCase.category,
		query: testCase.query,
		expected_case_id: testCase.expected_case_id,
		expected_type: expectedCase ? expectedCase.type || null : null,
		expected_diagnosis: expectedDiagnosis,
		expected_severity: expectedSeverity,
		actual_diagnosis: actualDiagnosis,
		actual_severity: actualSeverity,
		diagnosis_correct: diagnosisCorrect,
		severity_correct: severityCorrect,
		is_noisy: Boolean(testCase.is_noisy),
		noise_suppressed: noisySuppressed,
		reduction_observed: reductionObserved,
		reduction_ratio: roundNumber(reductionRatio, 4),
		post_prune_leakage_count: postPruneLeakageCount,
		retrieval_leakage_count: retrievalLeakageCount,
		returned_retrieved_count: returnedRetrievedCount,
		pruned_count: prunedCount,
		prune_target_count: safeNumber(payload?.prune_target_count, 0),
		request_failed: requestFailed,
		request_error: requestError ? requestError.message : null,
		request_status: requestError ? requestError.status || null : null,
		request_latency_ms: roundNumber(requestLatencyMs, 2),
		latency_ms: roundNumber(safeNumber(payload?.latency_ms, 0), 2),
		prune_meta: payload?.prune_meta || null,
		retrieval_filter_meta: payload?.retrieval_filter_meta || null,
		post_prune_filter_meta: payload?.post_prune_filter_meta || null
	};
}

function summarizeByCategory(results) {
	const categoryMap = new Map();

	for (const result of results) {
		if (!categoryMap.has(result.category)) {
			categoryMap.set(result.category, []);
		}

		categoryMap.get(result.category).push(result);
	}

	return [...categoryMap.entries()]
		.sort((left, right) => left[0].localeCompare(right[0]))
		.map(([category, categoryResults]) => {
			const caseCount = categoryResults.length;
			const diagnosisCorrectCount = categoryResults.filter((result) => result.diagnosis_correct).length;
			const severityCorrectCount = categoryResults.filter((result) => result.severity_correct).length;
			const leakageFreeCount = categoryResults.filter((result) => result.post_prune_leakage_count === 0 && !result.request_failed).length;
			const noisyCases = categoryResults.filter((result) => result.is_noisy);
			const noisySuppressedCount = noisyCases.filter((result) => result.noise_suppressed).length;

			return {
				category,
				case_count: caseCount,
				diagnosis_accuracy: roundNumber(caseCount > 0 ? diagnosisCorrectCount / caseCount : 0),
				severity_accuracy: roundNumber(caseCount > 0 ? severityCorrectCount / caseCount : 0),
				leakage_free_rate: roundNumber(caseCount > 0 ? leakageFreeCount / caseCount : 0),
				average_reduction_ratio: roundNumber(average(categoryResults.map((result) => result.reduction_ratio))),
				noisy_case_count: noisyCases.length,
				noisy_suppression_rate: roundNumber(
					noisyCases.length > 0 ? noisySuppressedCount / noisyCases.length : 0
				)
			};
		});
}

function evaluateGates(summary, thresholds) {
	const checks = [
		{
			name: "Diagnosis accuracy",
			metric: summary.diagnosis_accuracy,
			threshold: thresholds.diagnosis_accuracy_min,
			passed: summary.diagnosis_accuracy >= thresholds.diagnosis_accuracy_min
		},
		{
			name: "Severity correctness",
			metric: summary.severity_accuracy,
			threshold: thresholds.severity_accuracy_min,
			passed: summary.severity_accuracy >= thresholds.severity_accuracy_min
		},
		{
			name: "Noise suppression (noisy set)",
			metric: summary.noisy_suppression_rate,
			threshold: thresholds.noisy_suppression_min,
			passed: summary.noisy_suppression_rate >= thresholds.noisy_suppression_min
		},
		{
			name: "Leakage free rate",
			metric: summary.leakage_free_rate,
			threshold: thresholds.leakage_free_min,
			passed: summary.leakage_free_rate >= thresholds.leakage_free_min
		}
	];

	return {
		checks,
		overall_passed: checks.every((check) => check.passed)
	};
}

function buildMarkdownReport(reportInput) {
	const {
		generatedAt,
		baseUrl,
		datasetPath,
		reportJsonPath,
		startupMs,
		summary,
		thresholds,
		gate,
		byCategory,
		indexStats,
		seedInfo,
		reproducibilityConfig,
		failures
	} = reportInput;

	const gateRows = gate.checks.map((check) => {
		return `| ${check.name} | ${toPercentString(check.metric)} | ${toPercentString(check.threshold)} | ${check.passed ? "PASS" : "FAIL"} |`;
	});

	const categoryRows = byCategory.map((row) => {
		return `| ${row.category} | ${row.case_count} | ${toPercentString(row.diagnosis_accuracy)} | ${toPercentString(row.severity_accuracy)} | ${toPercentString(row.leakage_free_rate)} | ${row.average_reduction_ratio.toFixed(4)} | ${row.noisy_case_count} | ${toPercentString(row.noisy_suppression_rate)} |`;
	});

	const failureRows = failures.slice(0, 15).map((failure) => {
		const reasons = [];

		if (failure.request_failed) {
			reasons.push(`request_failed(${failure.request_status || "n/a"})`);
		}

		if (!failure.diagnosis_correct) {
			reasons.push("diagnosis_mismatch");
		}

		if (!failure.severity_correct) {
			reasons.push("severity_mismatch");
		}

		if (failure.post_prune_leakage_count > 0) {
			reasons.push(`leakage=${failure.post_prune_leakage_count}`);
		}

		return `| ${failure.id} | ${failure.category} | ${failure.expected_case_id} | ${failure.actual_diagnosis || "n/a"} | ${failure.actual_severity || "n/a"} | ${reasons.join(", ") || "n/a"} |`;
	});

	const lines = [
		"# Triage Evaluation Harness Report",
		"",
		`Generated UTC: ${generatedAt}`,
		`Base URL: ${baseUrl}`,
		`Dataset: ${datasetPath}`,
		`Raw JSON output: ${reportJsonPath}`,
		"",
		"## Completion Criteria",
		`- Labeled dataset size (50-100): ${summary.dataset_size_gate_met ? "YES" : "NO"} (${summary.total_cases})`,
		`- Reproducible run (isolated backend + pinned env): YES`,
		`- Results documented (markdown + json): YES`,
		"",
		"## Summary Metrics",
		`- Startup to healthy: ${startupMs} ms`,
		`- Request failures: ${summary.request_failure_count}`,
		`- Diagnosis accuracy: ${toPercentString(summary.diagnosis_accuracy)} (${summary.diagnosis_correct_count}/${summary.total_cases})`,
		`- Severity correctness: ${toPercentString(summary.severity_accuracy)} (${summary.severity_correct_count}/${summary.total_cases})`,
		`- Noise suppression rate (noisy subset): ${toPercentString(summary.noisy_suppression_rate)} (${summary.noisy_suppressed_count}/${summary.noisy_case_count})`,
		`- Leakage-free rate: ${toPercentString(summary.leakage_free_rate)} (${summary.leakage_free_count}/${summary.total_cases})`,
		`- Average reduction ratio (all cases): ${summary.average_reduction_ratio.toFixed(4)}`,
		`- Average reduction ratio (noisy subset): ${summary.average_reduction_ratio_noisy.toFixed(4)}`,
		"",
		"## Gate Checks",
		"| Gate | Metric | Threshold | Result |",
		"| --- | ---: | ---: | :---: |",
		...gateRows,
		`- Overall gate status: ${gate.overall_passed ? "PASS" : "FAIL"}`,
		"",
		"## Category Breakdown",
		"| Category | Cases | Diagnosis Accuracy | Severity Correctness | Leakage Free Rate | Avg Reduction Ratio | Noisy Cases | Noisy Suppression Rate |",
		"| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
		...categoryRows,
		"",
		"## Reproducibility Config",
		"```json",
		JSON.stringify(reproducibilityConfig, null, 2),
		"```",
		"",
		"## Noise Suppression Context",
		"```json",
		JSON.stringify(
			{
				seed: seedInfo,
				noise_filter_config: indexStats?.noise_filter_config || null
			},
			null,
			2
		),
		"```"
	];

	if (failureRows.length > 0) {
		lines.push(
			"",
			"## Failure Samples",
			"| Case ID | Category | Expected Case | Actual Diagnosis | Actual Severity | Reasons |",
			"| --- | --- | --- | --- | --- | --- |",
			...failureRows
		);
	}

	if (!summary.dataset_size_gate_met) {
		lines.push(
			"",
			"## Dataset Size Warning",
			`Dataset must contain between 50 and 100 prompts. Current size: ${summary.total_cases}.`
		);
	}

	lines.push("");
	return lines.join("\n");
}

function validateLabeledDataset(labeledSet, caseMap) {
	if (!Array.isArray(labeledSet)) {
		throw new Error("Labeled dataset must be a JSON array");
	}

	if (labeledSet.length === 0) {
		throw new Error("Labeled dataset is empty");
	}

	const seenIds = new Set();

	for (const [index, item] of labeledSet.entries()) {
		if (!item || typeof item !== "object") {
			throw new Error(`Dataset item at index ${index} must be an object`);
		}

		if (typeof item.id !== "string" || item.id.trim() === "") {
			throw new Error(`Dataset item at index ${index} requires a non-empty string id`);
		}

		if (seenIds.has(item.id)) {
			throw new Error(`Dataset item id is duplicated: ${item.id}`);
		}

		seenIds.add(item.id);

		if (typeof item.query !== "string" || item.query.trim() === "") {
			throw new Error(`Dataset item ${item.id} requires a non-empty query string`);
		}

		if (typeof item.category !== "string" || item.category.trim() === "") {
			throw new Error(`Dataset item ${item.id} requires a non-empty category`);
		}

		if (typeof item.expected_case_id !== "string" || item.expected_case_id.trim() === "") {
			throw new Error(`Dataset item ${item.id} requires expected_case_id`);
		}

		if (!caseMap.has(item.expected_case_id)) {
			throw new Error(`Dataset item ${item.id} references unknown case id ${item.expected_case_id}`);
		}
	}
}

async function run() {
	const backendRoot = path.resolve(__dirname, "..");
	const evalPort = parsePositiveInteger(process.env.TRIAGE_EVAL_PORT, 5108);
	const baseUrl = process.env.TRIAGE_EVAL_BASE_URL || `http://127.0.0.1:${evalPort}`;
	const datasetPath = path.resolve(
		backendRoot,
		process.env.TRIAGE_EVAL_DATASET_PATH || "evaluation/labeled-triage-prompts.json"
	);
	const reportMarkdownPath = path.resolve(
		backendRoot,
		process.env.TRIAGE_EVAL_REPORT_PATH || "reports/triage-evaluation-report.md"
	);
	const reportJsonPath = path.resolve(
		backendRoot,
		process.env.TRIAGE_EVAL_RESULTS_PATH || "reports/triage-evaluation-results.json"
	);
	const requestLimit = parsePositiveInteger(process.env.TRIAGE_EVAL_LIMIT, 8);
	const requestTimeoutMs = parsePositiveInteger(process.env.TRIAGE_EVAL_REQUEST_TIMEOUT_MS, 4000);
	const healthTimeoutMs = parsePositiveInteger(process.env.TRIAGE_EVAL_HEALTH_TIMEOUT_MS, 45000);
	const diagnosisAccuracyMin = parseRatio(process.env.TRIAGE_EVAL_DIAGNOSIS_MIN, 0.85);
	const severityAccuracyMin = parseRatio(process.env.TRIAGE_EVAL_SEVERITY_MIN, 0.9);
	const noisySuppressionMin = parseRatio(process.env.TRIAGE_EVAL_NOISE_SUPPRESSION_MIN, 0.7);
	const leakageFreeMin = parseRatio(process.env.TRIAGE_EVAL_LEAKAGE_FREE_MIN, 0.95);
	const thresholds = {
		diagnosis_accuracy_min: diagnosisAccuracyMin,
		severity_accuracy_min: severityAccuracyMin,
		noisy_suppression_min: noisySuppressionMin,
		leakage_free_min: leakageFreeMin
	};
	const caseMap = new Map(dataset.map((item) => [item.id, item]));
	const labeledSet = JSON.parse(await fs.readFile(datasetPath, "utf8"));
	const serverLogs = [];
	let serverProcess = null;

	validateLabeledDataset(labeledSet, caseMap);

	const reproducibilityConfig = {
		port: evalPort,
		request_timeout_ms: requestTimeoutMs,
		health_timeout_ms: healthTimeoutMs,
		request_limit: requestLimit,
		pinned_env: {
			scaledown_api_url: "",
			scaledown_force_remote: false,
			doc_recency_filter_enabled: true,
			doc_type_filter_enabled: true,
			doc_strict_type_filter_on_critical: true,
			doc_critical_recency_days: 365,
			doc_non_critical_recency_days: 3650
		}
	};

	try {
		serverProcess = spawn(process.execPath, ["server.js"], {
			cwd: backendRoot,
			env: {
				...process.env,
				PORT: String(evalPort),
				RATE_LIMIT_MAX: "5000",
				RATE_LIMIT_WINDOW_MS: "60000",
				SCALEDOWN_API_URL: "",
				SCALEDOWN_API_KEY: "",
				SCALEDOWN_FORCE_REMOTE: "false",
				DOC_RECENCY_FILTER_ENABLED: "true",
				DOC_TYPE_FILTER_ENABLED: "true",
				DOC_STRICT_TYPE_FILTER_ON_CRITICAL: "true",
				DOC_CRITICAL_RECENCY_DAYS: "365",
				DOC_NON_CRITICAL_RECENCY_DAYS: "3650"
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

			if (serverLogs.length > 200) {
				serverLogs.splice(0, serverLogs.length - 200);
			}
		};

		serverProcess.stdout.on("data", appendServerLog);
		serverProcess.stderr.on("data", appendServerLog);

		const startupMs = await waitForServerHealth(baseUrl, healthTimeoutMs);
		const todayIso = new Date().toISOString().slice(0, 10);
		const seedPayload = {
			items: [
				{
					id: "triage-eval-old-cardiology-2010",
					type: "cardiology",
					date: "2010-01-05",
					source: "eval/triage",
					section: "Historical",
					title: "Old cardiology narrative",
					text: "Historical chest pain chart from years ago with outdated interventions."
				},
				{
					id: "triage-eval-old-dental-2011",
					type: "dental",
					date: "2011-09-19",
					source: "eval/triage",
					section: "Historical",
					title: "Old dental narrative",
					text: "Historical molar pain and gum swelling narrative from many years ago."
				},
				{
					id: "triage-eval-recent-admin-noise",
					type: "general",
					date: todayIso,
					source: "eval/triage",
					section: "Administrative",
					title: "Recent refill request",
					text: "Travel refill request and administrative records with no emergency findings."
				},
				{
					id: "triage-eval-recent-dental-noise",
					type: "dental",
					date: todayIso,
					source: "eval/triage",
					section: "Dental",
					title: "Recent dental routine",
					text: "Routine cleaning and retainer adjustment note with no abscess findings."
				}
			],
			chunking: {
				chunk_size_words: 120,
				chunk_overlap_words: 20
			},
			persist: false
		};

		const seedInfo = await postJson(baseUrl, "ingest/unstructured", seedPayload, requestTimeoutMs);
		const indexStats = await axios.get(`${baseUrl}/index/stats`, {
			timeout: requestTimeoutMs,
			validateStatus: () => true
		});

		if (indexStats.status >= 400) {
			throw new Error(`index stats failed with status ${indexStats.status}`);
		}

		const results = [];

		for (const testCase of labeledSet) {
			const expectedCase = caseMap.get(testCase.expected_case_id);
			const requestStartedAt = performance.now();

			try {
				const payload = await postJson(
					baseUrl,
					"triage",
					{
						query: testCase.query,
						limit: requestLimit
					},
					requestTimeoutMs
				);
				results.push(
					buildCaseResult({
						testCase,
						expectedCase,
						payload,
						requestError: null,
						requestLatencyMs: performance.now() - requestStartedAt
					})
				);
			} catch (error) {
				results.push(
					buildCaseResult({
						testCase,
						expectedCase,
						payload: null,
						requestError: error,
						requestLatencyMs: performance.now() - requestStartedAt
					})
				);
			}
		}

		const totalCases = results.length;
		const diagnosisCorrectCount = results.filter((result) => result.diagnosis_correct).length;
		const severityCorrectCount = results.filter((result) => result.severity_correct).length;
		const leakageFreeCount = results.filter((result) => !result.request_failed && result.post_prune_leakage_count === 0).length;
		const noisyResults = results.filter((result) => result.is_noisy);
		const noisySuppressedCount = noisyResults.filter((result) => result.noise_suppressed).length;
		const requestFailureCount = results.filter((result) => result.request_failed).length;
		const summary = {
			total_cases: totalCases,
			dataset_size_gate_met: totalCases >= 50 && totalCases <= 100,
			request_failure_count: requestFailureCount,
			diagnosis_correct_count: diagnosisCorrectCount,
			severity_correct_count: severityCorrectCount,
			leakage_free_count: leakageFreeCount,
			noisy_case_count: noisyResults.length,
			noisy_suppressed_count: noisySuppressedCount,
			diagnosis_accuracy: roundNumber(totalCases > 0 ? diagnosisCorrectCount / totalCases : 0),
			severity_accuracy: roundNumber(totalCases > 0 ? severityCorrectCount / totalCases : 0),
			leakage_free_rate: roundNumber(totalCases > 0 ? leakageFreeCount / totalCases : 0),
			noisy_suppression_rate: roundNumber(
				noisyResults.length > 0 ? noisySuppressedCount / noisyResults.length : 0
			),
			average_reduction_ratio: roundNumber(average(results.map((result) => result.reduction_ratio))),
			average_reduction_ratio_noisy: roundNumber(average(noisyResults.map((result) => result.reduction_ratio)))
		};

		const byCategory = summarizeByCategory(results);
		const gate = evaluateGates(summary, thresholds);
		const failures = results.filter((result) => {
			return result.request_failed
				|| !result.diagnosis_correct
				|| !result.severity_correct
				|| result.post_prune_leakage_count > 0;
		});

		const reportMarkdown = buildMarkdownReport({
			generatedAt: new Date().toISOString(),
			baseUrl,
			datasetPath,
			reportJsonPath,
			startupMs,
			summary,
			thresholds,
			gate,
			byCategory,
			indexStats: indexStats.data,
			seedInfo: {
				ingested_item_count: seedInfo.ingested_item_count,
				ingested_chunk_count: seedInfo.ingested_chunk_count,
				total_searchable_chunks: seedInfo.total_searchable_chunks
			},
			reproducibilityConfig,
			failures
		});

		const reportJson = {
			generated_at: new Date().toISOString(),
			base_url: baseUrl,
			dataset_path: datasetPath,
			report_markdown_path: reportMarkdownPath,
			reproducibility_config: reproducibilityConfig,
			thresholds,
			summary,
			gate,
			by_category: byCategory,
			noise_filter_config: indexStats.data?.noise_filter_config || null,
			seed_info: {
				ingested_item_count: seedInfo.ingested_item_count,
				ingested_chunk_count: seedInfo.ingested_chunk_count,
				total_searchable_chunks: seedInfo.total_searchable_chunks
			},
			results
		};

		await fs.mkdir(path.dirname(reportMarkdownPath), { recursive: true });
		await fs.mkdir(path.dirname(reportJsonPath), { recursive: true });
		await fs.writeFile(reportMarkdownPath, reportMarkdown, "utf8");
		await fs.writeFile(reportJsonPath, JSON.stringify(reportJson, null, 2), "utf8");

		const output = {
			report_markdown_path: reportMarkdownPath,
			report_json_path: reportJsonPath,
			total_cases: summary.total_cases,
			dataset_size_gate_met: summary.dataset_size_gate_met,
			gate_passed: gate.overall_passed,
			failed_gate_checks: gate.checks.filter((check) => !check.passed).map((check) => check.name)
		};

		console.log(JSON.stringify(output, null, 2));

		if (!summary.dataset_size_gate_met || !gate.overall_passed) {
			process.exitCode = 1;
		}
	} catch (error) {
		console.error("Triage evaluation harness failed:", error.message);

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
