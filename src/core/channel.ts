/**
 * Shared channel vocabulary.
 *
 * This lives in `core` (the shared kernel) rather than in `moderation` because `policy` and
 * `knowledge` both need to reason about surfaces, and neither may depend on `moderation`
 * (ADR-001). The *entities* that use these values — channel connections, identities — stay in
 * their owning modules; only the vocabulary is shared.
 */
export const CHANNELS = ['FACEBOOK', 'INSTAGRAM', 'WHATSAPP', 'WEB', 'TEST'] as const;
export type Channel = (typeof CHANNELS)[number];

/**
 * Surfaces are separate from channels from day one: a public comment and a private DM on the same
 * Facebook page carry different authority, different privacy constraints, and different risk.
 * Modelling only the channel would force those rules to be rediscovered later, inside code that
 * had already assumed privacy.
 */
export const SURFACES = ['DIRECT_MESSAGE', 'PUBLIC_COMMENT'] as const;
export type Surface = (typeof SURFACES)[number];

export function isPublicSurface(surface: Surface): boolean {
  return surface === 'PUBLIC_COMMENT';
}
