import type { JevAnswer, JevQuestions, JevResponse, JevState } from './types.js';

export const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_MODEL = 'jev-latest';

export interface JevRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

/** The HTTP request for one Jev call, for any fetch-like transport. */
export function buildJevRequest(
  params: {
    apiKey: string;
    model?: string;
    baseUrl?: string;
  },
  state: JevState,
  questions: JevQuestions,
): JevRequest {
  return {
    url: params.baseUrl ?? SYSTEM_ONE_URL,
    method: 'POST',
    headers: {
      authorization: `Bearer ${params.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: params.model ?? DEFAULT_MODEL,
      state,
      questions,
    }),
  };
}

/** A non-2xx answer from the endpoint; `status` decides whether a retry makes sense. */
export class JevRequestError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`Jev request failed (${status}): ${body.slice(0, 200)}`);
    this.name = 'JevRequestError';
    this.status = status;
    this.body = body;
  }
  /** 429 and 5xx are transient by contract; anything else is the request's fault. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

/**
 * The transport failed before any status came back (DNS, TLS, a dropped
 * connection); retried like a 5xx. The built-in transports wrap a throwing
 * fetch in one; a custom `JevAsker` throws it to opt a failure into retries.
 */
export class JevTransportError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super(`Jev transport failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'JevTransportError';
    this.cause = cause;
  }
}

/** A 2xx answer whose body is not a Jev response; never retried. */
export class JevResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JevResponseError';
  }
}

/** Validates a Jev response body; throws on anything but an `answers` object. */
export function parseJevResponse(
  status: number,
  ok: boolean,
  text: string,
): JevResponse {
  if (!ok) throw new JevRequestError(status, text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new JevResponseError('Jev returned malformed JSON');
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('answers' in parsed) ||
    parsed.answers === null ||
    typeof parsed.answers !== 'object'
  ) {
    throw new JevResponseError('Jev response is missing answers');
  }
  return parsed as JevResponse;
}

/** The `noul` probability of one answer; throws when it is not there. */
export function noulAnswer(
  answers: Record<string, JevAnswer>,
  name: string,
): number {
  const answer = answers[name];
  if (
    !answer ||
    !('noul' in answer) ||
    typeof answer.noul !== 'number' ||
    !Number.isFinite(answer.noul)
  ) {
    throw new JevResponseError(`Invalid Jev answer for ${name}`);
  }
  return answer.noul;
}
