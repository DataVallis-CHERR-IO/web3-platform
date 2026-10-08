// Ratings of organisations (ADR-058, TASK-057): what a donor signs with their
// wallet (EIP-712 typed data) and the rules the server checks. One definition
// for the browser (signing) and the server (verifying).

import { keccak256, stringToBytes, zeroHash, type Address, type Hex } from "viem";

/** Days a finished campaign can be rated (ADR-058). */
export const RATING_WINDOW_DAYS = 90;
/** Maximum comment length in characters. */
export const RATING_COMMENT_MAX = 1000;
/** How far `issuedAt` may be from the server clock, in seconds. */
export const RATING_ISSUED_AT_TOLERANCE_S = 600;
/** Campaign states that can be rated (finished; ADR-058). */
export const RATEABLE_CAMPAIGN_STATES = ["COMPLETED", "FAILED", "REJECTED"] as const;

export function ratingDomain(chainId: number) {
  return { name: "CHERR.IO", version: "1", chainId } as const;
}

export const RATING_TYPES = {
  Rating: [
    { name: "campaign", type: "address" },
    { name: "organization", type: "string" },
    { name: "stars", type: "uint8" },
    { name: "commentHash", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
  ],
} as const;

/** keccak256 of the UTF-8 comment; the zero hash without a comment. */
export function ratingCommentHash(comment: string | null | undefined): Hex {
  return comment ? keccak256(stringToBytes(comment)) : zeroHash;
}

export interface RatingInput {
  campaign: Address;
  /** The organisation's UUID. */
  organization: string;
  stars: number;
  comment: string | null;
  /** Unix seconds. */
  issuedAt: bigint;
}

/** The typed data a donor signs (eth_signTypedData_v4 / viem signTypedData). */
export function ratingTypedData(chainId: number, input: RatingInput) {
  return {
    domain: ratingDomain(chainId),
    types: RATING_TYPES,
    primaryType: "Rating" as const,
    message: {
      campaign: input.campaign,
      organization: input.organization,
      stars: input.stars,
      commentHash: ratingCommentHash(input.comment),
      issuedAt: input.issuedAt,
    },
  };
}

/** Trims a comment; empty becomes null. */
export function normaliseRatingComment(comment: string | null | undefined): string | null {
  const c = (comment ?? "").trim();
  return c.length > 0 ? c : null;
}
