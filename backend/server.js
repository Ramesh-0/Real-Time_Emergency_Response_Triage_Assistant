require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const dataset = require("./data.json");

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

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

function retrieveDocuments(query) {
	const queryTokens = query.toLowerCase().match(/[a-z0-9]+/g) || [];
	const tokenSet = new Set(queryTokens);

	const scoreDocs = (docs) => {
		return docs
			.map((doc) => {
				const keywordScore = doc.keywords.reduce((score, keyword) => {
					const normalizedKeyword = String(keyword).toLowerCase();
					return tokenSet.has(normalizedKeyword) ? score + 2 : score;
				}, 0);

				const typeBonus = tokenSet.has(doc.type.toLowerCase()) ? 1 : 0;
				const totalScore = keywordScore + typeBonus;

				return { doc, totalScore };
			})
			.filter((item) => item.totalScore > 0)
			.sort((a, b) => b.totalScore - a.totalScore)
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
	const fallback = {
		prunedDocs: retrievedDocs.slice(0, 5),
		pruneMeta: {
			usedScaledown: false,
			reason: "SCALEDOWN_API_URL not configured",
			debug: {
				auth_mode: "none",
				payload_type: "none",
				payload_keys: []
			}
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
				timeout: 8000
			});

			const payload = response.data || {};
			const payloadType = Array.isArray(payload) ? "array" : typeof payload;
			const payloadKeys = payload && typeof payload === "object" && !Array.isArray(payload)
				? Object.keys(payload)
				: [];
			const debugInfo = {
				auth_mode: variant.mode,
				payload_type: payloadType,
				payload_keys: payloadKeys
			};

			const byIds = Array.isArray(payload.pruned_ids) ? payload.pruned_ids : null;
			const directDocs = Array.isArray(payload.pruned_docs)
				? payload.pruned_docs
				: Array.isArray(payload.documents)
					? payload.documents
					: null;

			if (byIds && byIds.length > 0) {
				const selected = retrievedDocs.filter((doc) => byIds.includes(doc.id));
				return {
					prunedDocs: selected.length > 0 ? selected : retrievedDocs.slice(0, 5),
					pruneMeta: {
						usedScaledown: true,
						reason: `Pruned via pruned_ids (${variant.mode})`,
						debug: debugInfo
					}
				};
			}

			if (directDocs && directDocs.length > 0) {
				return {
					prunedDocs: directDocs,
					pruneMeta: {
						usedScaledown: true,
						reason: `Pruned via document payload (${variant.mode})`,
						debug: debugInfo
					}
				};
			}

			return {
				prunedDocs: retrievedDocs.slice(0, 5),
				pruneMeta: {
					usedScaledown: true,
					reason: `Scaledown returned empty payload (${variant.mode})`,
					debug: {
						...debugInfo,
						candidate_counts: {
							pruned_ids: Array.isArray(payload.pruned_ids) ? payload.pruned_ids.length : 0,
							pruned_docs: Array.isArray(payload.pruned_docs) ? payload.pruned_docs.length : 0,
							documents: Array.isArray(payload.documents) ? payload.documents.length : 0
						}
					}
				}
			};
		} catch (error) {
			lastError = error;
		}
	}

	const statusCode = lastError?.response?.status;
	return {
		prunedDocs: retrievedDocs.slice(0, 5),
		pruneMeta: {
			usedScaledown: false,
			reason: statusCode
				? `Scaledown error (${statusCode}): ${lastError.message}`
				: `Scaledown error: ${lastError?.message || "Unknown error"}`,
			debug: {
				auth_mode: "all-tried",
				payload_type: "unknown",
				payload_keys: [],
				http_status: statusCode || null
			}
		}
	};
}

function parseLimit(limitValue, defaultLimit = 10, maxLimit = 50) {
	const parsed = Number.parseInt(limitValue, 10);

	if (Number.isNaN(parsed)) {
		return defaultLimit;
	}

	return Math.min(Math.max(parsed, 1), maxLimit);
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

app.get("/health", (_req, res) => {
	res.json({ status: "ok" });
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

app.post("/retrieve", async (req, res) => {
	const { query, limit } = req.body || {};

	if (!query || typeof query !== "string") {
		return res.status(400).json({
			error: "query is required and must be a string"
		});
	}

	const resultLimit = parseLimit(limit);
	const retrievedDocs = retrieveDocuments(query);
	const limitedRetrievedDocs = retrievedDocs.slice(0, resultLimit);
	const { prunedDocs, pruneMeta } = await pruneWithScaledown(query, limitedRetrievedDocs);
	const limitedPrunedDocs = prunedDocs.slice(0, resultLimit);

	return res.json({
		query,
		retrieved_count: retrievedDocs.length,
		returned_retrieved_count: limitedRetrievedDocs.length,
		pruned_count: limitedPrunedDocs.length,
		prune_meta: pruneMeta,
		retrieved_docs: limitedRetrievedDocs.map(toClientDoc),
		pruned_context: limitedPrunedDocs.map(toClientDoc)
	});
});

app.post("/triage", async (req, res) => {
	const { query, limit } = req.body || {};

	if (!query || typeof query !== "string") {
		return res.status(400).json({
			error: "query is required and must be a string"
		});
	}

	const resultLimit = parseLimit(limit);
	const retrievedDocs = retrieveDocuments(query);
	const limitedRetrievedDocs = retrievedDocs.slice(0, resultLimit);
	const { prunedDocs, pruneMeta } = await pruneWithScaledown(query, limitedRetrievedDocs);
	const limitedPrunedDocs = prunedDocs.slice(0, resultLimit);
	const responsePayload = {
		query,
		retrieved_count: retrievedDocs.length,
		returned_retrieved_count: limitedRetrievedDocs.length,
		pruned_count: limitedPrunedDocs.length,
		prune_meta: pruneMeta,
		retrieved_docs: limitedRetrievedDocs.map(toClientDoc),
		pruned_context: limitedPrunedDocs.map(toClientDoc)
	};

	return res.json(responsePayload);
});

app.listen(PORT, () => {
	console.log(`Triage backend running on http://localhost:${PORT}`);
});
