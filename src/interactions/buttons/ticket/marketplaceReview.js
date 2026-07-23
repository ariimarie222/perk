import { ActionRowBuilder, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } from 'discord.js';
import { getTicketData } from '../../../utils/database.js';
import { getColor } from '../../../config/bot.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { logger } from '../../../utils/logger.js';

function isImageAttachment(attachment) {
  return attachment.contentType?.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(attachment.name || '');
}

async function findBuyerProof(channel, buyerId, completedAt) {
  const since = Date.parse(completedAt || 0);
  const messages = await channel.messages.fetch({ limit: 100 });
  for (const message of messages.values()) {
    if (message.author?.id !== buyerId || message.createdTimestamp < since) continue;
    const attachment = message.attachments.find(isImageAttachment);
    if (attachment) {
      return {
        url: attachment.url,
        name: attachment.name,
        contentType: attachment.contentType,
        messageId: message.id,
      };
    }
  }
  return null;
}

function errorEmbed(description) {
  return new EmbedBuilder().setTitle('⚠️ Marketplace Review Required').setDescription(description).setColor(getColor('warning'));
}

const marketplaceReviewButton = {
  name: 'ticket_marketplace_review',
  async execute(interaction, client, args) {
    const [guildId, channelId] = args;
    if (guildId !== interaction.guildId || channelId !== interaction.channelId) {
      await InteractionHelper.safeReply(interaction, { embeds: [errorEmbed('This marketplace review link is invalid.')], flags: MessageFlags.Ephemeral });
      return;
    }

    try {
      const ticketData = await getTicketData(guildId, channelId);
      if (!ticketData || ticketData.transactionStatus !== 'review_required') {
        await InteractionHelper.safeReply(interaction, { embeds: [errorEmbed('This ticket is not currently waiting for a marketplace review.')], flags: MessageFlags.Ephemeral });
        return;
      }
      if (interaction.user.id !== ticketData.userId) {
        await InteractionHelper.safeReply(interaction, { embeds: [errorEmbed('Only the ticket creator can submit the required marketplace review.')], flags: MessageFlags.Ephemeral });
        return;
      }

      const proof = await findBuyerProof(interaction.channel, ticketData.userId, ticketData.transactionCompletedAt);
      if (!proof) {
        await InteractionHelper.safeReply(interaction, {
          embeds: [errorEmbed('Image proof is required. Upload at least one image attachment in this ticket, then click **Submit Marketplace Review** again.')],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const modal = new ModalBuilder()
        .setCustomId(`ticket_marketplace_review_modal:${guildId}:${channelId}`)
        .setTitle('Submit Marketplace Review')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('rating').setLabel('Star rating (1–5)').setStyle(TextInputStyle.Short).setPlaceholder('Enter a number from 1 to 5').setRequired(true).setMaxLength(1),
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('review').setLabel('Written review').setStyle(TextInputStyle.Paragraph).setPlaceholder('Share your transaction experience...').setRequired(true).setMinLength(1).setMaxLength(1000),
          ),
        );
      await interaction.showModal(modal);
    } catch (error) {
      logger.error('Failed to open marketplace review:', error);
      await InteractionHelper.safeReply(interaction, { embeds: [errorEmbed('Could not open the marketplace review form. Please try again.')], flags: MessageFlags.Ephemeral });
    }
  },
};

export { findBuyerProof };
export default marketplaceReviewButton;
