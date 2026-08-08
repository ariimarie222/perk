import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { getMarketplaceSellerMembers, isMarketplaceSellerMember } from '../../config/marketplace.js';
import { getGuildConfig } from '../../services/config/guildConfig.js';
import {
  adjustSellerMarketplaceStats,
  appendMarketplaceVouchAudit,
  findMarketplaceVouch,
  getTicketData,
  saveMarketplaceVouch,
  saveTicketData,
} from '../../utils/database.js';
import {
  createErrorEmbed,
  createModerationEmbed,
  createSuccessEmbed,
} from '../../utils/embeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logger } from '../../utils/logger.js';
import { buildMarketplaceVouchEmbed, getVouchMessageUrl } from '../../utils/marketplaceVouch.js';
import { canManageMarketplace } from '../Economy/pay.js';

const serviceChoices = [
  { name: 'Purchase', value: 'purchase' },
  { name: 'Cashout', value: 'cashout' },
  { name: 'Preorder', value: 'preorder' },
  { name: 'Middleman', value: 'middleman' },
];

const addCommonOptions = sub => sub
  .addStringOption(option => option.setName('vouch_id').setDescription('Vouch message ID or stored vouch ID').setRequired(true))
  .addStringOption(option => option.setName('reason').setDescription('Required audit reason').setRequired(true).setMaxLength(500));

const data = new SlashCommandBuilder()
  .setName('vouch-admin')
  .setDescription('Correct marketplace vouches with a permanent audit trail.')
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
  .addSubcommand(sub => {
    addCommonOptions(sub.setName('edit').setDescription('Edit a marketplace vouch'))
      .addStringOption(option => option.setName('seller').setDescription('Correct approved seller').setAutocomplete(true))
      .addIntegerOption(option => option.setName('rating').setDescription('Correct rating').setMinValue(1).setMaxValue(5))
      .addStringOption(option => option.setName('review').setDescription('Correct written review').setMaxLength(1000))
      .addAttachmentOption(option => option.setName('proof').setDescription('Correct proof image'))
      .addStringOption(option => option.setName('transaction_type').setDescription('Correct transaction type').addChoices(...serviceChoices))
      .addStringOption(option => option.setName('transaction_reference').setDescription('Correct transaction reference').setMaxLength(200));
    return sub;
  })
  .addSubcommand(sub => addCommonOptions(sub.setName('remove').setDescription('Remove an invalid, fake, duplicate, or incorrect vouch')))
  .addSubcommand(sub => addCommonOptions(sub.setName('transfer').setDescription('Transfer a vouch to another approved seller'))
    .addStringOption(option => option.setName('new_seller').setDescription('Approved seller receiving the vouch').setRequired(true).setAutocomplete(true)));

async function updateOriginalMessage(client, vouch, mode = 'edit') {
  const channel = await client.channels.fetch(vouch.vouchChannelId).catch(() => null);
  const message = channel?.messages
    ? await channel.messages.fetch(vouch.vouchMessageId).catch(() => null)
    : null;
  if (!message) return false;
  if (mode === 'remove') {
    return Boolean(await message.delete().catch(() => null));
  } else {
    return Boolean(await message.edit({ embeds: [buildMarketplaceVouchEmbed(vouch)] }).catch(() => null));
  }
}

async function updateTicketCopy(guildId, vouch) {
  if (!vouch.ticketChannelId) return;
  const ticket = await getTicketData(guildId, vouch.ticketChannelId);
  if (!ticket?.marketplaceReview) return;
  ticket.marketplaceReview = {
    ...ticket.marketplaceReview,
    rating: vouch.rating,
    review: vouch.review,
    sellerId: vouch.sellerId,
    serviceType: vouch.serviceType,
    image: { ...(ticket.marketplaceReview.image || {}), url: vouch.proofUrl },
  };
  await saveTicketData(guildId, vouch.ticketChannelId, ticket);
}

function auditFields(audit) {
  return [
    { name: 'Staff Member', value: `<@${audit.staffId}>`, inline: true },
    { name: 'Action', value: audit.action, inline: true },
    { name: 'Reason', value: audit.reason, inline: false },
    { name: 'Original Seller', value: audit.originalSellerId ? `<@${audit.originalSellerId}>` : 'N/A', inline: true },
    { name: 'New Seller', value: audit.newSellerId ? `<@${audit.newSellerId}>` : 'N/A', inline: true },
    { name: 'Old Rating', value: String(audit.oldRating ?? 'N/A'), inline: true },
    { name: 'New Rating', value: String(audit.newRating ?? 'N/A'), inline: true },
    { name: 'Old Review', value: String(audit.oldReview || 'N/A').slice(0, 1024), inline: false },
    { name: 'New Review', value: String(audit.newReview || 'N/A').slice(0, 1024), inline: false },
    { name: 'Old Proof', value: audit.oldProofUrl || 'N/A', inline: false },
    { name: 'New Proof', value: audit.newProofUrl || 'N/A', inline: false },
    { name: 'Vouch / Transaction', value: `${audit.vouchId}${audit.transactionReference ? ` • ${audit.transactionReference}` : ''}`, inline: false },
    ...(audit.messageUrl ? [{ name: 'Original Message', value: `[Open message](${audit.messageUrl})`, inline: false }] : []),
  ];
}

async function publishAudit(client, guildId, audit) {
  const config = await getGuildConfig(client, guildId);
  const channelId = config.logging?.channels?.audit || config.logChannelId || null;
  if (!channelId) return false;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isSendable()) return false;
  await channel.send({
    embeds: [createModerationEmbed({
      title: '🎀 Marketplace Vouch Audit',
      fields: auditFields(audit),
      timestamp: new Date(audit.timestamp),
    })],
  });
  return true;
}

