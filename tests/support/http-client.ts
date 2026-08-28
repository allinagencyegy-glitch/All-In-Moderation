import { request } from 'node:http';
import type { OutgoingHttpHeaders } from 'node:http';

/**
 * A deliberately unhelpful HTTP client.
 *
 * `fetch` would be shorter, but it is helpful in exactly the ways this suite must not tolerate:
 * it sets its own headers, decides its own encodings, and — the disqualifying one — will not send
 * a body that is not valid UTF-8. Two of the tests here exist precisely to prove what happens to
 * such a body, so the client has to be able to put arbitrary bytes on the wire.
 *
 * It also reports elapsed time, because "the acknowledgement is fast" is an assertion about
 * duration and a claim nobody has measured is a claim.
 */

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
  readonly durationMs: number;
}

export interface HttpRequestOptions {
  readonly method?: string;
  readonly headers?: OutgoingHttpHeaders;
  readonly body?: Buffer | string;
  readonly timeoutMs?: number;
  /**
   * Sends the body chunked, with no `Content-Length`.
   *
   * The two size-cap paths are genuinely different code: one refuses on a declared length before
   * reading anything, the other counts bytes as they arrive. A client that always declares a
   * length can only ever exercise the first.
   */
  readonly omitContentLength?: boolean;
}

export function httpRequest(
  base: { port: number; host: string },
  path: string,
  options: HttpRequestOptions = {},
): Promise<HttpResponse> {
  return new Promise<HttpResponse>((resolve, reject) => {
    const startedAt = Date.now();
    const body =
      options.body === undefined
        ? null
        : Buffer.isBuffer(options.body)
          ? options.body
          : Buffer.from(options.body, 'utf8');

    const headers: OutgoingHttpHeaders = { ...options.headers };
    // Set explicitly rather than left to chunked encoding: the size-cap tests care about what the
    // server is *told* the length is as much as about what arrives.
    if (body && !options.omitContentLength && headers['content-length'] === undefined) {
      headers['content-length'] = body.length;
    }

    const req = request(
      {
        // The server may bind `::` or `0.0.0.0`; neither is a connectable address on every host.
        host: base.host === '::' || base.host === '0.0.0.0' ? '127.0.0.1' : base.host,
        port: base.port,
        path,
        method: options.method ?? 'GET',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            durationMs: Date.now() - startedAt,
          });
        });
      },
    );

    req.setTimeout(options.timeoutMs ?? 10_000, () => {
      req.destroy(new Error('client timeout'));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Parses a JSON response body, failing loudly rather than returning `any`. */
export function jsonBody(response: HttpResponse): Record<string, unknown> {
  const parsed: unknown = JSON.parse(response.body);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`expected a JSON object, received: ${response.body.slice(0, 200)}`);
  }
  return parsed as Record<string, unknown>;
}
