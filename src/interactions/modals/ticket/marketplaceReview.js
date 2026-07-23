import { EmbedBuilder, MessageFlags } from 'discord.js';
import { getTicketData } from '../../../utils/database.js';
import { submitMarketplaceReview } from '../../../services/ticket.js';
import { getColor } from '../../../config/bot.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { logger } from '../../../utils/logger.js';
import { findBuyerProof } from '../../buttons/ticket/marketplaceReview.js';

function buildEmbed(title, description, color) {
  return new EmbedBuilder().setTitle(title).setDescription(description).setColor(color);
}

export default {
  name: 'ticket_marketplace_review_modal',
  async execute(interaction, client, args) {
    const [guildId, channelId] = args;
    if (guildId !== interaction.guildId || channelId !== interaction.channelId) {
      await InteractionHelper.safeReply(interaction, { embeds: [buildEmbed('⚠️ Invalid Marketplace Review', 'This marketplace review form is invalid.', getColor('error'))], flags: MessageFlags.Ephemeral });
      return;
    }

    const rating = Number(interaction.fields.getTextInputValue('rating')?.trim());
    const review = interaction.fields.getTextInputValue('review')?.trim();
    if (!Number.isInteger(rating) || rating < 1 || rating > 5 || !review) {
      await InteractionHelper.safeReply(interaction, { embeds: [buildEmbed('⚠️ Review Incomplete', 'Enter a whole-star rating from 1 to 5 and a written review.', getColor('warning'))], flags: MessageFlags.Ephemeral });
      return;
    }

    const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    if (!deferred) return;
    try {
      const ticketData = await getTicketData(guildId, channelId);
      if (!ticketData || interaction.user.id !== ticketData.userId) {
        await InteractionHelper.safeEditReply(interaction, { embeds: [buildEmbed('❌ Not Allowed', 'Only the ticket creator can submit this marketplace review.', getColor('error'))] });
        return;
      }
      const proof = await findBuyerProof(interaction.channel, ticketData.userId, ticketData.transactionCompletedAt);
      if (!proof) {
        await InteractionHelper.safeEditReply(interaction, { embeds: [buildEmbed('📷 Proof Required', 'Upload at least one image attachment in this ticket before submitting the marketplace review.', getColor('warning'))] });
        return;
      }

      const { sellerStats, vouchChannel } = await submitMarketplaceReview(interaction.channel, interaction.user, { rating, review, proofAttachment: proof });
      await InteractionHelper.safeEditReply(interaction, {
        embeds: [buildEmbed('✅ Marketplace Review Submitted', `Your vouch has been posted in ${vouchChannel}. The ticket can now be closed normally.\n\nSeller stats: **${sellerStats.completedTransactions}** completed transaction(s), **${sellerStats.averageRating}/5** average rating, **${sellerStats.totalReviews}** review(s).`, getColor('success'))],
      });
    } catch (error) {
      logger.error('Failed to submit marketplace review:', error);
      await InteractionHelper.safeEditReply(interaction, { embeds: [buildEmbed('⚠️ Review Not Submitted', error.userMessage || 'Could not submit the marketplace review. Please try again.', getColor('error'))] });
    }
  },
};
