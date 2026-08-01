import type { SpanContext } from "@opentelemetry/api";
import type { Api, AssistantMessage, AssistantMessageEvent, Model, ProviderStreams } from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import {
	logCompletion,
	logCompletionError,
	recordCompletionError,
	recordCompletionMetrics,
	type StreamSpanOptions,
	startStreamSpan,
	streamSpanOptions,
} from "../utils/otel.ts";

function createSetupErrorMessage(model: Model<Api>, error: unknown): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

function hasResult(
	source: AsyncIterable<AssistantMessageEvent>,
): source is AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> } {
	return typeof (source as { result?: unknown }).result === "function";
}

async function forwardStream(
	target: AssistantMessageEventStream,
	source: AsyncIterable<AssistantMessageEvent>,
	model: Model<Api>,
	startedAt: number,
	span: import("@opentelemetry/api").Span,
): Promise<void> {
	for await (const event of source) {
		target.push(event);
	}
	const finalMessage = hasResult(source) ? await source.result() : undefined;
	const durationMs = performance.now() - startedAt;
	if (finalMessage) {
		span.setAttribute("pi.status", finalMessage.stopReason);
		recordCompletionMetrics(model, finalMessage, durationMs);
		// Fire-and-forget: structured log emit is async (lazy OTEL SDK load);
		// the caller already has the AssistantMessage in hand. Failures are
		// swallowed inside logCompletion().
		void logCompletion(model, finalMessage, durationMs);
	}
	span.end();
	target.end(finalMessage);
}

/**
 * Returns a stream synchronously while running async setup (auth resolution,
 * lazy module loading) behind it. Setup failures terminate the stream with an
 * error event.
 *
 * When `parentContext` is supplied the stream span becomes a child of that
 * span context, enabling trace correlation from the caller (e.g. the agent
 * runtime passing its active span). `otelOptions` carries span attributes that
 * are not derivable from the model (thinking level, session id).
 */
export function lazyStream(
	model: Model<Api>,
	setup: () => Promise<AsyncIterable<AssistantMessageEvent>>,
	parentContext?: SpanContext,
	otelOptions?: StreamSpanOptions,
): AssistantMessageEventStream {
	const outer = new AssistantMessageEventStream();
	const startedAt = performance.now();
	const span = startStreamSpan(model, parentContext, otelOptions);
	let streaming = false;

	setup()
		.then((inner) => {
			streaming = true;
			return forwardStream(outer, inner, model, startedAt, span);
		})
		.catch((error) => {
			// Setup failures (auth, lazy module load) and stream-phase failures
			// (source stream throwing) both land here; the flag distinguishes them
			// for the error_type metric attribute.
			const errorType = streaming ? "stream" : "setup";
			span.setAttribute("pi.error_type", errorType);
			span.setAttribute("pi.status", "error");
			span.end();
			recordCompletionError(model, errorType);
			void logCompletionError(model, errorType, error);
			const message = createSetupErrorMessage(model, error);
			outer.push({ type: "error", reason: "error", error: message });
			outer.end(message);
		});

	return outer;
}

/**
 * Wraps a dynamically imported API implementation module as `ProviderStreams`.
 * The module loads on first stream call; the host's import cache deduplicates
 * loads. Load failures terminate the returned stream with an error event.
 */
export function lazyApi(load: () => Promise<ProviderStreams>): ProviderStreams {
	return {
		stream: (model, context, options) =>
			lazyStream(
				model,
				async () => (await load()).stream(model, context, options),
				undefined,
				streamSpanOptions(options),
			),
		streamSimple: (model, context, options) =>
			lazyStream(
				model,
				async () => (await load()).streamSimple(model, context, options),
				undefined,
				streamSpanOptions(options),
			),
	};
}
