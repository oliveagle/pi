/**
 * OpenTelemetry entry point for pi-ai. Re-exports the telemetry surface from
 * the focused modules:
 *
 * - `otel-config.ts`: TelemetryConfig, SDK init/shutdown, env overrides.
 * - `otel-metrics.ts`: completion counters/histograms.
 * - `otel-logs.ts`: structured completion log records.
 * - `otel-log-exporter.ts`: minimal OTLP/HTTP JSON logs exporter.
 * - `otel-span.ts`: `pi.stream` span creation and span-context helpers.
 */

export {
	DEFAULT_TELEMETRY_CONFIG,
	ensureLoggerProvider,
	getTelemetryConfig,
	isTelemetryEnabled,
	isTelemetryRequested,
	mergeEnvOverrides,
	setTelemetryConfig,
	shutdownTelemetry,
	type TelemetryConfig,
} from "./otel-config.ts";
export { OtlpHttpLogRecordExporter } from "./otel-log-exporter.ts";
export { logCompletion, logCompletionError } from "./otel-logs.ts";
export { recordCompletionError, recordCompletionMetrics } from "./otel-metrics.ts";
export { activeSpanContext, type StreamSpanOptions, startStreamSpan, streamSpanOptions } from "./otel-span.ts";
