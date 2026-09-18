import type { JevAnswer, JevQuestions, JevResponse, JevState, NoulAnswer } from './types.js';

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

/**
 * Every failure a Jev call can raise. `retryable` is the one place that says
 * whether another attempt could help; a plain `Error` from elsewhere never is.
 */
export abstract class JevError extends Error {
  constructor(message: string, name: string) {
    super(message);
    this.name = name;
  }
  get retryable(): boolean {
    return false;
  }
}

/** A non-2xx answer from the endpoint; `status` decides whether a retry makes sense. */
export class JevRequestError extends JevError {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`Jev request failed (${status}): ${body.slice(0, 200)}`, 'JevRequestError');
    this.status = status;
    this.body = body;
  }
  /** 429 and 5xx are transient by contract; anything else is the request's fault. */
  override get retryable(): boolean {
    const rateLimited = this.status === 429;
    const serverSide = this.status >= 500;
    return rateLimited || serverSide;
  }
}

type Thrown = { name?: unknown; code?: unknown; message?: unknown };

/** The caller gave up: an `AbortError` from a signal. */
function abortedByCaller(cause: Thrown): boolean {
  return cause.name === 'AbortError';
}

/** The URL itself is wrong: a configuration error, not the network. */
function unparsableUrl(cause: Thrown): boolean {
  return cause.code === 'ERR_INVALID_URL' || /invalid url|failed to parse url/i.test(String(cause.message ?? ''));
}

/**
 * The transport failed before any status came back (DNS, TLS, a dropped
 * connection); retried like a 5xx. The built-in transports wrap a throwing
 * fetch in one; a custom `JevAsker` throws it to opt a failure into retries.
 */
export class JevTransportError extends JevError {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super(`Jev transport failed: ${cause instanceof Error ? cause.message : String(cause)}`, 'JevTransportError');
    this.cause = cause;
  }
  /** True unless the caller aborted or the URL cannot be parsed. */
  override get retryable(): boolean {
    if (!this.cause || typeof this.cause !== 'object') return true;
    const cause = this.cause as Thrown;
    return !abortedByCaller(cause) && !unparsableUrl(cause);
  }
}

/** A 2xx answer whose body is not a Jev response; never retried. */
export class JevResponseError extends JevError {
  /** The question names whose answers were missing or malformed, when known. */
  readonly names: readonly string[];
  constructor(message: string, names: readonly string[] = []) {
    super(message, 'JevResponseError');
    this.names = names;
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

/** Whether `answer` carries a finite `noul` probability. */
export function hasNoul(answer: JevAnswer | undefined): answer is NoulAnswer {
  return answer !== undefined && 'noul' in answer && Number.isFinite(answer.noul);
}

/** The `noul` probability of one answer; throws when it is not there. */
export function noulAnswer(
  answers: Record<string, JevAnswer>,
  name: string,
): number {
  const answer = answers[name];
  if (!hasNoul(answer)) throw new JevResponseError(`Invalid Jev answer for ${name}`, [name]);
  return answer.noul;
}
