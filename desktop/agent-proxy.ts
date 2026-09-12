import http from 'node:http';
import https from 'node:https';
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import type { RuntimeModelConfig } from './model-service.ts';
import {
  OPENCODE_SESSION_HEADER,
  OPENCODE_USER_AGENT,
  geminiGeneratePath,
  joinEndpoint,
  type ModelProtocol,
} from '../src/domain/models.ts';

export const DUMMY_UPSTREAM_KEY = 'patent-workbench-dummy-key';
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_OUTPUT = 8_192;
export const PROXY_BODY_MAX_BYTES = 1_000_000;
export const PROXY_RESPONSE_MAX_BYTES = 8_000_000;
export const PROVIDER_NPM = {
  'openai-responses': '@ai-sdk/openai',
  'openai-chat-completions': '@ai-sdk/openai-compatible',
  'anthropic-messages': '@ai-sdk/anthropic',
  'gemini-generate-content': '@ai-sdk/google',
} as const;

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export class UnknownProtocolError extends Error {
  readonly protocol: string;
  constructor(protocol: string) {
    super('不支持的模型协议，已拒绝，未回退为 Chat Completions。');
    this.protocol = protocol;
  }
}

export function providerNpmForProtocol(protocol: string): (typeof PROVIDER_NPM)[keyof typeof PROVIDER_NPM] {
  if (protocol === 'openai-responses') return PROVIDER_NPM['openai-responses'];
  if (protocol === 'openai-chat-completions') return PROVIDER_NPM['openai-chat-completions'];
  if (protocol === 'anthropic-messages') return PROVIDER_NPM['anthropic-messages'];
  if (protocol === 'gemini-generate-content') return PROVIDER_NPM['gemini-generate-content'];
  throw new UnknownProtocolError(protocol);
}

export function effectiveContextWindow(runtime: Pick<RuntimeModelConfig, 'contextWindow'>): number {
  return runtime.contextWindow && runtime.contextWindow > 0 ? runtime.contextWindow : DEFAULT_CONTEXT_WINDOW;
}

export function effectiveMaxOutput(runtime: Pick<RuntimeModelConfig, 'contextWindow' | 'maxOutput'>): number {
  const context = effectiveContextWindow(runtime);
  const requested = runtime.maxOutput && runtime.maxOutput > 0 ? runtime.maxOutput : DEFAULT_MAX_OUTPUT;
  return Math.max(1, Math.min(requested, context));
}

export type SafeProxyRequest = {
  method: string;
  path: string;
  model?: string;
  hasAuthorization: boolean;
  hasApiKey: boolean;
  hasGoogApiKey: boolean;
  sessionHeader: string;
  userAgent: string;
  maxOutput?: number;
  reasoning?: unknown;
  store?: unknown;
  bytes: number;
};

export type AgentProxyOptions = {
  runtime: RuntimeModelConfig;
  discussionId: string;
  fetchImpl?: typeof fetch;
  bodyLimit?: number;
  responseLimit?: number;
  onSafeRequest?: (info: SafeProxyRequest) => void;
};

export type AgentProxy = {
  port: number;
  origin: string;
  childBaseURL: string;
  token: string;
  routePrefix: string;
  close: () => Promise<void>;
};

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}

function header(headers: http.IncomingHttpHeaders, name: string): string | undefined {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

function isLocalHost(host: string | undefined): boolean {
  if (!host) return false;
  const hostname = host.replace(/^\[|\]$/g, '').split(':')[0]?.toLowerCase();
  return LOCAL_HOSTS.has(hostname || host.toLowerCase());
}

function pathnameOf(urlPath: string): string {
  const noQuery = urlPath.split('?')[0] || '/';
  return noQuery.replace(/\/+$/, '') || '/';
}

export function queryStringOf(urlPath: string): string {
  const q = urlPath.indexOf('?');
  return q >= 0 ? urlPath.slice(q) : '';
}

function isLocalOrigin(value: string | undefined): boolean {
  if (!value) return true;
  try {
    const url = new URL(value);
    return LOCAL_HOSTS.has(url.hostname.replace(/^\[|\]$/g, '').toLowerCase());
  } catch {
    return false;
  }
}

export function proxyRoutePrefix(token: string): string {
  return `/r/${token}`;
}

export function childRequestPath(token: string, rest: string): string {
  const suffix = rest.startsWith('/') ? rest : `/${rest}`;
  return `${proxyRoutePrefix(token)}${suffix}`;
}

function stripRoutePrefix(urlPath: string, token: string): string | undefined {
  const prefix = proxyRoutePrefix(token);
  const pathname = pathnameOf(urlPath);
  const search = queryStringOf(urlPath);
  if (pathname === prefix) return `/${search}`;
  if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length) + search;
}

