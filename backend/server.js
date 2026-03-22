require("dotenv").config();

const { performance } = require("perf_hooks");
const { AsyncLocalStorage } = require("async_hooks");
const { randomUUID } = require("crypto");
const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const axios = require("axios");
const dataset = require("./data.json");
const { HybridChunkIndex } = require("./lib/hybridIndex");
const {
	ingestUnstructuredItems,
	mergeChunkRecords,
	loadPersistedChunks,
	persistChunks
} = require("./lib/unstructuredIngestion");

function parsePositiveInteger(value, fallback) {
	const parsed = Number.parseInt(value, 10);
	return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

function parseBoolean(value, fallback = false) {
	if (typeof value === "boolean") {
		return value;
	}

	if (typeof value !== "string") {
		return fallback;
	}

	const normalized = value.trim().toLowerCase();

	if (["1", "true", "yes", "on"].includes(normalized)) {
		return true;
	}

	if (["0", "false", "no", "off"].includes(normalized)) {
		return false;
	}

	return fallback;
}

function parseRatio(value, fallback) {
	const parsed = Number.parseFloat(value);

	if (!Number.isFinite(parsed)) {
		return fallback;
	}

	return Math.max(0, Math.min(parsed, 1));
}

const app = express();
const PORT = parsePositiveInteger(process.env.PORT, 5000);
const DEFAULT_LIMIT = parsePositiveInteger(process.env.DEFAULT_LIMIT, 10);
const MAX_LIMIT = parsePositiveInteger(process.env.MAX_LIMIT, 50);
const QUERY_MAX_LENGTH = parsePositiveInteger(process.env.QUERY_MAX_LENGTH, 300);
const RATE_LIMIT_WINDOW_MS = parsePositiveInteger(process.env.RATE_LIMIT_WINDOW_MS, 60000);
const RATE_LIMIT_MAX = parsePositiveInteger(process.env.RATE_LIMIT_MAX, 120);
const SCALEDOWN_TIMEOUT_MS = parsePositiveInteger(process.env.SCALEDOWN_TIMEOUT_MS, 8000);
const LATENCY_TARGET_MS = parsePositiveInteger(process.env.LATENCY_TARGET_MS, 500);
const LATENCY_BUDGET_RETRIEVE_MS = parsePositiveInteger(
	process.env.LATENCY_BUDGET_RETRIEVE_MS,
	Math.max(1, Math.round(LATENCY_TARGET_MS * 0.28))
);
const LATENCY_BUDGET_PRUNE_MS = parsePositiveInteger(
	process.env.LATENCY_BUDGET_PRUNE_MS,
	Math.max(1, Math.round(LATENCY_TARGET_MS * 0.44))
);
const LATENCY_BUDGET_DECIDE_MS = parsePositiveInteger(
	process.env.LATENCY_BUDGET_DECIDE_MS,
	Math.max(1, Math.round(LATENCY_TARGET_MS * 0.2))
);
const LATENCY_BUDGET_RESPONSE_MS = parsePositiveInteger(
	process.env.LATENCY_BUDGET_RESPONSE_MS,
	Math.max(1, LATENCY_TARGET_MS - LATENCY_BUDGET_RETRIEVE_MS - LATENCY_BUDGET_PRUNE_MS - LATENCY_BUDGET_DECIDE_MS)
);
const TRIAGE_STAGE_BUDGET_MS = Object.freeze({
	retrieve: LATENCY_BUDGET_RETRIEVE_MS,
	prune: LATENCY_BUDGET_PRUNE_MS,
	decide: LATENCY_BUDGET_DECIDE_MS,
	response: LATENCY_BUDGET_RESPONSE_MS
});
const SCALEDOWN_EFFECTIVE_TIMEOUT_MS = Math.max(
	50,
	Math.min(SCALEDOWN_TIMEOUT_MS, Math.floor(TRIAGE_STAGE_BUDGET_MS.prune * 0.8))
);
const SCALEDOWN_MIN_CANDIDATES = parsePositiveInteger(process.env.SCALEDOWN_MIN_CANDIDATES, 4);
const SCALEDOWN_FORCE_REMOTE = parseBoolean(process.env.SCALEDOWN_FORCE_REMOTE, false);
const LOCAL_PRUNE_TOP_K = parsePositiveInteger(process.env.LOCAL_PRUNE_TOP_K, 8);
const MAX_DOC_AGE_DAYS = parsePositiveInteger(process.env.MAX_DOC_AGE_DAYS, 3650);
const DOC_RECENCY_FILTER_ENABLED = parseBoolean(process.env.DOC_RECENCY_FILTER_ENABLED, true);
const DOC_TYPE_FILTER_ENABLED = parseBoolean(process.env.DOC_TYPE_FILTER_ENABLED, true);
const DOC_STRICT_TYPE_FILTER_ON_CRITICAL = parseBoolean(
	process.env.DOC_STRICT_TYPE_FILTER_ON_CRITICAL,
	true
);
const DOC_CRITICAL_RECENCY_DAYS = Math.min(
	MAX_DOC_AGE_DAYS,
	parsePositiveInteger(process.env.DOC_CRITICAL_RECENCY_DAYS, 365)
);
const DOC_NON_CRITICAL_RECENCY_DAYS = Math.min(
	MAX_DOC_AGE_DAYS,
	parsePositiveInteger(process.env.DOC_NON_CRITICAL_RECENCY_DAYS, MAX_DOC_AGE_DAYS)
);
const API_JSON_LIMIT = process.env.API_JSON_LIMIT || "5mb";
const MIN_SEARCHABLE_CHUNKS = parsePositiveInteger(process.env.MIN_SEARCHABLE_CHUNKS, 10000);
const INGEST_DEFAULT_CHUNK_SIZE_WORDS = parsePositiveInteger(process.env.INGEST_DEFAULT_CHUNK_SIZE_WORDS, 180);
const INGEST_DEFAULT_CHUNK_OVERLAP_WORDS = parsePositiveInteger(process.env.INGEST_DEFAULT_CHUNK_OVERLAP_WORDS, 35);
const INGEST_MAX_ITEMS_PER_REQUEST = parsePositiveInteger(process.env.INGEST_MAX_ITEMS_PER_REQUEST, 50);
const INGEST_MAX_TEXT_CHARS = parsePositiveInteger(process.env.INGEST_MAX_TEXT_CHARS, 3000000);
const PATIENT_INSIGHTS_MAX_RECORDS = parsePositiveInteger(process.env.PATIENT_INSIGHTS_MAX_RECORDS, 5000);
const HYBRID_VECTOR_DIMENSIONS = parsePositiveInteger(process.env.HYBRID_VECTOR_DIMENSIONS, 256);
const INGEST_CHUNK_STORE_PATH = process.env.INGEST_CHUNK_STORE_PATH
	? path.resolve(process.cwd(), process.env.INGEST_CHUNK_STORE_PATH)
	: path.join(__dirname, "ingested_chunks.json");
const ALLOWED_ORIGINS = (process.env.CORS_ORIGIN || "")
	.split(",")
	.map((origin) => origin.trim())
	.filter(Boolean);
const SAFE_DEFAULT_LIMIT = Math.min(DEFAULT_LIMIT, MAX_LIMIT);
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const OBS_LATENCY_WINDOW_SIZE = parsePositiveInteger(process.env.OBS_LATENCY_WINDOW_SIZE, 300);
const OBS_ERROR_RATE_WINDOW_SIZE = parsePositiveInteger(process.env.OBS_ERROR_RATE_WINDOW_SIZE, 300);
const OBS_PRUNE_RATIO_WINDOW_SIZE = parsePositiveInteger(process.env.OBS_PRUNE_RATIO_WINDOW_SIZE, 300);
const OBS_EXTERNAL_PRUNE_WINDOW_SIZE = parsePositiveInteger(process.env.OBS_EXTERNAL_PRUNE_WINDOW_SIZE, 200);
const ALERT_P95_THRESHOLD_MS = parsePositiveInteger(process.env.ALERT_P95_THRESHOLD_MS, LATENCY_TARGET_MS);
const ALERT_P95_MIN_SAMPLES = parsePositiveInteger(process.env.ALERT_P95_MIN_SAMPLES, 30);
const ALERT_PRUNE_OUTAGE_MIN_ATTEMPTS = parsePositiveInteger(process.env.ALERT_PRUNE_OUTAGE_MIN_ATTEMPTS, 5);
const ALERT_PRUNE_OUTAGE_AVAILABILITY_THRESHOLD = parseRatio(
	process.env.ALERT_PRUNE_OUTAGE_AVAILABILITY_THRESHOLD,
	0
);
const requestContextStorage = new AsyncLocalStorage();

class HttpError extends Error {
	constructor(statusCode, message) {
		super(message);
		this.name = "HttpError";
		this.statusCode = statusCode;
	}
}

function log(level, message, metadata = {}) {
	const requestContext = requestContextStorage.getStore();
	const contextualMetadata = requestContext && requestContext.requestId
		? { request_id: requestContext.requestId }
		: {};
	const entry = {
		timestamp: new Date().toISOString(),
		level,
		message,
		...contextualMetadata,
		...metadata
	};

	const serialized = JSON.stringify(entry);

	if (level === "error") {
		console.error(serialized);
		return;
	}

	if (level === "warn") {
		console.warn(serialized);
		return;
	}

	console.log(serialized);
}

app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use((req, res, next) => {
	const requestId = resolveRequestId(req);
	const startedAt = performance.now();
	const requestPath = req.originalUrl || req.url || req.path || "unknown";

	req.requestId = requestId;
	res.setHeader("x-request-id", requestId);

	requestContextStorage.run({ requestId }, () => {
		log("info", "HTTP request started", {
			event: "request_started",
			http: {
				method: req.method,
				path: requestPath
			}
		});

		res.on("finish", () => {
			const endpointPath = req.path || requestPath;
			const latencyMs = roundLatencyMs(performance.now() - startedAt);

			recordHttpRequestObservation({
				endpoint: endpointPath,
				method: req.method,
				statusCode: res.statusCode,
				latencyMs
			});

			log("info", "HTTP request completed", {
				event: "request_completed",
				http: {
					method: req.method,
					path: endpointPath,
					status_code: res.statusCode,
					latency_ms: latencyMs
				}
			});
		});

		next();
	});
});

app.use(helmet());

app.use(
	cors({
		origin: (origin, callback) => {
			if (ALLOWED_ORIGINS.length === 0) {
				return callback(null, true);
			}

			if (!origin || ALLOWED_ORIGINS.includes(origin)) {
				return callback(null, true);
			}

			return callback(new HttpError(403, "Origin is not allowed by CORS policy"));
		},
		methods: ["GET", "POST", "OPTIONS"],
		allowedHeaders: ["Content-Type", "Authorization", "x-api-key", "x-request-id"],
		exposedHeaders: ["x-request-id"],
		maxAge: 600
	})
);

app.use(
	rateLimit({
		windowMs: RATE_LIMIT_WINDOW_MS,
		max: RATE_LIMIT_MAX,
		standardHeaders: true,
		legacyHeaders: false,
		message: {
			error: "Too many requests. Please retry later."
		}
	})
);

app.use(express.json({ limit: API_JSON_LIMIT }));

const KEYWORD_TO_TYPE = {
	chest: "cardiology",
	cardiac: "cardiology",
	arm: "cardiology",
	sweating: "cardiology",
	pressure: "cardiology",
	ecg: "cardiology",
	heart: "cardiology",
	ischemia: "cardiology",
	tooth: "dental",
	gum: "dental",
	jaw: "dental",
	abscess: "dental",
	wisdom: "dental",
	molar: "dental",
	fever: "general",
	cough: "general",
	headache: "general",
	fatigue: "general",
	rash: "general",
	throat: "general"
};

const CRITICAL_QUERY_TOKENS = new Set([
	"severe",
	"acute",
	"chest",
	"sweating",
	"breath",
	"shortness",
	"ecg",
	"cardiac",
	"stroke",
	"slur",
	"droop",
	"weakness",
	"unconscious",
	"collapse",
	"bleeding"
]);

const CASE_BY_ID = new Map(
	dataset
		.filter((doc) => doc && doc.id)
		.map((doc) => [doc.id, doc])
);

const CASE_BY_NORMALIZED_ID = new Map(
	[...CASE_BY_ID.entries()].map(([caseId, doc]) => [String(caseId).trim().toUpperCase(), doc])
);

function toBaseIndexRecord(doc) {
	return {
		id: doc.id,
		type: doc.type || "general",
		date: doc.date || null,
		source: "seed:data.json",
		section: doc.type || "General",
		title: doc.title || "",
		text: doc.text || doc.content || "",
		keywords: Array.isArray(doc.keywords) ? doc.keywords : [],
		diagnosis: doc.diagnosis || null,
		action: doc.action || null,
		severity: doc.severity || null,
		content_type: "application/json"
	};
}

const baseDatasetRecords = dataset.filter((doc) => doc && doc.id).map(toBaseIndexRecord);
let ingestedChunkRecords = [];
const hybridIndex = new HybridChunkIndex({
	vectorDimensions: HYBRID_VECTOR_DIMENSIONS
});

function rebuildHybridIndex() {
	return hybridIndex.replaceAll([...baseDatasetRecords, ...ingestedChunkRecords]);
}

async function initializeHybridIndex() {
	ingestedChunkRecords = await loadPersistedChunks(INGEST_CHUNK_STORE_PATH);
	const totalIndexedChunks = rebuildHybridIndex();

	log("info", "Hybrid retrieval index initialized", {
		total_chunks: totalIndexedChunks,
		ingested_chunks: ingestedChunkRecords.length,
		min_searchable_chunks: MIN_SEARCHABLE_CHUNKS,
		chunk_goal_met: totalIndexedChunks >= MIN_SEARCHABLE_CHUNKS,
		chunk_store_path: INGEST_CHUNK_STORE_PATH
	});
}

function parseLimit(limitValue) {
	const parsed = Number.parseInt(limitValue, 10);

	if (Number.isNaN(parsed)) {
		return SAFE_DEFAULT_LIMIT;
	}

	return Math.min(Math.max(parsed, 1), MAX_LIMIT);
}

function toEpoch(dateValue) {
	const parsed = Date.parse(dateValue);
	return Number.isNaN(parsed) ? 0 : parsed;
}

function tokenize(text) {
	if (typeof text !== "string") {
		return [];
	}

	return text.toLowerCase().match(/[a-z0-9]+/g) || [];
}

function roundLatencyMs(value) {
	if (!Number.isFinite(value)) {
		return 0;
	}

	return Number(value.toFixed(2));
}

function roundRatio(value) {
	if (!Number.isFinite(value)) {
		return 0;
	}

	return Number(value.toFixed(4));
}

function clampRatio(value) {
	if (!Number.isFinite(value)) {
		return 0;
	}

	return Math.max(0, Math.min(value, 1));
}

function percentile(values, ratio) {
	if (!Array.isArray(values) || values.length === 0) {
		return 0;
	}

	const normalizedRatio = Math.max(0, Math.min(ratio, 1));
	const sortedValues = [...values].sort((left, right) => left - right);
	const index = Math.min(
		sortedValues.length - 1,
		Math.floor((sortedValues.length - 1) * normalizedRatio)
	);

	return sortedValues[index];
}

function summarizeNumericWindow(values, roundValue = roundLatencyMs) {
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
		avg: roundValue(average),
		p50: roundValue(percentile(values, 0.5)),
		p95: roundValue(percentile(values, 0.95)),
		max: roundValue(Math.max(...values))
	};
}

