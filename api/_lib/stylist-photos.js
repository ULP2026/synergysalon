/**
 * Each stylist's portrait, as the public site's team section shows it.
 *
 * Migration 012 copies these into stylists.photo, but a console deployed
 * before that migration ran showed drawn faces for four people whose real
 * photos were sitting in /assets. This is the same list, used when the column
 * is empty or missing, so a stylist's own picture always wins over a drawing.
 */
const PHOTOS = {
  synergy: {
    dina: '/assets/327bffc0-8c69-40d5-95e6-d5606dcfd055.webp',
    micah: '/assets/861d841d-a864-4116-803f-7df3bf16a4ef.jpg',
    // The same portraits as the website's team cards. Tami's pointed at a file
    // that was replaced with her new photo and deleted, so it showed broken.
    tami: '/assets/4c2f790e-5f1c-4948-9bd4-ed15c32fee8b.webp',
    kim: '/assets/212524d4-61d2-4843-b817-b2b37d34691d.jpg',
  },
};

export function stylistPhoto(tenantSlug, stylistSlug) {
  return PHOTOS[tenantSlug]?.[stylistSlug] ?? null;
}