export function allowedChildPath(protocol: ModelProtocol, modelId: string, urlPath: string): boolean {
  const path = pathnameOf(urlPath);
  const model = modelId.replace(/^models\//, '');
  if (protocol === 'openai-responses') {
    return /\/responses$/.test(path) || /\/responses\/[A-Za-z0-9._-]+$/.test(path);
  }
  if (protocol === 'openai-chat-completions') {
    return /\/chat\/completions$/.test(path);
  }
  if (protocol === 'anthropic-messages') {
    return /\/messages$/.test(path);
  }
  if (protocol === 'gemini-generate-content') {
    const escaped = model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`/models/${escaped}:(stream)?generateContent$`, 'i').test(path)
      || new RegExp(`/models/${escaped}:(stream)?GenerateContent$`).test(path);
  }
  return false;
}

export function upstreamUrlFor(runtime: Pick<RuntimeModelConfig, 'baseURL' | 'protocol' | 'modelId'>, urlPath: string): string | undefined {
  const protocol = runtime.protocol;
  const path = pathnameOf(urlPath);
  const search = queryStringOf(urlPath);
  const base = runtime.baseURL.replace(/\/+$/, '');
  if (!allowedChildPath(protocol, runtime.modelId, urlPath)) return;
  if (protocol === 'openai-responses') {
    const rest = path.slice(path.lastIndexOf('/responses'));
    if (base.endsWith('/responses') && rest.startsWith('/responses')) return base + rest.slice('/responses'.length) + search;
    return (base.endsWith('/v1') ? base + rest : joinEndpoint(base, rest.replace(/^\//, ''))) + search;
  }
  if (protocol === 'openai-chat-completions') {
    if (base.endsWith('/chat/completions')) return base + search;
    return joinEndpoint(base, 'chat/completions') + search;
  }
  if (protocol === 'anthropic-messages') {
    if (base.endsWith('/messages')) return base + search;
    return joinEndpoint(base, 'messages') + search;
  }
  const generate = geminiGeneratePath(runtime.modelId);
  const streaming = /streamgeneratecontent$/i.test(path);
  const geminiPath = streaming ? generate.replace(/:generateContent$/i, ':streamGenerateContent') : generate;
  const joined = joinEndpoint(base, geminiPath);
  if (streaming) {
    if (/[?&]alt=/.test(search)) return joined + search;
    return joined + (search ? `${search}&alt=sse` : '?alt=sse');
  }
  return joined + search;
}

export function childAuthHeaders(protocol: ModelProtocol, secret: string): Record<string, string> {
  if (protocol === 'anthropic-messages') return { 'x-api-key': secret };
  if (protocol === 'gemini-generate-content') return { 'x-goog-api-key': secret };
  return { Authorization: `Bearer ${secret}` };
}

function bearerSecret(authorization: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec((authorization || '').trim());
  return match?.[1];
}

export function presentedChildSecret(protocol: ModelProtocol, headers: http.IncomingHttpHeaders): string | undefined {
  const bearer = bearerSecret(header(headers, 'authorization'));
  if (protocol === 'anthropic-messages') return header(headers, 'x-api-key')?.trim() || bearer;
  if (protocol === 'gemini-generate-content') return header(headers, 'x-goog-api-key')?.trim() || bearer;
  return bearer;
}

export function childAuthAccepted(
  protocol: ModelProtocol,
  headers: http.IncomingHttpHeaders,
  dummy: string,
  token: string,
): boolean {
  const secret = presentedChildSecret(protocol, headers);
  return secret === dummy || secret === token;
}

function authHeaders(protocol: ModelProtocol, key: string): Record<string, string> {
  if (protocol === 'anthropic-messages') {
    return { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  }
  if (protocol === 'gemini-generate-content') {
    return { 'x-goog-api-key': key };
  }
  return { Authorization: `Bearer ${key}` };
}

function generationConfig(body: JsonObject): JsonObject {
  const existing = asObject(body.generationConfig) ?? {};
  body.generationConfig = existing;
  return existing;
}

function thinkingFromFragment(fragment: JsonObject): JsonObject | undefined {
  const nested = asObject(fragment.thinkingConfig);
  if (nested) return nested;
  if (fragment.thinkingBudget !== undefined || fragment.thinkingLevel !== undefined || fragment.includeThoughts !== undefined) return fragment;
}

function stripEngineInjections(body: JsonObject, protocol: ModelProtocol) {
  delete body.reasoning;
  delete body.reasoning_effort;
  delete body.thinking;
  delete body.temperature;
  delete body.top_p;
  delete body.top_k;
  if (protocol === 'gemini-generate-content') {
    const config = asObject(body.generationConfig);
    if (config) {
      delete config.thinkingConfig;
      delete config.temperature;
      delete config.topP;
      delete config.topK;
      body.generationConfig = config;
    }
  }
}

export function applyWirePolicy(protocol: ModelProtocol, body: JsonObject, runtime: RuntimeModelConfig, maxOutput: number): JsonObject {
  const next: JsonObject = { ...body };
  const model = typeof next.model === 'string' ? next.model.trim() : '';
  if (model && model !== runtime.modelId && !model.endsWith('/' + runtime.modelId)) {
    throw new Error('请求模型与当前运行配置不一致。');
  }
  const omitted = runtime.reasoning?.omitted === true || !runtime.reasoning?.request;
  if (omitted) stripEngineInjections(next, protocol);
  if (protocol === 'gemini-generate-content') {
    delete next.model;
    generationConfig(next).maxOutputTokens = maxOutput;
  } else {
    next.model = runtime.modelId;
    if (protocol === 'openai-responses') {
      next.max_output_tokens = maxOutput;
      next.store = false;
      delete next.max_tokens;
    } else if (protocol === 'openai-chat-completions') {
      next.max_tokens = maxOutput;
      delete next.max_output_tokens;
    } else if (protocol === 'anthropic-messages') {
      next.max_tokens = maxOutput;
    }
  }
  const fragment = runtime.reasoning?.request;
  if (!omitted && fragment && typeof fragment === 'object') {
    if (protocol === 'gemini-generate-content') {
      const thinking = thinkingFromFragment(fragment as JsonObject);
      if (thinking) {
        const config = generationConfig(next);
        config.thinkingConfig = { ...asObject(config.thinkingConfig), ...thinking };
      }
    } else {
      for (const [key, value] of Object.entries(fragment)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          next[key] = { ...asObject(next[key]), ...asObject(value) };
        } else {
          next[key] = value;
        }
      }
    }
  }
  return next;
}

function safeErrorPayload(code: string, requestId?: string) {
  return JSON.stringify({ error: { type: 'upstream_error', code, request_id: requestId } });
}

function writeJson(res: http.ServerResponse, status: number, payload: string) {
  if (res.headersSent || res.destroyed || res.writableEnded) return;
  try {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Length', Buffer.byteLength(payload));
    res.end(payload);
  } catch {
    try { if (!res.destroyed) res.destroy(); } catch { /* ignore */ }
  }
}

function requestIdOf(headers: Headers | http.IncomingHttpHeaders): string | undefined {
  if (headers instanceof Headers) {
    return headers.get('x-request-id') || headers.get('request-id') || headers.get('cf-ray') || undefined;
  }
  const raw = headers['x-request-id'] || headers['request-id'] || headers['cf-ray'];
  return Array.isArray(raw) ? raw[0] : raw;
}

function headerRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => { out[key] = value; });
  return out;
}

function safeLog(message: string, extra?: { code?: string; requestId?: string }) {
  const code = extra?.code ? ` code=${extra.code}` : '';
  const id = extra?.requestId ? ` request_id=${extra.requestId}` : '';
  console.error(`[agent-proxy] ${message}${code}${id}`);
}

function readLimited(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer | string) => {
      if (tooLarge) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        req.resume();
        reject(Object.assign(new Error('payload_too_large'), { code: 'payload_too_large' }));
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (!tooLarge) resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function redactCapture(headers: http.IncomingHttpHeaders, path: string, method: string, body: JsonObject | undefined, bytes: number): SafeProxyRequest {
  const names = Object.keys(headers).map(item => item.toLowerCase());
  return {
    method,
    path,
    model: typeof body?.model === 'string' ? body.model : undefined,
    hasAuthorization: names.includes('authorization'),
    hasApiKey: names.includes('x-api-key'),
    hasGoogApiKey: names.includes('x-goog-api-key'),
    sessionHeader: header(headers, OPENCODE_SESSION_HEADER) || '',
    userAgent: header(headers, 'user-agent') || '',
    maxOutput: typeof body?.max_output_tokens === 'number'
      ? body.max_output_tokens
      : typeof body?.max_tokens === 'number'
        ? body.max_tokens
        : typeof asObject(body?.generationConfig)?.maxOutputTokens === 'number'
          ? asObject(body?.generationConfig)!.maxOutputTokens as number
          : undefined,
    reasoning: body?.reasoning ?? body?.reasoning_effort ?? asObject(body?.generationConfig)?.thinkingConfig ?? body?.thinking,
    store: body?.store,
    bytes,
  };
}

const defaultFetch = globalThis.fetch.bind(globalThis);

async function forwardViaFetch(
  fetchImpl: typeof fetch,
  target: string,
  method: string,
  headers: Headers,
  raw: Buffer,
  controller: AbortController,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  responseLimit: number,
) {
  if (controller.signal.aborted) {
    if (!res.headersSent && !res.destroyed) res.destroy();
    return;
  }
  let upstream: Response;
  try {
    upstream = await fetchImpl(target, {
      method,
      headers,
      body: raw.length ? raw.toString('utf8') : undefined,
      redirect: 'error',
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      if (!res.headersSent) res.destroy();
      return;
    }
    const err = error as { cause?: { code?: string }; code?: string };
    const code = err.cause?.code || err.code || 'upstream_error';
    if (String(code).includes('redirect') || String((error as Error).message || '').toLowerCase().includes('redirect')) {
      safeLog('upstream redirect rejected', { code: 'redirect' });
      writeJson(res, 502, safeErrorPayload('redirect_rejected'));
      return;
    }
    safeLog('upstream fetch failed', { code });
    writeJson(res, 502, safeErrorPayload('upstream_error'));
    return;
  }
  await writeUpstreamResponse(upstream.status, upstream.headers, upstream.body, req, res, controller.signal, responseLimit);
}

function forwardViaNode(
  target: string,
  method: string,
  headers: Headers,
  raw: Buffer,
  signal: AbortSignal,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  responseLimit: number,
): Promise<void> {
  return new Promise(resolve => {
    let url: URL;
    try { url = new URL(target); } catch {
      writeJson(res, 502, safeErrorPayload('upstream_error'));
      resolve();
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      writeJson(res, 502, safeErrorPayload('upstream_error'));
      resolve();
      return;
    }
    if (signal.aborted) {
      if (!res.headersSent && !res.destroyed) res.destroy();
      resolve();
      return;
    }
    const lib = url.protocol === 'https:' ? https : http;
    const headerMap: Record<string, string> = {
      ...headerRecord(headers),
      Host: url.host,
      Connection: 'close',
    };
    if (raw.length) headerMap['Content-Length'] = String(raw.length);
    const upstreamReq = lib.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method,
      headers: headerMap,
    }, async upstream => {
      const status = upstream.statusCode || 0;
      if (status >= 300 && status < 400) {
        upstream.resume();
        safeLog('upstream redirect rejected', { code: 'redirect' });
        writeJson(res, 502, safeErrorPayload('redirect_rejected'));
        resolve();
        return;
      }
      const webHeaders = new Headers();
      for (const [key, value] of Object.entries(upstream.headers)) {
        if (value === undefined) continue;
        webHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      await writeNodeStream(status, webHeaders, upstream, req, res, signal, responseLimit);
      resolve();
    });
    const onAbort = () => {
      upstreamReq.destroy();
      if (!res.writableEnded && !res.destroyed) res.destroy();
      resolve();
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    upstreamReq.on('error', error => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const code = (error as { code?: string }).code || 'upstream_error';
      if (String(code).includes('redirect') || /redirect/i.test(error.message)) {
        safeLog('upstream redirect rejected', { code: 'redirect' });
        writeJson(res, 502, safeErrorPayload('redirect_rejected'));
      } else {
        safeLog('upstream fetch failed', { code });
        if (!res.headersSent) writeJson(res, 502, safeErrorPayload('upstream_error'));
        else if (!res.writableEnded) res.destroy();
      }
      resolve();
    });
    if (raw.length) upstreamReq.write(raw);
    upstreamReq.end();
  });
}

async function writeUpstreamResponse(
  status: number,
  headers: Headers,
  body: ReadableStream<Uint8Array> | null,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  signal: AbortSignal,
  responseLimit: number,
) {
  const rid = requestIdOf(headers);
  if (status >= 300 && status < 400) {
    void body?.cancel();
    safeLog('upstream redirect rejected', { code: 'redirect', requestId: rid });
    writeJson(res, 502, safeErrorPayload('redirect_rejected', rid));
    return;
  }
  if (status >= 400) {
    const code = status === 401 || status === 403 || status === 429 ? `http_${status}` : 'upstream_error';
    safeLog('upstream error', { code, requestId: rid });
    writeJson(res, status >= 500 ? 502 : status, safeErrorPayload(code, rid));
    void body?.cancel();
    return;
  }
  copySafeHeaders(status, headers, res);
  if (!body) {
    res.end();
    return;
  }
  const reader = body.getReader();
  let sent = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      sent += value.length;
      if (sent > responseLimit) {
        safeLog('upstream response over limit', { code: 'response_too_large', requestId: rid });
        void reader.cancel().catch(() => undefined);
        res.destroy();
        return;
      }
      if (res.destroyed || signal.aborted) {
        void reader.cancel().catch(() => undefined);
        return;
      }
      res.write(Buffer.from(value));
    }
    res.end();
  } catch {
    void reader.cancel().catch(() => undefined);
    if (!res.writableEnded) res.destroy();
  }
}

