import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { patchOpenAI, patchOpenAIResponses } from '../instrumentation/openai';
import { patchAnthropic } from '../instrumentation/anthropic';
import { getTracer } from '../auto';
import { enforceLlmCall, finishLlmCall } from '../governance/pep';
import { ISpan } from '../types';
import { getAgentId, runIdentity } from '../config/runtime-config';
import { getCurrentSpan } from '../context/context';

jest.mock('../auto', () => ({
    getTracer: jest.fn(),
}));

jest.mock('../governance/pep', () => ({
    enforceLlmCall: jest.fn().mockResolvedValue(undefined),
    finishLlmCall: jest.fn().mockResolvedValue(undefined),
}));

// Regression for TRC-280: the patch functions used to report success without
// replacing the provider create methods, so normal client calls were untraced.
describe('OpenAI/Anthropic auto-patching against the real provider SDKs', () => {
    let spanNames: string[];
    let span: ISpan;

    const jsonFetch = (body: unknown) =>
        jest.fn(async () =>
            new Response(JSON.stringify(body), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })
        );

    /** Let span/governance completion callbacks scheduled after the stream settle. */
    const flush = () => new Promise((resolve) => setImmediate(resolve));

    /** Fake fetch that answers with a server-sent-events body. */
    const sseFetch = (events: Array<{ event?: string; data: unknown }>, opts: { failAfter?: number } = {}) =>
        jest.fn(async () => {
            const encoder = new TextEncoder();
            let i = 0;
            const body = new ReadableStream<Uint8Array>({
                pull(controller) {
                    if (opts.failAfter !== undefined && i === opts.failAfter) {
                        controller.error(new Error('connection reset'));
                        return;
                    }
                    if (i < events.length) {
                        const { event, data } = events[i++];
                        const payload = typeof data === 'string' ? data : JSON.stringify(data);
                        const prefix = event ? 'event: ' + event + '\n' : '';
                        controller.enqueue(encoder.encode(prefix + 'data: ' + payload + '\n\n'));
                    } else {
                        controller.close();
                    }
                },
            });
            return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        });

    const chatChunk = (content: string, role?: 'assistant') => ({
        data: {
            id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'gpt-4o-mini',
            choices: [{ index: 0, delta: { role, content }, finish_reason: null }],
        },
    });

    const chatStreamEvents = [
        chatChunk('Hel', 'assistant'),
        chatChunk('lo'),
        {
            data: {
                id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'gpt-4o-mini',
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
            },
        },
        { data: '[DONE]' },
    ];

    const anthropicStreamEvents = [
        {
            event: 'message_start',
            data: {
                type: 'message_start',
                message: {
                    id: 'm1', type: 'message', role: 'assistant', model: 'claude-x', content: [],
                    stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 },
                },
            },
        },
        { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi ' } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'there' } } },
        { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
        {
            event: 'message_delta',
            data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
        },
        { event: 'message_stop', data: { type: 'message_stop' } },
    ];

    beforeAll(() => {
        expect(patchOpenAI()).toBe(true);
        expect(patchOpenAIResponses()).toBe(true);
        expect(patchAnthropic()).toBe(true);
    });

    beforeEach(() => {
        spanNames = [];
        span = {
            attributes: {},
            setAttribute: jest.fn(function (this: { attributes: Record<string, unknown> }, k: string, v: unknown) {
                this.attributes[k] = v;
            }),
            end: jest.fn(),
            recordException: jest.fn(),
        } as unknown as ISpan;
        (getTracer as jest.Mock).mockReturnValue({
            startSpan: jest.fn((name: string) => {
                spanNames.push(name);
                return span;
            }),
        });
        jest.clearAllMocks();
    });

    it('traces and enforces policy on chat.completions.create', async () => {
        const client = new OpenAI({
            apiKey: 'test',
            fetch: jsonFetch({
                id: 'c1', object: 'chat.completion', created: 0, model: 'gpt-4o-mini',
                choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
            }),
        });

        const res = await client.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: 'hello' }],
        });

        expect(res.choices[0].message.content).toBe('hi');
        expect(spanNames).toEqual(['llm.openai.chat.completions']);
        expect(enforceLlmCall).toHaveBeenCalledTimes(1);
        expect(finishLlmCall).toHaveBeenCalledTimes(1);
        expect(span.attributes['llm.usage.total_tokens']).toBe(4);
        expect(span.end).toHaveBeenCalled();
    });

    it('traces and enforces policy on responses.create', async () => {
        const client = new OpenAI({
            apiKey: 'test',
            fetch: jsonFetch({
                id: 'r1', object: 'response', created_at: 0, model: 'gpt-4o-mini', status: 'completed',
                output: [], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
            }),
        });

        await client.responses.create({ model: 'gpt-4o-mini', input: 'hello' });

        expect(spanNames).toEqual(['llm.openai.responses']);
        expect(enforceLlmCall).toHaveBeenCalledTimes(1);
        expect(span.attributes['llm.usage.total_tokens']).toBe(3);
    });

    it('traces and enforces policy on messages.create', async () => {
        const client = new Anthropic({
            apiKey: 'test',
            fetch: jsonFetch({
                id: 'm1', type: 'message', role: 'assistant', model: 'claude-x',
                content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn',
                usage: { input_tokens: 5, output_tokens: 1 },
            }),
        });

        await client.messages.create({
            model: 'claude-x',
            max_tokens: 16,
            messages: [{ role: 'user', content: 'hello' }],
        });

        expect(spanNames).toEqual(['llm.anthropic.messages']);
        expect(enforceLlmCall).toHaveBeenCalledTimes(1);
        expect(span.attributes['llm.response']).toBe('hi');
    });

    it('stops the provider call when policy enforcement rejects', async () => {
        (enforceLlmCall as jest.Mock).mockRejectedValueOnce(new Error('blocked by policy'));
        const fetchFn = jsonFetch({});
        const client = new OpenAI({ apiKey: 'test', fetch: fetchFn });

        await expect(
            client.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'x' }] })
        ).rejects.toThrow('blocked by policy');
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it('is idempotent: patching twice does not double-wrap', () => {
        const proto = Object.getPrototypeOf(new OpenAI({ apiKey: 'test' }).chat.completions);
        const once = proto.create;
        expect(patchOpenAI()).toBe(true);
        expect(proto.create).toBe(once);
    });

    it('keeps the span open until a chat stream is consumed, then records content and usage', async () => {
        const client = new OpenAI({ apiKey: 'test', fetch: sseFetch(chatStreamEvents) });

        const stream = await client.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: 'hello' }],
            stream: true,
        });
        expect(span.end).not.toHaveBeenCalled();
        expect(finishLlmCall).not.toHaveBeenCalled();

        let text = '';
        for await (const chunk of stream) {
            text += chunk.choices[0]?.delta?.content ?? '';
        }
        await flush();

        expect(text).toBe('Hello');
        expect(span.attributes['llm.streaming']).toBe(true);
        expect(span.attributes['llm.completion']).toBe('Hello');
        expect(span.attributes['llm.finish_reason']).toBe('stop');
        expect(span.attributes['llm.usage.total_tokens']).toBe(5);
        expect(span.end).toHaveBeenCalledTimes(1);
        expect(finishLlmCall).toHaveBeenCalledWith(undefined, undefined);
    });

    it('ends the span once when the caller stops reading a stream early', async () => {
        const client = new OpenAI({ apiKey: 'test', fetch: sseFetch(chatStreamEvents) });
        const stream = await client.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: 'hello' }],
            stream: true,
        });

        for await (const chunk of stream) {
            void chunk;
            break;
        }
        await flush();

        expect(span.end).toHaveBeenCalledTimes(1);
        expect(span.attributes['llm.completion']).toBe('Hel');
    });

    it('records the error and releases the governance hold when a stream fails mid-way', async () => {
        const client = new OpenAI({ apiKey: 'test', fetch: sseFetch(chatStreamEvents, { failAfter: 1 }) });
        const stream = await client.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: 'hello' }],
            stream: true,
        });

        await expect(
            (async () => {
                for await (const chunk of stream) {
                    void chunk;
                }
            })()
        ).rejects.toThrow();
        await flush();

        expect(span.recordException).toHaveBeenCalled();
        expect(finishLlmCall).toHaveBeenCalledWith(undefined, { release: true });
        expect(span.end).toHaveBeenCalledTimes(1);
    });

    it('traces a streamed responses.create from its terminal event', async () => {
        const client = new OpenAI({
            apiKey: 'test',
            fetch: sseFetch([
                { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: 'hi' } },
                {
                    event: 'response.completed',
                    data: {
                        type: 'response.completed',
                        response: {
                            id: 'r1', object: 'response', model: 'gpt-4o-mini', status: 'completed', output: [],
                            usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
                        },
                    },
                },
            ]),
        });

        const stream = await client.responses.create({ model: 'gpt-4o-mini', input: 'hello', stream: true });
        for await (const event of stream) {
            void event;
        }
        await flush();

        expect(spanNames).toEqual(['llm.openai.responses']);
        expect(span.attributes['llm.response.status']).toBe('completed');
        expect(span.attributes['llm.usage.total_tokens']).toBe(3);
        expect(span.end).toHaveBeenCalledTimes(1);
    });

    it('traces a raw Anthropic stream and records text, stop reason and usage', async () => {
        const client = new Anthropic({ apiKey: 'test', fetch: sseFetch(anthropicStreamEvents) });

        const stream = await client.messages.create({
            model: 'claude-x',
            max_tokens: 16,
            messages: [{ role: 'user', content: 'hello' }],
            stream: true,
        });
        expect(span.end).not.toHaveBeenCalled();
        for await (const event of stream) {
            void event;
        }
        await flush();

        expect(span.attributes['llm.response']).toBe('Hi there');
        expect(span.attributes['llm.stop_reason']).toBe('end_turn');
        expect(span.attributes['llm.usage.input_tokens']).toBe(7);
        expect(span.attributes['llm.usage.output_tokens']).toBe(2);
        expect(span.end).toHaveBeenCalledTimes(1);
    });

    it('keeps Anthropic messages.stream() working (it calls create().withResponse())', async () => {
        const client = new Anthropic({ apiKey: 'test', fetch: sseFetch(anthropicStreamEvents) });

        const message = await client.messages
            .stream({ model: 'claude-x', max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] })
            .finalMessage();
        await flush();

        expect(message.content[0]).toMatchObject({ type: 'text', text: 'Hi there' });
        expect(spanNames).toEqual(['llm.anthropic.messages']);
        expect(span.attributes['llm.response']).toBe('Hi there');
        expect(span.end).toHaveBeenCalledTimes(1);
    });

    it('keeps OpenAI chat.completions.stream() working', async () => {
        const client = new OpenAI({ apiKey: 'test', fetch: sseFetch(chatStreamEvents) });

        const completion = await client.chat.completions
            .stream({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] })
            .finalChatCompletion();
        await flush();

        expect(completion.choices[0].message.content).toBe('Hello');
        expect(spanNames).toEqual(['llm.openai.chat.completions']);
        expect(span.end).toHaveBeenCalledTimes(1);
    });

    it('keeps APIPromise helpers: withResponse(), asResponse() and parse() via _thenUnwrap', async () => {
        const body = {
            id: 'c1', object: 'chat.completion', created: 0, model: 'gpt-4o-mini',
            choices: [{ index: 0, message: { role: 'assistant', content: '{"a":1}', refusal: null }, finish_reason: 'stop' }],
        };
        const client = new OpenAI({ apiKey: 'test', fetch: jsonFetch(body) });
        const params = { model: 'gpt-4o-mini', messages: [{ role: 'user' as const, content: 'x' }] };

        const { data, response } = await client.chat.completions.create(params).withResponse();
        expect(data.choices[0].message.content).toBe('{"a":1}');
        expect(response.status).toBe(200);

        const raw = await client.chat.completions.create(params).asResponse();
        expect(raw.status).toBe(200);

        const parsed = await client.chat.completions.parse({
            ...params,
            response_format: { type: 'json_object' },
        });
        expect(parsed.choices[0].message.content).toBe('{"a":1}');
        expect(spanNames).toEqual([
            'llm.openai.chat.completions',
            'llm.openai.chat.completions',
            'llm.openai.chat.completions',
        ]);
    });
    describe('review: authorization context is preserved through finalization', () => {
        const captureSettlement = () => {
            const seen: Array<{ agentId?: string; span?: unknown }> = [];
            (finishLlmCall as jest.Mock).mockImplementationOnce(async () => {
                seen.push({ agentId: getAgentId(), span: getCurrentSpan() });
            });
            return seen;
        };

        it('settles a stream authorized under agent A for agent A when consumed under agent B', async () => {
            const seen = captureSettlement();
            const client = new OpenAI({ apiKey: 'test', fetch: sseFetch(chatStreamEvents) });

            const stream = await runIdentity({ agentId: 'agent-A' }, () =>
                client.chat.completions.create({
                    model: 'gpt-4o-mini',
                    messages: [{ role: 'user', content: 'hello' }],
                    stream: true,
                })
            );
            await runIdentity({ agentId: 'agent-B' }, async () => {
                for await (const chunk of stream) {
                    void chunk;
                }
            });
            await flush();

            expect(seen).toEqual([{ agentId: 'agent-A', span }]);
        });

        it('settles for the authorizing agent when the result is consumed outside any identity scope', async () => {
            const seen = captureSettlement();
            const client = new OpenAI({
                apiKey: 'test',
                fetch: jsonFetch({
                    id: 'c1', object: 'chat.completion', created: 0, model: 'gpt-4o-mini',
                    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
                }),
            });

            const pending = runIdentity({ agentId: 'agent-A' }, () =>
                client.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'x' }] })
            );
            await pending;

            expect(seen).toEqual([{ agentId: 'agent-A', span }]);
        });
    });

    it('review: asResponse() leaves the body unread for the caller', async () => {
        const client = new OpenAI({
            apiKey: 'test',
            fetch: jsonFetch({ id: 'c1', object: 'chat.completion', created: 0, model: 'gpt-4o-mini', choices: [] }),
        });

        const response = await client.chat.completions
            .create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'x' }] })
            .asResponse();

        await expect(response.json()).resolves.toMatchObject({ id: 'c1' });
        expect(finishLlmCall).toHaveBeenCalledTimes(1);
        expect(span.end).toHaveBeenCalledTimes(1);
    });

    it('review: fully consuming both .tee() branches ends the span and settles once', async () => {
        const client = new OpenAI({ apiKey: 'test', fetch: sseFetch(chatStreamEvents) });
        const stream = await client.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: 'hello' }],
            stream: true,
        });

        const [left, right] = stream.tee();
        const read = async (branch: typeof left) => {
            let text = '';
            for await (const chunk of branch) {
                text += chunk.choices[0]?.delta?.content ?? '';
            }
            return text;
        };
        expect(await read(left)).toBe('Hello');
        expect(await read(right)).toBe('Hello');
        await flush();

        expect(span.attributes['llm.completion']).toBe('Hello');
        expect(finishLlmCall).toHaveBeenCalledTimes(1);
        expect(finishLlmCall).toHaveBeenCalledWith(undefined, undefined);
        expect(span.end).toHaveBeenCalledTimes(1);
    });

    it('review: aborting a stream before iterating releases the reservation and ends the span', async () => {
        const client = new OpenAI({ apiKey: 'test', fetch: sseFetch(chatStreamEvents) });
        const stream = await client.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: 'hello' }],
            stream: true,
        });

        stream.controller.abort();
        await flush();

        expect(finishLlmCall).toHaveBeenCalledTimes(1);
        expect(finishLlmCall).toHaveBeenCalledWith(undefined, { release: true });
        expect(span.recordException).toHaveBeenCalled();
        expect(span.end).toHaveBeenCalledTimes(1);
    });

    it('review: keeps _request_id on create() and on parse() results (via _thenUnwrap)', async () => {
        const body = {
            id: 'c1', object: 'chat.completion', created: 0, model: 'gpt-4o-mini',
            choices: [{ index: 0, message: { role: 'assistant', content: '{"a":1}', refusal: null }, finish_reason: 'stop' }],
        };
        const fetchFn = jest.fn(async () =>
            new Response(JSON.stringify(body), {
                status: 200,
                headers: { 'content-type': 'application/json', 'x-request-id': 'req_test' },
            })
        );
        const client = new OpenAI({ apiKey: 'test', fetch: fetchFn });
        const params = { model: 'gpt-4o-mini', messages: [{ role: 'user' as const, content: 'x' }] };

        const created = await client.chat.completions.create(params);
        expect(created._request_id).toBe('req_test');

        const parsed = await client.chat.completions.parse({ ...params, response_format: { type: 'json_object' } });
        expect(parsed._request_id).toBe('req_test');
        expect(Object.keys(parsed)).not.toContain('_request_id');
    });
});
