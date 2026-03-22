const TOKEN_REGEX = /[a-z0-9]+/g;

const DEFAULT_VECTOR_DIMENSIONS = 256;
const DEFAULT_BM25_K1 = 1.2;
const DEFAULT_BM25_B = 0.75;
const DEFAULT_HYBRID_LEXICAL_WEIGHT = 0.65;
const DEFAULT_HYBRID_VECTOR_WEIGHT = 0.35;
const DEFAULT_CANDIDATE_POOL = 600;

function parsePositiveInteger(value, fallback) {
	const parsed = Number.parseInt(value, 10);
	return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

function tokenize(text) {
	if (typeof text !== "string") {
		return [];
	}

	return text.toLowerCase().match(TOKEN_REGEX) || [];
}

function toEpoch(dateValue) {
	if (typeof dateValue !== "string") {
		return 0;
	}

	const parsed = Date.parse(dateValue);
	return Number.isNaN(parsed) ? 0 : parsed;
}

function clamp(value, min, max) {
	return Math.min(Math.max(value, min), max);
}

function hashToken(token, modulo) {
	let hash = 2166136261;

	for (let index = 0; index < token.length; index += 1) {
		hash ^= token.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}

	return (hash >>> 0) % modulo;
}

function buildUnitVector(tokens, dimensions) {
	const vector = new Float32Array(dimensions);

	if (!Array.isArray(tokens) || tokens.length === 0) {
		return vector;
	}

	for (const token of tokens) {
		const tokenHash = hashToken(token, dimensions);
		vector[tokenHash] += 1;
	}

	let magnitude = 0;

	for (let index = 0; index < dimensions; index += 1) {
		magnitude += vector[index] * vector[index];
	}

	if (magnitude <= 0) {
		return vector;
	}

	const divisor = Math.sqrt(magnitude);

	for (let index = 0; index < dimensions; index += 1) {
		vector[index] /= divisor;
	}

	return vector;
}

function dotProduct(left, right) {
	let total = 0;

	for (let index = 0; index < left.length; index += 1) {
		total += left[index] * right[index];
	}

	return total;
}

function createUniqueId(baseId, seenIds) {
	let candidate = baseId;

	if (!candidate || seenIds.has(candidate)) {
		const seed = candidate || "chunk";
		let suffix = 1;
		candidate = `${seed}-${suffix}`;

		while (seenIds.has(candidate)) {
			suffix += 1;
			candidate = `${seed}-${suffix}`;
		}
	}

	seenIds.add(candidate);
	return candidate;
}

function sanitizeRecord(rawRecord, fallbackId, seenIds) {
	if (!rawRecord || typeof rawRecord !== "object") {
		return null;
	}

	const text = String(rawRecord.text || rawRecord.content || "").trim();
	if (!text) {
		return null;
	}

	const id = createUniqueId(String(rawRecord.id || fallbackId), seenIds);

	return {
		id,
		type: String(rawRecord.type || "unstructured"),
		date: typeof rawRecord.date === "string" ? rawRecord.date : null,
		source: String(rawRecord.source || "unknown"),
		section: String(rawRecord.section || "General"),
		title: String(rawRecord.title || ""),
		text,
		keywords: Array.isArray(rawRecord.keywords)
			? rawRecord.keywords.map((keyword) => String(keyword).toLowerCase())
			: [],
		diagnosis: rawRecord.diagnosis || null,
		action: rawRecord.action || null,
		severity: rawRecord.severity || null,
		parent_id: rawRecord.parent_id || null,
		chunk_index: Number.isInteger(rawRecord.chunk_index) ? rawRecord.chunk_index : null,
		chunk_count: Number.isInteger(rawRecord.chunk_count) ? rawRecord.chunk_count : null,
		ingested_at: rawRecord.ingested_at || null,
		content_type: rawRecord.content_type || null
	};
}

function incrementCount(map, key) {
	map.set(key, (map.get(key) || 0) + 1);
}

class HybridChunkIndex {
	constructor(options = {}) {
		this.vectorDimensions = parsePositiveInteger(options.vectorDimensions, DEFAULT_VECTOR_DIMENSIONS);
		this.bm25K1 = Number.isFinite(options.bm25K1) ? options.bm25K1 : DEFAULT_BM25_K1;
		this.bm25B = Number.isFinite(options.bm25B) ? options.bm25B : DEFAULT_BM25_B;
		this.hybridLexicalWeight = Number.isFinite(options.hybridLexicalWeight)
			? options.hybridLexicalWeight
			: DEFAULT_HYBRID_LEXICAL_WEIGHT;
		this.hybridVectorWeight = Number.isFinite(options.hybridVectorWeight)
			? options.hybridVectorWeight
			: DEFAULT_HYBRID_VECTOR_WEIGHT;
		this.defaultCandidatePool = parsePositiveInteger(options.defaultCandidatePool, DEFAULT_CANDIDATE_POOL);

		this.records = [];
		this.postings = new Map();
		this.docLengths = [];
		this.vectors = [];
		this.avgDocLength = 1;
		this.typeCounts = new Map();
		this.sourceCounts = new Map();
	}

	size() {
		return this.records.length;
	}

	getAllRecords() {
		return [...this.records];
	}

	replaceAll(records) {
		const seenIds = new Set();
		const sanitizedRecords = [];

		for (let index = 0; index < records.length; index += 1) {
			const sanitized = sanitizeRecord(records[index], `chunk-${index + 1}`, seenIds);
			if (sanitized) {
				sanitizedRecords.push(sanitized);
			}
		}

		this.records = sanitizedRecords;
		this.postings = new Map();
		this.docLengths = new Array(this.records.length);
		this.vectors = new Array(this.records.length);
		this.avgDocLength = 1;
		this.typeCounts = new Map();
		this.sourceCounts = new Map();

		let totalDocLength = 0;

		for (let docIndex = 0; docIndex < this.records.length; docIndex += 1) {
			const record = this.records[docIndex];
			const tokens = tokenize(`${record.title} ${record.section} ${record.text}`);
			const tokenFrequency = new Map();

			for (const token of tokens) {
				tokenFrequency.set(token, (tokenFrequency.get(token) || 0) + 1);
			}

			for (const [token, tf] of tokenFrequency.entries()) {
				if (!this.postings.has(token)) {
					this.postings.set(token, []);
				}

				this.postings.get(token).push({ docIndex, tf });
			}

			const docLength = tokens.length || 1;
			this.docLengths[docIndex] = docLength;
			totalDocLength += docLength;
			this.vectors[docIndex] = buildUnitVector(tokens, this.vectorDimensions);
			incrementCount(this.typeCounts, record.type);
			incrementCount(this.sourceCounts, record.source);
		}

		this.avgDocLength = this.records.length > 0 ? totalDocLength / this.records.length : 1;
		return this.records.length;
	}

	append(records) {
		return this.replaceAll([...this.records, ...records]);
	}

	matchesFilters(record, filters) {
		if (!filters || typeof filters !== "object") {
			return true;
		}

		if (typeof filters.type === "string" && filters.type.trim()) {
			if (record.type.toLowerCase() !== filters.type.trim().toLowerCase()) {
				return false;
			}
		}

		if (typeof filters.source === "string" && filters.source.trim()) {
			if (!record.source.toLowerCase().includes(filters.source.trim().toLowerCase())) {
				return false;
			}
		}

		if (typeof filters.section === "string" && filters.section.trim()) {
			if (!record.section.toLowerCase().includes(filters.section.trim().toLowerCase())) {
				return false;
			}
		}

		const startDateEpoch = toEpoch(filters.startDate);
		const endDateEpoch = toEpoch(filters.endDate);
		const recordEpoch = toEpoch(record.date);

		if (startDateEpoch > 0 && recordEpoch > 0 && recordEpoch < startDateEpoch) {
			return false;
		}

		if (endDateEpoch > 0 && recordEpoch > 0 && recordEpoch > endDateEpoch) {
			return false;
		}

		return true;
	}

	search(query, options = {}) {
		if (this.records.length === 0) {
			return [];
		}

		const queryTokens = tokenize(query);
		if (queryTokens.length === 0) {
			return [];
		}

		const limit = clamp(parsePositiveInteger(options.limit, 10), 1, 1000);
		const candidatePool = clamp(
			parsePositiveInteger(options.candidatePool, this.defaultCandidatePool),
			limit,
			5000
		);
		const lexicalScores = new Map();
		const totalDocs = this.records.length;
		const queryTermFrequency = new Map();

		for (const token of queryTokens) {
			queryTermFrequency.set(token, (queryTermFrequency.get(token) || 0) + 1);
		}

		for (const [token, queryFrequency] of queryTermFrequency.entries()) {
			const tokenPostings = this.postings.get(token);
			if (!tokenPostings || tokenPostings.length === 0) {
				continue;
			}

			const df = tokenPostings.length;
			const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
			const queryWeight = 1 + Math.log(1 + queryFrequency);

			for (const posting of tokenPostings) {
				const docLength = this.docLengths[posting.docIndex] || this.avgDocLength;
				const numerator = posting.tf * (this.bm25K1 + 1);
				const denominator = posting.tf + this.bm25K1 * (1 - this.bm25B + this.bm25B * (docLength / this.avgDocLength));
				const score = idf * (numerator / denominator) * queryWeight;
				lexicalScores.set(posting.docIndex, (lexicalScores.get(posting.docIndex) || 0) + score);
			}
		}

		const lexicalRanking = [...lexicalScores.entries()].sort((left, right) => right[1] - left[1]);
		const lexicalIndexes = lexicalRanking.slice(0, candidatePool).map(([docIndex]) => docIndex);
		const maxLexical = lexicalRanking.length > 0 ? lexicalRanking[0][1] : 0;

		const queryVector = buildUnitVector(queryTokens, this.vectorDimensions);
		const vectorScores = new Float32Array(this.records.length);
		let maxVector = 0;

		for (let docIndex = 0; docIndex < this.records.length; docIndex += 1) {
			const score = dotProduct(queryVector, this.vectors[docIndex]);
			vectorScores[docIndex] = score;
			if (score > maxVector) {
				maxVector = score;
			}
		}

		const vectorRanking = [];

		for (let docIndex = 0; docIndex < this.records.length; docIndex += 1) {
			const score = vectorScores[docIndex];
			if (score > 0) {
				vectorRanking.push([docIndex, score]);
			}
		}

		vectorRanking.sort((left, right) => right[1] - left[1]);
		const vectorIndexes = vectorRanking.slice(0, candidatePool).map(([docIndex]) => docIndex);
		const candidateSet = new Set([...lexicalIndexes, ...vectorIndexes]);

		if (candidateSet.size === 0) {
			for (const [docIndex] of vectorRanking.slice(0, limit)) {
				candidateSet.add(docIndex);
			}
		}

		const results = [];

		for (const docIndex of candidateSet) {
			const record = this.records[docIndex];
			if (!this.matchesFilters(record, options.filters)) {
				continue;
			}

			const lexicalScore = lexicalScores.get(docIndex) || 0;
			const vectorScore = vectorScores[docIndex] || 0;
			const normalizedLexical = maxLexical > 0 ? lexicalScore / maxLexical : 0;
			const normalizedVector = maxVector > 0 ? vectorScore / maxVector : 0;
			const hybridScore =
				this.hybridLexicalWeight * normalizedLexical + this.hybridVectorWeight * normalizedVector;

			if (hybridScore <= 0) {
				continue;
			}

			results.push({
				doc: record,
				score: Number(hybridScore.toFixed(6)),
				lexicalScore: Number(lexicalScore.toFixed(6)),
				vectorScore: Number(vectorScore.toFixed(6))
			});
		}

		results.sort((left, right) => {
			if (right.score !== left.score) {
				return right.score - left.score;
			}

			return toEpoch(right.doc.date) - toEpoch(left.doc.date);
		});

		return results.slice(0, limit);
	}

	getStats() {
		const topTypes = [...this.typeCounts.entries()]
			.sort((left, right) => right[1] - left[1])
			.slice(0, 10)
			.map(([type, count]) => ({ type, count }));
		const topSources = [...this.sourceCounts.entries()]
			.sort((left, right) => right[1] - left[1])
			.slice(0, 10)
			.map(([source, count]) => ({ source, count }));

		return {
			total_chunks: this.records.length,
			indexed_terms: this.postings.size,
			average_chunk_words: Number(this.avgDocLength.toFixed(2)),
			vector_dimensions: this.vectorDimensions,
			unique_types: this.typeCounts.size,
			unique_sources: this.sourceCounts.size,
			top_types: topTypes,
			top_sources: topSources
		};
	}
}

module.exports = {
	HybridChunkIndex,
	tokenize,
	toEpoch
};