function writeNodeStream(
  status: number,
  headers: Headers,
  upstream: http.IncomingMessage,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  signal: AbortSignal,
  responseLimit: number,
): Promise<void> {
  const rid = requestIdOf(headers);
  if (status >= 400) {
    upstream.resume();
    const code = status === 401 || status === 403 || status === 429 ? `http_${status}` : 'upstream_error';
    safeLog('upstream error', { code, requestId: rid });
    writeJson(res, status >= 500 ? 502 : status, safeErrorPayload(code, rid));
    return Promise.resolve();
  }
  copySafeHeaders(status, headers, res);
  (res as http.ServerResponse & { shouldKeepAlive?: boolean }).shouldKeepAlive = false;
  const lengthHeader = headers.get('content-length');
  const known = lengthHeader !== null && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : -1;
  return new Promise(resolve => {
    let sent = 0;
    const buffered: Buffer[] = [];
    const fail = () => {
      upstream.destroy();
      if (!res.writableEnded && !res.destroyed) res.destroy();
      resolve();
    };
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener('abort', fail, { once: true });
    const flushEnd = () => {
      if (res.writableEnded || res.destroyed) {
        resolve();
        return;
      }
      if (known >= 0) res.end(buffered.length ? Buffer.concat(buffered) : undefined);
      else res.end();
      resolve();
    };
    upstream.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      sent += buf.length;
      if (sent > responseLimit) {
        safeLog('upstream response over limit', { code: 'response_too_large', requestId: rid });
        fail();
        return;
      }
      if (res.destroyed || signal.aborted) {
        fail();
        return;
      }
      if (known >= 0) buffered.push(buf);
      else res.write(buf);
    });
    upstream.on('end', flushEnd);
    upstream.on('error', fail);
  });
}

