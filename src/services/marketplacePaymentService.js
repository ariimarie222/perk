import {
  PAYMENT_METHOD_TYPES,
  PAYMENT_PROFILES,
  isPaymentMethodType,
  isPaymentProfileKey,
} from '../config/marketplace.js';
import { getMarketplacePaymentProfilesKey } from '../utils/database/keys.js';
import { getFromDb, setInDb } from '../utils/database/wrapper.js';

const SENSITIVE_PAYMENT_PATTERN = /\b(card|routing|account|password|passcode|security\s*code|cvv|cvc|recovery|login|credential)\b/i;
const POSSIBLE_CARD_NUMBER_PATTERN = /(?:\d[ -]*?){13,19}/;

function defaultProfiles() {
  return Object.fromEntries(
    Object.values(PAYMENT_PROFILES).map(profile => [
      profile.key,
      {
        key: profile.key,
        name: profile.name,
        enabled: false,
        methods: {},
        updatedAt: null,
        updatedBy: null,
      },
    ]),
  );
}

function sanitizeProfiles(value) {
  const defaults = defaultProfiles();
  if (!value || typeof value !== 'object') return defaults;

  for (const profileKey of Object.keys(defaults)) {
    const stored = value[profileKey];
    if (!stored || typeof stored !== 'object') continue;
    defaults[profileKey] = {
      ...defaults[profileKey],
      enabled: stored.enabled === true,
      methods: stored.methods && typeof stored.methods === 'object'
        ? Object.fromEntries(
          Object.entries(stored.methods)
            .filter(([, method]) => method && isPaymentMethodType(method.type)),
        )
        : {},
      updatedAt: stored.updatedAt || null,
      updatedBy: stored.updatedBy || null,
    };
  }
  return defaults;
}

export function assertSafePaymentText(...values) {
  const unsafe = values.find(value => value && (
    SENSITIVE_PAYMENT_PATTERN.test(String(value))
    || POSSIBLE_CARD_NUMBER_PATTERN.test(String(value))
  ));
  if (unsafe) {
    throw new Error('Card, bank-account, routing, login, password, security-code, and recovery information cannot be stored.');
  }
}

export async function getPaymentProfiles(guildId) {
  return sanitizeProfiles(await getFromDb(getMarketplacePaymentProfilesKey(guildId), null));
}

export async function getPaymentProfile(guildId, profileKey) {
  if (!isPaymentProfileKey(profileKey)) return null;
  const profiles = await getPaymentProfiles(guildId);
  return profiles[profileKey];
}

export async function updatePaymentProfile(guildId, profileKey, changes, staffId) {
  if (!isPaymentProfileKey(profileKey)) throw new Error('Invalid payment profile.');
  const profiles = await getPaymentProfiles(guildId);
  profiles[profileKey] = {
    ...profiles[profileKey],
    ...changes,
    key: profileKey,
    name: PAYMENT_PROFILES[profileKey].name,
    updatedAt: new Date().toISOString(),
    updatedBy: staffId,
  };
  await setInDb(getMarketplacePaymentProfilesKey(guildId), profiles);
  return profiles[profileKey];
}

export async function resetPaymentProfile(guildId, profileKey, staffId) {
  return updatePaymentProfile(guildId, profileKey, {
    enabled: false,
    methods: {},
  }, staffId);
}

export async function upsertPaymentMethod(guildId, profileKey, {
  methodKey,
  type,
  label,
  details,
  notes,
  enabled = true,
}, staffId) {
  if (!isPaymentProfileKey(profileKey)) throw new Error('Invalid payment profile.');
  if (!isPaymentMethodType(type)) throw new Error('Invalid payment method type.');
  assertSafePaymentText(label, details, notes);

  const profile = await getPaymentProfile(guildId, profileKey);
  const safeKey = String(methodKey || type).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
  if (!safeKey) throw new Error('Invalid payment method key.');
  if (!profile.methods[safeKey] && Object.keys(profile.methods).length >= 25) {
    throw new Error('A payment profile can contain up to 25 payment methods.');
  }

  const methods = {
    ...profile.methods,
    [safeKey]: {
      key: safeKey,
      type,
      label: String(label || PAYMENT_METHOD_TYPES[type]).slice(0, 80),
      details: String(details || '').trim().slice(0, 1000),
      notes: String(notes || '').trim().slice(0, 500),
      enabled: enabled === true,
      updatedAt: new Date().toISOString(),
      updatedBy: staffId,
    },
  };
  return updatePaymentProfile(guildId, profileKey, {
    methods,
    // A configured, enabled method makes its profile immediately publishable.
    // Staff should not need a separate profile-enable step after adding it.
    enabled: profile.enabled || enabled === true,
  }, staffId);
}

export async function removePaymentMethod(guildId, profileKey, methodKey, staffId) {
  const profile = await getPaymentProfile(guildId, profileKey);
  if (!profile) throw new Error('Invalid payment profile.');
  const methods = { ...profile.methods };
  delete methods[methodKey];
  return updatePaymentProfile(guildId, profileKey, { methods }, staffId);
}

export async function togglePaymentMethod(guildId, profileKey, methodKey, enabled, staffId) {
  const profile = await getPaymentProfile(guildId, profileKey);
  const method = profile?.methods?.[methodKey];
  if (!method) throw new Error('Payment method not found.');
  return upsertPaymentMethod(guildId, profileKey, {
    ...method,
    methodKey,
    enabled,
  }, staffId);
}
