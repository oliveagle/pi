/**
 * Completion metric instruments for pi-ai.
 *
 * Instruments are cached per meter so a host swapping the global MeterProvider
 * gets fresh instruments without leaking the old pipeline. All record functions
 * are no-ops when telemetry is disabled.
 */

import { type Counter, type Histogram, type Meter, metrics } from "@opentelemetry/api";
import type { Api, AssistantMessage, Model } from "../types.ts";
import { isTelemetryEnabled } from "./otel-config.ts";

interface CompletionInstruments {
	requests: Counter;
	duration: Histogram;
	tokens: Histogram;
	errors: Counter;
}

let instrumentsCache: { meter: Meter; instruments: CompletionInstruments } | null = null;

function completionInstruments(): CompletionInstruments {
	const meter = metrics.getMeter("pi-ai");
	if (instrumentsCache && instrumentsCache.meter === meter) {
		return instrumentsCache.instruments;
	}
	const instruments: CompletionInstruments = {
		requests: meter.createCounter("pi.completion.requests", {
			description: "Total number of LLM completion requests",
			unit: "{request}",
		}),
		duration: meter.createHistogram("pi.completion.duration", {
			description: "LLM completion duration in milliseconds",
			unit: "ms",
		}),
		tokens: meter.createHistogram("pi.completion.tokens", {
			description: "LLM completion token usage",
			unit: "{token}",
		}),
		errors: meter.createCounter("pi.completion.errors", {
			description: "Total number of LLM completion errors",
			unit: "{error}",
		}),
	};
	instrumentsCache = { meter, instruments };
	return instruments;
}

/**
 * Record completion metrics for a finished stream: request count (with
 * provider/model/status attributes), duration histogram (ms), token usage
 * histogram (input/output/total) and, for error stop reasons, the error
 * counter. No-op when telemetry is disabled.
 */
export function recordCompletionMetrics(model: Model<Api>, message: AssistantMessage, durationMs: number): void {
	if (!isTelemetryEnabled()) return;
	const instruments = completionInstruments();
	const attributes = { "pi.provider": model.provider, "pi.model": model.id };
	instruments.requests.add(1, { ...attributes, "pi.status": message.stopReason });
	instruments.duration.record(durationMs, attributes);
	instruments.tokens.record(message.usage.input, { ...attributes, "pi.token_type": "input" });
	instruments.tokens.record(message.usage.output, { ...attributes, "pi.token_type": "output" });
	instruments.tokens.record(message.usage.totalTokens, { ...attributes, "pi.token_type": "total" });
	if (message.stopReason === "error") {
		instruments.errors.add(1, { ...attributes, "pi.error_type": "completion" });
	}
}

/**
 * Record metrics for a failed completion attempt: request count with status
 * "error" and the error counter with provider/model/error_type attributes.
 * `errorType` distinguishes setup failures from stream-phase failures.
 * No-op when telemetry is disabled.
 */
export function recordCompletionError(model: Model<Api>, errorType: "setup" | "stream"): void {
	if (!isTelemetryEnabled()) return;
	const instruments = completionInstruments();
	const attributes = { "pi.provider": model.provider, "pi.model": model.id };
	instruments.requests.add(1, { ...attributes, "pi.status": "error" });
	instruments.errors.add(1, { ...attributes, "pi.error_type": errorType });
}
