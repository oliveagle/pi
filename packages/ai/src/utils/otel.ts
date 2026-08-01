/**
 * OpenTelemetry metrics + structured logs loader for pi-ai.
 *
 * Design contract:
 * - Lazy load OTEL SDK + OTLP HTTP metric/log exporter (optionalDependencies).
 *   Missing packages are tolerated: telemetry silently disables with one
 *   warning.
 * - Idempotent init: repeated setTelemetryConfig() does not rebuild the
 *   providers. A shutdown + re-init cycle is supported.
 * - When telemetry is disabled, record* / emitLog functions are no-ops (one
 *   boolean read each) and the OTel API returns a no-op meter / logger whose
 *   instruments drop measurements, so the hot path stays branch-free at ~zero
 *   cost.
 * - Env overrides (PI_OTEL_ENABLED / OTEL_EXPORTER_OTLP_ENDPOINT) are applied
 *   at config-set time, not at every record call.
 */

import {
	type Counter,
	type Histogram,
	INVALID_SPANID,
	INVALID_TRACEID,
	type Meter,
	metrics,
	context as otelContext,
	type Span,
	type SpanContext,
	trace,
} from "@opentelemetry/api";
import type { ExportResult } from "@opentelemetry/core";
import type { LogRecordExporter, ReadableLogRecord } from "@opentelemetry/sdk-logs";
import type { Api, AssistantMessage, Model } from "../types.ts";
import { uuidv7 } from "./uuid.ts";

export interface TelemetryConfig {
	/** Master switch. False = metrics + logs fully off (no instruments, no exporter). */
	enabled: boolean;
	/** Base OTLP endpoint. Metrics → ${endpoint}/v1/metrics, logs → ${endpoint}/v1/logs. */
	endpoint: string;
	/** Reserved for future gRPC path. Default: "http". */
	protocol: "http";
	/** Service name attached to the metric/log resource. Default: "pi". */
	serviceName: string;
	/** Static resource attributes. */
	attributes: Record<string, string>;
	/**
	 * Where structured completion logs go. Default: "console" (one JSON line
	 * per completion on stdout). When set to "otlp", logs are exported to
	 * `${endpoint}/v1/logs` over OTLP/HTTP JSON. Ignored when telemetry is
	 * disabled.
	 */
	logExporter: "console" | "otlp";
}

export const DEFAULT_TELEMETRY_CONFIG: TelemetryConfig = {
	enabled: false,
	endpoint: "http://localhost:4318",
	protocol: "http",
	serviceName: "pi",
	attributes: {},
	logExporter: "console",
};

const NOOP_CONFIG: TelemetryConfig = { ...DEFAULT_TELEMETRY_CONFIG, enabled: false };

interface OtelInternals {
	initialized: boolean;
	config: TelemetryConfig;
	registeredGlobal: boolean;
	shutdown: (() => Promise<void>) | null;
	loggersInitialized: boolean;
	loggerShutdown: (() => Promise<void>) | null;
}

const internals: OtelInternals = {
	initialized: false,
	config: NOOP_CONFIG,
	registeredGlobal: false,
	shutdown: null,
	loggersInitialized: false,
	loggerShutdown: null,
};

let warnedModuleMissing = false;

/**
 * Apply env overrides (PI_OTEL_ENABLED / OTEL_EXPORTER_OTLP_ENDPOINT) on top
 * of the supplied partial config. Env wins over settings.
 */
export function mergeEnvOverrides(cfg: Partial<TelemetryConfig>): Partial<TelemetryConfig> {
	const merged: Partial<TelemetryConfig> = { ...cfg };
	const envEnabled = process.env.PI_OTEL_ENABLED;
	if (envEnabled === "1" || envEnabled === "true") {
		merged.enabled = true;
	} else if (envEnabled === "0" || envEnabled === "false") {
		merged.enabled = false;
	}
	const envEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
	if (envEndpoint) {
		merged.endpoint = envEndpoint;
	}
	return merged;
}

/**
 * Read effective telemetry config. Always returns a full object; missing
 * fields fall back to defaults.
 */
export function getTelemetryConfig(): TelemetryConfig {
	return { ...internals.config };
}

/**
 * Master switch check. Cheap (boolean read) so safe to call per completion.
 */
export function isTelemetryEnabled(): boolean {
	return internals.config.enabled && internals.initialized;
}

function metricsUrl(endpoint: string): string {
	const base = endpoint.replace(/\/+$/, "");
	if (base.endsWith("/v1/metrics")) {
		return base;
	}
	if (base.endsWith("/v1/traces")) {
		// Tolerate an endpoint configured for traces: metrics go to the
		// sibling /v1/metrics path on the same collector.
		return `${base.slice(0, -"/v1/traces".length)}/v1/metrics`;
	}
	return `${base}/v1/metrics`;
}

