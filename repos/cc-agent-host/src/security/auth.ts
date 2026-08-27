import {
  createBearerToken,
  type BearerToken,
  type Principal,
} from './identity.js';

export interface AuthorizationHeaders {
  readonly authorization?: string | readonly string[] | undefined;
}

export type AuthorizationInput = string | AuthorizationHeaders | undefined;

export interface BearerExtractionSuccess {
  readonly ok: true;
  /** Only the injected verifier receives this value; it is never in failures. */
  readonly token: BearerToken;
}

export interface BearerExtractionFailure {
  readonly ok: false;
}

export type BearerExtraction = BearerExtractionSuccess | BearerExtractionFailure;

/** A verifier is an injected product/OIDC/mTLS boundary, not a policy global. */
export type BearerVerifier = (
  token: BearerToken,
) => Principal | null | undefined | PromiseLike<Principal | null | undefined>;

export interface AuthenticatedResult {
  readonly ok: true;
  readonly principal: Principal;
}

export interface AuthenticationFailure {
  readonly ok: false;
  /** Deliberately constant for missing, malformed, expired and unknown tokens. */
  readonly error: 'authentication_failed';
}

export type AuthenticationResult = AuthenticatedResult | AuthenticationFailure;

export const AUTHENTICATION_FAILURE: AuthenticationFailure = Object.freeze({
  ok: false,
  error: 'authentication_failed',
});

function authorizationValue(input: AuthorizationInput): string | readonly string[] | undefined {
  if (typeof input === 'string' || input === undefined) {
    return input;
  }
  return input.authorization;
}

/**
 * Extract exactly one RFC-style `Bearer <opaque-token>` credential.  The
 * result has a constant failure shape and never includes malformed input or a
 * reason that could be used for account enumeration.
 */
export function extractBearer(input: AuthorizationInput): BearerExtraction {
  const header = authorizationValue(input);
  if (Array.isArray(header)) {
    if (header.length !== 1) {
      return { ok: false };
    }
    return extractBearer(header[0]);
  }
  if (typeof header !== 'string') {
    return { ok: false };
  }

  // Do not let JavaScript's `$` regexp behavior accept a value with a hidden
  // trailing newline or another header control character.
  if (/[\u0000-\u001f\u007f]/u.test(header)) {
    return { ok: false };
  }

  const match = /^Bearer[ \t]+([^\s]+)$/iu.exec(header);
  if (match?.[1] === undefined) {
    return { ok: false };
  }
  try {
    return { ok: true, token: createBearerToken(match[1]) };
  } catch {
    return { ok: false };
  }
}

/** Convenience form for callers that only need to pass a token to a verifier. */
export function extractBearerToken(input: AuthorizationInput): BearerToken | undefined {
  const extraction = extractBearer(input);
  return extraction.ok ? extraction.token : undefined;
}

/**
 * Authenticate at the transport boundary.  Verifier exceptions are collapsed
 * to the same frozen failure object as every other authentication failure.
 * The token is not returned in the result and therefore cannot enter a JSON
 * error response, action payload, or structured log by accident.
 */
export async function authenticateBearer(
  input: AuthorizationInput,
  verify: BearerVerifier,
): Promise<AuthenticationResult> {
  const extraction = extractBearer(input);
  if (!extraction.ok) {
    return AUTHENTICATION_FAILURE;
  }
  try {
    const principal = await verify(extraction.token);
    return principal === null || principal === undefined
      ? AUTHENTICATION_FAILURE
      : Object.freeze({ ok: true, principal });
  } catch {
    return AUTHENTICATION_FAILURE;
  }
}

export const verifyBearer = authenticateBearer;
export const authenticate = authenticateBearer;