function pushRollingValue(windowValues, nextValue, maxSize) {
	if (!Array.isArray(windowValues) || !Number.isFinite(nextValue) || maxSize <= 0) {
		return;
	}

	windowValues.push(nextValue);

	if (windowValues.length > maxSize) {
		windowValues.splice(0, windowValues.length - maxSize);
	}
}

function incrementCounter(counterMap, key, amount = 1) {
	const previous = counterMap.get(key) || 0;
	counterMap.set(key, previous + amount);
}

function normalizeEndpointLabel(endpoint) {
	if (typeof endpoint !== "string") {
		return "unknown";
	}

	const trimmed = endpoint.trim();

	if (!trimmed) {
		return "unknown";
	}

	const pathOnly = trimmed.split("?")[0];

	if (!pathOnly) {
		return "unknown";
	}

	return pathOnly.startsWith("/") ? pathOnly : `/${pathOnly}`;
}

function createAlertState(name) {
	return {
		name,
		active: false,
		active_since: null,
		last_evaluated_at: null,
		details: {}
	};
}

function createEndpointMetricState(endpoint) {
	return {
		endpoint,
		request_count: 0,
		server_error_count: 0,
		latency_ms_window: [],
		error_flag_window: [],
		prune_reduction_ratio_window: []
	};
}

const observabilityState = {
	started_at: new Date().toISOString(),
	request_counters: new Map(),
	endpoint_metrics: new Map(),
	external_prune: {
		attempted_total: 0,
		success_total: 0,
		local_fallback_total: 0,
		recent_attempt_outcomes: []
	},
	alerts: {
		p95_latency_breach: createAlertState("p95_latency_breach"),
		pruning_outage: createAlertState("pruning_outage")
	}
};

function getEndpointMetricState(endpoint) {
	const normalizedEndpoint = normalizeEndpointLabel(endpoint);

	if (!observabilityState.endpoint_metrics.has(normalizedEndpoint)) {
		observabilityState.endpoint_metrics.set(
			normalizedEndpoint,
			createEndpointMetricState(normalizedEndpoint)
		);
	}

	return observabilityState.endpoint_metrics.get(normalizedEndpoint);
}

function getExternalPruneWindowSnapshot() {
	const attempts = observabilityState.external_prune.recent_attempt_outcomes;
	const attemptCount = attempts.length;
	const successCount = attempts.reduce((sum, wasSuccessful) => {
		return sum + (wasSuccessful ? 1 : 0);
	}, 0);
	const availability = attemptCount === 0 ? 1 : successCount / attemptCount;

	return {
		attempt_count: attemptCount,
		success_count: successCount,
		availability
	};
}

function updateAlertState(alertKey, isActive, details) {
	const alertState = observabilityState.alerts[alertKey];

	if (!alertState) {
		return;
	}

	const evaluatedAt = new Date().toISOString();
	const safeDetails = details && typeof details === "object" ? details : {};

	if (alertState.active !== isActive) {
		const previouslyActiveSince = alertState.active_since;
		alertState.active = isActive;
		alertState.active_since = isActive ? evaluatedAt : null;

		if (isActive) {
			log("warn", "Observability alert triggered", {
				event: "alert_triggered",
				alert: alertState.name,
				active_since: alertState.active_since,
				details: safeDetails
			});
		} else {
			log("info", "Observability alert resolved", {
				event: "alert_resolved",
				alert: alertState.name,
				active_since: previouslyActiveSince,
				resolved_at: evaluatedAt,
				details: safeDetails
			});
		}
	}

	alertState.last_evaluated_at = evaluatedAt;
	alertState.details = safeDetails;
}

function evaluateObservabilityAlerts() {
	const triageMetrics = getEndpointMetricState("/triage");
	const triageLatency = summarizeNumericWindow(triageMetrics.latency_ms_window, roundLatencyMs);
	const p95BreachActive =
		triageLatency.count >= ALERT_P95_MIN_SAMPLES &&
		triageLatency.p95 > ALERT_P95_THRESHOLD_MS;

	updateAlertState("p95_latency_breach", p95BreachActive, {
		threshold_ms: ALERT_P95_THRESHOLD_MS,
		min_samples: ALERT_P95_MIN_SAMPLES,
		sample_count: triageLatency.count,
		p95_latency_ms: triageLatency.p95
	});

	const externalPruneWindow = getExternalPruneWindowSnapshot();
	const outageActive =
		externalPruneWindow.attempt_count >= ALERT_PRUNE_OUTAGE_MIN_ATTEMPTS &&
		externalPruneWindow.availability <= ALERT_PRUNE_OUTAGE_AVAILABILITY_THRESHOLD;

	updateAlertState("pruning_outage", outageActive, {
		min_attempts: ALERT_PRUNE_OUTAGE_MIN_ATTEMPTS,
		availability_threshold: ALERT_PRUNE_OUTAGE_AVAILABILITY_THRESHOLD,
		attempt_count: externalPruneWindow.attempt_count,
		availability: roundRatio(externalPruneWindow.availability)
	});
}

function recordHttpRequestObservation({ endpoint, method, statusCode, latencyMs }) {
	const normalizedEndpoint = normalizeEndpointLabel(endpoint);
	const normalizedMethod = typeof method === "string" ? method.toUpperCase() : "UNKNOWN";
	const numericStatusCode = Number.isInteger(statusCode)
		? statusCode
		: Number.parseInt(statusCode, 10) || 0;
	const roundedLatencyMs = roundLatencyMs(latencyMs);
	const counterKey = JSON.stringify({
		endpoint: normalizedEndpoint,
		method: normalizedMethod,
		status_code: numericStatusCode
	});

	incrementCounter(observabilityState.request_counters, counterKey, 1);

	const endpointMetrics = getEndpointMetricState(normalizedEndpoint);
	endpointMetrics.request_count += 1;

	if (numericStatusCode >= 500) {
		endpointMetrics.server_error_count += 1;
	}

	pushRollingValue(endpointMetrics.latency_ms_window, roundedLatencyMs, OBS_LATENCY_WINDOW_SIZE);
	pushRollingValue(
		endpointMetrics.error_flag_window,
		numericStatusCode >= 500 ? 1 : 0,
		OBS_ERROR_RATE_WINDOW_SIZE
	);

	evaluateObservabilityAlerts();
}

function recordPruneObservation({ endpoint, retrievedCount, prunedCount, pruneMeta }) {
	const endpointMetrics = getEndpointMetricState(endpoint);
	const safeRetrievedCount = Number.isFinite(retrievedCount) ? Math.max(0, retrievedCount) : 0;
	const safePrunedCount = Number.isFinite(prunedCount) ? Math.max(0, prunedCount) : 0;

	if (safeRetrievedCount > 0) {
		const reductionRatio = clampRatio((safeRetrievedCount - safePrunedCount) / safeRetrievedCount);
		pushRollingValue(
			endpointMetrics.prune_reduction_ratio_window,
			reductionRatio,
			OBS_PRUNE_RATIO_WINDOW_SIZE
		);
	}

	if (pruneMeta && pruneMeta.attemptedScaledown) {
		observabilityState.external_prune.attempted_total += 1;

		if (pruneMeta.usedScaledown) {
			observabilityState.external_prune.success_total += 1;
		}

		pushRollingValue(
			observabilityState.external_prune.recent_attempt_outcomes,
			pruneMeta.usedScaledown ? 1 : 0,
			OBS_EXTERNAL_PRUNE_WINDOW_SIZE
		);
	}

	if (pruneMeta && pruneMeta.usedLocalFallback) {
		observabilityState.external_prune.local_fallback_total += 1;
	}

	evaluateObservabilityAlerts();
}

