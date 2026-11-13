/**
 * Payment-attempt logging (decision 7).
 *
 * The point of recording this at all is that the v1 server could not tell a
 * payment attempt from a probe, so demand was unmeasurable. The point of
 * recording it *this way* is that a log line is the easiest place to leak a
 * credential by accident: a header value, a preimage, a signature, a payment
 * hash. So the shape is a closed record built by one function, and the field
 * values are drawn from fixed vocabularies.
 *
 * `paymentHeader` is the header's **name**, never its value. There is no field
 * that could hold one.
 */

export type HeaderPresent = "PAYMENT-SIGNATURE" | "X-PAYMENT" | "NONE";

export type AttemptOutcome =
  | "no_payment"
  | "settled"
  | "replay_rejected"
  | "rate_limited"
  | "degraded"
  | "verify_fail"
  | "error";

export interface AttemptRecord {
  ts: string;
  event: "payment_attempt";
  path: string;
  /** Rail label, e.g. `exact/eip155:8453`; omitted when no rail was selected. */
  rail?: string;
  /** The header NAME only. */
  payment_header: HeaderPresent;
  outcome: AttemptOutcome;
  /** Coarse error class, from the same closed vocabulary as the 402. */
  reason?: string;
  status: number;
  ms: number;
  /** Client address (already resolved through the trusted-proxy rule). */
  client?: string;
}

export interface AttemptInput {
  path: string;
  rail?: string;
  /** Header names actually present on the request. */
  headers: { paymentSignature?: string | null; xPayment?: string | null };
  outcome: AttemptOutcome;
  reason?: string;
  status: number;
  startedAtMs: number;
  nowMs?: number;
  client?: string;
}

/**
 * Which payment header the request carried, by name.
 *
 * `PAYMENT-SIGNATURE` wins when both are present: v2 is the only header the
 * server reads, and naming it makes an "I sent X-PAYMENT" report diagnosable.
 */
export function headerPresent(headers: {
  paymentSignature?: string | null;
  xPayment?: string | null;
}): HeaderPresent {
  if (headers.paymentSignature) return "PAYMENT-SIGNATURE";
  if (headers.xPayment) return "X-PAYMENT";
  return "NONE";
}

/**
 * Build the record. `reason` is forced into the coarse vocabulary — a
 * facilitator's `invalidMessage` or a revert string can never be passed through
 * because there is no free-text field to put it in.
 */
export function attemptRecord(input: AttemptInput): AttemptRecord {
  const now = input.nowMs ?? Date.now();
  const record: AttemptRecord = {
    ts: new Date(now).toISOString(),
    event: "payment_attempt",
    path: input.path,
    payment_header: headerPresent(input.headers),
    outcome: input.outcome,
    status: input.status,
    ms: Math.max(0, now - input.startedAtMs),
  };
  if (input.rail) record.rail = input.rail;
  if (input.reason) record.reason = input.reason.slice(0, 64);
  if (input.client) record.client = input.client;
  return record;
}

/**
 * Emit the record as one JSON line. Kept separate from building it so tests can
 * assert the exact object without capturing stdout for every case.
 */
export function logAttempt(
  input: AttemptInput,
  sink: (line: string) => void = (line) => console.log(line)
): AttemptRecord {
  const record = attemptRecord(input);
  sink(JSON.stringify(record));
  return record;
}

/**
 * Fields that must never appear in an attempt record. Used by the tests as an
 * explicit statement of the redaction contract rather than an implicit one.
 */
export const FORBIDDEN_ATTEMPT_FIELDS = [
  "paymentsignature",
  "x-payment",
  "signature",
  "preimage",
  "payment_hash",
  "paymenthash",
  "authorization",
  "nonce",
  "invoice",
  "secret",
  "token",
  "uri",
] as const;
