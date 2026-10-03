import { correlationIdSchema, errorEnvelopeSchema, REQUEST_ID_HEADER, type ErrorEnvelope } from '@portfolio-pilot/contracts';

export function getRequestId(request: Request): string {
  const supplied = correlationIdSchema.safeParse(request.headers.get(REQUEST_ID_HEADER));
  return supplied.success ? supplied.data : crypto.randomUUID();
}

export function errorResponse(code: ErrorEnvelope['error']['code'], message: string, requestId: string, status: number): Response {
  const body = errorEnvelopeSchema.parse({ error: { code, message, requestId } });
  return Response.json(body, { status, headers: { [REQUEST_ID_HEADER]: requestId } });
}