function buildEndpointMetricsSnapshot(endpoint) {
	const endpointMetrics = getEndpointMetricState(endpoint);
	const latencySummary = summarizeNumericWindow(endpointMetrics.latency_ms_window, roundLatencyMs);
	const pruneSummary = summarizeNumericWindow(
		endpointMetrics.prune_reduction_ratio_window,
		roundRatio
	);
	const errorWindowCount = endpointMetrics.error_flag_window.length;
	const serverErrorRatio = errorWindowCount === 0
		? 0
		: endpointMetrics.error_flag_window.reduce((sum, value) => sum + value, 0) / errorWindowCount;

	return {
		endpoint: endpointMetrics.endpoint,
		request_count: endpointMetrics.request_count,
		server_error_count: endpointMetrics.server_error_count,
		latency_ms: latencySummary,
		error_rate: roundRatio(serverErrorRatio),
		prune_reduction_ratio: pruneSummary
	};
}

function getAlertsSnapshot() {
	evaluateObservabilityAlerts();

	return Object.fromEntries(
		Object.entries(observabilityState.alerts).map(([alertKey, alertState]) => {
			return [
				alertKey,
				{
					...alertState,
					details: { ...alertState.details }
				}
			];
		})
	);
}

function buildObservabilityDashboardSnapshot() {
	const endpointKeys = [...observabilityState.endpoint_metrics.keys()].sort((left, right) => {
		return left.localeCompare(right);
	});
	const endpointMetrics = endpointKeys.map((endpoint) => buildEndpointMetricsSnapshot(endpoint));
	const externalPruneWindow = getExternalPruneWindowSnapshot();
	const alerts = getAlertsSnapshot();
	const activeAlerts = Object.values(alerts)
		.filter((alert) => alert.active)
		.map((alert) => alert.name);

	return {
		generated_at: new Date().toISOString(),
		started_at: observabilityState.started_at,
		uptime_seconds: Math.floor(process.uptime()),
		window_config: {
			latency_window_size: OBS_LATENCY_WINDOW_SIZE,
			error_rate_window_size: OBS_ERROR_RATE_WINDOW_SIZE,
			prune_ratio_window_size: OBS_PRUNE_RATIO_WINDOW_SIZE,
			external_prune_window_size: OBS_EXTERNAL_PRUNE_WINDOW_SIZE
		},
		thresholds: {
			p95_latency_threshold_ms: ALERT_P95_THRESHOLD_MS,
			p95_min_samples: ALERT_P95_MIN_SAMPLES,
			pruning_outage_min_attempts: ALERT_PRUNE_OUTAGE_MIN_ATTEMPTS,
			pruning_outage_availability_threshold: ALERT_PRUNE_OUTAGE_AVAILABILITY_THRESHOLD
		},
		endpoints: endpointMetrics,
		external_prune: {
			attempted_total: observabilityState.external_prune.attempted_total,
			success_total: observabilityState.external_prune.success_total,
			local_fallback_total: observabilityState.external_prune.local_fallback_total,
			window_attempt_count: externalPruneWindow.attempt_count,
			window_success_count: externalPruneWindow.success_count,
			availability: roundRatio(externalPruneWindow.availability)
		},
		alerts,
		active_alerts: activeAlerts
	};
}

