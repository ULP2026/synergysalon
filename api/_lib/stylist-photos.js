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
    micah: '/assets/6aec6da9-e6b5-44e1-885c-290acabf56c8.webp',
    tami: '/assets/040961f5-e03d-48bb-8574-b5b1708a7c72.webp',
    kim: '/assets/212524d4-61d2-4843-b817-b2b37d34691d.jpg',
  },
};

export function stylistPhoto(tenantSlug, stylistSlug) {
  return PHOTOS[tenantSlug]?.[stylistSlug] ?? null;
}
