require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const axios = require("axios");
const dataset = require("./data.json");

function parsePositiveInteger(value, fallback) {
	const parsed = Number.parseInt(value, 10);
	return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

const app = express();
const PORT = parsePositiveInteger(process.env.PORT, 5000);
const DEFAULT_LIMIT = parsePositiveInteger(process.env.DEFAULT_LIMIT, 10);
const MAX_LIMIT = parsePositiveInteger(process.env.MAX_LIMIT, 50);
const QUERY_MAX_LENGTH = parsePositiveInteger(process.env.QUERY_MAX_LENGTH, 300);
const RATE_LIMIT_WINDOW_MS = parsePositiveInteger(process.env.RATE_LIMIT_WINDOW_MS, 60000);
const RATE_LIMIT_MAX = parsePositiveInteger(process.env.RATE_LIMIT_MAX, 120);
const SCALEDOWN_TIMEOUT_MS = parsePositiveInteger(process.env.SCALEDOWN_TIMEOUT_MS, 8000);
const API_JSON_LIMIT = process.env.API_JSON_LIMIT || "50kb";
const ALLOWED_ORIGINS = (process.env.CORS_ORIGIN || "")
	.split(",")
	.map((origin) => origin.trim())
	.filter(Boolean);
const SAFE_DEFAULT_LIMIT = Math.min(DEFAULT_LIMIT, MAX_LIMIT);

class HttpError extends Error {
	constructor(statusCode, message) {
		super(message);
		this.name = "HttpError";
		this.statusCode = statusCode;
	}
}

function log(level, message, metadata = {}) {
	const entry = {
		timestamp: new Date().toISOString(),
		level,
		message,
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
		allowedHeaders: ["Content-Type", "Authorization", "x-api-key"],
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
	ecg: "cardiology",
	heart: "cardiology",
	tooth: "dental",
	gum: "dental",
	jaw: "dental",
	fever: "general",
	cough: "general",
	headache: "general"
};

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

function retrieveDocuments(query) {
	const queryTokens = query.toLowerCase().match(/[a-z0-9]+/g) || [];
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

	const inferredTypeEntry = Object.entries(KEYWORD_TO_TYPE).find(([keyword]) => {
		return tokenSet.has(keyword);
	});

	if (inferredTypeEntry) {
		const inferredType = inferredTypeEntry[1];
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

	return dataset.slice(0, 5);
}

async function pruneWithScaledown(query, retrievedDocs) {
	const fallbackDocs = retrievedDocs.slice(0, SAFE_DEFAULT_LIMIT);
	const fallback = {
		prunedDocs: fallbackDocs,
		pruneMeta: {
			usedScaledown: false,
			reason: "scaledown_not_configured"
		}
	};

	const scaledownUrl = process.env.SCALEDOWN_API_URL;
	const scaledownApiKey = process.env.SCALEDOWN_API_KEY;

	if (!scaledownUrl) {
		return fallback;
	}

	const requestBody = {
		query,
		documents: retrievedDocs.map((doc) => ({
			id: doc.id,
			type: doc.type,
			date: doc.date,
			text: doc.text
		}))
	};

	const authVariants = scaledownApiKey
		? [
			{ mode: "bearer+x-api-key", headers: { Authorization: `Bearer ${scaledownApiKey}`, "x-api-key": scaledownApiKey } },
			{ mode: "x-api-key", headers: { "x-api-key": scaledownApiKey } },
			{ mode: "bearer", headers: { Authorization: `Bearer ${scaledownApiKey}` } }
		]
		: [{ mode: "none", headers: {} }];

	let lastError = null;

	for (const variant of authVariants) {
		try {
			const response = await axios.post(scaledownUrl, requestBody, {
				headers: {
					"Content-Type": "application/json",
					...variant.headers
				},
				timeout: SCALEDOWN_TIMEOUT_MS
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
				const selected = retrievedDocs.filter((doc) => byIds.includes(doc.id));
				return {
					prunedDocs: selected.length > 0 ? selected : fallbackDocs,
					pruneMeta: {
						usedScaledown: true,
						reason: `scaledown_pruned_ids_${variant.mode}`
					}
				};
			}

			if (directDocs && directDocs.length > 0) {
				return {
					prunedDocs: directDocs,
					pruneMeta: {
						usedScaledown: true,
						reason: `scaledown_pruned_docs_${variant.mode}`
					}
				};
			}

			return {
				prunedDocs: fallbackDocs,
				pruneMeta: {
					usedScaledown: true,
					reason: `scaledown_empty_payload_${variant.mode}`
				}
			};
		} catch (error) {
			lastError = error;
		}
	}

	const statusCode = lastError?.response?.status;
	log("warn", "Scaledown pruning unavailable", {
		statusCode: statusCode || null,
		errorCode: lastError?.code || null
	});

	return {
		prunedDocs: fallbackDocs,
		pruneMeta: {
			usedScaledown: false,
			reason: "scaledown_unavailable"
		}
	};
}

function toClientDoc(doc) {
	return {
		id: doc.id || null,
		type: doc.type || "unknown",
		date: doc.date || null,
		title: doc.title || "",
		text: doc.text || doc.content || ""
	};
}

function asyncHandler(handler) {
	return (req, res, next) => {
		Promise.resolve(handler(req, res, next)).catch(next);
	};
}

async function handleRetrieveRequest(req, res) {
	const { query, limit } = validateRetrievePayload(req.body);
	const retrievedDocs = retrieveDocuments(query);
	const limitedRetrievedDocs = retrievedDocs.slice(0, limit);
	const { prunedDocs, pruneMeta } = await pruneWithScaledown(query, limitedRetrievedDocs);
	const limitedPrunedDocs = prunedDocs.slice(0, limit);

	return res.json({
		query,
		retrieved_count: retrievedDocs.length,
		returned_retrieved_count: limitedRetrievedDocs.length,
		pruned_count: limitedPrunedDocs.length,
		prune_meta: pruneMeta,
		retrieved_docs: limitedRetrievedDocs.map(toClientDoc),
		pruned_context: limitedPrunedDocs.map(toClientDoc)
	});
}

app.get("/health", (_req, res) => {
	res.json({
		status: "ok",
		uptime_seconds: Math.floor(process.uptime())
	});
});

app.get("/", (_req, res) => {
	res.json({
		name: "Real-Time Emergency Response Triage Assistant API",
		status: "ok",
		endpoints: ["GET /health", "POST /retrieve", "POST /triage"]
	});
});

app.get("/.well-known/appspecific/com.chrome.devtools.json", (_req, res) => {
	res.json({});
});

app.post("/retrieve", asyncHandler(handleRetrieveRequest));
app.post("/triage", asyncHandler(handleRetrieveRequest));

app.use((_req, res) => {
	res.status(404).json({ error: "Route not found" });
});

app.use((error, _req, res, _next) => {
	const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;

	if (statusCode >= 500) {
		log("error", "Unhandled server error", {
			message: error.message
		});
	}

	res.status(statusCode).json({
		error: statusCode === 500 ? "Internal server error" : error.message
	});
});

const server = app.listen(PORT, () => {
	log("info", "Triage backend running", {
		port: PORT,
		node_env: process.env.NODE_ENV || "development"
	});
});

function shutdown(signal) {
	log("info", "Shutdown signal received", { signal });

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

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
