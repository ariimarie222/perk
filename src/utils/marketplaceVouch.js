import { createMarketplaceEmbed } from './embeds.js';

export const MARKETPLACE_SERVICE_LABELS = Object.freeze({
  purchase: 'Purchase',
  cashout: 'Cashout',
  preorder: 'Preorder',
  middleman: 'Middleman',
});

export function buildMarketplaceVouchEmbed(vouch) {
  const serviceLabel = MARKETPLACE_SERVICE_LABELS[vouch.serviceType] || vouch.serviceType || 'Marketplace';
  return createMarketplaceEmbed({
    title: '🎀 New Marketplace Vouch',
    fields: [
      { name: 'Seller', value: `<@${vouch.sellerId}>`, inline: true },
      { name: 'Buyer', value: `<@${vouch.buyerId}>`, inline: true },
      { name: 'Service', value: serviceLabel, inline: true },
      {
        name: 'Rating',
        value: Number(vouch.rating) >= 1 ? '⭐'.repeat(Number(vouch.rating)) : 'Legacy vouch · no rating recorded',
        inline: true,
      },
      ...(vouch.transactionReference
        ? [{ name: 'Transaction Reference', value: String(vouch.transactionReference).slice(0, 1024), inline: true }]
        : []),
      { name: 'Review', value: String(vouch.review).slice(0, 1024), inline: false },
    ],
    image: vouch.proofUrl || vouch.image?.url || null,
    timestamp: vouch.submittedAt ? new Date(vouch.submittedAt) : new Date(),
    footer: `Vouch ID: ${vouch.id || vouch.vouchMessageId || 'pending'}`,
  });
}

export function getVouchMessageUrl(vouch) {
  if (vouch.messageUrl) return vouch.messageUrl;
  if (!vouch.guildId || !vouch.vouchChannelId || !vouch.vouchMessageId) return null;
  return `https://discord.com/channels/${vouch.guildId}/${vouch.vouchChannelId}/${vouch.vouchMessageId}`;
}
