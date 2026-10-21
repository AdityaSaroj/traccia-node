import { spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

const cli = path.join(__dirname, '../../dist/cli.js');
const sdk = path.join(__dirname, '../../dist/index.js');

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

describe('packaged CLI task cost', () => {
  test('a provider span from the public SDK is uploaded as task cost', async () => {
    expect(fs.existsSync(cli)).toBe(true);
    expect(fs.existsSync(sdk)).toBe(true);
    const uploads: any[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (req.method === 'POST' && (req.url || '').includes('/experiments')) {
          uploads.push(JSON.parse(body || '{}'));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id: 'exp-packaged', url: 'http://127.0.0.1/exp-packaged' }));
          return;
        }
        if ((req.url || '').includes('/datasets/demo')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id: 'ds1', name: 'demo' }));
          return;
        }
        if ((req.url || '').includes('/items')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            items: [{ id: 'item-1', input: { q: 'hi' }, expected_output: 'ok' }],
          }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
    });
    const port = await listen(server);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traccia-packaged-'));
    const task = path.join(dir, 'task.mjs');
    const summary = path.join(dir, 'summary.json');
    fs.writeFileSync(task, `import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { getTracer, getCurrentSpan } = require(${JSON.stringify(sdk)});
export async function task() {
  if (!getCurrentSpan()) throw new Error('missing current span');
  const span = getTracer('packaged-task').startSpan('chat.completions');
  span.setAttribute('llm.model', 'gpt-4o-mini');
  span.setAttribute('llm.cost.usd', 0.25);
  span.end();
  return 'ok';
}
`);
    const child = spawn(process.execPath, [cli, 'eval', task, '--dataset', 'demo', '--scorer', 'exact_match', '--output', summary], {
      cwd: dir,
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        TRACCIA_API_KEY: 'tr_test_packaged',
        TRACCIA_PROMPT_API_BASE: `http://127.0.0.1:${port}`,
        TRACCIA_ENDPOINT: `http://127.0.0.1:${port}/v1/traces`,
      },
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    const status = await new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? 1)));
    await new Promise((resolve) => server.close(resolve));
    const body = fs.existsSync(summary) ? JSON.parse(fs.readFileSync(summary, 'utf8')) : {};
    const cost = uploads[0]?.results?.rows?.[0]?.panels?.[0]?.task_cost;
    if (status !== 0 || cost?.usd !== 0.25) {
      throw new Error(`packaged eval status ${status} cost ${JSON.stringify(cost)} uploads ${uploads.length}\n${stderr}\n${JSON.stringify(body)}`);
    }
    expect(cost).toEqual({ usd: 0.25, coverage: 'complete', basis: 'instrumented_spans' });
    expect(body.exit_code).toBe(0);
  });
});
