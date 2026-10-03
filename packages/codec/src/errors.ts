/**
 * Error codes raised by the SMG codec. Codes are stable across versions and
 * are documented in docs/SPEC.md §9 ("Error codes").
 */
export const SmgErrorCode = {
  /** The input does not start with the SMG signature. */
  BAD_SIGNATURE: 'SMG_E_SIGNATURE',
  /** The file's major version is not supported by this decoder. */
  UNSUPPORTED_VERSION: 'SMG_E_VERSION',
  /** The input ended before a structure was complete. */
  TRUNCATED: 'SMG_E_TRUNCATED',
  /** A chunk's CRC-32 did not match its contents. */
  CRC_MISMATCH: 'SMG_E_CRC',
  /** Chunks appear in an invalid order or a required chunk is missing/duplicated. */
  CHUNK_ORDER: 'SMG_E_CHUNK_ORDER',
  /** A critical chunk type is unknown to this decoder. */
  UNKNOWN_CRITICAL_CHUNK: 'SMG_E_UNKNOWN_CRITICAL',
  /** Header fields are malformed or out of range. */
  BAD_HEADER: 'SMG_E_HEADER',
  /** Image dimensions exceed configured safety limits. */
  LIMIT_EXCEEDED: 'SMG_E_LIMIT',
  /** The encoded payload is internally inconsistent. */
  CORRUPT_PAYLOAD: 'SMG_E_CORRUPT',
  /** The payload uses a codec this decoder does not implement. */
  UNSUPPORTED_CODEC: 'SMG_E_CODEC',
  /** Decoded pixels did not match the stored pixel checksum. */
  CHECKSUM_MISMATCH: 'SMG_E_CHECKSUM',
  /** Caller supplied invalid arguments (e.g. wrong buffer size). */
  INVALID_ARGUMENT: 'SMG_E_ARGUMENT',
  /** Operation was cancelled by the caller. */
  ABORTED: 'SMG_E_ABORTED',
  /** An input image file (PNG, BMP, GIF …) could not be parsed. */
  BAD_INPUT_IMAGE: 'SMG_E_INPUT',
} as const;

export type SmgErrorCode = (typeof SmgErrorCode)[keyof typeof SmgErrorCode];

export class SmgError extends Error {
  readonly code: SmgErrorCode;
  constructor(code: SmgErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'SmgError';
    this.code = code;
  }
}

export function fail(code: SmgErrorCode, message: string): never {
  throw new SmgError(code, message);
}

export function isSmgError(e: unknown): e is SmgError {
  return e instanceof SmgError || (typeof e === 'object' && e !== null && (e as { name?: string }).name === 'SmgError');
}
