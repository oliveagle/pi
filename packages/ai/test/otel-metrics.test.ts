import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import type { Api, AssistantMessage, Model } from "../src/types.ts";
import {
	getTelemetryConfig,
	mergeEnvOverrides,
	recordCompletionError,
	recordCompletionMetrics,
	setTelemetryConfig,
	shutdownTelemetry,
} from "../src/utils/otel.ts";

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
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

afterEach(async () => {
	await shutdownTelemetry().catch(() => {});
});

it("is disabled by default and record functions are no-ops", () => {
	expect(getTelemetryConfig().enabled).toBe(false);
	const model = makeModel();
	expect(() => {
		recordCompletionMetrics(model, makeMessage(), 123);
		recordCompletionError(model, "setup");
		recordCompletionError(model, "stream");
	}).not.toThrow();
});

it("applies PI_OTEL_ENABLED and OTEL_EXPORTER_OTLP_ENDPOINT env overrides", () => {
	const prevEnabled = process.env.PI_OTEL_ENABLED;
	const prevEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
	process.env.PI_OTEL_ENABLED = "1";
	process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector:4318";
	try {
		const merged = mergeEnvOverrides({});
		expect(merged.enabled).toBe(true);
		expect(merged.endpoint).toBe("http://collector:4318");
	} finally {
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

it("exports completion metrics via OTLP HTTP to the configured endpoint", async () => {
	// Isolate from ambient env overrides (PI_OTEL_ENABLED /
	// OTEL_EXPORTER_OTLP_ENDPOINT) so the exporter targets the local server.
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
		const ok = await setTelemetryConfig({ enabled: true, endpoint });
		expect(ok).toBe(true);

		const model = makeModel();
		recordCompletionMetrics(model, makeMessage({ stopReason: "stop" }), 123);
		recordCompletionMetrics(model, makeMessage({ stopReason: "error" }), 45);
		recordCompletionError(model, "setup");
		recordCompletionError(model, "stream");

		await shutdownTelemetry();

		expect(requests.length).toBeGreaterThan(0);
		expect(requests.every((r) => r.url.endsWith("/v1/metrics"))).toBe(true);
		const bodies = requests.map((r) => r.body).join("\n");
		expect(bodies).toContain("pi.completion.requests");
		expect(bodies).toContain("pi.completion.duration");
		expect(bodies).toContain("pi.completion.tokens");
		expect(bodies).toContain("pi.completion.errors");
		expect(bodies).toContain("test-provider");
		expect(bodies).toContain("test-model");
		expect(bodies).toContain("service.name");
		expect(bodies).toContain("pi");
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
