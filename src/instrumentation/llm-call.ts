/**
 * Shared call lifecycle for patched provider `create` methods (OpenAI, Anthropic).
 *
 * Handles what a plain `async` wrapper cannot:
 * - Streaming (`stream: true`): the span and governance hold stay open until the
 *   returned stream is fully consumed, closed early, or errors.
 * - Provider promise helpers: the provider SDKs return an `APIPromise` and call
 *   `.withResponse()` / `._thenUnwrap()` on it internally (e.g. Anthropic
 *   `messages.stream()`, OpenAI `chat.completions.parse()`), so the returned
 *   promise keeps those methods.
 */

import { getTracer } from '../auto';
import { runWithSpanAsync } from '../context/context';
import { SpanStatus, ISpan } from '../types';
import { enforceLlmCall, finishLlmCall } from '../governance/pep';

export interface ProviderCallHooks<S> {
    tracerName: string;
    spanName: string;
    attributes: Record<string, unknown>;
    /** Populate the span from a completed (non-streaming) response. */
    onResponse(span: ISpan, response: unknown): void;
    /** Fresh accumulator for one streamed call. */
    initStreamState(): S;
    /** Called for every streamed event/chunk. */
    onStreamEvent(span: ISpan, event: unknown, state: S): void;
    /** Called once when the stream completes successfully. */
    onStreamEnd(span: ISpan, state: S): void;
}

/** Result of `APIPromise#withResponse()`: `{ data, response, request_id? }`. */
interface RawResult {
    data: unknown;
    response?: unknown;
    [key: string]: unknown;
}

/** Promise returned by patched `create`, mirroring the provider `APIPromise` helpers. */
export interface ProviderPromise<T> extends Promise<T> {
    withResponse(): Promise<RawResult>;
    asResponse(): Promise<unknown>;
    parse(): Promise<T>;
    _thenUnwrap<U>(transform: (data: T, props: { response?: unknown }) => U): ProviderPromise<U>;
}

type AsyncIterableObject = { [Symbol.asyncIterator]: () => AsyncIterator<unknown> };

const noop = (): void => undefined;

function isAsyncIterable(value: unknown): value is AsyncIterableObject {
    return (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as Partial<AsyncIterableObject>)[Symbol.asyncIterator] === 'function'
    );
}

function recordError(span: ISpan, error: unknown): void {
    if (error instanceof Error) {
        span.recordException(error);
        span.status = SpanStatus.ERROR;
        span.statusDescription = error.message;
    }
}

/** Span population must never break the caller's request. */
function safely(fn: () => void): void {
    try {
        fn();
    } catch {
        /* ignore attribute extraction errors */
    }
}

/**
 * Re-point the stream's async iterator so each event is observed and `finish`
 * runs exactly once when iteration ends (done, break/return, or error).
 * The stream object itself is returned to the caller unchanged.
 */
function observeStream(
    stream: AsyncIterableObject,
    onEvent: (event: unknown) => void,
    finish: (error?: unknown) => void
): void {
    const iterate = stream[Symbol.asyncIterator];
    const original = (): AsyncIterator<unknown> => iterate.call(stream) as AsyncIterator<unknown>;
    stream[Symbol.asyncIterator] = function observedIterator(): AsyncIterator<unknown> {
        const it: AsyncIterator<unknown> = original();
        const iterator: AsyncIterator<unknown> & { [Symbol.asyncIterator](): AsyncIterator<unknown> } = {
            async next(...nextArgs: [] | [unknown]): Promise<IteratorResult<unknown>> {
                try {
                    const result: IteratorResult<unknown> = await it.next(...nextArgs);
                    if (result.done) {
                        finish();
                    } else {
                        onEvent(result.value);
                    }
                    return result;
                } catch (error) {
                    finish(error);
                    throw error;
                }
            },
            return(value?: unknown): Promise<IteratorResult<unknown>> {
                finish();
                return it.return ? it.return(value) : Promise.resolve({ done: true, value });
            },
            throw(error?: unknown): Promise<IteratorResult<unknown>> {
                finish(error);
                return it.throw ? it.throw(error) : Promise.reject(error);
            },
            [Symbol.asyncIterator]() {
                return iterator;
            },
        };
        return iterator;
    };
}

function toProviderPromise<T>(raw: Promise<RawResult>): ProviderPromise<T> {
    const data = raw.then((r) => r.data as T);
    // Callers may only use withResponse()/asResponse(); don't surface the same
    // rejection twice as unhandled. Awaiting `data` still rejects normally.
    data.catch(noop);
    return Object.assign(data, {
        withResponse: () => raw,
        asResponse: () => raw.then((r) => r.response),
        parse: () => data,
        _thenUnwrap: <U>(transform: (value: T, props: { response?: unknown }) => U) =>
            toProviderPromise<U>(
                raw.then((r) => ({ ...r, data: transform(r.data as T, { response: r.response }) }))
            ),
    });
}

/**
 * Run a provider `create` call inside a traced, governance-enforced span.
 */
export function tracedProviderCall<S>(
    createFn: (...args: unknown[]) => unknown,
    thisArg: unknown,
    args: unknown[],
    hooks: ProviderCallHooks<S>
): ProviderPromise<unknown> {
    const tracer = getTracer(hooks.tracerName);
    const kwargs = (args[0] || {}) as Record<string, unknown>;
    const span = tracer.startSpan(hooks.spanName);
    for (const [key, value] of Object.entries(hooks.attributes)) {
        span.setAttribute(key, value);
    }

    let decision: Record<string, unknown> | undefined;

    const raw = runWithSpanAsync(span, async (): Promise<RawResult> => {
        try {
            decision = await enforceLlmCall(kwargs);
            const pending = createFn.apply(thisArg, args) as { withResponse?: () => Promise<RawResult> };
            const result: RawResult =
                typeof pending?.withResponse === 'function'
                    ? await pending.withResponse()
                    : { data: await (pending as Promise<unknown>) };

            if (kwargs.stream === true && isAsyncIterable(result.data)) {
                const state = hooks.initStreamState();
                let finished = false;
                observeStream(
                    result.data,
                    (event) => safely(() => hooks.onStreamEvent(span, event, state)),
                    (error) => {
                        if (finished) return;
                        finished = true;
                        if (error === undefined) {
                            safely(() => hooks.onStreamEnd(span, state));
                        } else {
                            recordError(span, error);
                        }
                        finishLlmCall(decision, error === undefined ? undefined : { release: true })
                            .catch(noop)
                            .finally(() => span.end());
                    }
                );
                return result;
            }

            safely(() => hooks.onResponse(span, result.data));
            await finishLlmCall(decision);
            span.end();
            return result;
        } catch (error) {
            await finishLlmCall(decision, { release: true }).catch(noop);
            recordError(span, error);
            span.end();
            throw error;
        }
    });

    return toProviderPromise(raw);
}
