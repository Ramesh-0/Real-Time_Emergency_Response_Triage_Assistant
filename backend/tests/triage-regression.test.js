const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
const { performance } = require("perf_hooks");
const axios = require("axios");

function parsePositiveInteger(value, fallback) {
	const parsed = Number.parseInt(value, 10);
	return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
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

function valueKind(value) {
	if (Array.isArray(value)) {
		return "array";
	}

	if (value === null) {
		return "null";
	}

	return typeof value;
}

function assertSameResponseStructure(left, right, pathLabel = "response") {
	const leftKind = valueKind(left);
	const rightKind = valueKind(right);

	assert.equal(
		rightKind,
		leftKind,
		`type mismatch at ${pathLabel}: expected ${leftKind}, received ${rightKind}`
	);

	if (leftKind === "array") {
		if (left.length === 0 || right.length === 0) {
			return;
		}

		assertSameResponseStructure(left[0], right[0], `${pathLabel}[0]`);
		return;
	}

	if (leftKind !== "object") {
		return;
	}

	const leftKeys = Object.keys(left).sort();
	const rightKeys = Object.keys(right).sort();

	assert.deepEqual(rightKeys, leftKeys, `key mismatch at ${pathLabel}`);

	for (const key of leftKeys) {
		assertSameResponseStructure(left[key], right[key], `${pathLabel}.${key}`);
	}
}

function leakageCount(meta) {
	if (!meta || typeof meta !== "object") {
		return 0;
	}

	const unrelated = Number.isFinite(meta.unrelated_type_leakage_count)
		? meta.unrelated_type_leakage_count
		: 0;
	const stale = Number.isFinite(meta.stale_record_leakage_count)
		? meta.stale_record_leakage_count
		: 0;

	return unrelated + stale;
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
				return;
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

async function postTriage(baseUrl, query, limit) {
	const response = await axios.post(
		`${baseUrl}/triage`,
		{ query, limit },
		{
			headers: {
				"Content-Type": "application/json"
			},
			timeout: 5000,
			validateStatus: () => true
		}
	);

	if (response.status >= 400) {
		const message = response.data && response.data.error
			? response.data.error
			: `HTTP ${response.status}`;
		throw new Error(message);
	}

	return response.data;
}

async function postVoiceTriage(baseUrl, transcript, limit) {
	const response = await axios.post(
		`${baseUrl}/triage/voice`,
		{ transcript, limit },
		{
			headers: {
				"Content-Type": "application/json"
			},
			timeout: 5000,
			validateStatus: () => true
		}
	);

	if (response.status >= 400) {
		const message = response.data && response.data.error
			? response.data.error
			: `HTTP ${response.status}`;
		throw new Error(message);
	}

	return response.data;
}

const backendRoot = path.resolve(__dirname, "..");
const port = parsePositiveInteger(process.env.REGRESSION_TEST_PORT, 5112);
const baseUrl = process.env.REGRESSION_TEST_BASE_URL || `http://127.0.0.1:${port}`;
const healthTimeoutMs = parsePositiveInteger(process.env.REGRESSION_TEST_HEALTH_TIMEOUT_MS, 45000);
const requestLimit = parsePositiveInteger(process.env.REGRESSION_TEST_LIMIT, 8);
const criticalScenarios = [
	{
		id: "cardiac-critical",
		query: "severe chest pain with sweating and left arm pressure",
		expectedDiagnosis: "Possible acute coronary syndrome",
		expectedSeverity: "HIGH",
		requireReduction: false
	},
	{
		id: "fever-critical",
		query: "high fever with body ache and fatigue",
		expectedDiagnosis: "Acute febrile illness",
		expectedSeverity: "MEDIUM",
		requireReduction: false
	},
	{
		id: "dental-critical",
		query: "severe tooth pain with gum swelling and abscess",
		expectedDiagnosis: "Acute dental abscess",
		expectedSeverity: "MEDIUM",
		requireReduction: false
	},
	{
		id: "mixed-noise-critical",
		query: "severe chest pain sweating left arm pain plus travel refill request and retainer adjustment history",
		expectedDiagnosis: "Possible acute coronary syndrome",
		expectedSeverity: "HIGH",
		requireReduction: true
	}
];

let serverProcess = null;
const serverLogs = [];

test.before(async () => {
	serverProcess = spawn(process.execPath, ["server.js"], {
		cwd: backendRoot,
		env: {
			...process.env,
			PORT: String(port),
			RATE_LIMIT_MAX: "3000",
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

	const appendLogs = (chunk) => {
		const lines = String(chunk)
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean);

		for (const line of lines) {
			serverLogs.push(line);
		}

		if (serverLogs.length > 150) {
			serverLogs.splice(0, serverLogs.length - 150);
		}
	};

	serverProcess.stdout.on("data", appendLogs);
	serverProcess.stderr.on("data", appendLogs);

	await waitForServerHealth(baseUrl, healthTimeoutMs);
});

test.after(async () => {
	await stopServerProcess(serverProcess);
});

test("critical triage regressions", async (t) => {
	for (const scenario of criticalScenarios) {
		await t.test(scenario.id, async () => {
			const payload = await postTriage(baseUrl, scenario.query, requestLimit);
			const actualDiagnosis = payload?.result?.diagnosis || "";
			const actualSeverity = payload?.result?.severity || "";
			const postPruneLeakage = leakageCount(payload?.post_prune_filter_meta);
			const reductionObserved = Number.isFinite(payload?.returned_retrieved_count)
				&& Number.isFinite(payload?.pruned_count)
				&& payload.pruned_count < payload.returned_retrieved_count;

			assert.equal(
				normalizeText(actualDiagnosis),
				normalizeText(scenario.expectedDiagnosis),
				`diagnosis mismatch for ${scenario.id}`
			);
			assert.equal(
				normalizeSeverity(actualSeverity),
				normalizeSeverity(scenario.expectedSeverity),
				`severity mismatch for ${scenario.id}`
			);
			assert.equal(
				postPruneLeakage,
				0,
				`post-prune leakage detected for ${scenario.id}`
			);

			if (scenario.requireReduction) {
				assert.equal(
					reductionObserved,
					true,
					`expected pruning reduction for ${scenario.id}`
				);
			}
		});
	}
});

test("voice triage matches text triage structure", async () => {
	const sharedQuery = "severe chest pain with sweating and left arm pressure";
	const textPayload = await postTriage(baseUrl, sharedQuery, requestLimit);
	const voicePayload = await postVoiceTriage(baseUrl, sharedQuery, requestLimit);

	assertSameResponseStructure(textPayload, voicePayload);
	assert.equal(
		normalizeText(voicePayload?.result?.diagnosis),
		normalizeText(textPayload?.result?.diagnosis),
		"voice diagnosis should match text diagnosis for same utterance"
	);
	assert.equal(
		normalizeSeverity(voicePayload?.result?.severity),
		normalizeSeverity(textPayload?.result?.severity),
		"voice severity should match text severity for same utterance"
	);
});

test("low-confidence symptom overlap returns related-case recommendation", async () => {
	const payload = await postTriage(baseUrl, "joint pain and knee bleeding", requestLimit);

	assert.notEqual(
		normalizeText(payload?.result?.diagnosis),
		normalizeText("Needs clinician triage review"),
		"low-confidence query should return the closest related diagnosis"
	);
	assert.equal(
		typeof payload?.result?.action === "string" && payload.result.action.trim().length > 0,
		true,
		"related-case fallback should include a recommended action"
	);
	assert.equal(
		Array.isArray(payload?.pruned_context),
		true,
		"triage payload should include related context cases"
	);
	assert.equal(
		payload.pruned_context.length > 0,
		true,
		"related context should contain symptom-overlap candidates"
	);
});

test("knee and back pain maps to musculoskeletal recommendation", async () => {
	const payload = await postTriage(baseUrl, "knee pain and back pain", requestLimit);

	assert.equal(
		normalizeText(payload?.result?.diagnosis),
		normalizeText("Musculoskeletal knee and lower back strain"),
		"knee/back query should resolve to orthopedic musculoskeletal diagnosis"
	);
	assert.equal(
		normalizeSeverity(payload?.result?.severity),
		normalizeSeverity("MEDIUM"),
		"knee/back musculoskeletal case severity should be MEDIUM"
	);
	assert.equal(
		normalizeText(payload?.result?.action).includes("physiotherapy"),
		true,
		"knee/back musculoskeletal recommendation should include physiotherapy guidance"
	);
});

process.on("unhandledRejection", (error) => {
	const recentLogs = serverLogs.slice(-20).join("\n");
	if (recentLogs) {
		console.error("Recent backend logs:\n" + recentLogs);
	}
	throw error;
});
