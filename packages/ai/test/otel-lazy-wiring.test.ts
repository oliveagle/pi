import { afterEach, expect, it, vi } from "vitest";
import { lazyStream } from "../src/api/lazy.ts";
import type { Api, AssistantMessageEvent, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { setTelemetryConfig, shutdownTelemetry } from "../src/utils/otel.ts";

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

function makeMessage() {
	return {
		role: "assistant" as const,
		content: [],
		api: "openai-responses" as const,
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
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

afterEach(async () => {
	vi.restoreAllMocks();
	await shutdownTelemetry().catch(() => {});
});

it("lazyStream emits a structured INFO log when a completion finishes", async () => {
	const dirSpy = vi.spyOn(console, "dir").mockImplementation(() => {});
	await setTelemetryConfig({ enabled: true, logExporter: "console" });

	const finalMessage = makeMessage();
	function source() {
		const stream = new AssistantMessageEventStream();
		stream.push({ type: "done", reason: "stop", message: finalMessage });
		stream.end(finalMessage);
		return stream;
	}

	const stream = lazyStream(makeModel(), async () => source());
	const result = await stream.result();
	expect(result.stopReason).toBe("stop");

	// Wait for fire-and-forget log emit to land in console.dir.
	await new Promise<void>((resolve) => {
		const deadline = Date.now() + 2000;
		const tick = () => {
			if (dirSpy.mock.calls.length > 0 || Date.now() > deadline) resolve();
			else setTimeout(tick, 20);
		};
		tick();
	});

	expect(dirSpy).toHaveBeenCalled();
	const printed = dirSpy.mock.calls.map((args) => JSON.stringify(args[0])).join("\n");
	expect(printed).toContain("llm.completion");
	expect(printed).toContain("test-provider");
	expect(printed).toContain("test-model");
	expect(printed).toContain("pi.duration_ms");
});

it("lazyStream emits a structured ERROR log when setup fails", async () => {
	const dirSpy = vi.spyOn(console, "dir").mockImplementation(() => {});
	await setTelemetryConfig({ enabled: true, logExporter: "console" });

	const stream = lazyStream(makeModel(), async () => {
		throw new Error("setup blew up");
	});
	const result = await stream.result();
	expect(result.stopReason).toBe("error");
	expect(result.errorMessage).toBe("setup blew up");

	await new Promise<void>((resolve) => {
		const deadline = Date.now() + 2000;
		const tick = () => {
			if (dirSpy.mock.calls.length > 0 || Date.now() > deadline) resolve();
			else setTimeout(tick, 20);
		};
		tick();
	});

	expect(dirSpy).toHaveBeenCalled();
	const printed = dirSpy.mock.calls.map((args) => JSON.stringify(args[0])).join("\n");
	expect(printed).toContain("llm.completion.error");
	expect(printed).toContain("setup");
	expect(printed).toContain("setup blew up");
});

it("lazyStream emits a structured ERROR log when the source stream throws", async () => {
	const dirSpy = vi.spyOn(console, "dir").mockImplementation(() => {});
	await setTelemetryConfig({ enabled: true, logExporter: "console" });

	const finalMessage = makeMessage();
	async function* throwingSource(): AsyncIterable<AssistantMessageEvent> {
		yield { type: "start", partial: finalMessage };
		throw new Error("mid-stream failure");
	}

	const stream = lazyStream(makeModel(), async () => throwingSource());
	const result = await stream.result();
	expect(result.stopReason).toBe("error");
	expect(result.errorMessage).toBe("mid-stream failure");

	await new Promise<void>((resolve) => {
		const deadline = Date.now() + 2000;
		const tick = () => {
			if (dirSpy.mock.calls.length > 0 || Date.now() > deadline) resolve();
			else setTimeout(tick, 20);
		};
		tick();
	});

	expect(dirSpy).toHaveBeenCalled();
	const printed = dirSpy.mock.calls.map((args) => JSON.stringify(args[0])).join("\n");
	expect(printed).toContain("llm.completion.error");
	expect(printed).toContain("stream");
	expect(printed).toContain("mid-stream failure");
});
