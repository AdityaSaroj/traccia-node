/**
 * Span processor that redacts sensitive PII from spans before export.
 */

import { ISpan, ISpanProcessor } from "../types";
import { applyRedactionToSpan } from "./redaction";

export interface RedactionSpanProcessorOptions {
  extraKeyFragments?: Iterable<string>;
  redactAllStrings?: boolean;
}

export class RedactionSpanProcessor implements ISpanProcessor {
  private readonly extraKeyFragments?: Iterable<string>;
  private readonly redactAllStrings: boolean;

  constructor(options?: RedactionSpanProcessorOptions) {
    this.extraKeyFragments = options?.extraKeyFragments;
    this.redactAllStrings = options?.redactAllStrings ?? false;
  }

  onEnd(span: ISpan): void {
    applyRedactionToSpan(span, {
      extraKeyFragments: this.extraKeyFragments,
      redactAllStrings: this.redactAllStrings,
      setUnchanged: true,
    });
  }

  shutdown(): void {
    // No-op
  }

  forceFlush(_timeout?: number): void {
    // No-op
  }
}