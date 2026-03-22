const { performance } = require("perf_hooks");
const { HybridChunkIndex } = require("../lib/hybridIndex");

function parsePositiveInteger(value, fallback) {
	const parsed = Number.parseInt(value, 10);
	return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

function percentile(values, ratio) {
	if (values.length === 0) {
		return 0;
	}

	const sorted = [...values].sort((left, right) => left - right);
	const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio));
	return sorted[index];
}

function generateSyntheticChunks(totalChunks) {
	const protocols = [
		{ type: "cardiology", section: "Chest Pain Pathway", source: "aha-guideline" },
		{ type: "respiratory", section: "Respiratory Escalation", source: "who-protocol" },
		{ type: "dental", section: "Infection Control", source: "dental-board" },
		{ type: "general", section: "Fever Triage", source: "ed-protocols" },
		{ type: "neurology", section: "Stroke Screening", source: "stroke-network" }
	];

	const symptomPhrases = [
		"severe chest pain sweating shortness breath left arm pressure",
		"high fever cough headache body ache progressive fatigue",
		"jaw swelling tooth pain abscess redness facial tenderness",
		"speech slur facial droop unilateral weakness urgent imaging",
		"oxygen saturation low wheeze respiratory distress rapid breathing"
	];

	const chunks = [];

	for (let index = 0; index < totalChunks; index += 1) {
		const protocol = protocols[index % protocols.length];
		const phrase = symptomPhrases[index % symptomPhrases.length];
		const text = [
			`Protocol chunk ${index + 1} for ${protocol.section}.`,
			"Immediate triage: check vitals, red flags, and escalation thresholds.",
			`Clinical cues: ${phrase}.`,
			"Action plan: prioritize severity, notify specialist, and monitor response."
		].join(" ");

		chunks.push({
			id: `bench-${String(index + 1).padStart(6, "0")}`,
			parent_id: `bench-parent-${String((index % 400) + 1).padStart(4, "0")}`,
			type: protocol.type,
			date: `2026-03-${String((index % 28) + 1).padStart(2, "0")}`,
			source: protocol.source,
			section: protocol.section,
			title: `${protocol.section} guidance`,
			text,
			chunk_index: index,
			chunk_count: totalChunks,
			keywords: phrase.split(" ").slice(0, 8)
		});
	}

	return chunks;
}

function run() {
	const requiredChunks = parsePositiveInteger(process.env.BENCH_REQUIRED_CHUNKS, 10000);
	const targetLatencyMs = parsePositiveInteger(process.env.LATENCY_TARGET_MS, 500);
	const totalChunks = parsePositiveInteger(process.env.BENCH_CHUNK_COUNT, Math.max(requiredChunks, 12000));
	const queryRuns = parsePositiveInteger(process.env.BENCH_QUERY_RUNS, 120);
	const index = new HybridChunkIndex({
		vectorDimensions: parsePositiveInteger(process.env.HYBRID_VECTOR_DIMENSIONS, 256)
	});
	const chunks = generateSyntheticChunks(totalChunks);

	const buildStartedAt = performance.now();
	index.replaceAll(chunks);
	const buildLatencyMs = performance.now() - buildStartedAt;

	const benchmarkQueries = [
		"severe chest pain sweating",
		"jaw swelling tooth abscess",
		"stroke facial droop weakness",
		"high fever cough headache",
		"respiratory distress oxygen saturation"
	];
	const latencies = [];

	for (let indexRun = 0; indexRun < queryRuns; indexRun += 1) {
		const query = benchmarkQueries[indexRun % benchmarkQueries.length];
		const startedAt = performance.now();
		index.search(query, { limit: 25, candidatePool: 700 });
		const latencyMs = performance.now() - startedAt;
		latencies.push(latencyMs);
	}

	const p50 = percentile(latencies, 0.5);
	const p95 = percentile(latencies, 0.95);
	const max = Math.max(...latencies);
	const average = latencies.reduce((sum, value) => sum + value, 0) / latencies.length;

	const output = {
		total_chunks: index.size(),
		required_chunks: requiredChunks,
		met_chunk_goal: index.size() >= requiredChunks,
		target_latency_ms: targetLatencyMs,
		build_latency_ms: Number(buildLatencyMs.toFixed(2)),
		average_query_latency_ms: Number(average.toFixed(2)),
		p50_query_latency_ms: Number(p50.toFixed(2)),
		p95_query_latency_ms: Number(p95.toFixed(2)),
		max_query_latency_ms: Number(max.toFixed(2)),
		met_latency_goal: p95 <= targetLatencyMs,
		query_runs: queryRuns
	};

	console.log(JSON.stringify(output, null, 2));

	if (!output.met_chunk_goal || !output.met_latency_goal) {
		process.exitCode = 1;
	}
}

run();
