/** Records requests and returns scripted responses for Graph API tests. */

export interface RecordedRequest {
  method: string;
  url: string;
  body: string | null;
  headers: Record<string, string>;
}

export type Responder = (req: RecordedRequest) => {
  status?: number;
  // deno-lint-ignore no-explicit-any
  json?: any;
  text?: string;
};

export interface FetchMock {
  fetch: typeof fetch;
  requests: RecordedRequest[];
  /** Parsed form body of request `i` (for application/x-www-form-urlencoded). */
  form(i: number): URLSearchParams;
  /** Parsed query string of request `i`. */
  query(i: number): URLSearchParams;
}

export function createFetchMock(responder: Responder): FetchMock {
  const requests: RecordedRequest[] = [];

  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : null;
    const headers: Record<string, string> = {};
    const h = init?.headers;
    if (h) {
      const entries = h instanceof Headers
        ? [...h.entries()]
        : Array.isArray(h)
        ? h
        : Object.entries(h);
      for (const [k, v] of entries) headers[k.toLowerCase()] = String(v);
    }
    const recorded: RecordedRequest = { method, url, body, headers };
    requests.push(recorded);

    const r = responder(recorded);
    const status = r.status ?? 200;
    const responseBody = r.text ?? (r.json !== undefined ? JSON.stringify(r.json) : "");
    return Promise.resolve(
      new Response(responseBody, {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;

  return {
    fetch: fetchImpl,
    requests,
    form(i) {
      return new URLSearchParams(requests[i].body ?? "");
    },
    query(i) {
      return new URL(requests[i].url).searchParams;
    },
  };
}
