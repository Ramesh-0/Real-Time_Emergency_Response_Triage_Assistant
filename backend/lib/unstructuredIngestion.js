const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");

const TOKEN_REGEX = /[a-z0-9]+/g;
const SUPPORTED_FILE_EXTENSIONS = new Set([".pdf", ".docx", ".txt", ".md", ".rtf"]);
const STOPWORDS = new Set([
	"the",
	"and",
	"for",
	"with",
	"from",
	"that",
	"this",
	"into",
	"have",
	"will",
	"not",
	"are",
	"was",
	"were",
	"can",
	"should",
	"protocol",
	"patient",
	"clinical",
	"care"
]);

const SECTION_PATTERNS = [
	/^section\s+[a-z0-9]+/i,
	/^chapter\s+[a-z0-9]+/i,
	/^\d+(\.\d+){0,4}\s+[a-z]/i,
	/^[A-Z][A-Z0-9\s\-:]{6,}$/
];

function parsePositiveInteger(value, fallback) {
	const parsed = Number.parseInt(value, 10);
	return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

function normalizeWhitespace(text) {
	if (typeof text !== "string") {
		return "";
	}

	return text.replace(/[\t\f\v\u00A0]+/g, " ").replace(/\r?\n+/g, "\n").replace(/[ ]{2,}/g, " ").trim();
}

function tokenize(text) {
	if (typeof text !== "string") {
		return [];
	}

	return text.toLowerCase().match(TOKEN_REGEX) || [];
}

function normalizeDate(dateValue) {
	if (typeof dateValue === "string" && !Number.isNaN(Date.parse(dateValue))) {
		return new Date(dateValue).toISOString().slice(0, 10);
	}

	return new Date().toISOString().slice(0, 10);
}

function looksLikeSectionHeading(line) {
	if (typeof line !== "string") {
		return false;
	}

	const normalized = line.trim();
	if (!normalized || normalized.length > 120) {
		return false;
	}

	return SECTION_PATTERNS.some((pattern) => pattern.test(normalized));
}

function splitIntoSectionBlocks(text, fallbackSection) {
	const normalized = normalizeWhitespace(text);
	if (!normalized) {
		return [];
	}

	const lines = normalized.split("\n");
	let currentSection = fallbackSection || "General";
	const sectionBlocks = [];
	let buffer = [];

	const flush = () => {
		if (buffer.length === 0) {
			return;
		}

		const blockText = normalizeWhitespace(buffer.join(" "));
		if (blockText) {
			sectionBlocks.push({
				section: currentSection,
				text: blockText
			});
		}

		buffer = [];
	};

	for (const line of lines) {
		const trimmed = line.trim();

		if (!trimmed) {
			flush();
			continue;
		}

		if (looksLikeSectionHeading(trimmed)) {
			flush();
			currentSection = trimmed;
			continue;
		}

		buffer.push(trimmed);
	}

	flush();
	return sectionBlocks;
}

function chunkTextByWords(text, chunkSizeWords, chunkOverlapWords) {
	const words = normalizeWhitespace(text).split(/\s+/).filter(Boolean);
	if (words.length === 0) {
		return [];
	}

	const size = parsePositiveInteger(chunkSizeWords, 180);
	const overlap = Math.min(parsePositiveInteger(chunkOverlapWords, 35), size - 1);
	const step = Math.max(1, size - overlap);

	if (words.length <= size) {
		return [words.join(" ")];
	}

	const chunks = [];

	for (let start = 0; start < words.length; start += step) {
		const slice = words.slice(start, start + size);
		if (slice.length === 0) {
			break;
		}

		chunks.push(slice.join(" "));

		if (start + size >= words.length) {
			break;
		}
	}

	return chunks;
}

function extractKeywords(text, maxKeywords = 8) {
	const frequencies = new Map();

	for (const token of tokenize(text)) {
		if (token.length <= 2 || STOPWORDS.has(token)) {
			continue;
		}

		frequencies.set(token, (frequencies.get(token) || 0) + 1);
	}

	return [...frequencies.entries()]
		.sort((left, right) => right[1] - left[1])
		.slice(0, maxKeywords)
		.map(([token]) => token);
}

function inferContentType(extension) {
	switch (extension) {
		case ".pdf":
			return "application/pdf";
		case ".docx":
			return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
		case ".md":
			return "text/markdown";
		case ".rtf":
			return "application/rtf";
		default:
			return "text/plain";
	}
}

function buildStableParentId(seed) {
	return `src-${crypto.createHash("sha1").update(seed).digest("hex").slice(0, 14)}`;
}

async function extractTextFromSource(item, rootDirectory) {
	if (typeof item.text === "string" && item.text.trim()) {
		return {
			text: item.text,
			sourceLabel: String(item.source || "inline-text"),
			resolvedPath: null,
			contentType: "text/plain"
		};
	}

	if (typeof item.sourcePath !== "string" || !item.sourcePath.trim()) {
		throw new Error("Each ingestion item must include either text or sourcePath");
	}

	const resolvedPath = path.isAbsolute(item.sourcePath)
		? item.sourcePath
		: path.resolve(rootDirectory, item.sourcePath);
	const extension = path.extname(resolvedPath).toLowerCase();

	if (!SUPPORTED_FILE_EXTENSIONS.has(extension)) {
		throw new Error(`Unsupported file extension: ${extension}`);
	}

	let text = "";

	if (extension === ".pdf") {
		const buffer = await fs.readFile(resolvedPath);
		const parsed = await pdfParse(buffer);
		text = parsed.text || "";
	} else if (extension === ".docx") {
		const parsed = await mammoth.extractRawText({ path: resolvedPath });
		text = parsed.value || "";
	} else {
		text = await fs.readFile(resolvedPath, "utf8");
	}

	const normalizedRoot = rootDirectory.endsWith(path.sep) ? rootDirectory : `${rootDirectory}${path.sep}`;
	const relativePath = resolvedPath.startsWith(normalizedRoot)
		? resolvedPath.slice(normalizedRoot.length)
		: resolvedPath;
	const sourceLabel = String(item.source || relativePath).replace(/\\/g, "/");

	return {
		text,
		sourceLabel,
		resolvedPath,
		contentType: inferContentType(extension)
	};
}

function createChunkRecordsForItem(item, extracted, options = {}) {
	const chunkSizeWords = parsePositiveInteger(options.chunkSizeWords, 180);
	const chunkOverlapWords = parsePositiveInteger(options.chunkOverlapWords, 35);
	const fallbackSection = String(item.section || "General");
	const sectionBlocks = splitIntoSectionBlocks(extracted.text, fallbackSection);
	const titleBase = String(item.title || path.basename(extracted.sourceLabel || "protocol"));
	const sourceLabel = String(item.source || extracted.sourceLabel || "unknown");
	const parentId = String(
		item.id || buildStableParentId(`${sourceLabel}|${titleBase}|${normalizeDate(item.date)}|${extracted.text.slice(0, 500)}`)
	);
	const normalizedType = String(item.type || "protocol");
	const normalizedDate = normalizeDate(item.date);
	const nowIso = new Date().toISOString();
	const chunks = [];

	for (const block of sectionBlocks) {
		const pieces = chunkTextByWords(block.text, chunkSizeWords, chunkOverlapWords);

		for (const piece of pieces) {
			const chunkId = `${parentId}-chunk-${String(chunks.length + 1).padStart(4, "0")}`;
			chunks.push({
				id: chunkId,
				parent_id: parentId,
				type: normalizedType,
				date: normalizedDate,
				source: sourceLabel,
				section: block.section || fallbackSection,
				title: titleBase,
				text: piece,
				keywords: extractKeywords(piece, 8),
				diagnosis: null,
				action: null,
				severity: null,
				chunk_index: chunks.length,
				chunk_count: null,
				ingested_at: nowIso,
				content_type: extracted.contentType
			});
		}
	}

	for (const chunk of chunks) {
		chunk.chunk_count = chunks.length;
	}

	return chunks;
}

async function ingestUnstructuredItems(items, options = {}) {
	if (!Array.isArray(items) || items.length === 0) {
		return {
			chunks: [],
			summaries: [],
			errors: []
		};
	}

	const rootDirectory = options.rootDirectory || process.cwd();
	const summaries = [];
	const errors = [];
	const chunks = [];

	for (let index = 0; index < items.length; index += 1) {
		const item = items[index];

		try {
			const extracted = await extractTextFromSource(item, rootDirectory);
			const itemChunks = createChunkRecordsForItem(item, extracted, options);

			if (itemChunks.length === 0) {
				errors.push({
					index,
					source: item.sourcePath || item.source || "unknown",
					message: "No chunkable text found"
				});
				continue;
			}

			chunks.push(...itemChunks);
			summaries.push({
				index,
				source: extracted.sourceLabel,
				resolved_path: extracted.resolvedPath,
				content_type: extracted.contentType,
				chunk_count: itemChunks.length,
				char_count: normalizeWhitespace(extracted.text).length
			});
		} catch (error) {
			errors.push({
				index,
				source: item?.sourcePath || item?.source || "unknown",
				message: error.message
			});
		}
	}

	return {
		chunks,
		summaries,
		errors
	};
}

function mergeChunkRecords(existingChunks, incomingChunks) {
	const merged = new Map();

	for (const chunk of existingChunks || []) {
		if (chunk && chunk.id) {
			merged.set(chunk.id, chunk);
		}
	}

	for (const chunk of incomingChunks || []) {
		if (chunk && chunk.id) {
			merged.set(chunk.id, chunk);
		}
	}

	return [...merged.values()];
}

async function loadPersistedChunks(storePath) {
	try {
		const raw = await fs.readFile(storePath, "utf8");
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch (error) {
		if (error.code === "ENOENT") {
			return [];
		}

		throw error;
	}
}

async function persistChunks(storePath, chunks) {
	const payload = JSON.stringify(chunks, null, 2);
	await fs.writeFile(storePath, payload, "utf8");
}

module.exports = {
	ingestUnstructuredItems,
	mergeChunkRecords,
	loadPersistedChunks,
	persistChunks,
	chunkTextByWords,
	normalizeWhitespace,
	extractKeywords
};
