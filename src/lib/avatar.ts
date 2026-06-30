// ====================================================================
// Nexus Gate — Avatar Seed Generator
// Generates a neutral, gender-free avatar seed from the account name.
// Uses a hash of the name so the avatar is deterministic and consistent
// across devices, without revealing personal information.
// ====================================================================

import { createHash } from "crypto";

/**
 * Generates a neutral avatar seed from a full name.
 * The seed is a hash of the name — it doesn't encode gender, ethnicity,
 * or any personal characteristic. It's just a deterministic string that
 * DiceBear uses to generate a consistent cartoon avatar.
 *
 * @param fullName The account holder's full name
 * @returns A short hex string (8 chars) suitable as a DiceBear seed
 */
export function generateAvatarSeed(fullName: string): string {
  const normalized = fullName.toLowerCase().trim().replace(/\s+/g, " ");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 8);
}
