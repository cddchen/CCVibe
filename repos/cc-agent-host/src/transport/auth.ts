import {
  AUTHENTICATION_FAILURE,
  extractBearer,
  type AuthorizationInput,
} from '../security/auth.js';
import type { BearerToken } from '../security/identity.js';

/**
 * Authentication primitives owned by the transport boundary.
 *
 * The transport deliberately knows only how to extract a bearer credential
 * and call an injected verifier. It does not know about OIDC, JWT claims, or
 * application ACLs. In particular, the credential is never included in the
 * verification context, result, or any error returned by this module.
 */

export type { AuthorizationInput, BearerToken };

/** A transport that can ask an authentication provider to verify a bearer. */
export type BearerTransport = 'websocket' | 'http';

/** Metadata safe to pass to an injected verifier. It intentionally contains no headers or URL. */
export interface BearerVerificationContext {
  readonly transport: BearerTransport;
  readonly remoteAddress?: string;
}

/**
 * Authentication provider port. The second argument is optional at runtime so
 * existing one-argument verifiers remain valid; production verifiers can use
 * the transport metadata without receiving raw request headers.
 */
export type BearerTokenVerifier<TPrincipal> = (
  token: BearerToken,
  context: BearerVerificationContext,
) => TPrincipal | null | undefined | PromiseLike<TPrincipal | null | undefined>;

/** Explicit async spelling for consumers that want a promise-only contract. */
export type AsyncBearerTokenVerifier<TPrincipal> = (
  token: BearerToken,
  context: BearerVerificationContext,
) => PromiseLike<TPrincipal | null | undefined>;

/** Descriptive aliases used by callers that name the port as an authenticator. */
export type BearerVerifier<TPrincipal> = BearerTokenVerifier<TPrincipal>;
export type BearerAuthenticationVerifier<TPrincipal> = BearerTokenVerifier<TPrincipal>;

/** Authenticated identity attached to a protocol connection. */
export interface AuthenticatedConnectionContext<TPrincipal> {
  readonly authenticated: true;
  readonly principal: TPrincipal;
  readonly scheme: 'Bearer';
}

/** Explicit anonymous context used only when a caller opts into anonymous development mode. */
export interface AnonymousConnectionContext {
  readonly authenticated: false;
  readonly scheme: 'Anonymous';
}

export type TransportAuthenticationContext<TPrincipal> =
  | AuthenticatedConnectionContext<TPrincipal>
  | AnonymousConnectionContext;

export type AuthenticationSuccess<TPrincipal> = {
  readonly ok: true;
  readonly context: TransportAuthenticationContext<TPrincipal>;
};

export type AuthenticationFailure = {
  readonly ok: false;
  /** Deliberately constant across missing, malformed and invalid credentials. */
  readonly error: 'authentication_failed';
};

export type AuthenticationResult<TPrincipal> =
  | AuthenticationSuccess<TPrincipal>
  | AuthenticationFailure;

/** One deliberately generic response used for every authentication failure. */
export const AUTHENTICATION_FAILURE_MESSAGE = 'authentication_failed' as const;

/** HTTP status for a failed or missing bearer credential. */
export const AUTHENTICATION_FAILURE_STATUS = 401 as const;

/** A policy-violation close code for a connection that cannot be authenticated after upgrade. */
export const AUTHENTICATION_FAILURE_CLOSE_CODE = 1008 as const;

/** Same reason for missing, malformed, invalid, and verifier-error credentials. */
export const AUTHENTICATION_FAILURE_CLOSE_REASON = AUTHENTICATION_FAILURE_MESSAGE;

/**
 * Extract one bearer value from an Authorization header. The value is branded
 * by the security boundary, so a caller cannot accidentally pass an arbitrary
 * string as an authenticated credential. The returned value is only for the
 * verifier and must not be logged or copied to a response.
 */
export function extractBearerToken(
  authorization: string | readonly string[] | undefined,
): BearerToken | undefined {
  const extraction = extractBearer({ authorization });
  return extraction.ok ? extraction.token : undefined;
}

/**
 * Return true when a URL contains a credential-shaped query parameter.
 * Long-lived credentials in URLs are forbidden even when authentication is
 * disabled for a local test server; rejecting them prevents accidental secret
 * acceptance and makes request logging safe by construction.
 */
export function containsCredentialQuery(url: string | undefined): boolean {
  if (url === undefined) {
    return false;
  }
  try {
    const parsed = new URL(url, 'http://transport.invalid');
    for (const key of parsed.searchParams.keys()) {
      const normalized = key.toLowerCase();
      if (
        normalized === 'token'
        || normalized === 'access_token'
        || normalized === 'id_token'
        || normalized === 'authorization'
        || normalized === 'bearer'
      ) {
        return true;
      }
    }
  } catch {
    // An invalid URL is handled by Fastify's normal routing. It is not a
    // credential-bearing URL we need to inspect here.
  }
  return false;
}

/**
 * Verify a request using the injected bearer port. All verifier failures,
 * including thrown/rejected errors, collapse to one safe failure category.
 */
export async function authenticateBearer<TPrincipal>(input: {
  readonly verifier?: BearerTokenVerifier<TPrincipal> | undefined;
  readonly required: boolean;
  readonly authorization?: string | readonly string[] | undefined;
  readonly url?: string;
  readonly context: BearerVerificationContext;
}): Promise<AuthenticationResult<TPrincipal>> {
  if (containsCredentialQuery(input.url)) {
    return AUTHENTICATION_FAILURE;
  }

  const token = extractBearerToken(input.authorization);
  if (token === undefined) {
    return input.required
      ? AUTHENTICATION_FAILURE
      : { ok: true, context: Object.freeze({ authenticated: false, scheme: 'Anonymous' }) };
  }

  if (input.verifier === undefined) {
    // A supplied credential cannot silently turn an unconfigured server into
    // an authenticated one. Configuration with required=false remains useful
    // for local deployments but still has no identity to authorize.
    return AUTHENTICATION_FAILURE;
  }

  try {
    const principal = await input.verifier(token, input.context);
    if (principal === null || principal === undefined) {
      return AUTHENTICATION_FAILURE;
    }
    return {
      ok: true,
      context: Object.freeze({ authenticated: true, principal, scheme: 'Bearer' }),
    };
  } catch {
    return AUTHENTICATION_FAILURE;
  }
}

/** Safe JSON body for an HTTP authentication rejection. */
export function safeAuthenticationFailureBody(): {
  readonly error: typeof AUTHENTICATION_FAILURE_MESSAGE;
} {
  return Object.freeze({ error: AUTHENTICATION_FAILURE_MESSAGE });
}

/** The shared security-layer failure object, exposed for integration tests without its token. */
export { AUTHENTICATION_FAILURE };
