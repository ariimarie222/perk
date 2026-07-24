import { MessageFlags } from 'discord.js';
import { PAYMENT_PROFILES } from '../../../config/marketplace.js';
import { getPaymentProfile } from '../../../services/marketplacePaymentService.js';
import { createErrorEmbed, createMarketplaceEmbed } from '../../../utils/embeds.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { logger } from '../../../utils/logger.js';

function normalizeBreaks(value) {
  return String(value || '').replace(/\\n/g, '\n').trim();
}

export function formatPaymentDetails(value, type) {
  if (type === 'crypto') {
    return `\`\`\`\n${normalizeBreaks(value)}\n\`\`\``;
  }
  return normalizeBreaks(value)
    .replace(/\s+(?=\d+\.\s+https?:\/\/)/gi, '\n')
    .replace(/https?:\/\/[^\s<>]+/gi, url => `<${url}>`);
}

export function formatPaymentNotes(value) {
  return normalizeBreaks(value)
    .replace(/\s+(?=\$\d+(?:-\d+)?\+?\s*[-–—])/g, '\n');
}

export default {
  name: 'perk_payment',

  async execute(interaction, client, [profileKey, methodKey]) {
    const profile = await getPaymentProfile(interaction.guildId, profileKey);
    const method = profile?.methods?.[methodKey];

    if (!PAYMENT_PROFILES[profileKey] || !profile?.enabled || !method?.enabled || !method.details) {
      return InteractionHelper.safeReply(interaction, {
        embeds: [createErrorEmbed('That payment method is no longer available. Please ask the seller for an updated payment menu.')],
        flags: MessageFlags.Ephemeral,
      });
    }

    logger.info('Private marketplace payment method viewed', {
      guildId: interaction.guildId,
      userId: interaction.user.id,
      profileKey,
      methodKey,
    });

    return InteractionHelper.safeReply(interaction, {
      embeds: [
        createMarketplaceEmbed({
          title: `💗 ${method.label}`,
          description:
            `**Payment details**\n${formatPaymentDetails(method.details, method.type)}`
            + `${method.notes ? `\n\n**Payment notes**\n${formatPaymentNotes(method.notes)}\n` : '\n'}`
            + '\nPlease verify the payment username and payment amount with the seller before sending.',
        }),
      ],
      flags: MessageFlags.Ephemeral,
    });
  },
};
