const fs = require("fs/promises");
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

function writeReportMarkdown(reportInput) {
	const {
		generatedAt,
		baseUrl,
		checks,
		dashboardData,
		alertsData,
		metricsPreview,
		testRequestId
	} = reportInput;
	const passedCount = checks.filter((check) => check.passed).length;
	const failedCount = checks.length - passedCount;
	const activeAlerts = alertsData.active_alerts || [];

	const checkRows = checks.map((check) => {
		return `| ${check.name} | ${check.passed ? "PASS" : "FAIL"} | ${check.details} |`;
	});

	return [
		"# Observability Validation Report",
		"",
		`Generated UTC: ${generatedAt}`,
		`Base URL: ${baseUrl}`,
		`Validation request id: ${testRequestId}`,
		"",
		"## Summary",
		`- Total checks: ${checks.length}`,
		`- Passed checks: ${passedCount}`,
		`- Failed checks: ${failedCount}`,
		`- Active alerts: ${activeAlerts.length === 0 ? "none" : activeAlerts.join(", ")}`,
		"",
		"## Check Results",
		"| Check | Result | Details |",
		"| --- | :---: | --- |",
		...checkRows,
		"",
		"## Dashboard Snapshot",
		"```json",
		JSON.stringify(dashboardData, null, 2),
		"```",
		"",
		"## Alerts Snapshot",
		"```json",
		JSON.stringify(alertsData, null, 2),
		"```",
		"",
		"## Metrics Excerpt",
		"```text",
		metricsPreview,
		"```",
		""
	].join("\n");
}

