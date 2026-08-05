import { MARKETPLACE_SELLER_IDS } from '../config/marketplace.js';
import {
  listMarketplaceVouches,
  saveMarketplaceVouch,
  setSellerMarketplaceStats,
} from '../utils/database/tickets.js';
import { logger } from '../utils/logger.js';

export const LEGACY_VOUCH_CHANNEL_ID = '1444261518068682763';

function mentionId(value = '') {
  return String(value).match(/<@!?(\d{16,22})>/)?.[1] || null;
}

function parseRating(value = '') {
  const text = String(value);
  const stars = text.match(/⭐/g)?.length || 0;
  if (stars >= 1 && stars <= 5) return stars;

  const fraction = text.match(/\b([1-5])\s*\/\s*5\b/);
  if (fraction) return Number(fraction[1]);

  const labelled = text.match(/(?:rating|stars?)\s*[:=-]?\s*([1-5])\b/i);
  return labelled ? Number(labelled[1]) : null;
}

function parseService(value = '') {
  const normalized = String(value).toLowerCase().replace(/[\s_-]+/g, '');
  if (normalized.includes('cashout')) return 'cashout';
  if (normalized.includes('preorder')) return 'preorder';
  if (normalized.includes('middleman')) return 'middleman';
  if (normalized.includes('purchase')) return 'purchase';
  return 'marketplace';
}

function embedText(embed) {
  return [
    embed?.title,
    embed?.description,
    ...(embed?.fields || []).flatMap(field => [field.name, field.value]),
    embed?.footer?.text,
  ].filter(Boolean).join('\n');
}

export function parseMarketplaceVouchMessage(message) {
  const embed = message.embeds?.[0] || null;
  const fields = embed?.fields || [];
  const field = name => fields.find(item => item.name?.toLowerCase() === name)?.value || '';
  const fullText = [message.content, embedText(embed)].filter(Boolean).join('\n');

  const sellerFromField = mentionId(field('seller'));
  const mentionedApprovedSellers = MARKETPLACE_SELLER_IDS.filter(id =>
    new RegExp(`<@!?${id}>`).test(fullText),
  );
  const sellerId = sellerFromField && MARKETPLACE_SELLER_IDS.includes(sellerFromField)
    ? sellerFromField
    : mentionedApprovedSellers.length === 1 ? mentionedApprovedSellers[0] : null;
  if (!sellerId) return null;

  const rating = parseRating(field('rating')) ?? parseRating(fullText);
  if (!rating) return { candidate: true, reason: 'missing_rating', sellerId };

  const buyerId = mentionId(field('buyer')) || (message.author?.bot ? null : message.author?.id) || null;
  const review = field('review') || message.content?.trim() || 'Legacy marketplace vouch';
  const serviceType = parseService(field('service') || fullText);
  const proofUrl = embed?.image?.url
    || message.attachments?.find?.(attachment => attachment.contentType?.startsWith('image/'))?.url
    || message.attachments?.first?.()?.url
    || null;

  return {
    candidate: true,
    record: {
      id: message.id,
      sellerId,
      buyerId,
      serviceType,
      rating,
      review: String(review).slice(0, 1000),
      proofUrl,
      submittedAt: message.createdAt?.toISOString?.() || new Date(Number(message.createdTimestamp || Date.now())).toISOString(),
      source: 'history-backfill',
      vouchMessageId: message.id,
      vouchChannelId: message.channelId,
      messageUrl: message.url,
    },
  };
}

async function fetchAllMessages(channel) {
  const messages = [];
  let before;
  while (true) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!batch.size) break;
    messages.push(...batch.values());
    before = batch.last()?.id;
    if (batch.size < 100) break;
  }
  return messages;
}

export async function syncMarketplaceVouchHistory(client) {
  const channel = await client.channels.fetch(LEGACY_VOUCH_CHANNEL_ID).catch(() => null);
  if (!channel?.isTextBased?.() || !channel.messages?.fetch || !channel.guildId) {
    return { scanned: 0, imported: 0, matched: 0, skipped: 0, reconciled: false, unavailable: true };
  }

  const guildId = channel.guildId;
  const stored = await listMarketplaceVouches(guildId);
  const storedById = new Map(stored.map(vouch => [String(vouch.id), vouch]));
  const messages = await fetchAllMessages(channel);
  const active = [];
  let imported = 0;
  let skipped = 0;

  for (const message of messages) {
    const parsed = parseMarketplaceVouchMessage(message);
    if (!parsed?.candidate) continue;
    if (!parsed.record) {
      skipped += 1;
      continue;
    }

    const existing = storedById.get(String(message.id));
    if (existing?.status === 'removed') continue;
    const record = existing || await saveMarketplaceVouch(guildId, {
      ...parsed.record,
      guildId,
    });
    if (!existing) imported += 1;
    if (MARKETPLACE_SELLER_IDS.includes(String(record.sellerId)) && Number(record.rating) >= 1 && Number(record.rating) <= 5) {
      active.push(record);
    }
  }

  // Only replace totals when every seller-mentioned historical message was understood.
  // This prevents an unfamiliar legacy format from silently lowering a seller's stats.
  let reconciled = false;
  if (skipped === 0) {
    for (const sellerId of MARKETPLACE_SELLER_IDS) {
      const sellerVouches = active.filter(vouch => String(vouch.sellerId) === sellerId);
      await setSellerMarketplaceStats(guildId, sellerId, {
        completedTransactions: sellerVouches.length,
        totalReviews: sellerVouches.length,
        ratingTotal: sellerVouches.reduce((sum, vouch) => sum + Number(vouch.rating), 0),
      });
    }
    reconciled = true;
  }

  const summary = {
    scanned: messages.length,
    imported,
    matched: active.length,
    skipped,
    reconciled,
    unavailable: false,
  };
  logger.info('Marketplace vouch history sync complete', { channelId: channel.id, guildId, ...summary });
  return summary;
}
