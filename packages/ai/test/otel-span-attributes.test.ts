// Unit tests for the span attributes startStreamSpan sets: model-derived ones
// plus the optional pi.thinking / pi.session_id pair, and their propagation
// through lazyStream's otelOptions parameter.

import { type Span, type SpanOptions, type Tracer, type TracerProvider, trace } from "@opentelemetry/api";
import { afterEach, beforeEach, expect, it } from "vitest";
import { lazyStream } from "../src/api/lazy.ts";
import type { Api, AssistantMessage, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { setTelemetryConfig, shutdownTelemetry, startStreamSpan, streamSpanOptions } from "../src/utils/otel.ts";

type Attributes = Record<string, unknown>;

const startedSpans: { name: string; attributes: Attributes }[] = [];

function fakeSpan(): Span {
	return {
		end: () => {},
		setAttribute: () => fakeSpan(),
		setAttributes: () => fakeSpan(),
		addEvent: () => fakeSpan(),
		setStatus: () => fakeSpan(),
		updateName: () => fakeSpan(),
		isRecording: () => true,
		recordException: () => {},
		spanContext: () => ({ traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 0 }),
		addLink: () => fakeSpan(),
		addLinks: () => fakeSpan(),
	} as unknown as Span;
}

/** Records startSpan calls so attributes can be asserted. */
const recordingTracerProvider: TracerProvider = {
	getTracer: (): Tracer =>
		({
			startSpan: (name: string, options?: SpanOptions): Span => {
				startedSpans.push({ name, attributes: (options?.attributes ?? {}) as Attributes });
				return fakeSpan();
			},
			startActiveSpan: () => {
				throw new Error("not used");
			},
		}) as unknown as Tracer,
};

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
	const message = makeMessage();
	const stream = new AssistantMessageEventStream();
	stream.push({ type: "done", reason: "stop", message });
	stream.end(message);
	return stream;
}

/**
 * Telemetry must be enabled for startStreamSpan to attach attributes; the
 * recording tracer provider stands in for a host-registered SDK tracer.
 */
async function enableTelemetry(): Promise<void> {
	trace.setGlobalTracerProvider(recordingTracerProvider);
	await setTelemetryConfig({ enabled: true, endpoint: "http://127.0.0.1:1/unused" });
}

beforeEach(() => {
	startedSpans.length = 0;
});

afterEach(async () => {
	await shutdownTelemetry().catch(() => {});
	trace.disable();
});

it("omits pi.thinking and pi.session_id when no otelOptions are supplied", async () => {
	await enableTelemetry();
	startStreamSpan(makeModel());

	expect(startedSpans).toHaveLength(1);
	const attributes = startedSpans[0].attributes;
	expect(attributes["pi.provider"]).toBe("test-provider");
	expect(attributes["pi.model"]).toBe("test-model");
	expect(attributes).not.toHaveProperty("pi.thinking");
	expect(attributes).not.toHaveProperty("pi.session_id");
});

it("sets pi.thinking and pi.session_id when supplied", async () => {
	await enableTelemetry();
	startStreamSpan(makeModel(), undefined, { thinking: "high", sessionId: "session-42" });

	expect(startedSpans[0].attributes["pi.thinking"]).toBe("high");
	expect(startedSpans[0].attributes["pi.session_id"]).toBe("session-42");
});

it("sets only the supplied attribute when the other is missing", async () => {
	await enableTelemetry();
	startStreamSpan(makeModel(), undefined, { thinking: "low" });
	startStreamSpan(makeModel(), undefined, { sessionId: "session-7" });

	expect(startedSpans[0].attributes["pi.thinking"]).toBe("low");
	expect(startedSpans[0].attributes).not.toHaveProperty("pi.session_id");
	expect(startedSpans[1].attributes).not.toHaveProperty("pi.thinking");
	expect(startedSpans[1].attributes["pi.session_id"]).toBe("session-7");
});

it("lazyStream forwards otelOptions to the stream span", async () => {
	await enableTelemetry();
	const stream = lazyStream(makeModel(), async () => makeSource(), undefined, {
		thinking: "medium",
		sessionId: "session-9",
	});
	await stream.result();

	expect(startedSpans[0].attributes["pi.thinking"]).toBe("medium");
	expect(startedSpans[0].attributes["pi.session_id"]).toBe("session-9");
});

it("streamSpanOptions maps reasoning to thinking and drops empty option sets", () => {
	expect(streamSpanOptions(undefined)).toBeUndefined();
	expect(streamSpanOptions({})).toBeUndefined();
	expect(streamSpanOptions({ reasoning: "xhigh" })).toEqual({ thinking: "xhigh", sessionId: undefined });
	expect(streamSpanOptions({ sessionId: "s1" })).toEqual({ thinking: undefined, sessionId: "s1" });
	expect(streamSpanOptions({ reasoning: "max", sessionId: "s2" })).toEqual({ thinking: "max", sessionId: "s2" });
});
