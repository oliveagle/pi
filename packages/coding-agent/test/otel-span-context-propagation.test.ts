// Verifies the coding-agent stream entry points hand the active span context to
// pi-ai's lazyStream, so LLM stream spans become children of the caller's span.

import type { Provider } from "@earendil-works/pi-ai";
import {
	type Context,
	type ContextManager,
	context as otelContext,
	ROOT_CONTEXT,
	type Span,
	type SpanContext,
	trace,
} from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelConfig } from "../src/core/model-config.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { composeModelProvider } from "../src/core/provider-composer.ts";

const { lazyStreamMock } = vi.hoisted(() => ({ lazyStreamMock: vi.fn() }));

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai")>();
	return {
		...actual,
		lazyStream: (...args: Parameters<typeof actual.lazyStream>) => {
			lazyStreamMock(...args);
			return actual.createAssistantMessageEventStream();
		},
	};
});

/** Synchronous context manager; the API default no-op manager ignores with(). */
class StackContextManager implements ContextManager {
	private current: Context = ROOT_CONTEXT;

	active(): Context {
		return this.current;
	}

	with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
		context: Context,
		fn: F,
		thisArg?: ThisParameterType<F>,
		...args: A
	): ReturnType<F> {
		const previous = this.current;
		this.current = context;
		try {
			return fn.call(thisArg as ThisParameterType<F>, ...args);
		} finally {
			this.current = previous;
		}
	}

	bind<T>(_context: Context, target: T): T {
		return target;
	}

	enable(): this {
		return this;
	}

	disable(): this {
		this.current = ROOT_CONTEXT;
		return this;
	}
}

const parentSpanContext: SpanContext = {
	traceId: "abcdef0123456789abcdef0123456789",
	spanId: "0123456789abcdef",
	traceFlags: 1,
};

function withActiveSpan<T>(fn: () => T): T {
	otelContext.setGlobalContextManager(new StackContextManager());
	const span = { spanContext: () => parentSpanContext } as unknown as Span;
	return otelContext.with(trace.setSpan(ROOT_CONTEXT, span), fn);
}

async function createRuntime(): Promise<ModelRuntime> {
	const credentials = AuthStorage.inMemory();
	await credentials.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
	return ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
}

/**
 * ModelRuntime keeps builtins untouched when no models.json / extension overlay
 * exists, so the composed provider path is exercised directly.
 */
async function composedProvider(): Promise<Provider> {
	const runtime = await createRuntime();
	const base = runtime.getProvider("anthropic");
	expect(base).toBeDefined();
	return composeModelProvider("anthropic", base, await ModelConfig.load(undefined), {
		name: "anthropic-with-overlay",
		apiKey: "overlay-key",
	});
}

function capturedParentContexts(): (SpanContext | undefined)[] {
	return lazyStreamMock.mock.calls.map((call) => call[2] as SpanContext | undefined);
}

beforeEach(() => {
	lazyStreamMock.mockClear();
});

afterEach(() => {
	otelContext.disable();
});

describe("span context propagation into lazyStream", () => {
	it("passes undefined when no span is active", async () => {
		const runtime = await createRuntime();
		const model = runtime.getModels()[0];
		expect(model).toBeDefined();

		runtime.stream(model, { messages: [] });
		runtime.streamSimple(model, { messages: [] });
		(await composedProvider()).stream(model, { messages: [] }, {});

		expect(capturedParentContexts()).toEqual([undefined, undefined, undefined]);
	});

	it("passes the active span context from ModelRuntime.stream", async () => {
		const runtime = await createRuntime();
		const model = runtime.getModels()[0];

		withActiveSpan(() => runtime.stream(model, { messages: [] }));

		expect(capturedParentContexts()).toEqual([parentSpanContext]);
	});

	it("passes the active span context from ModelRuntime.streamSimple", async () => {
		const runtime = await createRuntime();
		const model = runtime.getModels()[0];

		withActiveSpan(() => runtime.streamSimple(model, { messages: [] }));

		expect(capturedParentContexts()).toEqual([parentSpanContext]);
	});

	it("passes the active span context from the composed provider stream", async () => {
		const runtime = await createRuntime();
		const model = runtime.getModels()[0];
		const provider = await composedProvider();

		withActiveSpan(() => provider.stream(model, { messages: [] }, {}));
		withActiveSpan(() => provider.streamSimple(model, { messages: [] }, {}));

		expect(capturedParentContexts()).toEqual([parentSpanContext, parentSpanContext]);
	});
});
