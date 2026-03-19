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
	const normalizedQuery = query.toLowerCase();

	const scored = dataset
		.map((doc) => {
			const keywordScore = doc.keywords.reduce((score, keyword) => {
				return normalizedQuery.includes(keyword.toLowerCase()) ? score + 2 : score;
			}, 0);

			const typeBonus = normalizedQuery.includes(doc.type) ? 1 : 0;
			const totalScore = keywordScore + typeBonus;

			return { doc, totalScore };
		})
		.filter((item) => item.totalScore > 0)
		.sort((a, b) => b.totalScore - a.totalScore)
		.map((item) => item.doc);

	if (scored.length > 0) {
		return scored;
	}

	const inferredType = Object.entries(KEYWORD_TO_TYPE).find(([keyword]) => {
		return normalizedQuery.includes(keyword);
	});

	if (!inferredType) {
		return dataset.slice(0, 5);
	}

	return dataset.filter((doc) => doc.type === inferredType[1]);
}

async function pruneWithScaledown(query, retrievedDocs) {
	const fallback = {
		prunedDocs: retrievedDocs.slice(0, 5),
		pruneMeta: {
			usedScaledown: false,
			reason: "SCALEDOWN_API_URL not configured"
		}
	};

	const scaledownUrl = process.env.SCALEDOWN_API_URL;
	const scaledownApiKey = process.env.SCALEDOWN_API_KEY;

	if (!scaledownUrl) {
		return fallback;
	}

	try {
		const response = await axios.post(
			scaledownUrl,
			{
				query,
				documents: retrievedDocs.map((doc) => ({
					id: doc.id,
					type: doc.type,
					date: doc.date,
					text: doc.text
				}))
			},
			{
				headers: {
					"Content-Type": "application/json",
					...(scaledownApiKey ? { Authorization: `Bearer ${scaledownApiKey}` } : {})
				},
				timeout: 8000
			}
		);

		const payload = response.data || {};
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
				pruneMeta: { usedScaledown: true, reason: "Pruned via pruned_ids" }
			};
		}

		if (directDocs && directDocs.length > 0) {
			return {
				prunedDocs: directDocs,
				pruneMeta: { usedScaledown: true, reason: "Pruned via document payload" }
			};
		}

		return {
			prunedDocs: retrievedDocs.slice(0, 5),
			pruneMeta: { usedScaledown: true, reason: "Scaledown returned empty payload" }
		};
	} catch (error) {
		return {
			prunedDocs: retrievedDocs.slice(0, 5),
			pruneMeta: {
				usedScaledown: false,
				reason: `Scaledown error: ${error.message}`
			}
		};
	}
}

function buildDecision(query, prunedDocs) {
	const normalizedQuery = query.toLowerCase();
	const hasCardiologySignal = prunedDocs.some((doc) => doc.type === "cardiology");
	const hasDentalSignal = prunedDocs.some((doc) => doc.type === "dental");

	if (
		normalizedQuery.includes("chest") ||
		(normalizedQuery.includes("ecg") && hasCardiologySignal)
	) {
		return {
			diagnosis: "Possible acute cardiac event",
			action: "Immediate ER escalation and urgent ECG/troponin protocol",
			severity: "HIGH"
		};
	}

	if (normalizedQuery.includes("fever")) {
		return {
			diagnosis: "Likely systemic infection or viral illness",
			action: "General physician evaluation, vitals monitoring, and symptomatic care",
			severity: "MEDIUM"
		};
	}

	if (normalizedQuery.includes("tooth") || normalizedQuery.includes("gum") || hasDentalSignal) {
		return {
			diagnosis: "Likely acute dental issue",
			action: "Dental review and pain/infection management",
			severity: "LOW"
		};
	}

	return {
		diagnosis: "General triage case requiring physician review",
		action: "Primary care assessment and targeted tests based on symptoms",
		severity: "MEDIUM"
	};
}

app.get("/health", (_req, res) => {
	res.json({ status: "ok" });
});

app.get("/", (_req, res) => {
	res.json({
		name: "Real-Time Emergency Response Triage Assistant API",
		status: "ok",
		endpoints: ["GET /health", "POST /triage"]
	});
});

app.get("/.well-known/appspecific/com.chrome.devtools.json", (_req, res) => {
	res.json({});
});

app.post("/triage", async (req, res) => {
	const { query } = req.body || {};

	if (!query || typeof query !== "string") {
		return res.status(400).json({
			error: "query is required and must be a string"
		});
	}

	const retrievedDocs = retrieveDocuments(query);
	const { prunedDocs, pruneMeta } = await pruneWithScaledown(query, retrievedDocs);
	const result = buildDecision(query, prunedDocs);

	return res.json({
		query,
		retrieved_count: retrievedDocs.length,
		pruned_count: prunedDocs.length,
		prune_meta: pruneMeta,
		result
	});
});

app.listen(PORT, () => {
	console.log(`Triage backend running on http://localhost:${PORT}`);
});
