/**
 * Errors from talking to OPNsense, mapped to a small set of kinds the rest of
 * the app can act on. Messages never contain credentials or full URLs with auth.
 */

export type OpnsenseErrorKind =
  | "auth" // 401 / expired session: not (or no longer) signed in
  | "forbidden" // 403: signed in, but the OPNsense user lacks the privilege
  | "unsupported" // 404: endpoint not available on this version
  | "validation" // result: failed + validations
  | "rejected" // OPNsense refused the operation (errorMessage), e.g. alias in use
  | "server" // 5xx
  | "timeout"
  | "network" // DNS, refused, reset
  | "tls" // certificate problems
  | "protocol"; // unexpected response shape

export class OpnsenseError extends Error {
  constructor(
    public readonly kind: OpnsenseErrorKind,
    message: string,
    public readonly details: {
      endpoint?: string;
      status?: number;
      validations?: Record<string, string | string[]>;
      title?: string;
    } = {},
  ) {
    super(message);
    this.name = "OpnsenseError";
  }

  /** Safe to send to the browser. */
  toJSON() {
    return {
      kind: this.kind,
      message: this.message,
      endpoint: this.details.endpoint,
      status: this.details.status,
      validations: this.details.validations,
    };
  }
}

const TLS_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_NOT_YET_VALID",
]);

/** Map a thrown fetch/undici error into an OpnsenseError. */
export function mapTransportError(err: unknown, endpoint: string): OpnsenseError {
  const e = err as { name?: string; code?: string; cause?: { code?: string; message?: string } };
  const code = e?.cause?.code ?? e?.code ?? "";
  if (e?.name === "TimeoutError" || e?.name === "AbortError" || code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT") {
    return new OpnsenseError("timeout", "The firewall did not respond in time.", { endpoint });
  }
  if (code === "ERR_TLS_PIN_MISMATCH") {
    return new OpnsenseError(
      "tls",
      "The firewall presented a different certificate than the one pinned in the topology (tlsFingerprint). If the firewall's certificate was renewed, update the fingerprint; otherwise someone may be intercepting the connection.",
      { endpoint },
    );
  }
  if (TLS_CODES.has(code)) {
    return new OpnsenseError(
      "tls",
      `The firewall's TLS certificate could not be verified (${code}). Pin it with "tlsFingerprint" (npm run fingerprint -- <address>) or add its CA as "caFile" in the topology file.`,
      { endpoint },
    );
  }
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ECONNRESET" || code === "EHOSTUNREACH" || code === "ETIMEDOUT") {
    return new OpnsenseError("network", `Could not reach the firewall (${code}).`, { endpoint });
  }
  return new OpnsenseError("network", "Could not reach the firewall.", { endpoint });
}

/** Map an HTTP response status/body into an error, or null when it is a success. */
export function mapResponseError(status: number, body: unknown, endpoint: string): OpnsenseError | null {
  const b = (body ?? {}) as Record<string, unknown>;
  if (status === 401) {
    return new OpnsenseError("auth", "The firewall did not accept the sign-in (wrong credentials or the session ended).", { endpoint, status });
  }
  if (status === 403) {
    // OPNsense answers an ACL denial with JSON {status: 403}; a failed CSRF check
    // on a session request has an empty body. Don't send admins chasing ACLs then.
    const aclDenial = typeof b.status === "number" || typeof b.message === "string";
    return new OpnsenseError(
      "forbidden",
      aclDenial
        ? `Your OPNsense user lacks the privilege for ${endpoint}.`
        : `The firewall refused ${endpoint} (missing privilege, or the firewall session's security token was rejected; signing in again helps in that case).`,
      { endpoint, status },
    );
  }
  if (status === 404) {
    return new OpnsenseError("unsupported", "This API endpoint is not available on the connected OPNsense version.", { endpoint, status });
  }
  if (status >= 500) {
    return new OpnsenseError("server", "The firewall reported an internal error.", { endpoint, status });
  }
  if (typeof b.errorMessage === "string") {
    return new OpnsenseError("rejected", b.errorMessage, { endpoint, status, title: typeof b.errorTitle === "string" ? b.errorTitle : undefined });
  }
  if (b.result === "failed") {
    const validations = (b.validations ?? {}) as Record<string, string | string[]>;
    return new OpnsenseError("validation", "The firewall rejected the change.", { endpoint, status, validations });
  }
  if (status >= 400) {
    return new OpnsenseError("server", `Unexpected HTTP status ${status}.`, { endpoint, status });
  }
  return null;
}
