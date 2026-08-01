/**
 * Structured completion logging for pi-ai.
 *
 * One log record per completion (success or failure) with the field shape
 * operators asked for, emitted through the OTEL LoggerProvider so the
 * configured exporter (console or OTLP/HTTP) decides where it lands. All emit
 * functions are no-ops when telemetry is disabled.
 */

import type { HrTime } from "@opentelemetry/api";
import { trace } from "@opentelemetry/api";
import type { Logger } from "@opentelemetry/api-logs";
import type { Api, AssistantMessage, Model } from "../types.ts";
import { ensureLoggerProvider, isTelemetryRequested } from "./otel-config.ts";
import { uuidv7 } from "./uuid.ts";

/**
 * Pull the active traceId/spanId pair for log correlation. When the host has
 * registered a global tracer and a span is active, use the span context.
 * Otherwise generate a fresh UUIDv7 trace id + random span id so logs still
 * carry something the operator can grep for.
 */
function currentTraceSpanIds(): { traceId: string; spanId: string } {
	try {
		const activeSpan = trace.getActiveSpan();
		const ctx = activeSpan?.spanContext();
		if (ctx?.traceId && ctx.traceId !== "00000000000000000000000000000000") {
			return { traceId: ctx.traceId, spanId: ctx.spanId };
		}
	} catch {
		// fall through to generated ids
	}
	const traceId = uuidv7().replace(/-/g, "").padEnd(32, "0").slice(0, 32);
	const spanBytes = new Uint8Array(8);
	if (globalThis.crypto?.getRandomValues) {
		globalThis.crypto.getRandomValues(spanBytes);
	} else {
		for (let i = 0; i < spanBytes.length; i++) spanBytes[i] = Math.floor(Math.random() * 256);
	}
	const spanId = Array.from(spanBytes, (b) => b.toString(16).padStart(2, "0")).join("");
	return { traceId, spanId };
}

let loggerCache: { provider: unknown; logger: Logger } | null = null;

async function completionLogger(): Promise<Logger | null> {
	if (!isTelemetryRequested()) return null;
	const ready = await ensureLoggerProvider();
	if (!ready) return null;
	const { logs } = (await import("@opentelemetry/api-logs")) as typeof import("@opentelemetry/api-logs");
	const provider = logs.getLoggerProvider();
	if (loggerCache && loggerCache.provider === provider) {
		return loggerCache.logger;
	}
	const logger = provider.getLogger("pi-ai");
	loggerCache = { provider, logger };
	return logger;
}

function nowHrTime(): HrTime {
	const ms = Date.now();
	const sec = Math.floor(ms / 1000);
	const ns = (ms - sec * 1000) * 1_000_000;
	return [sec, ns];
}

function completionLogAttributes(
	model: Model<Api>,
	extra: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
	return {
		"pi.provider": model.provider,
		"pi.model": model.id,
		...extra,
	};
}

/**
 * Emit a single structured log line per completion with the field shape
 * requested by operators: timestamp / level / provider / model / duration_ms
 * / input_tokens / output_tokens / total_tokens / cost / stop_reason /
 * traceId / spanId. Uses the OTEL LoggerProvider (so when logExporter is
 * "console" it goes via ConsoleLogRecordExporter; when "otlp" via the OTLP
 * HTTP exporter). No-op when telemetry is disabled.
 */
export async function logCompletion(model: Model<Api>, message: AssistantMessage, durationMs: number): Promise<void> {
	if (!isTelemetryRequested()) return;
	const logger = await completionLogger();
	if (!logger) return;
	const { SeverityNumber } = (await import("@opentelemetry/api-logs")) as typeof import("@opentelemetry/api-logs");
	const ids = currentTraceSpanIds();
	logger.emit({
		timestamp: nowHrTime(),
		severityNumber: SeverityNumber.INFO,
		severityText: "INFO",
		body: "llm.completion",
		attributes: completionLogAttributes(model, {
			"pi.duration_ms": durationMs,
			"pi.input_tokens": message.usage.input,
			"pi.output_tokens": message.usage.output,
			"pi.total_tokens": message.usage.totalTokens,
			"pi.cost": message.usage.cost.total,
			"pi.stop_reason": message.stopReason,
			"pi.trace_id": ids.traceId,
			"pi.span_id": ids.spanId,
			traceId: ids.traceId,
			spanId: ids.spanId,
		}),
	});
}

/**
 * Emit a structured ERROR log line for a failed completion attempt. Includes
 * the error message and the same provider/model correlation fields as the
 * success path. `errorType` distinguishes setup failures from stream-phase
 * failures. No-op when telemetry is disabled.
 */
export async function logCompletionError(
	model: Model<Api>,
	errorType: "setup" | "stream",
	error: unknown,
): Promise<void> {
	if (!isTelemetryRequested()) return;
	const logger = await completionLogger();
	if (!logger) return;
	const { SeverityNumber } = (await import("@opentelemetry/api-logs")) as typeof import("@opentelemetry/api-logs");
	const ids = currentTraceSpanIds();
	const errorMessage = error instanceof Error ? error.message : String(error);
	logger.emit({
		timestamp: nowHrTime(),
		severityNumber: SeverityNumber.ERROR,
		severityText: "ERROR",
		body: "llm.completion.error",
		attributes: completionLogAttributes(model, {
			"pi.error_type": errorType,
			"pi.error_message": errorMessage,
			"pi.stop_reason": "error",
			"pi.trace_id": ids.traceId,
			"pi.span_id": ids.spanId,
			traceId: ids.traceId,
			spanId: ids.spanId,
		}),
	});
}
