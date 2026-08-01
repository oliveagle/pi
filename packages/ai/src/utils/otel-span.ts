/**
 * Stream span creation for pi-ai.
 *
 * Spans are named `pi.stream` and carry model-derived attributes plus optional
 * caller-supplied ones. When telemetry is disabled a no-op span is returned so
 * callers never need null checks.
 */

import {
	INVALID_SPANID,
	INVALID_TRACEID,
	context as otelContext,
	type Span,
	type SpanContext,
	trace,
} from "@opentelemetry/api";
import type { Api, Model } from "../types.ts";
import { isTelemetryEnabled } from "./otel-config.ts";

/**
 * Span context of the currently active span, or undefined when no host tracer
 * is registered / no span is active. Callers pass the result straight into
 * `lazyStream(model, setup, parentContext)` so the stream span becomes a child
 * of the caller's span. Exported so consumers (e.g. pi-coding-agent) do not
 * need a direct `@opentelemetry/api` dependency.
 */
export function activeSpanContext(): SpanContext | undefined {
	const ctx = trace.getActiveSpan()?.spanContext();
	if (!ctx || ctx.traceId === INVALID_TRACEID || ctx.spanId === INVALID_SPANID) return undefined;
	return ctx;
}

/**
 * Optional per-stream span attributes that are not derivable from the model:
 * the requested thinking level and the caller's session id.
 */
export interface StreamSpanOptions {
	thinking?: string;
	sessionId?: string;
}

/**
 * Project the telemetry-relevant fields of stream options onto
 * `StreamSpanOptions`. Returns undefined when neither field is present so
 * callers can pass the result straight through to `lazyStream`.
 */
export function streamSpanOptions(options?: { reasoning?: string; sessionId?: string }): StreamSpanOptions | undefined {
	if (!options?.reasoning && !options?.sessionId) return undefined;
	return { thinking: options.reasoning, sessionId: options.sessionId };
}

/**
 * Create a span representing a single LLM stream lifecycle. When
 * `parentContext` is supplied the span becomes a child of that context;
 * otherwise it uses the active context (which may be root when no host
 * tracer is registered). Returns a no-op Span when telemetry is disabled so
 * callers can unconditionally call `.end()` / `.setAttribute()`.
 */
export function startStreamSpan(model: Model<Api>, parentContext?: SpanContext, otelOptions?: StreamSpanOptions): Span {
	if (!isTelemetryEnabled()) {
		// Return a no-op span so callers don't need null checks.
		return trace.getTracer("pi-ai").startSpan("pi.stream");
	}
	const tracer = trace.getTracer("pi-ai");
	const attributes: Record<string, string | number | boolean> = {
		"pi.provider": model.provider,
		"pi.model": model.id,
		"pi.context_window": model.contextWindow,
		"pi.max_tokens": model.maxTokens,
		"pi.streaming": true,
	};
	// Omitted rather than set to "" / "unknown" when the caller has no value, so
	// backends can distinguish "not reported" from "reported empty".
	if (otelOptions?.thinking) attributes["pi.thinking"] = otelOptions.thinking;
	if (otelOptions?.sessionId) attributes["pi.session_id"] = otelOptions.sessionId;
	if (parentContext) {
		const parentCtx = trace.setSpanContext(otelContext.active(), parentContext);
		return tracer.startSpan("pi.stream", { attributes }, parentCtx);
	}
	return tracer.startSpan("pi.stream", { attributes });
}
