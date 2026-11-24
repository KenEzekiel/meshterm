type HttpHandler = (request: Request, requestId: string) => Response | Promise<Response>;

export function withHttpLogging(handle: HttpHandler) {
  return async (request: Request): Promise<Response> => {
    const requestId = crypto.randomUUID();
    const started = performance.now();
    const path = new URL(request.url).pathname;
    const route = ["/health", "/livez", "/readyz", "/internal/metrics"].includes(path)
      ? path
      : path.startsWith("/v1/") ? "/v1/*" : "unmatched";
    const method = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(request.method)
      ? request.method
      : "OTHER";
    let status = 500;
    try {
      const response = await handle(request, requestId);
      status = response.status;
      response.headers.set("x-request-id", requestId);
      return response;
    } finally {
      console.log(JSON.stringify({
        schema: "personal.observability.v1",
        event: "http.request",
        route,
        method,
        status,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        requestId,
        errorType: status >= 500 ? "ServerError" : "none",
      }));
    }
  };
}