async function run() {
	const backendRoot = path.resolve(__dirname, "..");
	const port = parsePositiveInteger(process.env.OBS_VALIDATE_PORT, 5099);
	const baseUrl = `http://127.0.0.1:${port}`;
	const reportPath = path.resolve(
		backendRoot,
		process.env.OBS_VALIDATE_REPORT_PATH || "reports/observability-validation-report.md"
	);
	const healthTimeoutMs = parsePositiveInteger(process.env.OBS_VALIDATE_HEALTH_TIMEOUT_MS, 45000);
	const requestTimeoutMs = parsePositiveInteger(process.env.OBS_VALIDATE_REQUEST_TIMEOUT_MS, 6000);
	const testRequestId = "obs-validate-request-001";
	const serverLogs = [];
	let serverProcess = null;

	try {
		serverProcess = spawn(process.execPath, ["server.js"], {
			cwd: backendRoot,
			env: {
				...process.env,
				PORT: String(port),
				RATE_LIMIT_MAX: "2000",
				RATE_LIMIT_WINDOW_MS: "60000",
				ALERT_P95_THRESHOLD_MS: "1",
				ALERT_P95_MIN_SAMPLES: "3",
				ALERT_PRUNE_OUTAGE_MIN_ATTEMPTS: "3",
				ALERT_PRUNE_OUTAGE_AVAILABILITY_THRESHOLD: "0",
				SCALEDOWN_API_URL: "http://127.0.0.1:9/unavailable",
				SCALEDOWN_FORCE_REMOTE: "true",
				SCALEDOWN_MIN_CANDIDATES: "1"
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

			if (serverLogs.length > 250) {
				serverLogs.splice(0, serverLogs.length - 250);
			}
		};

		serverProcess.stdout.on("data", appendServerLog);
		serverProcess.stderr.on("data", appendServerLog);

		await waitForServerHealth(baseUrl, healthTimeoutMs);

		const triageQuery = "severe chest pain and sweating fever cough headache and weakness";
		const firstResponse = await axios.post(
			`${baseUrl}/triage`,
			{ query: triageQuery, limit: 5 },
			{
				headers: {
					"Content-Type": "application/json",
					"x-request-id": testRequestId
				},
				timeout: requestTimeoutMs,
				validateStatus: () => true
			}
		);

		if (firstResponse.status >= 400) {
			throw new Error(`Initial triage call failed with status ${firstResponse.status}`);
		}

		for (let index = 0; index < 5; index += 1) {
			const response = await axios.post(
				`${baseUrl}/triage`,
				{ query: triageQuery, limit: 5 },
				{
					headers: { "Content-Type": "application/json" },
					timeout: requestTimeoutMs,
					validateStatus: () => true
				}
			);

			if (response.status >= 400) {
				throw new Error(`Warm triage call #${index + 1} failed with status ${response.status}`);
			}
		}

		const [metricsResponse, dashboardResponse, alertsResponse, dashboardHtmlResponse] = await Promise.all([
			axios.get(`${baseUrl}/metrics`, {
				timeout: requestTimeoutMs,
				responseType: "text",
				validateStatus: () => true
			}),
			axios.get(`${baseUrl}/observability/dashboard`, {
				timeout: requestTimeoutMs,
				validateStatus: () => true
			}),
			axios.get(`${baseUrl}/observability/alerts`, {
				timeout: requestTimeoutMs,
				validateStatus: () => true
			}),
			axios.get(`${baseUrl}/observability/dashboard.html`, {
				timeout: requestTimeoutMs,
				responseType: "text",
				validateStatus: () => true
			})
		]);

		if (metricsResponse.status !== 200) {
			throw new Error(`Metrics endpoint failed with status ${metricsResponse.status}`);
		}

		if (dashboardResponse.status !== 200) {
			throw new Error(`Dashboard endpoint failed with status ${dashboardResponse.status}`);
		}

		if (alertsResponse.status !== 200) {
			throw new Error(`Alerts endpoint failed with status ${alertsResponse.status}`);
		}

		if (dashboardHtmlResponse.status !== 200) {
			throw new Error(`Dashboard HTML endpoint failed with status ${dashboardHtmlResponse.status}`);
		}

		const metricsText = String(metricsResponse.data || "");
		const dashboardData = dashboardResponse.data;
		const alertsData = alertsResponse.data;
		const responseHeaderRequestId = firstResponse.headers["x-request-id"] || "";
		const responseBodyRequestId = firstResponse.data?.request_id || "";
		const expectedMetrics = [
			"triage_http_latency_ms_p95",
			"triage_prune_reduction_ratio_avg",
			"triage_http_error_rate",
			"triage_external_prune_availability",
			"triage_alert_state"
		];
		const metricsPresent = expectedMetrics.every((name) => metricsText.includes(name));
		const dashboardHasTriage = Array.isArray(dashboardData?.endpoints)
			&& dashboardData.endpoints.some((endpoint) => endpoint && endpoint.endpoint === "/triage");
		const activeAlerts = alertsData?.active_alerts || [];
		const p95AlertActive = activeAlerts.includes("p95_latency_breach");
		const pruningOutageAlertActive = activeAlerts.includes("pruning_outage");
		const externalAvailability = Number(dashboardData?.external_prune?.availability || 0);
		const dashboardHtmlLive = String(dashboardHtmlResponse.data || "").includes("Triage Observability Dashboard");
		const structuredLogHasRequestId = serverLogs.some((line) => {
			try {
				const parsed = JSON.parse(line);
				return parsed.request_id === testRequestId && parsed.event === "request_completed";
			} catch (_error) {
				return false;
			}
		});

		const checks = [
			{
				name: "Request ID propagates in response header and body",
				passed: responseHeaderRequestId === testRequestId && responseBodyRequestId === testRequestId,
				details: `header=${responseHeaderRequestId || "missing"}, body=${responseBodyRequestId || "missing"}`
			},
			{
				name: "Structured logs include request_id",
				passed: structuredLogHasRequestId,
				details: structuredLogHasRequestId
					? "request_completed log found with matching request_id"
					: "matching request_id not found in recent server logs"
			},
			{
				name: "Metrics endpoint exposes required observability metrics",
				passed: metricsPresent,
				details: metricsPresent ? "all required metric names found" : "one or more expected metrics missing"
			},
			{
				name: "Dashboard API is live with triage endpoint data",
				passed: dashboardHasTriage,
				details: dashboardHasTriage ? "triage endpoint present in snapshot" : "triage endpoint missing from dashboard snapshot"
			},
			{
				name: "Dashboard HTML page is live",
				passed: dashboardHtmlLive,
				details: dashboardHtmlLive ? "dashboard title found in HTML payload" : "dashboard HTML payload did not contain expected title"
			},
			{
				name: "P95 latency breach alert triggers",
				passed: p95AlertActive,
				details: p95AlertActive ? "p95_latency_breach is active" : "p95_latency_breach not active"
			},
			{
				name: "Pruning outage alert triggers",
				passed: pruningOutageAlertActive,
				details: pruningOutageAlertActive ? "pruning_outage is active" : "pruning_outage not active"
			},
			{
				name: "External prune availability reflects outage",
				passed: externalAvailability <= 0.01,
				details: `availability=${externalAvailability}`
			}
		];

		const reportMarkdown = writeReportMarkdown({
			generatedAt: new Date().toISOString(),
			baseUrl,
			checks,
			dashboardData,
			alertsData,
			metricsPreview: metricsText.split(/\r?\n/).slice(0, 60).join("\n"),
			testRequestId
		});

		await fs.mkdir(path.dirname(reportPath), { recursive: true });
		await fs.writeFile(reportPath, reportMarkdown, "utf8");

		const allPassed = checks.every((check) => check.passed);
		const output = {
			report_path: reportPath,
			base_url: baseUrl,
			all_passed: allPassed,
			failed_checks: checks.filter((check) => !check.passed).map((check) => check.name)
		};

		console.log(JSON.stringify(output, null, 2));

		if (!allPassed) {
			process.exitCode = 1;
		}
	} catch (error) {
		console.error("Observability validation failed:", error.message);
		if (serverLogs.length > 0) {
			console.error("Recent backend logs:");
			for (const line of serverLogs.slice(-25)) {
				console.error(line);
			}
		}
		process.exitCode = 1;
	} finally {
		await stopServerProcess(serverProcess);
	}
}

run();
