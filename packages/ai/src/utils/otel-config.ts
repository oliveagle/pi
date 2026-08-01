/**
 * Telemetry configuration + SDK lifecycle for pi-ai.
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

import { metrics } from "@opentelemetry/api";
import { OtlpHttpLogRecordExporter } from "./otel-log-exporter.ts";

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

/** Whether operators asked for telemetry, regardless of SDK init state. */
export function isTelemetryRequested(): boolean {
	return internals.config.enabled;
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
export async function ensureLoggerProvider(): Promise<boolean> {
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
