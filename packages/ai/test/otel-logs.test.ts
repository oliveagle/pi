import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import type { Api, AssistantMessage, Model } from "../src/types.ts";
import { logCompletion, logCompletionError, setTelemetryConfig, shutdownTelemetry } from "../src/utils/otel.ts";

function makeModel(): Model<Api> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "openai-responses",
		provider: "test-provider",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
}

function makeMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "test-provider",
		model: "test-model",
		usage: {
			input: 10,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 30,
			cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

afterEach(async () => {
	vi.restoreAllMocks();
	await shutdownTelemetry().catch(() => {});
});

it("logCompletion is a no-op when telemetry is disabled", async () => {
	// No setTelemetryConfig call → disabled. Should resolve without throwing
	// even when the OTEL SDK is missing (lazy logger init catches MODULE_NOT_FOUND).
	const model = makeModel();
	await expect(logCompletion(model, makeMessage(), 123)).resolves.toBeUndefined();
	await expect(logCompletionError(model, "setup", new Error("boom"))).resolves.toBeUndefined();
});

it("emits an INFO structured log per completion via the console exporter", async () => {
	const ok = await setTelemetryConfig({ enabled: true, logExporter: "console" });
	expect(ok).toBe(true);

	const dirSpy = vi.spyOn(console, "dir").mockImplementation(() => {});

	const model = makeModel();
	await logCompletion(model, makeMessage(), 321);

	// ConsoleLogRecordExporter writes synchronously on emit; give the microtask
	// queue one tick to flush.
	await new Promise<void>((resolve) => setImmediate(resolve));

	expect(dirSpy).toHaveBeenCalled();
	const printed = dirSpy.mock.calls.map((args) => JSON.stringify(args[0])).join("\n");
	expect(printed).toContain("llm.completion");
	expect(printed).toContain("test-provider");
	expect(printed).toContain("test-model");
	expect(printed).toContain("321");
	expect(printed).toContain("pi.duration_ms");
	expect(printed).toContain("pi.input_tokens");
	expect(printed).toContain("pi.output_tokens");
	expect(printed).toContain("pi.total_tokens");
	expect(printed).toContain("pi.cost");
	expect(printed).toContain("pi.stop_reason");
	expect(printed).toContain("pi.trace_id");
	expect(printed).toContain("pi.span_id");
	// INFO severity rendered as level text and OTEL severity number 9
	expect(printed).toContain("INFO");
	expect(printed).toContain('"severityNumber":9');
});

it("emits an ERROR structured log when a completion fails", async () => {
	const ok = await setTelemetryConfig({ enabled: true, logExporter: "console" });
	expect(ok).toBe(true);

	const dirSpy = vi.spyOn(console, "dir").mockImplementation(() => {});

	const model = makeModel();
	await logCompletionError(model, "stream", new Error("connection reset"));

	await new Promise<void>((resolve) => setImmediate(resolve));

	expect(dirSpy).toHaveBeenCalled();
	const printed = dirSpy.mock.calls.map((args) => JSON.stringify(args[0])).join("\n");
	expect(printed).toContain("llm.completion.error");
	expect(printed).toContain("stream");
	expect(printed).toContain("connection reset");
	expect(printed).toContain("test-provider");
	expect(printed).toContain("test-model");
	expect(printed).toContain("ERROR");
	expect(printed).toContain('"severityNumber":17');
});

it("exports structured logs via OTLP HTTP when logExporter=otlp", async () => {
	// Isolate from ambient env overrides.
	const prevEnabled = process.env.PI_OTEL_ENABLED;
	const prevEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
	delete process.env.PI_OTEL_ENABLED;
	delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

	const requests: { url: string; body: string }[] = [];
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk) => chunks.push(chunk as Buffer));
		req.on("end", () => {
			requests.push({ url: req.url ?? "", body: Buffer.concat(chunks).toString("utf8") });
			res.statusCode = 200;
			res.end();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("failed to bind test server");
	}
	const endpoint = `http://127.0.0.1:${address.port}`;

	try {
		const ok = await setTelemetryConfig({ enabled: true, endpoint, logExporter: "otlp" });
		expect(ok).toBe(true);

		const model = makeModel();
		await logCompletion(model, makeMessage(), 999);
		await logCompletionError(model, "setup", new Error("auth failed"));

		// SimpleLogRecordProcessor dispatches each export asynchronously; wait
		// for both server requests to land before asserting.
		await new Promise<void>((resolve) => {
			const deadline = Date.now() + 2000;
			const tick = () => {
				if (requests.length >= 2 || Date.now() > deadline) resolve();
				else setTimeout(tick, 20);
			};
			tick();
		});

		await shutdownTelemetry();

		expect(requests.length).toBeGreaterThan(0);
		expect(requests.every((r) => r.url.endsWith("/v1/logs"))).toBe(true);
		const bodies = requests.map((r) => r.body).join("\n");
		expect(bodies).toContain("llm.completion");
		expect(bodies).toContain("llm.completion.error");
		expect(bodies).toContain("test-provider");
		expect(bodies).toContain("test-model");
		expect(bodies).toContain("pi.duration_ms");
		expect(bodies).toContain("pi.input_tokens");
		expect(bodies).toContain("pi.output_tokens");
		expect(bodies).toContain("pi.total_tokens");
		expect(bodies).toContain("pi.cost");
		expect(bodies).toContain("pi.stop_reason");
		expect(bodies).toContain("pi.trace_id");
		expect(bodies).toContain("pi.span_id");
		expect(bodies).toContain("pi.error_message");
		expect(bodies).toContain("auth failed");
		// SeverityNumber mapping: 9 = INFO, 17 = ERROR
		expect(bodies).toContain('"severityNumber":9');
		expect(bodies).toContain('"severityNumber":17');
	} finally {
		await shutdownTelemetry().catch(() => {});
		await new Promise<void>((resolve) => server.close(() => resolve()));
		if (prevEnabled === undefined) {
			delete process.env.PI_OTEL_ENABLED;
		} else {
			process.env.PI_OTEL_ENABLED = prevEnabled;
		}
		if (prevEndpoint === undefined) {
			delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
		} else {
			process.env.OTEL_EXPORTER_OTLP_ENDPOINT = prevEndpoint;
		}
	}
});
