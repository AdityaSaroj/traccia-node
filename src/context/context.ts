/**
 * Context management for spans using async local storage.
 */

import { AsyncLocalStorage } from 'async_hooks';
import { ISpan } from '../types';

interface SpanContext {
  span?: ISpan;
}

const CONTEXT_KEY = Symbol.for('traccia.spanContext');

/** One process shares the active span across the CLI bundle and the public SDK. */
function spanContext(): AsyncLocalStorage<SpanContext> {
  const host = globalThis as typeof globalThis & { [CONTEXT_KEY]?: AsyncLocalStorage<SpanContext> };
  if (!host[CONTEXT_KEY]) host[CONTEXT_KEY] = new AsyncLocalStorage();
  return host[CONTEXT_KEY];
}

/**
 * Get the current span from context.
 */
export function getCurrentSpan(): ISpan | undefined {
  const ctx = spanContext().getStore();
  return ctx?.span;
}

/**
 * Set the current span in context.
 */
export function setCurrentSpan(span: ISpan | undefined): void {
  const ctx = spanContext().getStore() || {};
  ctx.span = span;
  spanContext().enterWith(ctx);
}

/**
 * Run a function with a specific span as the current span.
 */
export function runWithSpan<T>(span: ISpan, fn: () => T): T {
  return spanContext().run({ span }, fn);
}

/**
 * Run a function with a specific span as the current span (async).
 */
export function runWithSpanAsync<T>(span: ISpan, fn: () => Promise<T>): Promise<T> {
  return spanContext().run({ span }, fn);
}

/**
 * Get the current context store.
 */
export function getContext(): SpanContext {
  return spanContext().getStore() || {};
}
