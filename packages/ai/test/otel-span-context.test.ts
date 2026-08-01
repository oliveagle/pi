import type { SpanContext } from "@opentelemetry/api";
import { afterEach, describe, expect, it } from "vitest";

import { lazyStream } from "../src/api/lazy.ts";
import type { Api, AssistantMessage, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { shutdownTelemetry, startStreamSpan } from "../src/utils/otel.ts";

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
	} as Model<Api>;
}

function makeMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "test-provider",
		model: "test-model",
		usage: {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function makeSource(): AssistantMessageEventStream {
	const msg = makeMessage();
	const stream = new AssistantMessageEventStream();
	stream.push({ type: "done", reason: "stop", message: msg });
	stream.end(msg);
	return stream;
}

afterEach(async () => {
	await shutdownTelemetry().catch(() => {});
});

describe("startStreamSpan", () => {
	it("returns a span when telemetry is disabled (no-op)", async () => {
		const model = makeModel();
		const span = startStreamSpan(model);
		expect(span).toBeDefined();
		expect(typeof span.end).toBe("function");
		span.end();
	});

	it("accepts an optional parentContext without throwing", async () => {
		const model = makeModel();
		const parentContext: SpanContext = {
			traceId: "abcdef0123456789abcdef0123456789",
			spanId: "0123456789abcdef",
			traceFlags: 1,
		};
		const span = startStreamSpan(model, parentContext);
		expect(span).toBeDefined();
		span.end();
	});
});

describe("lazyStream parentContext", () => {
	it("is backward compatible (no parentContext)", async () => {
		const model = makeModel();
		const stream = lazyStream(model, async () => makeSource());
		const result = await stream.result();
		expect(result.stopReason).toBe("stop");
	});

	it("accepts an optional parentContext parameter", async () => {
		const model = makeModel();
		const parentContext: SpanContext = {
			traceId: "abcdef0123456789abcdef0123456789",
			spanId: "0123456789abcdef",
			traceFlags: 1,
		};
		const stream = lazyStream(model, async () => makeSource(), parentContext);
		const result = await stream.result();
		expect(result.stopReason).toBe("stop");
	});

	it("parentContext does not affect error handling", async () => {
		const model = makeModel();
		const parentContext: SpanContext = {
			traceId: "abcdef0123456789abcdef0123456789",
			spanId: "0123456789abcdef",
			traceFlags: 1,
		};
		const stream = lazyStream(
			model,
			async () => {
				throw new Error("setup failed");
			},
			parentContext,
		);
		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("setup failed");
	});
});