export default {
  data,

  async execute(interaction, config, client) {
    if (!canManageMarketplace(interaction.member, config)) {
      return InteractionHelper.safeReply(interaction, {
        embeds: [createErrorEmbed('Only authorized marketplace staff can correct vouches.')],
        flags: MessageFlags.Ephemeral,
      });
    }

    await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    const action = interaction.options.getSubcommand(true);
    const vouchId = interaction.options.getString('vouch_id', true).trim();
    const reason = interaction.options.getString('reason', true).trim();
    const original = await findMarketplaceVouch(interaction.guildId, vouchId);

    if (!original || original.status === 'removed') {
      return InteractionHelper.safeEditReply(interaction, {
        embeds: [createErrorEmbed('That active vouch could not be found. Older vouches created before vouch administration was added may not have a stored record.')],
      });
    }

    const updated = { ...original };
    if (action === 'edit') {
      const sellerId = interaction.options.getString('seller');
      const rating = interaction.options.getInteger('rating');
      const review = interaction.options.getString('review');
      const proof = interaction.options.getAttachment('proof');
      const serviceType = interaction.options.getString('transaction_type');
      const transactionReference = interaction.options.getString('transaction_reference');
      if (sellerId) {
        const sellerMember = await interaction.guild.members.fetch(sellerId).catch(() => null);
        if (!isMarketplaceSellerMember(sellerMember)) {
          return InteractionHelper.safeEditReply(interaction, { embeds: [createErrorEmbed('Please choose a current member with the marketplace seller role.')] });
        }
      }
      if (proof && !(proof.contentType?.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(proof.name || ''))) {
        return InteractionHelper.safeEditReply(interaction, { embeds: [createErrorEmbed('The replacement proof must be an image.')] });
      }
      Object.assign(updated, {
        sellerId: sellerId || original.sellerId,
        rating: rating ?? original.rating,
        review: review?.trim() || original.review,
        proofUrl: proof?.url || original.proofUrl,
        serviceType: serviceType || original.serviceType,
        transactionReference: transactionReference?.trim() || original.transactionReference,
      });
    } else if (action === 'transfer') {
      const newSellerId = interaction.options.getString('new_seller', true);
      const newSellerMember = await interaction.guild.members.fetch(newSellerId).catch(() => null);
      if (!isMarketplaceSellerMember(newSellerMember)) {
        return InteractionHelper.safeEditReply(interaction, { embeds: [createErrorEmbed('Please choose a current member with the marketplace seller role.')] });
      }
      if (newSellerId === original.sellerId) {
        return InteractionHelper.safeEditReply(interaction, { embeds: [createErrorEmbed('The new seller must be different from the original seller.')] });
      }
      updated.sellerId = newSellerId;
    } else {
      updated.status = 'removed';
      updated.removedAt = new Date().toISOString();
      updated.removedBy = interaction.user.id;
      updated.removalReason = reason;
    }

    const sellerChanged = updated.sellerId !== original.sellerId;
    const ratingChanged = Number(updated.rating) !== Number(original.rating);
    if (action === 'remove') {
      await adjustSellerMarketplaceStats(interaction.guildId, original.sellerId, {
        transactionDelta: -1,
        reviewDelta: -1,
        ratingDelta: -Number(original.rating),
      });
    } else if (sellerChanged) {
      await adjustSellerMarketplaceStats(interaction.guildId, original.sellerId, {
        transactionDelta: -1,
        reviewDelta: -1,
        ratingDelta: -Number(original.rating),
      });
      await adjustSellerMarketplaceStats(interaction.guildId, updated.sellerId, {
        transactionDelta: 1,
        reviewDelta: 1,
        ratingDelta: Number(updated.rating),
      });
    } else if (ratingChanged) {
      await adjustSellerMarketplaceStats(interaction.guildId, original.sellerId, {
        ratingDelta: Number(updated.rating) - Number(original.rating),
      });
    }

    updated.lastCorrectedAt = new Date().toISOString();
    updated.lastCorrectedBy = interaction.user.id;
    await saveMarketplaceVouch(interaction.guildId, updated);
    if (action !== 'remove') await updateTicketCopy(interaction.guildId, updated);
    const messageUpdated = await updateOriginalMessage(client, updated, action === 'remove' ? 'remove' : 'edit');

    const audit = await appendMarketplaceVouchAudit(interaction.guildId, {
      staffId: interaction.user.id,
      timestamp: new Date().toISOString(),
      action,
      reason,
      originalSellerId: original.sellerId,
      newSellerId: sellerChanged ? updated.sellerId : null,
      oldRating: original.rating,
      newRating: action === 'remove' ? null : updated.rating,
      oldReview: original.review,
      newReview: action === 'remove' ? null : updated.review,
      oldProofUrl: original.proofUrl,
      newProofUrl: action === 'remove' ? null : updated.proofUrl,
      vouchId,
      transactionReference: updated.transactionReference,
      messageUrl: getVouchMessageUrl(original),
      originalMessageUpdated: messageUpdated,
    });
    await publishAudit(client, interaction.guildId, audit).catch(error => {
      logger.error('Failed to publish marketplace vouch audit embed', { error: error.message, guildId: interaction.guildId, vouchId });
    });

    return InteractionHelper.safeEditReply(interaction, {
      embeds: [createSuccessEmbed('🌷 Vouch correction saved!', `The **${action}** action was applied and permanently audited.`)],
    });
  },

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused().toLowerCase();
    const members = await getMarketplaceSellerMembers(interaction.guild);
    await interaction.respond(
      members
        .map(member => ({ name: member.displayName || member.user.username, value: member.id }))
        .filter(choice => choice.name.toLowerCase().includes(focused))
        .slice(0, 25),
    );
  },
};