function copySafeHeaders(status: number, headers: Headers, res: http.ServerResponse) {
  res.statusCode = status;
  const contentType = headers.get('content-type') || 'application/json';
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Connection', 'close');
  const skip = new Set(['transfer-encoding', 'connection', 'authorization', 'x-api-key', 'api-key', 'x-goog-api-key']);
  headers.forEach((value, key) => {
    const low = key.toLowerCase();
    if (skip.has(low) || low.includes('authorization') || low.includes('api-key')) return;
    if (low === 'content-type' || low === 'cache-control') return;
    try { res.setHeader(key, value); } catch { /* ignore hop-by-hop */ }
  });
}

export function startAgentProxy(options: AgentProxyOptions): Promise<AgentProxy> {
  const runtime = options.runtime;
  providerNpmForProtocol(runtime.protocol);
  const maxOutput = effectiveMaxOutput(runtime);
  const bodyLimit = options.bodyLimit ?? PROXY_BODY_MAX_BYTES;
  const responseLimit = options.responseLimit ?? PROXY_RESPONSE_MAX_BYTES;
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const discussionId = options.discussionId.trim();
  if (!discussionId) throw new Error('缺少会话标识。');
  const token = randomBytes(24).toString('hex');
  const routePrefix = proxyRoutePrefix(token);
  const controllers = new Set<AbortController>();
  let closed = false;

  const server = http.createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) writeJson(res, 500, safeErrorPayload('internal_error'));
      else if (!res.writableEnded) res.destroy();
    });
  });
  server.keepAliveTimeout = 5_000;
  server.headersTimeout = 15_000;
  server.requestTimeout = 0;

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const refuseClosed = () => {
      if (!closed) return false;
      writeJson(res, 503, safeErrorPayload('proxy_closed'));
      return true;
    };
    if (refuseClosed()) return;
    const host = header(req.headers, 'host');
    if (!isLocalHost(host?.split(':')[0])) {
      writeJson(res, 403, safeErrorPayload('forbidden_host'));
      return;
    }
    const origin = header(req.headers, 'origin');
    if (origin && !isLocalOrigin(origin)) {
      writeJson(res, 403, safeErrorPayload('forbidden_origin'));
      return;
    }
    const urlPath = req.url || '/';
    const stripped = stripRoutePrefix(urlPath, token);
    if (stripped === undefined) {
      writeJson(res, 401, safeErrorPayload('unauthorized'));
      return;
    }
    if (!childAuthAccepted(runtime.protocol, req.headers, DUMMY_UPSTREAM_KEY, token)) {
      writeJson(res, 401, safeErrorPayload('unauthorized'));
      return;
    }
    const method = (req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'POST' && method !== 'DELETE') {
      writeJson(res, 405, safeErrorPayload('method_not_allowed'));
      return;
    }
    if (!allowedChildPath(runtime.protocol, runtime.modelId, stripped)) {
      writeJson(res, 403, safeErrorPayload('forbidden_endpoint'));
      return;
    }
    let raw: Buffer;
    try {
      raw = method === 'GET' ? Buffer.alloc(0) : await readLimited(req, bodyLimit);
    } catch (error) {
      if (refuseClosed()) return;
      writeJson(res, (error as { code?: string }).code === 'payload_too_large' ? 413 : 400, safeErrorPayload((error as { code?: string }).code || 'bad_request'));
      return;
    }
    if (refuseClosed()) return;
    let body: JsonObject | undefined;
    if (raw.length) {
      try {
        const parsed = JSON.parse(raw.toString('utf8'));
        body = asObject(parsed);
        if (!body) {
          writeJson(res, 400, safeErrorPayload('invalid_json'));
          return;
        }
        try {
          body = applyWirePolicy(runtime.protocol, body, runtime, maxOutput);
        } catch {
          writeJson(res, 403, safeErrorPayload('model_mismatch'));
          return;
        }
        raw = Buffer.from(JSON.stringify(body));
      } catch {
        writeJson(res, 400, safeErrorPayload('invalid_json'));
        return;
      }
    }
    if (refuseClosed()) return;
    const target = upstreamUrlFor(runtime, stripped);
    if (!target) {
      writeJson(res, 403, safeErrorPayload('forbidden_endpoint'));
      return;
    }
    options.onSafeRequest?.(redactCapture(req.headers, pathnameOf(stripped) + queryStringOf(stripped), method, body, raw.length));
    const controller = new AbortController();
    controllers.add(controller);
    if (closed) {
      controller.abort();
      controllers.delete(controller);
      writeJson(res, 503, safeErrorPayload('proxy_closed'));
      return;
    }
    (req as http.IncomingMessage & { __abort?: AbortController }).__abort = controller;
    req.on('aborted', () => controller.abort());
    const headers = new Headers({
      Accept: header(req.headers, 'accept') || 'application/json, text/event-stream',
      'User-Agent': OPENCODE_USER_AGENT,
      Connection: 'close',
      [OPENCODE_SESSION_HEADER]: discussionId,
      ...authHeaders(runtime.protocol, runtime.key),
    });
    if (raw.length) headers.set('Content-Type', header(req.headers, 'content-type') || 'application/json');
    try {
      if (closed || controller.signal.aborted) {
        writeJson(res, 503, safeErrorPayload('proxy_closed'));
        return;
      }
      if (fetchImpl !== defaultFetch) {
        await forwardViaFetch(fetchImpl, target, method, headers, raw, controller, req, res, responseLimit);
      } else {
        await forwardViaNode(target, method, headers, raw, controller.signal, req, res, responseLimit);
      }
    } finally {
      controllers.delete(controller);
    }
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('代理未能绑定本机端口。'));
        return;
      }
      const origin = `http://127.0.0.1:${address.port}`;
      resolve({
        port: address.port,
        origin,
        childBaseURL: `${origin}${routePrefix}/v1`,
        token,
        routePrefix,
        close: async () => {
          closed = true;
          for (const controller of controllers) controller.abort();
          controllers.clear();
          server.closeAllConnections?.();
          await new Promise<void>((done, fail) => server.close(err => err ? fail(err) : done())).catch(() => undefined);
        },
      });
    });
  });
}
