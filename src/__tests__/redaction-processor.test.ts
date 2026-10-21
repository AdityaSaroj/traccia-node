import { RedactionSpanProcessor } from '../redaction/processor';
import { ISpan } from '../types';
import { REDACTION_APPLIED } from '../redaction/redaction';

describe('RedactionSpanProcessor', () => {
    let mockSpan: ISpan;

    beforeEach(() => {
        mockSpan = {
            attributes: {},
            setAttribute: jest.fn((key, val) => {
                mockSpan.attributes![key] = val;
            })
        } as unknown as ISpan;
    });

    it('should ignore if span is missing setAttribute', () => {
        const processor = new RedactionSpanProcessor();
        const span = {} as any;
        expect(() => processor.onEnd(span)).not.toThrow();
    });

    it('should ignore if span has no attributes', () => {
        const processor = new RedactionSpanProcessor();
        processor.onEnd(mockSpan);
        expect(mockSpan.setAttribute).not.toHaveBeenCalled();
    });

    it('should redact sensitive attributes and add REDACTION_APPLIED flag', () => {
        const processor = new RedactionSpanProcessor();
        mockSpan.attributes = {
            'user.password': 'secret123 and test@example.com',
            'safe.key': 'public data',
            'number.val': 123
        };

        processor.onEnd(mockSpan);

        expect(mockSpan.setAttribute).toHaveBeenCalledWith('user.password', 'secret123 and [REDACTED_EMAIL]');
        expect(mockSpan.setAttribute).toHaveBeenCalledWith('safe.key', 'public data');
        expect(mockSpan.setAttribute).toHaveBeenCalledWith('number.val', 123);
        expect(mockSpan.setAttribute).toHaveBeenCalledWith(REDACTION_APPLIED, true);
    });

    it('should support extraKeyFragments', () => {
        const processor = new RedactionSpanProcessor({ extraKeyFragments: ['custom_secret'] });
        mockSpan.attributes = {
            'my_custom_secret_key': 'super secret with 123-45-6789',
            'normal_key': 'normal'
        };

        processor.onEnd(mockSpan);

        expect(mockSpan.setAttribute).toHaveBeenCalledWith('my_custom_secret_key', 'super secret with [REDACTED_SSN]');
        expect(mockSpan.setAttribute).toHaveBeenCalledWith('normal_key', 'normal');
        expect(mockSpan.setAttribute).toHaveBeenCalledWith(REDACTION_APPLIED, true);
    });

    it('implements shutdown and forceFlush', () => {
        const processor = new RedactionSpanProcessor();
        expect(() => processor.shutdown()).not.toThrow();
        expect(() => processor.forceFlush()).not.toThrow();
    });
});

describe('RedactionSpanProcessor (TRC-291 coverage)', () => {
    const { TracerProvider } = require('../tracer/provider');

    function runSpan(options: ConstructorParameters<typeof RedactionSpanProcessor>[0], body: (span: ISpan) => void) {
        const provider = new TracerProvider();
        let seen: any;
        provider.addSpanProcessor(new RedactionSpanProcessor(options));
        provider.addSpanProcessor({
            onEnd: (s: ISpan) => {
                seen = JSON.parse(JSON.stringify({ a: s.attributes, e: s.events, d: s.statusDescription }));
            },
            shutdown() {},
            forceFlush() {},
        });
        const span = provider.getTracer('t').startSpan('op');
        body(span);
        span.end();
        return seen;
    }

    it('honors redactAllStrings for opaque keys and string arrays', () => {
        const seen = runSpan({ redactAllStrings: true }, (span) => {
            span.setAttribute('opaque', 'x@y.io');
            span.setAttribute('llm.prompt', ['hi x@y.io', 'ok']);
        });
        expect(seen.a.opaque).toBe('[REDACTED_EMAIL]');
        expect(seen.a['llm.prompt']).toEqual(['hi [REDACTED_EMAIL]', 'ok']);
    });

    it('redacts result attributes by default', () => {
        const seen = runSpan(undefined, (span) => span.setAttribute('result', 'x@y.io'));
        expect(seen.a.result).toBe('[REDACTED_EMAIL]');
    });

    it('redacts custom events, exceptions and status description', () => {
        const seen = runSpan({ redactAllStrings: true }, (span) => {
            span.addEvent('custom', { payload: 'x@y.io' });
            span.recordException(new Error('bad x@y.io'));
        });
        expect(JSON.stringify(seen)).not.toContain('x@y.io');
        expect(seen.e.map((e: any) => e.name)).toEqual(['custom', 'exception']);
        expect(seen.d).toBe('bad [REDACTED_EMAIL]');
    });
});
