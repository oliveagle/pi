/**
 * Minimal OTLP/HTTP JSON logs exporter for pi-ai structured completion logs.
 *
 * Used when `logExporter === "otlp"`. Avoids depending on
 * `@opentelemetry/exporter-logs-otlp-http` (which is not currently an
 * optionalDependency); `otlp-transformer` + Node's http module cover the JSON
 * wire format used by every standard OTLP/HTTP collector.
 */

import type { ExportResult } from "@opentelemetry/core";
import type { LogRecordExporter, ReadableLogRecord } from "@opentelemetry/sdk-logs";

export class OtlpHttpLogRecordExporter implements LogRecordExporter {
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
