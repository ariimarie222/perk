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
  return Boolean(
    member
    && !member.user?.bot
    && member.roles?.cache?.has(MARKETPLACE_SELLER_ROLE_ID),
  );
}

export async function getMarketplaceSellerMembers(guild) {
  if (!guild) return [];

  await guild.members.fetch();
  const sellerRole = await guild.roles.fetch(MARKETPLACE_SELLER_ROLE_ID).catch(() => null);
  if (!sellerRole) return [];

  return [...sellerRole.members.values()]
    .filter(isMarketplaceSellerMember)
    .sort((a, b) => (a.displayName || a.user.username).localeCompare(b.displayName || b.user.username));
}
