export const MARKETPLACE_SELLER_IDS = Object.freeze([
  '900918516855742497',
  '761610879924961280',
  '1464305576828997754',
  '876364511886589962',
  '484469700164714506',
]);

export const MARKETPLACE_SELLER_ROLE_ID = '1444267814851448862';

export const PAYMENT_PROFILES = Object.freeze({
  'arii-josi': Object.freeze({ key: 'arii-josi', name: 'Arii & Josi' }),
  burhan: Object.freeze({ key: 'burhan', name: 'Burhan' }),
  maj: Object.freeze({ key: 'maj', name: 'Maj' }),
  flix: Object.freeze({ key: 'flix', name: 'Flix' }),
  elias: Object.freeze({ key: 'elias', name: 'Elias' }),
});

export const PAYMENT_METHOD_TYPES = Object.freeze({
  cashapp: 'Cash App',
  applepay: 'Apple Pay',
  paypal: 'PayPal',
  venmo: 'Venmo',
  zelle: 'Zelle',
  crypto: 'Crypto',
});

export function isPaymentProfileKey(profileKey) {
  return Object.hasOwn(PAYMENT_PROFILES, String(profileKey));
}

export function isPaymentMethodType(methodType) {
  return Object.hasOwn(PAYMENT_METHOD_TYPES, String(methodType));
}

export function isMarketplaceSellerMember(member) {
  if (!member || member.user?.bot) return false;

  return Boolean(
    member.roles?.cache?.has(MARKETPLACE_SELLER_ROLE_ID)
    || MARKETPLACE_SELLER_IDS.includes(member.id),
  );
}

export async function getMarketplaceSellerMembers(guild) {
  if (!guild) return [];

  // Refresh the member cache first so role.members is not stale after role changes.
  await guild.members.fetch().catch(() => null);

  const sellersById = new Map();
  const sellerRole = await guild.roles.fetch(MARKETPLACE_SELLER_ROLE_ID).catch(() => null);

  // The role is the live source of truth when Discord can resolve it.
  if (sellerRole) {
    for (const member of sellerRole.members.values()) {
      if (isMarketplaceSellerMember(member)) sellersById.set(member.id, member);
    }
  }

  // Keep /vouch usable if the role lookup/cache temporarily fails. These are the
  // same explicitly approved marketplace sellers already used elsewhere by Perk.
  for (const sellerId of MARKETPLACE_SELLER_IDS) {
    const member = guild.members.cache.get(sellerId)
      || await guild.members.fetch(sellerId).catch(() => null);
    if (isMarketplaceSellerMember(member)) sellersById.set(member.id, member);
  }

  return [...sellersById.values()]
    .sort((a, b) => (a.displayName || a.user.username).localeCompare(b.displayName || b.user.username));
}
