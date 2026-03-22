require("dotenv").config();

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

const app = express();
const PORT = parsePositiveInteger(process.env.PORT, 5000);
const DEFAULT_LIMIT = parsePositiveInteger(process.env.DEFAULT_LIMIT, 10);
const MAX_LIMIT = parsePositiveInteger(process.env.MAX_LIMIT, 50);
const QUERY_MAX_LENGTH = parsePositiveInteger(process.env.QUERY_MAX_LENGTH, 300);
const RATE_LIMIT_WINDOW_MS = parsePositiveInteger(process.env.RATE_LIMIT_WINDOW_MS, 60000);
const RATE_LIMIT_MAX = parsePositiveInteger(process.env.RATE_LIMIT_MAX, 120);
const SCALEDOWN_TIMEOUT_MS = parsePositiveInteger(process.env.SCALEDOWN_TIMEOUT_MS, 8000);
const LATENCY_TARGET_MS = parsePositiveInteger(process.env.LATENCY_TARGET_MS, 500);
const SCALEDOWN_MIN_CANDIDATES = parsePositiveInteger(process.env.SCALEDOWN_MIN_CANDIDATES, 4);
const SCALEDOWN_FORCE_REMOTE = parseBoolean(process.env.SCALEDOWN_FORCE_REMOTE, false);
const LOCAL_PRUNE_TOP_K = parsePositiveInteger(process.env.LOCAL_PRUNE_TOP_K, 8);
const MAX_DOC_AGE_DAYS = parsePositiveInteger(process.env.MAX_DOC_AGE_DAYS, 3650);
const API_JSON_LIMIT = process.env.API_JSON_LIMIT || "5mb";
const MIN_SEARCHABLE_CHUNKS = parsePositiveInteger(process.env.MIN_SEARCHABLE_CHUNKS, 10000);
const INGEST_DEFAULT_CHUNK_SIZE_WORDS = parsePositiveInteger(process.env.INGEST_DEFAULT_CHUNK_SIZE_WORDS, 180);
const INGEST_DEFAULT_CHUNK_OVERLAP_WORDS = parsePositiveInteger(process.env.INGEST_DEFAULT_CHUNK_OVERLAP_WORDS, 35);
const INGEST_MAX_ITEMS_PER_REQUEST = parsePositiveInteger(process.env.INGEST_MAX_ITEMS_PER_REQUEST, 50);
const INGEST_MAX_TEXT_CHARS = parsePositiveInteger(process.env.INGEST_MAX_TEXT_CHARS, 3000000);
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

const CASE_BY_ID = new Map(
	dataset
		.filter((doc) => doc && doc.id)
		.map((doc) => [doc.id, doc])
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
	log("warn", "Scaledown pruning unavailable", {
		statusCode: statusCode || null,
		errorCode: lastError?.code || null
	});

	return {
		prunedDocs: fallbackDocs,
		pruneMeta: {
			usedScaledown: false,
			attemptedScaledown: true,
			usedLocalFallback: true,
			localFallbackCount: fallbackDocs.length,
			reason: "scaledown_unavailable"
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
	const retrievedDocs = retrieveDocuments(query, MAX_LIMIT);
	const limitedRetrievedDocs = retrievedDocs.slice(0, limit);
	const pruningCandidates = retrievedDocs.slice(0, Math.min(retrievedDocs.length, MAX_LIMIT));
	const pruneTargetCount = computePruneTargetCount(query, limitedRetrievedDocs.length, pruningCandidates.length);
	const { prunedDocs, pruneMeta } = await pruneWithScaledown(query, pruningCandidates, pruneTargetCount);
	const limitedPrunedDocs = prunedDocs.slice(0, pruneTargetCount);
	const retrievedAverageRelevance = calculateAverageRelevance(query, limitedRetrievedDocs);
	const prunedAverageRelevance = calculateAverageRelevance(query, limitedPrunedDocs);
	const latencyMs = Date.now() - startedAt;

	return res.json({
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
		prune_meta: pruneMeta,
		retrieved_docs: limitedRetrievedDocs.map(toClientDoc),
		pruned_context: limitedPrunedDocs.map(toClientDoc)
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

function handleIndexStatsRequest(_req, res) {
	const stats = hybridIndex.getStats();

	return res.json({
		...stats,
		base_dataset_chunks: baseDatasetRecords.length,
		ingested_chunks: ingestedChunkRecords.length,
		min_searchable_chunks: MIN_SEARCHABLE_CHUNKS,
		chunk_goal_met: stats.total_chunks >= MIN_SEARCHABLE_CHUNKS,
		latency_target_ms: LATENCY_TARGET_MS,
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

async function handleTriageRequest(req, res) {
	const startedAt = Date.now();
	const { query, limit } = validateRetrievePayload(req.body);
	const retrievedDocs = retrieveDocuments(query, MAX_LIMIT);
	const limitedRetrievedDocs = retrievedDocs.slice(0, limit);
	const pruningCandidates = retrievedDocs.slice(0, Math.min(retrievedDocs.length, MAX_LIMIT));
	const pruneTargetCount = computePruneTargetCount(query, limitedRetrievedDocs.length, pruningCandidates.length);
	const { prunedDocs, pruneMeta } = await pruneWithScaledown(query, pruningCandidates, pruneTargetCount);
	const limitedPrunedDocs = prunedDocs.slice(0, pruneTargetCount);
	const result = buildDecision(query, limitedPrunedDocs);
	const retrievedAverageRelevance = calculateAverageRelevance(query, limitedRetrievedDocs);
	const prunedAverageRelevance = calculateAverageRelevance(query, limitedPrunedDocs);
	const latencyMs = Date.now() - startedAt;

	return res.json({
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
		prune_meta: pruneMeta,
		retrieved_docs: limitedRetrievedDocs.map(toClientDoc),
		pruned_context: limitedPrunedDocs.map(toClientDoc),
		result
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
		endpoints: [
			"GET /health",
			"GET /index/stats",
			"POST /retrieve",
			"POST /search/chunks",
			"POST /ingest/unstructured",
			"POST /triage"
		]
	});
});

app.get("/.well-known/appspecific/com.chrome.devtools.json", (_req, res) => {
	res.json({});
});

app.get("/index/stats", handleIndexStatsRequest);
app.post("/retrieve", asyncHandler(handleRetrieveRequest));
app.post("/search/chunks", asyncHandler(handleChunkSearchRequest));
app.post("/ingest/unstructured", asyncHandler(handleUnstructuredIngestRequest));
app.post("/triage", asyncHandler(handleTriageRequest));

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

let server = null;

async function startServer() {
	await initializeHybridIndex();

	server = app.listen(PORT, () => {
		log("info", "Triage backend running", {
			port: PORT,
			node_env: process.env.NODE_ENV || "development",
			total_searchable_chunks: hybridIndex.size(),
			chunk_goal_met: hybridIndex.size() >= MIN_SEARCHABLE_CHUNKS,
			scaledown_min_candidates: SCALEDOWN_MIN_CANDIDATES,
			scaledown_force_remote: SCALEDOWN_FORCE_REMOTE
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
