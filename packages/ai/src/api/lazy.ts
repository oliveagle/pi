import type { Api, AssistantMessage, AssistantMessageEvent, Model, ProviderStreams } from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { logCompletion, logCompletionError, recordCompletionError, recordCompletionMetrics } from "../utils/otel.ts";

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
): Promise<void> {
	for await (const event of source) {
		target.push(event);
	}
	const finalMessage = hasResult(source) ? await source.result() : undefined;
	const durationMs = Date.now() - startedAt;
	if (finalMessage) {
		recordCompletionMetrics(model, finalMessage, durationMs);
		// Fire-and-forget: structured log emit is async (lazy OTEL SDK load);
		// the caller already has the AssistantMessage in hand. Failures are
		// swallowed inside logCompletion().
		void logCompletion(model, finalMessage, durationMs);
	}
	target.end(finalMessage);
}

/**
 * Returns a stream synchronously while running async setup (auth resolution,
 * lazy module loading) behind it. Setup failures terminate the stream with an
 * error event.
 */
export function lazyStream(
	model: Model<Api>,
	setup: () => Promise<AsyncIterable<AssistantMessageEvent>>,
): AssistantMessageEventStream {
	const outer = new AssistantMessageEventStream();
	const startedAt = Date.now();
	let streaming = false;

	setup()
		.then((inner) => {
			streaming = true;
			return forwardStream(outer, inner, model, startedAt);
		})
		.catch((error) => {
			// Setup failures (auth, lazy module load) and stream-phase failures
			// (source stream throwing) both land here; the flag distinguishes them
			// for the error_type metric attribute.
			const errorType = streaming ? "stream" : "setup";
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
			lazyStream(model, async () => (await load()).stream(model, context, options)),
		streamSimple: (model, context, options) =>
			lazyStream(model, async () => (await load()).streamSimple(model, context, options)),
	};
}