function escapePrometheusLabelValue(value) {
	return String(value)
		.replace(/\\/g, "\\\\")
		.replace(/\"/g, '\\\"')
		.replace(/\n/g, "\\n");
}

function toPrometheusMetric(name, labels, value) {
	const numericValue = Number.isFinite(value) ? Number(value.toFixed(6)) : 0;
	const labelEntries = labels && typeof labels === "object"
		? Object.entries(labels).filter(([, labelValue]) => labelValue !== null && labelValue !== undefined)
		: [];
	const serializedLabels = labelEntries.length === 0
		? ""
		: `{${labelEntries
			.map(([labelName, labelValue]) => {
				return `${labelName}="${escapePrometheusLabelValue(labelValue)}"`;
			})
			.join(",")}}`;

	return `${name}${serializedLabels} ${numericValue}`;
}

function renderPrometheusMetrics() {
	const lines = [];
	const dashboardSnapshot = buildObservabilityDashboardSnapshot();

	lines.push(
		"# HELP triage_http_requests_total Total observed HTTP requests by endpoint, method, and status code.",
		"# TYPE triage_http_requests_total counter"
	);

	const requestCounterEntries = [...observabilityState.request_counters.entries()].sort((left, right) => {
		return left[0].localeCompare(right[0]);
	});

	for (const [key, count] of requestCounterEntries) {
		let labels = {};

		try {
			labels = JSON.parse(key);
		} catch (_error) {
			continue;
		}

		lines.push(
			toPrometheusMetric(
				"triage_http_requests_total",
				{
					endpoint: labels.endpoint || "unknown",
					method: labels.method || "UNKNOWN",
					status_code: labels.status_code || 0
				},
				count
			)
		);
	}

	lines.push(
		"# HELP triage_http_latency_ms_avg Rolling average HTTP latency in milliseconds by endpoint.",
		"# TYPE triage_http_latency_ms_avg gauge",
		"# HELP triage_http_latency_ms_p95 Rolling p95 HTTP latency in milliseconds by endpoint.",
		"# TYPE triage_http_latency_ms_p95 gauge",
		"# HELP triage_http_error_rate Rolling server error rate by endpoint (0 to 1).",
		"# TYPE triage_http_error_rate gauge",
		"# HELP triage_prune_reduction_ratio_avg Rolling average prune reduction ratio by endpoint (0 to 1).",
		"# TYPE triage_prune_reduction_ratio_avg gauge"
	);

	for (const endpointMetric of dashboardSnapshot.endpoints) {
		lines.push(
			toPrometheusMetric(
				"triage_http_latency_ms_avg",
				{ endpoint: endpointMetric.endpoint },
				endpointMetric.latency_ms.avg
			)
		);
		lines.push(
			toPrometheusMetric(
				"triage_http_latency_ms_p95",
				{ endpoint: endpointMetric.endpoint },
				endpointMetric.latency_ms.p95
			)
		);
		lines.push(
			toPrometheusMetric(
				"triage_http_error_rate",
				{ endpoint: endpointMetric.endpoint },
				endpointMetric.error_rate
			)
		);
		lines.push(
			toPrometheusMetric(
				"triage_prune_reduction_ratio_avg",
				{ endpoint: endpointMetric.endpoint },
				endpointMetric.prune_reduction_ratio.avg
			)
		);
	}

	lines.push(
		"# HELP triage_external_prune_attempts_total Total external pruning attempts.",
		"# TYPE triage_external_prune_attempts_total counter",
		toPrometheusMetric(
			"triage_external_prune_attempts_total",
			null,
			observabilityState.external_prune.attempted_total
		),
		"# HELP triage_external_prune_success_total Total successful external pruning operations.",
		"# TYPE triage_external_prune_success_total counter",
		toPrometheusMetric(
			"triage_external_prune_success_total",
			null,
			observabilityState.external_prune.success_total
		),
		"# HELP triage_external_prune_local_fallback_total Total local fallback pruning operations.",
		"# TYPE triage_external_prune_local_fallback_total counter",
		toPrometheusMetric(
			"triage_external_prune_local_fallback_total",
			null,
			observabilityState.external_prune.local_fallback_total
		),
		"# HELP triage_external_prune_availability Rolling availability of external pruning service (0 to 1).",
		"# TYPE triage_external_prune_availability gauge",
		toPrometheusMetric(
			"triage_external_prune_availability",
			null,
			dashboardSnapshot.external_prune.availability
		)
	);

	lines.push(
		"# HELP triage_alert_state Active alert state (1=active, 0=inactive).",
		"# TYPE triage_alert_state gauge"
	);

	for (const [alertKey, alertValue] of Object.entries(dashboardSnapshot.alerts)) {
		lines.push(
			toPrometheusMetric(
				"triage_alert_state",
				{ alert: alertKey },
				alertValue.active ? 1 : 0
			)
		);
	}

	return `${lines.join("\n")}\n`;
}

function resolveRequestId(req) {
	const rawHeaderValue = req.headers["x-request-id"];
	const candidate = Array.isArray(rawHeaderValue) ? rawHeaderValue[0] : rawHeaderValue;

	if (typeof candidate === "string") {
		const trimmed = candidate.trim();

		if (trimmed && trimmed.length <= 128) {
			return trimmed;
		}
	}

	return randomUUID();
}

function evaluateStageBudget(stageLatencies) {
	return {
		retrieve: stageLatencies.retrieve <= TRIAGE_STAGE_BUDGET_MS.retrieve,
		prune: stageLatencies.prune <= TRIAGE_STAGE_BUDGET_MS.prune,
		decide: stageLatencies.decide <= TRIAGE_STAGE_BUDGET_MS.decide,
		response: stageLatencies.response <= TRIAGE_STAGE_BUDGET_MS.response
	};
}

function createDocIdentity(doc) {
	if (!doc || typeof doc !== "object") {
		return "__invalid_doc__";
	}

	if (doc.id) {
		return `id:${doc.id}`;
	}

	return `fallback:${doc.type || "unknown"}:${doc.title || ""}:${doc.date || ""}`;
}

function dedupeDocs(docs) {
	const seen = new Set();

	return docs.filter((doc) => {
		const identity = createDocIdentity(doc);

		if (seen.has(identity)) {
			return false;
		}

		seen.add(identity);
		return true;
	});
}

function computeRelevanceScore(queryTokens, doc) {
	if (!doc || typeof doc !== "object") {
		return 0;
	}

	const tokenSet = new Set(queryTokens);
	const keywords = Array.isArray(doc.keywords) ? doc.keywords : [];
	const keywordHits = keywords.reduce((score, keyword) => {
		return tokenSet.has(String(keyword).toLowerCase()) ? score + 3 : score;
	}, 0);

	const textBody = `${doc.title || ""} ${doc.text || doc.content || ""}`.toLowerCase();
	const textHits = queryTokens.reduce((score, token) => {
		return token.length > 2 && textBody.includes(token) ? score + 1 : score;
	}, 0);

	const typeHit = typeof doc.type === "string" && tokenSet.has(doc.type.toLowerCase()) ? 1 : 0;

	return keywordHits + textHits + typeHit;
}

function rankDocsByRelevance(query, docs) {
	const queryTokens = tokenize(query);
	const uniqueDocs = dedupeDocs(docs);

	return uniqueDocs
		.map((doc, index) => {
			return {
				doc,
				index,
				relevanceScore: computeRelevanceScore(queryTokens, doc)
			};
		})
		.sort((a, b) => {
			if (b.relevanceScore !== a.relevanceScore) {
				return b.relevanceScore - a.relevanceScore;
			}

			const dateOrder = toEpoch(b.doc.date) - toEpoch(a.doc.date);
			if (dateOrder !== 0) {
				return dateOrder;
			}

			return a.index - b.index;
		})
		.map((item) => item.doc);
}

function calculateAverageRelevance(query, docs) {
	if (!Array.isArray(docs) || docs.length === 0) {
		return 0;
	}

	const queryTokens = tokenize(query);
	const total = docs.reduce((sum, doc) => sum + computeRelevanceScore(queryTokens, doc), 0);

	return Number((total / docs.length).toFixed(2));
}

function normalizeType(typeValue) {
	if (typeof typeValue !== "string") {
		return "";
	}

	return typeValue.trim().toLowerCase();
}

function inferQueryTypes(queryTokens, docs = []) {
	const inferredTypes = new Set();
	const knownTypes = new Set();

	for (const doc of docs) {
		const normalizedDocType = normalizeType(doc && doc.type);

		if (normalizedDocType) {
			knownTypes.add(normalizedDocType);
		}
	}

	for (const token of queryTokens) {
		const mappedType = KEYWORD_TO_TYPE[token];

		if (mappedType) {
			inferredTypes.add(mappedType);
		}

		if (knownTypes.has(token)) {
			inferredTypes.add(token);
		}
	}

	return [...inferredTypes];
}

function isCriticalQuery(queryTokens) {
	if (!Array.isArray(queryTokens) || queryTokens.length === 0) {
		return false;
	}

	const tokenSet = new Set(queryTokens);

	if (tokenSet.has("emergency") || tokenSet.has("urgent")) {
		return true;
	}

	let criticalSignalCount = 0;

	for (const token of tokenSet) {
		if (CRITICAL_QUERY_TOKENS.has(token)) {
			criticalSignalCount += 1;
		}
	}

	if (tokenSet.has("severe") || tokenSet.has("acute")) {
		return criticalSignalCount >= 1;
	}

	return criticalSignalCount >= 2;
}

function calculateDocAgeDays(doc, nowEpoch) {
	const docEpoch = toEpoch(doc && doc.date);

	if (docEpoch === 0) {
		return null;
	}

	return Math.floor((nowEpoch - docEpoch) / ONE_DAY_MS);
}

function evaluateFilterLeakage(docs, policy, nowEpoch) {
	const allowedTypeSet = new Set(policy.allowedTypes.map(normalizeType));
	let unrelatedTypeCount = 0;
	let staleRecordCount = 0;

	for (const doc of docs) {
		const normalizedDocType = normalizeType(doc && doc.type);
		const shouldCheckType = policy.applyTypeFilter && allowedTypeSet.size > 0;

		if (shouldCheckType && normalizedDocType && !allowedTypeSet.has(normalizedDocType)) {
			unrelatedTypeCount += 1;
		}

		if (Number.isFinite(policy.maxAgeDays) && policy.maxAgeDays > 0) {
			const docAgeDays = calculateDocAgeDays(doc, nowEpoch);

			if (docAgeDays !== null && docAgeDays > policy.maxAgeDays) {
				staleRecordCount += 1;
			}
		}
	}

	return {
		unrelatedTypeCount,
		staleRecordCount
	};
}

function buildNoiseFilterPolicy(query, docs) {
	const queryTokens = tokenize(query);
	const inferredTypes = inferQueryTypes(queryTokens, docs);
	const criticalQuery = isCriticalQuery(queryTokens);
	const maxAgeDays = DOC_RECENCY_FILTER_ENABLED
		? Math.min(criticalQuery ? DOC_CRITICAL_RECENCY_DAYS : DOC_NON_CRITICAL_RECENCY_DAYS, MAX_DOC_AGE_DAYS)
		: null;
	const applyTypeFilter = DOC_TYPE_FILTER_ENABLED && inferredTypes.length > 0;
	const strictTypeCheck = applyTypeFilter && criticalQuery && DOC_STRICT_TYPE_FILTER_ON_CRITICAL;

	return {
		queryTokens,
		inferredTypes,
		allowedTypes: inferredTypes,
		criticalQuery,
		maxAgeDays,
		applyTypeFilter,
		strictTypeCheck
	};
}

function applyNoiseReductionFilters(query, docs, options = {}) {
	const safeDocs = Array.isArray(docs) ? docs : [];
	const dedupedDocs = dedupeDocs(safeDocs);
	const policy = options.policy || buildNoiseFilterPolicy(query, dedupedDocs);
	const allowUnfilteredFallback = options.allowUnfilteredFallback !== false;
	const nowEpoch = Date.now();

	let workingDocs = dedupedDocs;
	let recencyFilteredOutCount = 0;
	let typeFilteredOutCount = 0;

	if (Number.isFinite(policy.maxAgeDays) && policy.maxAgeDays > 0) {
		const beforeRecencyCount = workingDocs.length;

		workingDocs = workingDocs.filter((doc) => {
			const docAgeDays = calculateDocAgeDays(doc, nowEpoch);

			if (docAgeDays === null) {
				return true;
			}

			return docAgeDays <= policy.maxAgeDays;
		});

		recencyFilteredOutCount = Math.max(0, beforeRecencyCount - workingDocs.length);
	}

	if (policy.applyTypeFilter && policy.allowedTypes.length > 0) {
		const allowedTypeSet = new Set(policy.allowedTypes.map(normalizeType));
		const beforeTypeCount = workingDocs.length;

		workingDocs = workingDocs.filter((doc) => {
			const normalizedDocType = normalizeType(doc && doc.type);

			if (!normalizedDocType) {
				return false;
			}

			return allowedTypeSet.has(normalizedDocType);
		});

		typeFilteredOutCount = Math.max(0, beforeTypeCount - workingDocs.length);
	}

	let fallbackToUnfiltered = false;

	if (
		workingDocs.length === 0 &&
		dedupedDocs.length > 0 &&
		allowUnfilteredFallback &&
		!policy.strictTypeCheck
	) {
		workingDocs = dedupedDocs;
		fallbackToUnfiltered = true;
	}

	const leakage = evaluateFilterLeakage(workingDocs, policy, nowEpoch);

	return {
		docs: workingDocs,
		policy,
		meta: {
			checks_applied: {
				recency: Number.isFinite(policy.maxAgeDays) && policy.maxAgeDays > 0,
				type: policy.applyTypeFilter && policy.allowedTypes.length > 0
			},
			critical_query: policy.criticalQuery,
			inferred_types: policy.inferredTypes,
			allowed_types: policy.allowedTypes,
			strict_type_check: policy.strictTypeCheck,
			max_age_days: policy.maxAgeDays,
			recency_filtered_out_count: recencyFilteredOutCount,
			type_filtered_out_count: typeFilteredOutCount,
			total_filtered_out_count: recencyFilteredOutCount + typeFilteredOutCount,
			fallback_to_unfiltered: fallbackToUnfiltered,
			unrelated_type_leakage_count: leakage.unrelatedTypeCount,
			stale_record_leakage_count: leakage.staleRecordCount
		}
	};
}

function validateRetrievePayload(payload) {
	const { query, limit } = payload || {};

	if (typeof query !== "string") {
		throw new HttpError(400, "query is required and must be a string");
	}

	const normalizedQuery = query.trim();

	if (!normalizedQuery) {
		throw new HttpError(400, "query cannot be empty");
	}

	if (normalizedQuery.length > QUERY_MAX_LENGTH) {
		throw new HttpError(400, `query exceeds max length of ${QUERY_MAX_LENGTH}`);
	}

	return {
		query: normalizedQuery,
		limit: parseLimit(limit)
	};
}

function validateVoiceTriagePayload(payload) {
	const candidateTranscript = typeof payload?.transcript === "string"
		? payload.transcript
		: payload?.query;

	if (typeof candidateTranscript !== "string") {
		throw new HttpError(400, "transcript is required and must be a string");
	}

	const normalizedTranscript = candidateTranscript.trim();

	if (!normalizedTranscript) {
		throw new HttpError(400, "transcript cannot be empty");
	}

	if (normalizedTranscript.length > QUERY_MAX_LENGTH) {
		throw new HttpError(400, `transcript exceeds max length of ${QUERY_MAX_LENGTH}`);
	}

	return {
		transcript: normalizedTranscript,
		limit: parseLimit(payload?.limit)
	};
}

function validatePatientId(patientIdValue) {
	if (typeof patientIdValue !== "string") {
		throw new HttpError(400, "patientId is required and must be a string");
	}

	const normalizedPatientId = patientIdValue.trim().toUpperCase();

	if (!normalizedPatientId) {
		throw new HttpError(400, "patientId cannot be empty");
	}

	if (!/^[A-Z0-9_-]{2,64}$/.test(normalizedPatientId)) {
		throw new HttpError(400, "patientId format is invalid");
	}

	return normalizedPatientId;
}

function validatePatientInsightsPayload(payload) {
	const rawPatientId = typeof payload?.patientId === "string"
		? payload.patientId
		: payload?.patient_id;
	const rawDatasetRecords = extractPatientInsightRawRecords(payload);

	if (rawDatasetRecords.length > PATIENT_INSIGHTS_MAX_RECORDS) {
		throw new HttpError(
			400,
			`dataset exceeds max record count of ${PATIENT_INSIGHTS_MAX_RECORDS}`
		);
	}

	return {
		patientId: validatePatientId(rawPatientId),
		limit: parseLimit(payload?.limit),
		datasetRecords: rawDatasetRecords.map((record, index) => {
			return normalizePatientInsightRecord(record, index);
		})
	};
}

function extractPatientInsightRawRecords(payload) {
	if (Array.isArray(payload?.dataset)) {
		return payload.dataset;
	}

	if (Array.isArray(payload?.records)) {
		return payload.records;
	}

	if (Array.isArray(payload?.items)) {
		return payload.items;
	}

	if (Array.isArray(payload?.dataset?.items)) {
		return payload.dataset.items;
	}

	if (Array.isArray(payload?.records?.items)) {
		return payload.records.items;
	}

	return [];
}

function normalizeInsightSeverity(severityValue) {
	if (typeof severityValue !== "string") {
		return null;
	}

	const normalized = severityValue.trim().toUpperCase();

	if (["HIGH", "MEDIUM", "LOW"].includes(normalized)) {
		return normalized;
	}

	if (normalized === "CRITICAL") {
		return "HIGH";
	}

	if (normalized === "MODERATE") {
		return "MEDIUM";
	}

	return null;
}

function insightSeverityRank(severityValue) {
	const normalized = normalizeInsightSeverity(severityValue);

	if (normalized === "HIGH") {
		return 3;
	}

	if (normalized === "MEDIUM") {
		return 2;
	}

	if (normalized === "LOW") {
		return 1;
	}

	return 0;
}

function normalizePatientHistoryRecord(rawHistoryRecord) {
	if (!rawHistoryRecord || typeof rawHistoryRecord !== "object") {
		return null;
	}

	const condition = normalizeOptionalString(
		rawHistoryRecord.condition
			|| rawHistoryRecord.diagnosis
			|| rawHistoryRecord.text
			|| rawHistoryRecord.title
	);
	const type = normalizeOptionalString(rawHistoryRecord.type);
	const severity = normalizeInsightSeverity(rawHistoryRecord.severity);
	const date = rawHistoryRecord.date !== null && rawHistoryRecord.date !== undefined
		? normalizeOptionalString(String(rawHistoryRecord.date))
		: null;

	if (!(condition || type || severity || date)) {
		return null;
	}

	return {
		condition,
		type,
		severity,
		date
	};
}

function pickDominantType(historyRecords) {
	const typeCounts = new Map();

	historyRecords.forEach((historyRecord) => {
		if (!historyRecord.type) {
			return;
		}

		const normalizedType = historyRecord.type.toLowerCase();
		typeCounts.set(normalizedType, (typeCounts.get(normalizedType) || 0) + 1);
	});

	if (typeCounts.size === 0) {
		return null;
	}

	const [dominantType] = [...typeCounts.entries()].sort((left, right) => {
		if (right[1] !== left[1]) {
			return right[1] - left[1];
		}

		return left[0].localeCompare(right[0]);
	})[0];

	return dominantType;
}

function pickLatestHistoryDate(historyRecords) {
	const datedRecords = historyRecords.filter((historyRecord) => {
		return historyRecord.date && toEpoch(historyRecord.date) > 0;
	});

	if (datedRecords.length === 0) {
		return null;
	}

	const sortedByDate = [...datedRecords].sort((left, right) => {
		return toEpoch(right.date) - toEpoch(left.date);
	});

	return sortedByDate[0].date;
}

function pickDerivedSeverity(historyRecords) {
	const rankedHistory = [...historyRecords].sort((left, right) => {
		return insightSeverityRank(right.severity) - insightSeverityRank(left.severity);
	});

	return rankedHistory[0]?.severity || null;
}

function buildHistorySummaryText(historyRecords) {
	if (!Array.isArray(historyRecords) || historyRecords.length === 0) {
		return "";
	}

	return historyRecords
		.slice(0, 8)
		.map((historyRecord) => {
			const condition = historyRecord.condition || "unspecified finding";
			const parts = [historyRecord.type, historyRecord.severity, historyRecord.date]
				.filter((value) => typeof value === "string" && value.trim());

			if (parts.length === 0) {
				return condition;
			}

			return `${condition} (${parts.join(", ")})`;
		})
		.join("; ");
}

function deriveDiagnosisFromHistory(historyRecords) {
	if (!Array.isArray(historyRecords) || historyRecords.length === 0) {
		return null;
	}

	const sortedHistory = [...historyRecords].sort((left, right) => {
		const severityDelta = insightSeverityRank(right.severity) - insightSeverityRank(left.severity);

		if (severityDelta !== 0) {
			return severityDelta;
		}

		return toEpoch(right.date) - toEpoch(left.date);
	});

	const topCondition = sortedHistory[0]?.condition;

	if (!topCondition) {
		return null;
	}

	return `History suggests ${topCondition}`;
}

function normalizePatientInsightRecord(rawRecord, index) {
	if (!rawRecord || typeof rawRecord !== "object") {
		throw new HttpError(400, `dataset[${index}] must be an object`);
	}

	const rawIdValue = rawRecord.id ?? rawRecord.patientId ?? rawRecord.patient_id;

	if (rawIdValue === null || rawIdValue === undefined) {
		throw new HttpError(400, `dataset[${index}].id is required`);
	}

	const normalizedId = validatePatientId(String(rawIdValue));
	const keywords = Array.isArray(rawRecord.keywords)
		? rawRecord.keywords
			.map((keyword) => String(keyword || "").trim())
			.filter(Boolean)
		: [];
	const historyRecords = Array.isArray(rawRecord.records)
		? rawRecord.records.map((rawHistoryRecord) => {
			return normalizePatientHistoryRecord(rawHistoryRecord);
		}).filter(Boolean)
		: [];

	const textCandidates = [
		rawRecord.text,
		rawRecord.content,
		rawRecord.notes,
		rawRecord.history,
		rawRecord.patient_history
	];
	let normalizedText = "";

	for (const candidateText of textCandidates) {
		if (typeof candidateText === "string" && candidateText.trim()) {
			normalizedText = candidateText.trim();
			break;
		}
	}

	const derivedType = pickDominantType(historyRecords);
	const derivedDate = pickLatestHistoryDate(historyRecords);
	const derivedSeverity = pickDerivedSeverity(historyRecords);
	const derivedDiagnosis = deriveDiagnosisFromHistory(historyRecords);
	const historySummary = buildHistorySummaryText(historyRecords);
	const historyKeywords = historyRecords.flatMap((historyRecord) => {
		const conditionTokens = tokenize(historyRecord.condition || "");
		const typeTokens = tokenize(historyRecord.type || "");

		return [...conditionTokens, ...typeTokens];
	});
	const mergedKeywords = [...new Set([...keywords.map((keyword) => keyword.toLowerCase()), ...historyKeywords])]
		.slice(0, 128);

	return {
		id: normalizedId,
		type: normalizeOptionalString(rawRecord.type) || derivedType || "general",
		title: normalizeOptionalString(rawRecord.title) || "",
		text: normalizedText || historySummary,
		keywords: mergedKeywords,
		date: normalizeOptionalString(rawRecord.date) || derivedDate,
		diagnosis: normalizeOptionalString(rawRecord.diagnosis) || derivedDiagnosis,
		action: normalizeOptionalString(rawRecord.action)
			|| (historyRecords.length > 0
				? "Review longitudinal history and correlate with current symptoms before final triage decision."
				: null),
		severity: normalizeInsightSeverity(rawRecord.severity) || derivedSeverity,
		history_records: historyRecords
	};
}

function buildPatientSearchQuery(doc) {
	if (!doc || typeof doc !== "object") {
		return "";
	}

	const keywords = Array.isArray(doc.keywords) ? doc.keywords : [];
	const historyTerms = Array.isArray(doc.history_records)
		? doc.history_records.flatMap((historyRecord) => {
			return [historyRecord?.condition, historyRecord?.type].filter((value) => {
				return typeof value === "string" && value.trim();
			});
		})
		: [];

	return [doc.title, doc.text, ...keywords, doc.type, ...historyTerms]
		.filter((part) => typeof part === "string" && part.trim())
		.join(" ");
}

function toRelatedDiagnosisDoc(doc, score = null) {
	return {
		id: doc.id || null,
		type: doc.type || "unknown",
		title: doc.title || "",
		date: doc.date || null,
		diagnosis: doc.diagnosis || null,
		action: doc.action || null,
		severity: doc.severity || null,
		hybrid_score: Number.isFinite(score) ? Number(score.toFixed(4)) : null
	};
}

function buildRelatedDiagnosisList(patientDoc, limit, sourceRecords = null) {
	const safeLimit = Math.max(1, limit);
	const hasCustomSource = Array.isArray(sourceRecords) && sourceRecords.length > 0;

	if (hasCustomSource) {
		const searchQuery = buildPatientSearchQuery(patientDoc);
		const candidateDocs = sourceRecords.filter((doc) => {
			return doc && doc.id !== patientDoc.id && doc.diagnosis;
		});
		const rankedDocs = rankDocsByRelevance(searchQuery, candidateDocs);
		const queryTokens = tokenize(searchQuery);

		return rankedDocs.slice(0, safeLimit).map((doc) => {
			return toRelatedDiagnosisDoc(doc, computeRelevanceScore(queryTokens, doc));
		});
	}

	const candidatePoolSize = Math.min(MAX_LIMIT, Math.max(safeLimit * 4, 16));
	const searchQuery = buildPatientSearchQuery(patientDoc);
	const relatedById = new Map();

	const tryAddDoc = (doc, score = null) => {
		if (!doc || doc.id === patientDoc.id || !doc.diagnosis) {
			return;
		}

		if (!relatedById.has(doc.id)) {
			relatedById.set(doc.id, toRelatedDiagnosisDoc(doc, score));
		}
	};

	if (searchQuery) {
		const typedSearchOptions = {
			limit: candidatePoolSize,
			candidatePool: Math.max(candidatePoolSize * 8, 200)
		};

		if (typeof patientDoc.type === "string" && patientDoc.type.trim()) {
			typedSearchOptions.filters = { type: patientDoc.type };
		}

		const typedHits = hybridIndex.search(searchQuery, typedSearchOptions);
		typedHits.forEach((hit) => {
			tryAddDoc(hit.doc, hit.score);
		});

		if (relatedById.size < safeLimit) {
			const globalHits = hybridIndex.search(searchQuery, {
				limit: candidatePoolSize,
				candidatePool: Math.max(candidatePoolSize * 8, 200)
			});

			globalHits.forEach((hit) => {
				tryAddDoc(hit.doc, hit.score);
			});
		}
	}

	if (relatedById.size < safeLimit) {
		const fallbackDocs = dataset
			.filter((doc) => doc && doc.id !== patientDoc.id && doc.diagnosis)
			.sort((left, right) => toEpoch(right.date) - toEpoch(left.date));

		fallbackDocs.forEach((doc) => {
			tryAddDoc(doc);
		});
	}

	return [...relatedById.values()].slice(0, safeLimit);
}

function normalizeOptionalString(value) {
	if (typeof value !== "string") {
		return null;
	}

	const trimmed = value.trim();
	return trimmed ? trimmed : null;
}

function normalizeIngestionItem(rawItem, index) {
	if (!rawItem || typeof rawItem !== "object") {
		throw new HttpError(400, `items[${index}] must be an object`);
	}

	const normalizedText = normalizeOptionalString(rawItem.text);
	const normalizedSourcePath =
		normalizeOptionalString(rawItem.sourcePath) || normalizeOptionalString(rawItem.source_path);

	if (!normalizedText && !normalizedSourcePath) {
		throw new HttpError(400, `items[${index}] requires either text or sourcePath`);
	}

	if (normalizedText && normalizedText.length > INGEST_MAX_TEXT_CHARS) {
		throw new HttpError(400, `items[${index}].text exceeds max length of ${INGEST_MAX_TEXT_CHARS}`);
	}

	return {
		id: normalizeOptionalString(rawItem.id),
		type: normalizeOptionalString(rawItem.type) || "protocol",
		date: normalizeOptionalString(rawItem.date),
		source: normalizeOptionalString(rawItem.source),
		section: normalizeOptionalString(rawItem.section),
		title: normalizeOptionalString(rawItem.title),
		text: normalizedText,
		sourcePath: normalizedSourcePath
	};
}

function validateIngestionPayload(payload) {
	if (!payload || typeof payload !== "object") {
		throw new HttpError(400, "Request body must be a JSON object");
	}

	const rawItems = Array.isArray(payload.items) ? payload.items : [payload];

	if (rawItems.length === 0) {
		throw new HttpError(400, "items must include at least one ingestion entry");
	}

	if (rawItems.length > INGEST_MAX_ITEMS_PER_REQUEST) {
		throw new HttpError(400, `items exceeds max batch size of ${INGEST_MAX_ITEMS_PER_REQUEST}`);
	}

	const items = rawItems.map((item, index) => normalizeIngestionItem(item, index));
	const chunking = payload.chunking && typeof payload.chunking === "object" ? payload.chunking : {};
	const chunkSizeWords = parsePositiveInteger(
		chunking.chunkSizeWords || chunking.chunk_size_words || payload.chunkSizeWords || payload.chunk_size_words,
		INGEST_DEFAULT_CHUNK_SIZE_WORDS
	);
	const chunkOverlapWords = parsePositiveInteger(
		chunking.chunkOverlapWords || chunking.chunk_overlap_words || payload.chunkOverlapWords || payload.chunk_overlap_words,
		INGEST_DEFAULT_CHUNK_OVERLAP_WORDS
	);

	if (chunkOverlapWords >= chunkSizeWords) {
		throw new HttpError(400, "chunk overlap must be smaller than chunk size");
	}

	return {
		items,
		chunkSizeWords,
		chunkOverlapWords,
		persist: payload.persist !== false
	};
}

function validateChunkSearchPayload(payload) {
	const { query, limit } = validateRetrievePayload(payload);
	const filters = payload && typeof payload.filters === "object" ? payload.filters : {};

	return {
		query,
		limit,
		filters: {
			type: normalizeOptionalString(filters.type || payload?.type),
			source: normalizeOptionalString(filters.source || payload?.source),
			section: normalizeOptionalString(filters.section || payload?.section),
			startDate: normalizeOptionalString(filters.startDate || filters.start_date || payload?.startDate || payload?.start_date),
			endDate: normalizeOptionalString(filters.endDate || filters.end_date || payload?.endDate || payload?.end_date)
		}
	};
}

function retrieveDocumentsFallback(query) {
	const queryTokens = tokenize(query);
	const tokenSet = new Set(queryTokens);

	const scoreDocs = (docs) => {
		return docs
			.map((doc) => {
				const keywords = Array.isArray(doc.keywords) ? doc.keywords : [];
				const keywordScore = keywords.reduce((score, keyword) => {
					const normalizedKeyword = String(keyword).toLowerCase();
					return tokenSet.has(normalizedKeyword) ? score + 2 : score;
				}, 0);

				const typeBonus = typeof doc.type === "string" && tokenSet.has(doc.type.toLowerCase()) ? 1 : 0;
				const totalScore = keywordScore + typeBonus;

				return { doc, totalScore };
			})
			.filter((item) => item.totalScore > 0)
			.sort((a, b) => {
				if (b.totalScore !== a.totalScore) {
					return b.totalScore - a.totalScore;
				}

				return toEpoch(b.doc.date) - toEpoch(a.doc.date);
			})
			.map((item) => item.doc);
	};

	const inferredTypes = [...new Set(queryTokens.map((token) => KEYWORD_TO_TYPE[token]).filter(Boolean))];

	if (inferredTypes.length === 1) {
		const inferredType = inferredTypes[0];
		const typedDocs = dataset.filter((doc) => doc.type === inferredType);
		const typedScored = scoreDocs(typedDocs);

		if (typedScored.length > 0) {
			return typedScored;
		}

		return typedDocs.slice(0, 5);
	}

	const scored = scoreDocs(dataset);

	if (scored.length > 0) {
		return scored;
	}

	return dataset.slice(0, SAFE_DEFAULT_LIMIT);
}

function retrieveDocuments(query, limit = MAX_LIMIT) {
	const normalizedLimit = Math.min(Math.max(limit, 1), MAX_LIMIT);
	const candidatePool = Math.max(normalizedLimit * 8, 200);
	const hybridHits = hybridIndex.search(query, {
		limit: normalizedLimit,
		candidatePool
	});
	const hybridDocs = hybridHits.map((hit) => hit.doc);
	const fallbackSeed = retrieveDocumentsFallback(query).slice(
		0,
		Math.max(3, Math.ceil(normalizedLimit * 0.25))
	);
	const merged = dedupeDocs([...hybridDocs, ...fallbackSeed]);

	if (merged.length > 0) {
		return merged.slice(0, normalizedLimit);
	}

	return retrieveDocumentsFallback(query).slice(0, normalizedLimit);
}

function isNoisyQuery(query, candidateCount) {
	const queryTokens = tokenize(query);
	const uniqueTokenCount = new Set(queryTokens).size;
	const inferredTypes = new Set(queryTokens.map((token) => KEYWORD_TO_TYPE[token]).filter(Boolean));

	if (candidateCount >= 8) {
		return true;
	}

	if (inferredTypes.size > 1) {
		return true;
	}

	return uniqueTokenCount >= 5;
}

function computePruneTargetCount(query, returnedRetrievedCount, candidateCount) {
	if (candidateCount <= 0 || returnedRetrievedCount <= 0) {
		return 0;
	}

	const maxComparableCount = Math.min(returnedRetrievedCount, candidateCount);

	if (!isNoisyQuery(query, candidateCount)) {
		return maxComparableCount;
	}

	if (maxComparableCount <= 2) {
		return maxComparableCount;
	}

	const ratioTarget = Math.max(2, Math.ceil(maxComparableCount * 0.6));

	return Math.max(1, Math.min(ratioTarget, maxComparableCount - 1));
}

function intelligentContextPrune(query, retrievedDocs, targetCount) {
	if (!Array.isArray(retrievedDocs) || retrievedDocs.length === 0 || targetCount <= 0) {
		return [];
	}

	const now = Date.now();
	const maxAgeMs = MAX_DOC_AGE_DAYS * ONE_DAY_MS;

	const recentDocs = retrievedDocs.filter((doc) => {
		if (!doc.date) {
			return true;
		}

		const docEpoch = toEpoch(doc.date);
		if (docEpoch === 0) {
			return true;
		}

		return now - docEpoch <= maxAgeMs;
	});

	const candidatePool = recentDocs.length > 0 ? recentDocs : retrievedDocs;
	const ranked = rankDocsByRelevance(query, candidatePool);
	const maxContextDocs = Math.min(targetCount, LOCAL_PRUNE_TOP_K, ranked.length);

	return ranked.slice(0, maxContextDocs);
}

function buildScaledownContext(documents) {
	return documents
		.map((doc) => {
			const id = doc.id || "unknown";
			const type = doc.type || "unknown";
			const date = doc.date || "unknown";
			const title = doc.title || "";
			const text = doc.text || "";

			return `[DOC:${id}] type=${type}; date=${date}; title=${title}; text=${text}`;
		})
		.join("\n");
}

function extractDocIdsFromCompressedText(compressedText) {
	if (typeof compressedText !== "string" || !compressedText.trim()) {
		return [];
	}

	const markerRegex = /\[DOC:([A-Za-z0-9_-]+)\]/g;
	const ids = [];
	let match = markerRegex.exec(compressedText);

	while (match) {
		ids.push(match[1]);
		match = markerRegex.exec(compressedText);
	}

	return [...new Set(ids)];
}

async function pruneWithScaledown(query, candidateDocs, targetCount) {
	const normalizedTargetCount = Math.max(1, Math.min(targetCount, candidateDocs.length || 0));
	const fallbackDocs = intelligentContextPrune(query, candidateDocs, normalizedTargetCount);
	const fallback = {
		prunedDocs: fallbackDocs,
		pruneMeta: {
			usedScaledown: false,
			attemptedScaledown: false,
			usedLocalFallback: true,
			localFallbackCount: fallbackDocs.length,
			reason: "scaledown_not_configured"
		}
	};

	const scaledownUrl = process.env.SCALEDOWN_API_URL;
	const scaledownApiKey = process.env.SCALEDOWN_API_KEY;

	if (!scaledownUrl) {
		return fallback;
	}

	if (candidateDocs.length === 0) {
		return {
			prunedDocs: fallbackDocs,
			pruneMeta: {
				usedScaledown: false,
				attemptedScaledown: false,
				usedLocalFallback: true,
				localFallbackCount: fallbackDocs.length,
				reason: "local_prune_no_candidates"
			}
		};
	}

	if (!SCALEDOWN_FORCE_REMOTE && candidateDocs.length < SCALEDOWN_MIN_CANDIDATES) {
		return {
			prunedDocs: fallbackDocs,
			pruneMeta: {
				usedScaledown: false,
				attemptedScaledown: false,
				usedLocalFallback: true,
				localFallbackCount: fallbackDocs.length,
				reason: "local_prune_sufficient_context"
			}
		};
	}

	const documentsPayload = candidateDocs.map((doc) => ({
		id: doc.id,
		type: doc.type,
		date: doc.date,
		title: doc.title,
		text: doc.text
	}));

	const requestBody = {
		prompt: query,
		context: buildScaledownContext(candidateDocs),
		query,
		target_count: normalizedTargetCount,
		max_docs: normalizedTargetCount,
		documents: documentsPayload
	};

	const authVariants = scaledownApiKey
		? [
			{ mode: "bearer+x-api-key", headers: { Authorization: `Bearer ${scaledownApiKey}`, "x-api-key": scaledownApiKey } },
			{ mode: "x-api-key", headers: { "x-api-key": scaledownApiKey } },
			{ mode: "bearer", headers: { Authorization: `Bearer ${scaledownApiKey}` } }
		]
		: [{ mode: "none", headers: {} }];

	let lastError = null;
	const scaledownAttemptStartedAt = performance.now();

	for (const variant of authVariants) {
		const elapsedMs = performance.now() - scaledownAttemptStartedAt;
		const remainingTimeoutMs = Math.floor(SCALEDOWN_EFFECTIVE_TIMEOUT_MS - elapsedMs);

		if (remainingTimeoutMs <= 20) {
			break;
		}

		try {
			const response = await axios.post(scaledownUrl, requestBody, {
				headers: {
					"Content-Type": "application/json",
					...variant.headers
				},
				timeout: remainingTimeoutMs
			});

			const payload = response.data && typeof response.data === "object" ? response.data : {};

			const byIds = Array.isArray(payload.pruned_ids)
				? payload.pruned_ids
				: Array.isArray(payload.ids)
					? payload.ids
					: null;
			const directDocs = Array.isArray(payload.pruned_docs)
				? payload.pruned_docs
				: Array.isArray(payload.documents)
					? payload.documents
					: Array.isArray(payload.data)
						? payload.data
					: null;

			if (byIds && byIds.length > 0) {
				const candidateById = new Map(candidateDocs.map((doc) => [doc.id, doc]));
				const selected = byIds.map((id) => candidateById.get(id)).filter(Boolean);
				const rankedSelection = rankDocsByRelevance(query, selected);
				const narrowed = rankedSelection.slice(0, normalizedTargetCount);

				if (narrowed.length === 0) {
					continue;
				}

				return {
					prunedDocs: narrowed,
					pruneMeta: {
						usedScaledown: true,
						attemptedScaledown: true,
						usedLocalFallback: false,
						localFallbackCount: fallbackDocs.length,
						reason: `scaledown_pruned_ids_${variant.mode}`
					}
				};
			}

			if (directDocs && directDocs.length > 0) {
				const hydratedDocs = directDocs
					.map((doc) => {
						if (doc && doc.id && CASE_BY_ID.has(doc.id)) {
							return CASE_BY_ID.get(doc.id);
						}

						return doc;
					})
					.filter(Boolean);
				const rankedSelection = rankDocsByRelevance(query, hydratedDocs);
				const narrowed = rankedSelection.slice(0, normalizedTargetCount);

				if (narrowed.length === 0) {
					continue;
				}

				return {
					prunedDocs: narrowed,
					pruneMeta: {
						usedScaledown: true,
						attemptedScaledown: true,
						usedLocalFallback: false,
						localFallbackCount: fallbackDocs.length,
						reason: `scaledown_pruned_docs_${variant.mode}`
					}
				};
			}

			const compressedOutputCandidates = [
				payload?.results?.compressed_prompt,
				payload?.compressed_prompt,
				payload?.results?.compressed_context,
				payload?.compressed_context,
				payload?.output
			].filter((value) => typeof value === "string" && value.trim().length > 0);

			for (const compressedText of compressedOutputCandidates) {
				const markerIds = extractDocIdsFromCompressedText(compressedText);

				if (markerIds.length > 0) {
					const candidateById = new Map(candidateDocs.map((doc) => [doc.id, doc]));
					const selected = markerIds.map((id) => candidateById.get(id)).filter(Boolean);
					const rankedSelection = rankDocsByRelevance(query, selected);
					const narrowed = rankedSelection.slice(0, normalizedTargetCount);

					if (narrowed.length > 0) {
						return {
							prunedDocs: narrowed,
							pruneMeta: {
								usedScaledown: true,
								attemptedScaledown: true,
								usedLocalFallback: false,
								localFallbackCount: fallbackDocs.length,
								reason: `scaledown_pruned_markers_${variant.mode}`
							}
						};
					}
				}
			}

			return {
				prunedDocs: fallbackDocs,
				pruneMeta: {
					usedScaledown: false,
					attemptedScaledown: true,
					usedLocalFallback: true,
					localFallbackCount: fallbackDocs.length,
					reason: `scaledown_empty_payload_${variant.mode}_fallback_local`
				}
			};
		} catch (error) {
			lastError = error;
		}
	}

	const statusCode = lastError?.response?.status;
	const scaledownElapsedMs = performance.now() - scaledownAttemptStartedAt;
	const timeoutBudgetExceeded = scaledownElapsedMs >= SCALEDOWN_EFFECTIVE_TIMEOUT_MS;
	const fallbackReason = timeoutBudgetExceeded ? "scaledown_timeout_budget_exceeded" : "scaledown_unavailable";
	log("warn", "Scaledown pruning unavailable", {
		statusCode: statusCode || null,
		errorCode: lastError?.code || null,
		timeout_budget_ms: SCALEDOWN_EFFECTIVE_TIMEOUT_MS,
		elapsed_ms: roundLatencyMs(scaledownElapsedMs)
	});

	return {
		prunedDocs: fallbackDocs,
		pruneMeta: {
			usedScaledown: false,
			attemptedScaledown: true,
			usedLocalFallback: true,
			localFallbackCount: fallbackDocs.length,
			reason: fallbackReason
		}
	};
}

function toClientDoc(doc) {
	return {
		id: doc.id || null,
		type: doc.type || "unknown",
		date: doc.date || null,
		source: doc.source || "unknown",
		section: doc.section || "General",
		title: doc.title || "",
		text: doc.text || doc.content || "",
		diagnosis: doc.diagnosis || null,
		action: doc.action || null,
		severity: doc.severity || null,
		history_records: Array.isArray(doc.history_records) ? doc.history_records : [],
		parent_id: doc.parent_id || null,
		chunk_index: Number.isInteger(doc.chunk_index) ? doc.chunk_index : null,
		chunk_count: Number.isInteger(doc.chunk_count) ? doc.chunk_count : null,
		content_type: doc.content_type || null
	};
}

function buildDecision(query, prunedDocs) {
	const normalizedCandidates = prunedDocs
		.map((doc) => {
			if (doc && doc.id && CASE_BY_ID.has(doc.id)) {
				return CASE_BY_ID.get(doc.id);
			}

			return doc;
		})
		.filter(Boolean);

	const scoredCandidates = normalizedCandidates
		.map((doc) => {
			const totalScore = computeRelevanceScore(tokenize(query), doc);

			return { doc, totalScore };
		})
		.sort((a, b) => {
			if (b.totalScore !== a.totalScore) {
				return b.totalScore - a.totalScore;
			}

			return toEpoch(b.doc.date) - toEpoch(a.doc.date);
		});

	const bestCase = scoredCandidates.find(({ doc }) => {
		return doc && doc.diagnosis && doc.action && doc.severity;
	});

	if (bestCase) {
		return {
			diagnosis: bestCase.doc.diagnosis,
			action: bestCase.doc.action,
			severity: bestCase.doc.severity
		};
	}

	const fallbackCase = rankDocsByRelevance(query, dataset).find((doc) => {
		return doc && doc.diagnosis && doc.action && doc.severity;
	});

	if (fallbackCase) {
		return {
			diagnosis: fallbackCase.diagnosis,
			action: fallbackCase.action,
			severity: fallbackCase.severity
		};
	}

	return {
		diagnosis: "Needs clinician triage review",
		action: "No confident case match found. Perform immediate clinician assessment.",
		severity: "MEDIUM"
	};
}

function asyncHandler(handler) {
	return (req, res, next) => {
		Promise.resolve(handler(req, res, next)).catch(next);
	};
}

async function handleRetrieveRequest(req, res) {
	const startedAt = Date.now();
	const { query, limit } = validateRetrievePayload(req.body);
	const retrievedDocsRaw = retrieveDocuments(query, MAX_LIMIT);
	const retrievedFilterResult = applyNoiseReductionFilters(query, retrievedDocsRaw, {
		allowUnfilteredFallback: true
	});
	const retrievedDocs = retrievedFilterResult.docs;
	const limitedRetrievedDocs = retrievedDocs.slice(0, limit);
	const pruningCandidates = retrievedDocs.slice(0, Math.min(retrievedDocs.length, MAX_LIMIT));
	const pruneTargetCount = computePruneTargetCount(query, limitedRetrievedDocs.length, pruningCandidates.length);
	const { prunedDocs, pruneMeta } = await pruneWithScaledown(query, pruningCandidates, pruneTargetCount);
	const prunedFilterResult = applyNoiseReductionFilters(query, prunedDocs, {
		allowUnfilteredFallback: false,
		policy: retrievedFilterResult.policy
	});
	const limitedPrunedDocs = prunedFilterResult.docs.slice(0, pruneTargetCount);
	recordPruneObservation({
		endpoint: "/retrieve",
		retrievedCount: limitedRetrievedDocs.length,
		prunedCount: limitedPrunedDocs.length,
		pruneMeta
	});
	const retrievedAverageRelevance = calculateAverageRelevance(query, limitedRetrievedDocs);
	const prunedAverageRelevance = calculateAverageRelevance(query, limitedPrunedDocs);
	const latencyMs = Date.now() - startedAt;

	return res.json({
		request_id: req.requestId,
		query,
		retrieved_count: retrievedDocs.length,
		returned_retrieved_count: limitedRetrievedDocs.length,
		local_pruned_count: pruneMeta.localFallbackCount,
		prune_target_count: pruneTargetCount,
		pruned_count: limitedPrunedDocs.length,
		latency_ms: latencyMs,
		latency_target_ms: LATENCY_TARGET_MS,
		relevance_meta: {
			retrieved_average_score: retrievedAverageRelevance,
			pruned_average_score: prunedAverageRelevance,
			delta: Number((prunedAverageRelevance - retrievedAverageRelevance).toFixed(2))
		},
		prune_meta: {
			...pruneMeta,
			post_prune_guardrail_removed_count: prunedFilterResult.meta.total_filtered_out_count
		},
		retrieval_filter_meta: retrievedFilterResult.meta,
		post_prune_filter_meta: prunedFilterResult.meta,
		retrieved_docs: limitedRetrievedDocs.map(toClientDoc),
		pruned_context: limitedPrunedDocs.map(toClientDoc)
	});
}

function handlePatientInsightsRequest(req, res) {
	const startedAt = Date.now();
	const { patientId, limit, datasetRecords } = validatePatientInsightsPayload(req.body);
	const usingUploadedDataset = datasetRecords.length > 0;
	const sourceRecords = usingUploadedDataset ? datasetRecords : dataset;
	const sourceCaseMap = usingUploadedDataset
		? new Map(
			sourceRecords
				.filter((doc) => doc && doc.id)
				.map((doc) => [String(doc.id).trim().toUpperCase(), doc])
		)
		: CASE_BY_NORMALIZED_ID;
	const patientDoc = sourceCaseMap.get(patientId);

	if (!patientDoc) {
		throw new HttpError(404, `patientId '${patientId}' was not found`);
	}

	const relatedDiagnoses = buildRelatedDiagnosisList(
		patientDoc,
		limit,
		usingUploadedDataset ? sourceRecords : null
	);
	const latencyMs = Date.now() - startedAt;

	return res.json({
		request_id: req.requestId,
		patient_id: patientId,
		data_source: usingUploadedDataset ? "uploaded_dataset" : "default_dataset",
		source_record_count: sourceRecords.length,
		related_count: relatedDiagnoses.length,
		latency_ms: latencyMs,
		patient_history: toClientDoc(patientDoc),
		related_diagnoses: relatedDiagnoses
	});
}

async function handleChunkSearchRequest(req, res) {
	const startedAt = Date.now();
	const { query, limit, filters } = validateChunkSearchPayload(req.body);
	const hits = hybridIndex.search(query, {
		limit,
		candidatePool: Math.max(limit * 8, 200),
		filters
	});
	const latencyMs = Date.now() - startedAt;

	return res.json({
		request_id: req.requestId,
		query,
		limit,
		hit_count: hits.length,
		total_searchable_chunks: hybridIndex.size(),
		min_searchable_chunks: MIN_SEARCHABLE_CHUNKS,
		chunk_goal_met: hybridIndex.size() >= MIN_SEARCHABLE_CHUNKS,
		latency_ms: latencyMs,
		latency_target_ms: LATENCY_TARGET_MS,
		latency_target_met: latencyMs <= LATENCY_TARGET_MS,
		filters,
		results: hits.map((hit) => ({
			...toClientDoc(hit.doc),
			hybrid_score: hit.score,
			lexical_score: hit.lexicalScore,
			vector_score: hit.vectorScore
		}))
	});
}

function handleIndexStatsRequest(req, res) {
	const stats = hybridIndex.getStats();

	return res.json({
		request_id: req.requestId,
		...stats,
		base_dataset_chunks: baseDatasetRecords.length,
		ingested_chunks: ingestedChunkRecords.length,
		min_searchable_chunks: MIN_SEARCHABLE_CHUNKS,
		chunk_goal_met: stats.total_chunks >= MIN_SEARCHABLE_CHUNKS,
		latency_target_ms: LATENCY_TARGET_MS,
		noise_filter_config: {
			recency_filter_enabled: DOC_RECENCY_FILTER_ENABLED,
			type_filter_enabled: DOC_TYPE_FILTER_ENABLED,
			strict_type_filter_on_critical: DOC_STRICT_TYPE_FILTER_ON_CRITICAL,
			critical_recency_days: DOC_CRITICAL_RECENCY_DAYS,
			non_critical_recency_days: DOC_NON_CRITICAL_RECENCY_DAYS,
			max_doc_age_days: MAX_DOC_AGE_DAYS
		},
		triage_stage_budget_ms: TRIAGE_STAGE_BUDGET_MS,
		scaledown_effective_timeout_ms: SCALEDOWN_EFFECTIVE_TIMEOUT_MS,
		chunk_store_path: INGEST_CHUNK_STORE_PATH
	});
}

async function handleUnstructuredIngestRequest(req, res) {
	const startedAt = Date.now();
	const { items, chunkSizeWords, chunkOverlapWords, persist } = validateIngestionPayload(req.body);
	const { chunks, summaries, errors } = await ingestUnstructuredItems(items, {
		rootDirectory: __dirname,
		chunkSizeWords,
		chunkOverlapWords
	});

	if (chunks.length === 0) {
		const firstError = errors[0]?.message || "No chunkable text found in request";
		throw new HttpError(400, firstError);
	}

	ingestedChunkRecords = mergeChunkRecords(ingestedChunkRecords, chunks);

	if (persist) {
		await persistChunks(INGEST_CHUNK_STORE_PATH, ingestedChunkRecords);
	}

	const totalSearchableChunks = rebuildHybridIndex();
	const latencyMs = Date.now() - startedAt;

	if (errors.length > 0) {
		log("warn", "Ingestion completed with partial failures", {
			error_count: errors.length,
			ingested_chunks: chunks.length
		});
	}

	return res.status(errors.length > 0 ? 207 : 201).json({
		request_id: req.requestId,
		ingested_item_count: summaries.length,
		ingested_chunk_count: chunks.length,
		total_ingested_chunks: ingestedChunkRecords.length,
		total_searchable_chunks: totalSearchableChunks,
		min_searchable_chunks: MIN_SEARCHABLE_CHUNKS,
		chunk_goal_met: totalSearchableChunks >= MIN_SEARCHABLE_CHUNKS,
		latency_ms: latencyMs,
		latency_target_ms: LATENCY_TARGET_MS,
		latency_target_met: latencyMs <= LATENCY_TARGET_MS,
		persisted: persist,
		chunking: {
			chunk_size_words: chunkSizeWords,
			chunk_overlap_words: chunkOverlapWords
		},
		ingested_items: summaries,
		errors
	});
}

async function runTriagePipeline(query, limit, endpointLabel) {
	const startedAt = performance.now();

	const retrieveStartedAt = performance.now();
	const retrievedDocsRaw = retrieveDocuments(query, MAX_LIMIT);
	const retrievedFilterResult = applyNoiseReductionFilters(query, retrievedDocsRaw, {
		allowUnfilteredFallback: true
	});
	const retrievedDocs = retrievedFilterResult.docs;
	const limitedRetrievedDocs = retrievedDocs.slice(0, limit);
	const pruningCandidates = retrievedDocs.slice(0, Math.min(retrievedDocs.length, MAX_LIMIT));
	const pruneTargetCount = computePruneTargetCount(query, limitedRetrievedDocs.length, pruningCandidates.length);
	const retrieveLatencyMs = performance.now() - retrieveStartedAt;

	const pruneStartedAt = performance.now();
	const { prunedDocs, pruneMeta } = await pruneWithScaledown(query, pruningCandidates, pruneTargetCount);
	const prunedFilterResult = applyNoiseReductionFilters(query, prunedDocs, {
		allowUnfilteredFallback: false,
		policy: retrievedFilterResult.policy
	});
	const limitedPrunedDocs = prunedFilterResult.docs.slice(0, pruneTargetCount);
	const pruneLatencyMs = performance.now() - pruneStartedAt;

	const decideStartedAt = performance.now();
	const result = buildDecision(query, limitedPrunedDocs);
	const retrievedAverageRelevance = calculateAverageRelevance(query, limitedRetrievedDocs);
	const prunedAverageRelevance = calculateAverageRelevance(query, limitedPrunedDocs);
	const decideLatencyMs = performance.now() - decideStartedAt;

	const responseStartedAt = performance.now();
	const responsePayload = {
		query,
		retrieved_count: retrievedDocs.length,
		returned_retrieved_count: limitedRetrievedDocs.length,
		local_pruned_count: pruneMeta.localFallbackCount,
		prune_target_count: pruneTargetCount,
		pruned_count: limitedPrunedDocs.length,
		relevance_meta: {
			retrieved_average_score: retrievedAverageRelevance,
			pruned_average_score: prunedAverageRelevance,
			delta: Number((prunedAverageRelevance - retrievedAverageRelevance).toFixed(2))
		},
		prune_meta: {
			...pruneMeta,
			post_prune_guardrail_removed_count: prunedFilterResult.meta.total_filtered_out_count
		},
		retrieval_filter_meta: retrievedFilterResult.meta,
		post_prune_filter_meta: prunedFilterResult.meta,
		retrieved_docs: limitedRetrievedDocs.map(toClientDoc),
		pruned_context: limitedPrunedDocs.map(toClientDoc),
		result
	};
	const responseLatencyMs = performance.now() - responseStartedAt;
	const totalLatencyMs = roundLatencyMs(performance.now() - startedAt);
	const stageLatencies = {
		retrieve: roundLatencyMs(retrieveLatencyMs),
		prune: roundLatencyMs(pruneLatencyMs),
		decide: roundLatencyMs(decideLatencyMs),
		response: roundLatencyMs(responseLatencyMs)
	};

	recordPruneObservation({
		endpoint: endpointLabel,
		retrievedCount: limitedRetrievedDocs.length,
		prunedCount: limitedPrunedDocs.length,
		pruneMeta
	});

	return {
		...responsePayload,
		latency_ms: totalLatencyMs,
		latency_target_ms: LATENCY_TARGET_MS,
		latency_target_met: totalLatencyMs < LATENCY_TARGET_MS,
		stage_latencies_ms: stageLatencies,
		stage_budget_ms: TRIAGE_STAGE_BUDGET_MS,
		stage_budget_met: evaluateStageBudget(stageLatencies)
	};
}

async function handleTriageRequest(req, res) {
	const { query, limit } = validateRetrievePayload(req.body);
	const responsePayload = await runTriagePipeline(query, limit, "/triage");

	return res.json({
		request_id: req.requestId,
		...responsePayload
	});
}

async function handleVoiceTriageRequest(req, res) {
	const { transcript, limit } = validateVoiceTriagePayload(req.body);
	const responsePayload = await runTriagePipeline(transcript, limit, "/triage/voice");

	return res.json({
		request_id: req.requestId,
		...responsePayload,
		query: transcript
	});
}

function handleObservabilityDashboardRequest(req, res) {
	const dashboardSnapshot = buildObservabilityDashboardSnapshot();

	return res.json({
		request_id: req.requestId,
		...dashboardSnapshot
	});
}

function handleObservabilityAlertsRequest(req, res) {
	const alerts = getAlertsSnapshot();
	const activeAlerts = Object.values(alerts)
		.filter((alert) => alert.active)
		.map((alert) => alert.name);

	return res.json({
		request_id: req.requestId,
		generated_at: new Date().toISOString(),
		active_alerts: activeAlerts,
		alerts
	});
}

function handlePrometheusMetricsRequest(_req, res) {
	res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
	res.send(renderPrometheusMetrics());
}

function handleObservabilityDashboardHtmlRequest(_req, res) {
	res.sendFile(path.join(__dirname, "observability", "dashboard.html"));
}

app.get("/health", (req, res) => {
	res.json({
		request_id: req.requestId,
		status: "ok",
		uptime_seconds: Math.floor(process.uptime())
	});
});

app.get("/", (req, res) => {
	res.json({
		request_id: req.requestId,
		name: "Real-Time Emergency Response Triage Assistant API",
		status: "ok",
		endpoints: [
			"GET /health",
			"GET /metrics",
			"GET /index/stats",
			"GET /observability/dashboard",
			"GET /observability/alerts",
			"GET /observability/dashboard.html",
			"POST /patients/insights",
			"POST /retrieve",
			"POST /search/chunks",
			"POST /ingest/unstructured",
			"POST /triage",
			"POST /triage/voice"
		]
	});
});

app.get("/.well-known/appspecific/com.chrome.devtools.json", (_req, res) => {
	res.json({});
});

app.get("/metrics", handlePrometheusMetricsRequest);
app.get("/index/stats", handleIndexStatsRequest);
app.get("/observability/dashboard", handleObservabilityDashboardRequest);
app.get("/observability/alerts", handleObservabilityAlertsRequest);
app.get("/observability/dashboard.html", handleObservabilityDashboardHtmlRequest);
app.post("/patients/insights", asyncHandler(handlePatientInsightsRequest));
app.post("/retrieve", asyncHandler(handleRetrieveRequest));
app.post("/search/chunks", asyncHandler(handleChunkSearchRequest));
app.post("/ingest/unstructured", asyncHandler(handleUnstructuredIngestRequest));
app.post("/triage", asyncHandler(handleTriageRequest));
app.post("/triage/voice", asyncHandler(handleVoiceTriageRequest));

app.use((req, res) => {
	res.status(404).json({
		request_id: req.requestId,
		error: "Route not found"
	});
});

app.use((error, req, res, _next) => {
	const bodyTooLarge = error?.type === "entity.too.large" || error?.status === 413;
	const statusCode = bodyTooLarge
		? 413
		: Number.isInteger(error.statusCode)
			? error.statusCode
			: 500;
	const clientMessage = bodyTooLarge
		? `Payload too large. Increase API_JSON_LIMIT (current: ${API_JSON_LIMIT}) or upload a smaller dataset.`
		: error.message;

	if (statusCode >= 500) {
		log("error", "Unhandled server error", {
			message: error.message,
			http: {
				method: req.method,
				path: req.originalUrl || req.path || "unknown"
			}
		});
	}

	res.status(statusCode).json({
		request_id: req.requestId,
		error: statusCode === 500 ? "Internal server error" : clientMessage
	});
});

let server = null;

async function startServer() {
	await initializeHybridIndex();

	server = app.listen(PORT, () => {
		log("info", "Triage backend running", {
			port: PORT,
			node_env: process.env.NODE_ENV || "development",
			total_searchable_chunks: hybridIndex.size(),
			chunk_goal_met: hybridIndex.size() >= MIN_SEARCHABLE_CHUNKS,
			doc_recency_filter_enabled: DOC_RECENCY_FILTER_ENABLED,
			doc_type_filter_enabled: DOC_TYPE_FILTER_ENABLED,
			doc_strict_type_filter_on_critical: DOC_STRICT_TYPE_FILTER_ON_CRITICAL,
			doc_critical_recency_days: DOC_CRITICAL_RECENCY_DAYS,
			doc_non_critical_recency_days: DOC_NON_CRITICAL_RECENCY_DAYS,
			triage_stage_budget_ms: TRIAGE_STAGE_BUDGET_MS,
			scaledown_effective_timeout_ms: SCALEDOWN_EFFECTIVE_TIMEOUT_MS,
			scaledown_min_candidates: SCALEDOWN_MIN_CANDIDATES,
			scaledown_force_remote: SCALEDOWN_FORCE_REMOTE,
			obs_latency_window_size: OBS_LATENCY_WINDOW_SIZE,
			obs_error_rate_window_size: OBS_ERROR_RATE_WINDOW_SIZE,
			obs_prune_ratio_window_size: OBS_PRUNE_RATIO_WINDOW_SIZE,
			obs_external_prune_window_size: OBS_EXTERNAL_PRUNE_WINDOW_SIZE,
			alert_p95_threshold_ms: ALERT_P95_THRESHOLD_MS,
			alert_p95_min_samples: ALERT_P95_MIN_SAMPLES,
			alert_prune_outage_min_attempts: ALERT_PRUNE_OUTAGE_MIN_ATTEMPTS,
			alert_prune_outage_availability_threshold: ALERT_PRUNE_OUTAGE_AVAILABILITY_THRESHOLD
		});
	});
}

function shutdown(signal) {
	log("info", "Shutdown signal received", { signal });

	if (!server) {
		process.exit(0);
		return;
	}

	server.close((error) => {
		if (error) {
			log("error", "Error while shutting down server", {
				message: error.message
			});
			process.exit(1);
			return;
		}

		process.exit(0);
	});

	setTimeout(() => {
		log("error", "Forced shutdown due to timeout");
		process.exit(1);
	}, 10000).unref();
}

startServer().catch((error) => {
	log("error", "Failed to start server", {
		message: error.message
	});
	process.exit(1);
});

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
