// Unit tests for activeSpanContext(): the helper consumers use to turn the
// currently active span into a lazyStream() parent context without depending
// on @opentelemetry/api themselves.

import {
	type Context,
	type ContextManager,
	INVALID_SPANID,
	INVALID_TRACEID,
	context as otelContext,
	ROOT_CONTEXT,
	type Span,
	type SpanContext,
	trace,
} from "@opentelemetry/api";
import { afterEach, expect, it } from "vitest";
import { activeSpanContext } from "../src/utils/otel.ts";

/**
 * Minimal synchronous context manager. The API ships a no-op manager by
 * default whose with() ignores the supplied context, so a real manager is
 * required to make trace.getActiveSpan() observable in tests.
 */
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

function fakeSpan(spanContext: SpanContext): Span {
	return { spanContext: () => spanContext } as unknown as Span;
}

afterEach(() => {
	otelContext.disable();
});

it("returns undefined when no span is active", () => {
	expect(activeSpanContext()).toBeUndefined();
});

it("returns the active span context when a span is active", () => {
	otelContext.setGlobalContextManager(new StackContextManager());
	const spanContext: SpanContext = {
		traceId: "abcdef0123456789abcdef0123456789",
		spanId: "0123456789abcdef",
		traceFlags: 1,
	};
	const captured = otelContext.with(trace.setSpan(ROOT_CONTEXT, fakeSpan(spanContext)), () => activeSpanContext());
	expect(captured).toEqual(spanContext);
});

it("treats an invalid trace id as no parent", () => {
	otelContext.setGlobalContextManager(new StackContextManager());
	const spanContext: SpanContext = { traceId: INVALID_TRACEID, spanId: "0123456789abcdef", traceFlags: 0 };
	const captured = otelContext.with(trace.setSpan(ROOT_CONTEXT, fakeSpan(spanContext)), () => activeSpanContext());
	expect(captured).toBeUndefined();
});

it("treats an invalid span id as no parent", () => {
	otelContext.setGlobalContextManager(new StackContextManager());
	const spanContext: SpanContext = {
		traceId: "abcdef0123456789abcdef0123456789",
		spanId: INVALID_SPANID,
		traceFlags: 0,
	};
	const captured = otelContext.with(trace.setSpan(ROOT_CONTEXT, fakeSpan(spanContext)), () => activeSpanContext());
	expect(captured).toBeUndefined();
});