function logsUrl(endpoint: string): string {
	const base = endpoint.replace(/\/+$/, "");
	if (base.endsWith("/v1/logs")) {
		return base;
	}
	return `${base}/v1/logs`;
}

/**
 * Configure and initialize telemetry. Safe to call multiple times; subsequent
 * calls without intermediate shutdown() are no-ops for the SDK init but still
 * update the in-memory config.
 *
 * When a global MeterProvider / LoggerProvider was already registered by the
 * host, this function does not replace it (instruments/logs flow into the
 * host pipeline) and returns true. When the OTEL SDK packages are not
 * installed, returns false and falls back to telemetry off.
 */
export async function setTelemetryConfig(cfg: Partial<TelemetryConfig>): Promise<boolean> {
	const merged = mergeEnvOverrides(cfg);
	const next: TelemetryConfig = { ...DEFAULT_TELEMETRY_CONFIG, ...merged };

	// Always store the merged config — even when disabled — so getTelemetryConfig
	// reflects operator intent.
	internals.config = next;

	if (!next.enabled) {
		return false;
	}

	if (internals.initialized) {
		// Metrics already wired; still attempt logs init (idempotent).
		await ensureLoggerProvider();
		return true;
	}

	try {
		const sdkModule = (await import("@opentelemetry/sdk-metrics")) as typeof import("@opentelemetry/sdk-metrics");
		const exporterModule = (await import(
			"@opentelemetry/exporter-metrics-otlp-http"
		)) as typeof import("@opentelemetry/exporter-metrics-otlp-http");
		const resourcesModule = (await import("@opentelemetry/resources")) as typeof import("@opentelemetry/resources");
		const semconv = await import("@opentelemetry/semantic-conventions");

		const resource = resourcesModule.resourceFromAttributes({
			[semconv.SEMRESATTRS_SERVICE_NAME]: next.serviceName,
			...next.attributes,
		});
		const exporter = new exporterModule.OTLPMetricExporter({
			url: metricsUrl(next.endpoint),
		});
		const meterProvider = new sdkModule.MeterProvider({
			resource,
			readers: [
				new sdkModule.PeriodicExportingMetricReader({
					exporter,
					exportIntervalMillis: 60_000,
				}),
			],
		});
		const registered = metrics.setGlobalMeterProvider(meterProvider);

		if (registered) {
			internals.initialized = true;
			internals.registeredGlobal = true;
			internals.shutdown = async () => {
				await meterProvider.shutdown();
				metrics.disable();
				internals.initialized = false;
				internals.registeredGlobal = false;
				internals.shutdown = null;
			};
		} else {
			// A global MeterProvider is already registered (host-owned).
			// Instruments created via metrics.getMeter() flow into that
			// pipeline; do not run a second exporter.
			internals.initialized = true;
			internals.registeredGlobal = false;
			internals.shutdown = null;
		}
	} catch (err) {
		const code = (err as Error & { code?: string }).code;
		if (code === "MODULE_NOT_FOUND" && !warnedModuleMissing) {
			warnedModuleMissing = true;
			console.warn(
				"[pi-ai] telemetry enabled but @opentelemetry/sdk-metrics and/or @opentelemetry/exporter-metrics-otlp-http not installed; telemetry disabled. Install the optionalDependencies to enable.",
			);
		} else {
			console.warn(`[pi-ai] telemetry init failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		internals.config = NOOP_CONFIG;
		return false;
	}

	// Initialize structured logging provider (independent of metrics; can fail
	// without taking down metrics). No-op when telemetry is disabled.
	await ensureLoggerProvider();

	return true;
}

/**
 * Initialize the structured logging provider lazily. Idempotent — a second
 * call without intermediate shutdownTelemetry() is a no-op. Returns true when
 * a usable provider is in place, false when initialization failed or telemetry
 * is disabled. Errors during log init are logged once and do not propagate.
 */
async function ensureLoggerProvider(): Promise<boolean> {
	if (!internals.config.enabled) {
		return false;
	}
	if (internals.loggersInitialized) {
		return true;
	}
	try {
		const { logs } = (await import("@opentelemetry/api-logs")) as typeof import("@opentelemetry/api-logs");
		const sdkLogs = (await import("@opentelemetry/sdk-logs")) as typeof import("@opentelemetry/sdk-logs");
		const resourcesModule = (await import("@opentelemetry/resources")) as typeof import("@opentelemetry/resources");
		const semconv = await import("@opentelemetry/semantic-conventions");

		const resource = resourcesModule.resourceFromAttributes({
			[semconv.SEMRESATTRS_SERVICE_NAME]: internals.config.serviceName,
			...internals.config.attributes,
		});

		let processor: import("@opentelemetry/sdk-logs").LogRecordProcessor;
		if (internals.config.logExporter === "otlp") {
			const exporter = new OtlpHttpLogRecordExporter(logsUrl(internals.config.endpoint));
			processor = new sdkLogs.SimpleLogRecordProcessor({ exporter });
		} else {
			processor = new sdkLogs.SimpleLogRecordProcessor({ exporter: new sdkLogs.ConsoleLogRecordExporter() });
		}

		const provider = new sdkLogs.LoggerProvider({ resource, processors: [processor] });
		const registered = logs.setGlobalLoggerProvider(provider);
		if (registered) {
			internals.loggersInitialized = true;
			internals.loggerShutdown = async () => {
				await provider.shutdown();
				logs.disable();
				internals.loggersInitialized = false;
				internals.loggerShutdown = null;
			};
		} else {
			// A global LoggerProvider is already registered (host-owned).
			internals.loggersInitialized = true;
			internals.loggerShutdown = null;
		}
		return true;
	} catch (err) {
		const code = (err as Error & { code?: string }).code;
		if (code === "MODULE_NOT_FOUND" && !warnedModuleMissing) {
			warnedModuleMissing = true;
			console.warn(
				`[pi-ai] telemetry enabled but OTEL log SDK not installed (${err instanceof Error ? err.message : String(err)}); structured logs disabled. Install @opentelemetry/api-logs and @opentelemetry/sdk-logs to enable.`,
			);
		} else {
			console.warn(`[pi-ai] log provider init failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		return false;
	}
}

/**
 * Flush and shut down the OTEL SDK. Safe to call when not initialized.
 */
export async function shutdownTelemetry(): Promise<void> {
	if (internals.shutdown) {
		await internals.shutdown();
	}
	if (internals.loggerShutdown) {
		await internals.loggerShutdown();
	}
}

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

// ---------------------------------------------------------------------------
// Stream span management
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Structured completion logging
// ---------------------------------------------------------------------------

/**
 * Minimal OTLP/HTTP JSON logs exporter. Used when logExporter === "otlp".
 * Avoids depending on `@opentelemetry/exporter-logs-otlp-http` (which is not
 * currently an optionalDependency); `otlp-transformer` + Node's http module
 * cover the JSON wire format used by every standard OTLP/HTTP collector.
 */
class OtlpHttpLogRecordExporter implements LogRecordExporter {
	private readonly url: string;
	private readonly headers: Record<string, string>;
	constructor(url: string) {
		this.url = url;
		this.headers = { "Content-Type": "application/json" };
	}

	export(logs: ReadableLogRecord[], resultCallback: (result: ExportResult) => void): void {
		void (async () => {
			try {
				const serializerModule = (await import(
					"@opentelemetry/otlp-transformer"
				)) as typeof import("@opentelemetry/otlp-transformer");
				const body = serializerModule.JsonLogsSerializer.serializeRequest(logs);
				if (!body) {
					resultCallback({ code: 0 });
					return;
				}
				const ok = await postJson(this.url, this.headers, body);
				resultCallback(ok ? { code: 0 } : { code: 1, error: new Error("otlp logs export failed") });
			} catch (err) {
				resultCallback({ code: 1, error: err instanceof Error ? err : new Error(String(err)) });
			}
		})();
	}

	async forceFlush(): Promise<void> {
		// SimpleLogRecordProcessor exports synchronously per emit; nothing buffered.
	}

	async shutdown(): Promise<void> {
		// No persistent state.
	}
}

async function postJson(url: string, headers: Record<string, string>, body: Uint8Array): Promise<boolean> {
	try {
		const parsed = new URL(url);
		const transportModule = await import("node:http");
		const transport = parsed.protocol === "https:" ? null : transportModule;
		return await new Promise<boolean>((resolve) => {
			const req = (transport ?? transportModule).request(
				{
					method: "POST",
					hostname: parsed.hostname,
					port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
					path: `${parsed.pathname}${parsed.search}`,
					headers: { ...headers, "Content-Length": String(body.byteLength) },
					timeout: 5000,
				},
				(res) => {
					res.on("data", () => {});
					res.on("end", () =>
						resolve(res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300),
					);
					res.on("error", () => resolve(false));
				},
			);
			req.on("error", () => resolve(false));
			req.on("timeout", () => {
				req.destroy();
				resolve(false);
			});
			req.end(Buffer.from(body));
		});
	} catch {
		return false;
	}
}

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

let loggerCache: { provider: unknown; logger: import("@opentelemetry/api-logs").Logger } | null = null;

async function completionLogger(): Promise<import("@opentelemetry/api-logs").Logger | null> {
	if (!internals.config.enabled) return null;
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

function nowHrTime(): import("@opentelemetry/api").HrTime {
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
	if (!internals.config.enabled) return;
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
	if (!internals.config.enabled) return;
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
