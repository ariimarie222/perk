// ticket.js

import {
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  AttachmentBuilder,
  EmbedBuilder,
} from 'discord.js';
import { buildStandardLogEmbed, formatLogLine } from '../utils/logging/logEmbeds.js';
import { getGuildConfig } from './config/guildConfig.js';
import { getTicketData, saveTicketData, deleteTicketData, getOpenTicketCountForUser, incrementTicketCounter } from '../utils/database.js';
import { recordSellerMarketplaceReview } from '../utils/database/tickets.js';
import { logger } from '../utils/logger.js';
import { createEmbed, errorEmbed } from '../utils/embeds.js';
import { logTicketEvent } from '../utils/ticket/ticketLogging.js';
import { createError, ErrorTypes } from '../utils/errorHandler.js';
import { ensureTypedServiceError, wrapServiceBoundary } from '../utils/serviceErrorBoundary.js';
import { PRIORITY_MAP } from '../utils/helpers.js';
const TICKET_DELETE_DELAY_MS = 3000;
const TICKET_DELETE_DELAY_SECONDS = Math.floor(TICKET_DELETE_DELAY_MS / 1000);
const TICKET_SERVICE = 'ticketService';
const SERVICE_TYPE_LABELS = Object.freeze({
  purchase: 'Purchase',
  cashout: 'Cashout',
  middleman: 'Middleman',
  preorder: 'Preorder',
  support: 'Support',
});
const MARKETPLACE_REVIEW_SERVICE_TYPES = new Set([
  'purchase',
  'cashout',
  'middleman',
  'preorder',
]);

function getServiceTypeLabel(serviceType) {
  return SERVICE_TYPE_LABELS[serviceType] || SERVICE_TYPE_LABELS.support;
}

function requiresMarketplaceReview(serviceType) {
  return MARKETPLACE_REVIEW_SERVICE_TYPES.has(serviceType);
}

function ticketUserError(message, userMessage, type = ErrorTypes.VALIDATION, context = {}) {
  throw createError(message, type, userMessage, { service: TICKET_SERVICE, ...context });
}

function requireTicket(ticketData, channel) {
  if (!ticketData) {
    ticketUserError(
      'Not a ticket channel',
      'This is not a ticket channel.',
      ErrorTypes.VALIDATION,
      { channelId: channel?.id, guildId: channel?.guild?.id }
    );
  }
  return ticketData;
}

function rethrowTicketError(error, operation, userMessage, context = {}) {
  throw ensureTypedServiceError(error, {
    service: TICKET_SERVICE,
    operation,
    message: `Ticket operation failed: ${operation}`,
    userMessage,
    context,
  });
}



function buildTicketControlRow({ claimedBy = null, transactionComplete = false, serviceType = 'support' } = {}) {
  const buttons = [
    new ButtonBuilder()
      .setCustomId('ticket_claim')
      .setLabel(claimedBy ? 'Claimed' : 'Claim')
      .setStyle(claimedBy ? ButtonStyle.Secondary : ButtonStyle.Primary)
      .setEmoji('🙋')
      .setDisabled(!!claimedBy),
    new ButtonBuilder()
      .setCustomId('ticket_pin')
      .setLabel('Pin')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('📌'),
    new ButtonBuilder()
      .setCustomId('ticket_close')
      .setLabel('Close')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🔒'),
  ];

  if (requiresMarketplaceReview(serviceType)) {
    buttons.push(new ButtonBuilder()
      .setCustomId('ticket_complete_transaction')
      .setLabel(transactionComplete ? 'Review Required' : 'Complete Transaction')
      .setStyle(transactionComplete ? ButtonStyle.Secondary : ButtonStyle.Success)
      .setEmoji(transactionComplete ? '⭐' : '✅')
      .setDisabled(!claimedBy || transactionComplete));
  }

  return new ActionRowBuilder().addComponents(buttons);
}

export const getUserTicketCount = wrapServiceBoundary(async function getUserTicketCount(guildId, userId) {
  return await getOpenTicketCountForUser(guildId, userId);
}, {
  service: TICKET_SERVICE,
  operation: 'getUserTicketCount',
  userMessage: 'Failed to count open tickets.',
  context: {},
});

export async function createTicket(guild, member, categoryId, reason = 'No reason provided', priority = 'none', serviceType = 'support') {
  try {
    const config = await getGuildConfig(guild.client, guild.id);
    const ticketConfig = config.tickets || {};
    
    const maxTicketsPerUser = config.maxTicketsPerUser ?? 3;
    const currentTicketCount = await getUserTicketCount(guild.id, member.id);
    
    if (currentTicketCount >= maxTicketsPerUser) {
      ticketUserError(
        `Max open tickets reached for ${member.id}`,
        `You have reached the maximum number of open tickets (${maxTicketsPerUser}). Please close your existing tickets before creating a new one.`,
        ErrorTypes.VALIDATION,
        { guildId: guild.id, userId: member.id, operation: 'createTicket' }
      );
    }
    
    let category = categoryId ? 
      guild.channels.cache.get(categoryId) :
      guild.channels.cache.find(c => 
        c.type === ChannelType.GuildCategory && 
        c.name.toLowerCase().includes('tickets')
      );
    
    if (!category && !categoryId) {
      category = await guild.channels.create({
        name: 'Tickets',
        type: ChannelType.GuildCategory,
        permissionOverwrites: [
          {
            id: guild.id,
            deny: [PermissionFlagsBits.ViewChannel],
          },
        ],
      });
    }
    
    const ticketNumber = await getNextTicketNumber(guild.id);
    
    let channelName = `ticket-${ticketNumber}`;
    
    if (priority !== 'none') {
      const priorityInfo = PRIORITY_MAP[priority];
      if (priorityInfo) {
        channelName = `${priorityInfo.emoji} ${channelName}`;
      }
    }
    
    const serviceTypeLabel = getServiceTypeLabel(serviceType);
    const channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: category?.id,
      topic: `Marketplace service: ${serviceTypeLabel} | Customer: ${member.user?.tag || member.id}`,
      permissionOverwrites: [
        {
          id: guild.id,
          deny: [PermissionFlagsBits.ViewChannel],
        },
        {
          id: member.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        },
        ...(config.ticketStaffRoleId ? [{
          id: config.ticketStaffRoleId,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        }] : []),
      ],
    });
    
    const ticketData = {
      id: channel.id,
      userId: member.id,
      guildId: guild.id,
      createdAt: new Date().toISOString(),
      status: 'open',
      claimedBy: null,
      sellerId: null,
      serviceType: Object.hasOwn(SERVICE_TYPE_LABELS, serviceType) ? serviceType : 'support',
      priority: priority || 'none',
      reason,
    };
    
    await saveTicketData(guild.id, channel.id, ticketData);
    
    const priorityInfo = PRIORITY_MAP[priority] || PRIORITY_MAP.none;
    
    const embed = createEmbed({
      title: `Ticket #${ticketNumber}`,
      description: `${member.toString()}, thanks for creating a ticket!\n\n**Reason:** ${reason}\n**Priority:** ${priorityInfo.emoji} ${priorityInfo.label}`,
      color: priorityInfo.color,
      fields: [
        { name: 'Status', value: '🟢 Open', inline: true },
        { name: 'Service Type', value: serviceTypeLabel, inline: true },
        { name: 'Claimed By', value: 'Not claimed', inline: true },
        { name: 'Seller', value: 'Not claimed', inline: true },
        { name: 'Created', value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true },
      ],
    });
    
    const row = buildTicketControlRow({ serviceType: ticketData.serviceType });
    
    if (ticketConfig.enablePriority) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId('ticket_priority:low')
          .setLabel('Low')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('🔵'),
        new ButtonBuilder()
          .setCustomId('ticket_priority:high')
          .setLabel('High')
          .setStyle(ButtonStyle.Danger)
          .setEmoji('🔴')
      );
    }
    
    const staffMention = config.ticketStaffRoleId ? ` <@&${config.ticketStaffRoleId}>` : '';
    const messageContent = `${member.toString()}${staffMention}`;
    
    const ticketMessage = await channel.send({ 
      content: messageContent,
      embeds: [embed],
      components: [row] 
    });

    await ticketMessage.pin().catch(() => {});
    
    await logTicketEvent({
      client: guild.client,
      guildId: guild.id,
      event: {
        type: 'open',
        ticketId: channel.id,
        ticketNumber: ticketNumber,
        userId: member.id,
        executorId: member.id,
        reason: reason,
        priority: priority || 'none',
        metadata: {
          channelId: channel.id,
          categoryName: category?.name || 'Default',
          serviceType: ticketData.serviceType,
        }
      }
    });
    
    return { channel, ticketData };
    
  } catch (error) {
    rethrowTicketError(error, 'createTicket', 'Failed to create ticket. Please try again in a moment.', { guildId: guild?.id, userId: member?.id });
  }
}

export async function closeTicket(
  channel,
  closer,
  reason = 'No reason provided',
  { overrideMarketplaceReview = false } = {},
) {
  try {
    const ticketData = requireTicket(await getTicketData(channel.guild.id, channel.id), channel);

    if (
      requiresMarketplaceReview(ticketData.serviceType)
      && ticketData.transactionStatus === 'review_required'
      && !ticketData.marketplaceReview
      && !overrideMarketplaceReview
    ) {
      ticketUserError(
        'Marketplace review required before closing',
        'This transaction is complete, but the buyer must submit the required marketplace review and image proof before the ticket can be closed.',
        ErrorTypes.VALIDATION,
        { channelId: channel.id, ticketId: ticketData.id, operation: 'closeTicket' },
      );
    }

    if (overrideMarketplaceReview && ticketData.transactionStatus === 'review_required' && !ticketData.marketplaceReview) {
      ticketData.marketplaceReviewOverride = {
        overriddenBy: closer.id,
        reason,
        overriddenAt: new Date().toISOString(),
      };
      ticketData.transactionStatus = 'review_overridden';
    }
    
    const config = await getGuildConfig(channel.client, channel.guild.id);
    const dmOnClose = config.dmOnClose !== false;
    const closedCategoryId = config.ticketClosedCategoryId || null;
    let movedToClosedCategory = false;
    
    ticketData.status = 'closed';
    ticketData.closedBy = closer.id;
    ticketData.closedAt = new Date().toISOString();
    ticketData.closeReason = reason;
    
    await saveTicketData(channel.guild.id, channel.id, ticketData);

    if (closedCategoryId && channel.parentId !== closedCategoryId) {
      const closedCategory = channel.guild.channels.cache.get(closedCategoryId)
        || await channel.guild.channels.fetch(closedCategoryId).catch(() => null);

      if (closedCategory?.type === ChannelType.GuildCategory) {
        try {
          await channel.setParent(closedCategoryId, { lockPermissions: false });
          movedToClosedCategory = true;
        } catch (moveError) {
            logger.warn(`Could not move ticket ${channel.id} to closed category ${closedCategoryId}: ${moveError.message}`);
        }
      } else {
        logger.warn(`Configured closed category is invalid for guild ${channel.guild.id}: ${closedCategoryId}`);
      }
    }
    
    if (dmOnClose) {
      try {
        const ticketCreator = await channel.client.users.fetch(ticketData.userId).catch(() => null);
        if (ticketCreator) {
          const dmEmbed = createEmbed({
            title: '🎫 Your Ticket Has Been Closed',
            description: `Your ticket **${channel.name}** has been closed.\n\n**Reason:** ${reason}\n**Closed by:** ${closer.tag}\n**Closed at:** <t:${Math.floor(Date.now() / 1000)}:F>\n\nThank you for using our support system! If you have any further questions, feel free to create a new ticket.`,
            color: '#e74c3c',
            footer: { text: `Ticket ID: ${ticketData.id}` }
          });

          await ticketCreator.send({ embeds: [dmEmbed] });

          try {
            const feedbackEmbed = createEmbed({
              title: '⭐ How was your support experience?',
              description: `We'd love to know how we did with **${channel.name}**.\nSelect a rating below — it only takes a second!`,
              color: '#F1C40F',
              footer: { text: 'Your feedback helps us improve.' },
            });

            const base = `ticket_feedback:${channel.guild.id}:${channel.id}`;
            const starsRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`${base}:1`).setLabel('⭐ 1').setStyle(ButtonStyle.Secondary),
              new ButtonBuilder().setCustomId(`${base}:2`).setLabel('⭐ 2').setStyle(ButtonStyle.Secondary),
              new ButtonBuilder().setCustomId(`${base}:3`).setLabel('⭐ 3').setStyle(ButtonStyle.Secondary),
              new ButtonBuilder().setCustomId(`${base}:4`).setLabel('⭐ 4').setStyle(ButtonStyle.Secondary),
              new ButtonBuilder().setCustomId(`${base}:5`).setLabel('⭐ 5').setStyle(ButtonStyle.Primary),
            );
            const declineRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`ticket_feedback_comment:${channel.guild.id}:${channel.id}`)
                .setLabel('✍️ Add Comment')
                .setStyle(ButtonStyle.Secondary),
              new ButtonBuilder()
                .setCustomId(`ticket_feedback_decline:${channel.guild.id}:${channel.id}`)
                .setLabel('❌ No thanks')
                .setStyle(ButtonStyle.Secondary),
            );

            await ticketCreator.send({
              embeds: [feedbackEmbed],
              components: [starsRow, declineRow],
            });
          } catch (feedbackError) {
            logger.warn(`Could not send feedback survey to ticket creator ${ticketData.userId}: ${feedbackError.message}`);
          }
        }
      } catch (dmError) {
          logger.warn(`Could not send DM to ticket creator ${ticketData.userId}: ${dmError.message}`);
      }
    }
    
    try {
      const user = await channel.guild.members.fetch(ticketData.userId).catch(() => null);
      const targetUser = user?.user || await channel.client.users.fetch(ticketData.userId).catch(() => null);
      
      if (targetUser) {
        const overwrite = channel.permissionOverwrites.cache.get(ticketData.userId);
        if (overwrite) {
          await overwrite.edit({
            ViewChannel: false,
            SendMessages: false,
          });
        } else {
          await channel.permissionOverwrites.create(targetUser, {
            ViewChannel: false,
            SendMessages: false,
          });
        }
      }
    } catch (permError) {
        logger.warn(`Could not update user permissions for closed ticket: ${permError.message}`);
    }
    
    const messages = await channel.messages.fetch();
    const ticketMessage = messages.find(m => 
      m.embeds.length > 0 && 
      m.embeds[0].title?.startsWith('Ticket #')
    );
    
    if (ticketMessage) {
      const embed = ticketMessage.embeds[0];
      const statusField = embed.fields?.find(f => f.name === 'Status');
      
      if (statusField) {
        statusField.value = '🔴 Closed';
      }
      
      const updatedEmbed = createEmbed({
        title: embed.title || 'Ticket',
        description: embed.description || 'Ticket discussion',
        color: '#e74c3c',
        fields: embed.fields || [],
        footer: embed.footer
      });
      
      await ticketMessage.edit({ 
        embeds: [updatedEmbed],
components: []
      });
    }
    
    const closeEmbed = createEmbed({
      title: 'Ticket Closed',
      description: `This ticket has been closed by ${closer}.\n**Reason:** ${reason}${dmOnClose ? '\n\n📩 A DM has been sent to the ticket creator.' : ''}`,
      color: '#e74c3c',
      footer: { text: `Ticket ID: ${ticketData.id}` }
    });
    
    const controlRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('ticket_reopen')
        .setLabel('Reopen Ticket')
        .setStyle(ButtonStyle.Success)
        .setEmoji('🔓'),
      new ButtonBuilder()
        .setCustomId('ticket_delete')
        .setLabel('Delete Ticket')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🗑️')
    );
    
    await channel.send({ embeds: [closeEmbed], components: [controlRow] });
    
    await logTicketEvent({
      client: channel.client,
      guildId: channel.guild.id,
      event: {
        type: 'close',
        ticketId: channel.id,
        ticketNumber: ticketData.id,
        userId: ticketData.userId,
        executorId: closer.id,
        reason: reason,
        metadata: {
          dmSent: dmOnClose,
          closedAt: ticketData.closedAt,
          movedToClosedCategory,
          marketplaceReviewOverridden: Boolean(ticketData.marketplaceReviewOverride),
        }
      }
    });
    
    return ticketData;
    
  } catch (error) {
    rethrowTicketError(error, 'closeTicket', 'Failed to close ticket. Please try again in a moment.', { guildId: channel?.guild?.id, channelId: channel?.id, closerId: closer?.id });
  }
}

export async function claimTicket(channel, claimer) {
  try {
    const ticketData = requireTicket(await getTicketData(channel.guild.id, channel.id), channel);
    
    if (ticketData.claimedBy) {
      ticketUserError(
        'Ticket already claimed',
        `This ticket is already claimed by <@${ticketData.claimedBy}>`,
        ErrorTypes.VALIDATION,
        { channelId: channel.id, claimedBy: ticketData.claimedBy, operation: 'claimTicket' }
      );
    }
    
    ticketData.claimedBy = claimer.id;
    ticketData.sellerId = claimer.id;
    ticketData.claimedAt = new Date().toISOString();
    
    await saveTicketData(channel.guild.id, channel.id, ticketData);
    
    const messages = await channel.messages.fetch();
    const ticketMessage = messages.find(m => 
      m.embeds.length > 0 && 
      m.embeds[0].title?.startsWith('Ticket #')
    );
    
    if (ticketMessage) {
      const embed = ticketMessage.embeds[0];
      const claimedField = embed.fields?.find(f => f.name === 'Claimed By');
      const sellerField = embed.fields?.find(f => f.name === 'Seller');
      
      if (claimedField) {
        claimedField.value = claimer.toString();
      }
      if (sellerField) {
        sellerField.value = claimer.toString();
      }
      
      const row = buildTicketControlRow({
        claimedBy: claimer.id,
        transactionComplete: ticketData.transactionStatus === 'review_required',
        serviceType: ticketData.serviceType,
      });
      
      await ticketMessage.edit({ 
        embeds: [embed],
        components: [row] 
      });
    }
    
    const claimEmbed = createEmbed({
      title: 'Ticket Claimed',
      description: `🎉 ${claimer} is now the seller for this ticket!`,
      color: '#2ecc71'
    });
    
    const unclaimRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('ticket_unclaim')
        .setLabel('Unclaim')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('🔓')
    );

    const claimStatusMessage = messages.find(m =>
      m.embeds.length > 0 &&
      (m.embeds[0].title === 'Ticket Claimed' || m.embeds[0].title === 'Ticket Unclaimed')
    );

    if (claimStatusMessage) {
      await claimStatusMessage.edit({ embeds: [claimEmbed], components: [unclaimRow] });
    } else {
      await channel.send({ embeds: [claimEmbed], components: [unclaimRow] });
    }
    
    await logTicketEvent({
      client: channel.client,
      guildId: channel.guild.id,
      event: {
        type: 'claim',
        ticketId: channel.id,
        ticketNumber: ticketData.id,
        userId: ticketData.userId,
        executorId: claimer.id,
        metadata: {
          claimedAt: ticketData.claimedAt,
          sellerId: ticketData.sellerId,
        }
      }
    });
    
    return ticketData;
    
  } catch (error) {
    rethrowTicketError(error, 'claimTicket', 'Failed to claim ticket. Please try again in a moment.', { guildId: channel?.guild?.id, channelId: channel?.id, claimerId: claimer?.id });
  }
}

export async function completeMarketplaceTransaction(channel, seller) {
  try {
    const ticketData = requireTicket(await getTicketData(channel.guild.id, channel.id), channel);
    const config = await getGuildConfig(channel.client, channel.guild.id);

    if (!requiresMarketplaceReview(ticketData.serviceType)) {
      ticketUserError(
        'Marketplace review is not available for support tickets',
        'Support tickets do not require marketplace completion or a vouch.',
        ErrorTypes.VALIDATION,
        { channelId: channel.id, serviceType: ticketData.serviceType, operation: 'completeMarketplaceTransaction' },
      );
    }

    if (!ticketData.sellerId || ticketData.sellerId !== seller.id) {
      ticketUserError(
        'Only the claimed seller can complete the transaction',
        'Only the claimed seller can mark this transaction as complete.',
        ErrorTypes.PERMISSION,
        { channelId: channel.id, sellerId: ticketData.sellerId, executorId: seller.id, operation: 'completeMarketplaceTransaction' },
      );
    }
    if (!config.vouchChannelId) {
      ticketUserError(
        'Vouch channel not configured',
        'A marketplace vouch channel must be configured before this transaction can be completed.',
        ErrorTypes.CONFIGURATION,
        { channelId: channel.id, operation: 'completeMarketplaceTransaction' },
      );
    }
    if (ticketData.marketplaceReview) {
      ticketUserError(
        'Marketplace review already submitted',
        'The buyer has already submitted the required marketplace review.',
        ErrorTypes.VALIDATION,
        { channelId: channel.id, operation: 'completeMarketplaceTransaction' },
      );
    }
    if (ticketData.transactionStatus === 'review_required') {
      ticketUserError(
        'Marketplace review already requested',
        'The buyer has already been asked to submit the required marketplace review.',
        ErrorTypes.VALIDATION,
        { channelId: channel.id, operation: 'completeMarketplaceTransaction' },
      );
    }

    ticketData.transactionStatus = 'review_required';
    ticketData.transactionCompletedAt = new Date().toISOString();
    ticketData.transactionCompletedBy = seller.id;
    await saveTicketData(channel.guild.id, channel.id, ticketData);

    const messages = await channel.messages.fetch();
    const ticketMessage = messages.find(message =>
      message.embeds.length > 0 && message.embeds[0].title?.startsWith('Ticket #')
    );
    if (ticketMessage) {
      await ticketMessage.edit({
        components: [buildTicketControlRow({
          claimedBy: seller.id,
          transactionComplete: true,
          serviceType: ticketData.serviceType,
        })],
      });
    }

    const reviewEmbed = createEmbed({
      title: '⭐ Marketplace Review Required',
      description: `<@${ticketData.userId}>, the seller has marked this transaction as complete. Before this ticket can be closed, please:\n\n1. Upload at least one image proving the completed transaction in this ticket.\n2. Click **Submit Marketplace Review**.\n3. Provide a 1–5 star rating and written review.`,
      color: '#F1C40F',
    });
    const reviewRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`ticket_marketplace_review:${channel.guild.id}:${channel.id}`)
        .setLabel('Submit Marketplace Review')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('⭐'),
    );
    await channel.send({ embeds: [reviewEmbed], components: [reviewRow] });

    await logTicketEvent({
      client: channel.client,
      guildId: channel.guild.id,
      event: {
        type: 'transaction_complete',
        ticketId: channel.id,
        ticketNumber: ticketData.id,
        userId: ticketData.userId,
        executorId: seller.id,
        metadata: { sellerId: seller.id, serviceType: ticketData.serviceType },
      },
    });

    return ticketData;
  } catch (error) {
    rethrowTicketError(error, 'completeMarketplaceTransaction', 'Failed to complete this transaction. Please try again in a moment.', { guildId: channel?.guild?.id, channelId: channel?.id, sellerId: seller?.id });
  }
}

export async function submitMarketplaceReview(channel, buyer, { rating, review, proofAttachment }) {
  try {
    const ticketData = requireTicket(await getTicketData(channel.guild.id, channel.id), channel);
    if (ticketData.userId !== buyer.id) {
      ticketUserError('Only the buyer can submit a marketplace review', 'Only the ticket creator can submit this marketplace review.', ErrorTypes.PERMISSION, { channelId: channel.id, operation: 'submitMarketplaceReview' });
    }
    if (ticketData.transactionStatus !== 'review_required' || !ticketData.sellerId) {
      ticketUserError('Marketplace review is not required', 'This ticket is not waiting for a marketplace review.', ErrorTypes.VALIDATION, { channelId: channel.id, operation: 'submitMarketplaceReview' });
    }
    if (ticketData.marketplaceReview) {
      ticketUserError('Marketplace review already submitted', 'A marketplace review has already been submitted for this ticket.', ErrorTypes.VALIDATION, { channelId: channel.id, operation: 'submitMarketplaceReview' });
    }

    const config = await getGuildConfig(channel.client, channel.guild.id);
    const vouchChannel = config.vouchChannelId
      ? await channel.client.channels.fetch(config.vouchChannelId).catch(() => null)
      : null;
    if (!vouchChannel?.isSendable()) {
      ticketUserError('Vouch channel unavailable', 'The configured marketplace vouch channel is unavailable. Please ask staff to check the ticket settings.', ErrorTypes.CONFIGURATION, { channelId: channel.id, operation: 'submitMarketplaceReview' });
    }

    const serviceTypeLabel = getServiceTypeLabel(ticketData.serviceType);
    const submittedAt = new Date().toISOString();
    const vouchEmbed = new EmbedBuilder()
      .setTitle('⭐ New Marketplace Vouch')
      .setColor('#F1C40F')
      .addFields(
        { name: 'Seller', value: `<@${ticketData.sellerId}>`, inline: true },
        { name: 'Buyer', value: `<@${ticketData.userId}>`, inline: true },
        { name: 'Service', value: serviceTypeLabel, inline: true },
        { name: 'Rating', value: '⭐'.repeat(rating), inline: true },
        { name: 'Review', value: review.slice(0, 1024), inline: false },
      )
      .setImage(proofAttachment.url)
      .setTimestamp(new Date(submittedAt));
    const vouchMessage = await vouchChannel.send({ embeds: [vouchEmbed] });

    ticketData.marketplaceReview = {
      rating,
      review,
      image: {
        url: proofAttachment.url,
        name: proofAttachment.name || null,
        contentType: proofAttachment.contentType || null,
        messageId: proofAttachment.messageId,
      },
      sellerId: ticketData.sellerId,
      buyerId: ticketData.userId,
      serviceType: ticketData.serviceType || 'support',
      submittedAt,
      vouchMessageId: vouchMessage.id,
      vouchChannelId: vouchChannel.id,
    };
    ticketData.transactionStatus = 'review_complete';
    await saveTicketData(channel.guild.id, channel.id, ticketData);

    const sellerStats = await recordSellerMarketplaceReview(channel.guild.id, ticketData.sellerId, rating);
    await logTicketEvent({
      client: channel.client,
      guildId: channel.guild.id,
      event: {
        type: 'marketplace_review',
        ticketId: channel.id,
        ticketNumber: ticketData.id,
        userId: ticketData.userId,
        executorId: buyer.id,
        metadata: { rating, review, sellerId: ticketData.sellerId, serviceType: ticketData.serviceType, vouchChannelId: vouchChannel.id },
      },
    });

    return { ticketData, sellerStats, vouchChannel };
  } catch (error) {
    rethrowTicketError(error, 'submitMarketplaceReview', 'Failed to submit the marketplace review. Please try again in a moment.', { guildId: channel?.guild?.id, channelId: channel?.id, buyerId: buyer?.id });
  }
}

export async function reopenTicket(channel, reopener) {
  try {
    const ticketData = requireTicket(await getTicketData(channel.guild.id, channel.id), channel);
    
    if (ticketData.status !== 'closed') {
      ticketUserError(
        'Ticket not closed',
        'This ticket is not currently closed.',
        ErrorTypes.VALIDATION,
        { channelId: channel.id, operation: 'reopenTicket' }
      );
    }

    const config = await getGuildConfig(channel.client, channel.guild.id);
    const openCategoryId = config.ticketCategoryId || null;
    let movedToOpenCategory = false;
    let openCategoryMoveFailed = false;
    
    ticketData.status = 'open';
    ticketData.closedBy = null;
    ticketData.closedAt = null;
    ticketData.closeReason = null;
    
    await saveTicketData(channel.guild.id, channel.id, ticketData);

    if (openCategoryId && channel.parentId !== openCategoryId) {
      const openCategory = channel.guild.channels.cache.get(openCategoryId)
        || await channel.guild.channels.fetch(openCategoryId).catch(() => null);

      if (openCategory?.type === ChannelType.GuildCategory) {
        try {
          await channel.setParent(openCategoryId, { lockPermissions: false });
          movedToOpenCategory = true;
        } catch (moveError) {
          openCategoryMoveFailed = true;
          logger.warn(`Could not move reopened ticket ${channel.id} to open category ${openCategoryId}: ${moveError.message}`);
        }
      } else {
        openCategoryMoveFailed = true;
        logger.warn(`Configured open ticket category is invalid for guild ${channel.guild.id}: ${openCategoryId}`);
      }
    }
    
    try {
      const user = await channel.guild.members.fetch(ticketData.userId).catch(() => null);
      if (user) {
        await channel.permissionOverwrites.create(user, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
          AttachFiles: true
        });
      }
    } catch (error) {
      logger.warn(`Could not restore access for user ${ticketData.userId}:`, error.message);
    }
    
    const messages = await channel.messages.fetch();
    const ticketMessage = messages.find(m => 
      m.embeds.length > 0 && 
      m.embeds[0].title?.startsWith('Ticket #')
    );
    
    if (ticketMessage) {
      const embed = ticketMessage.embeds[0];
      const statusField = embed.fields?.find(f => f.name === 'Status');
      
      if (statusField) {
        statusField.value = '🟢 Open';
      }
      
      const row = buildTicketControlRow({
        claimedBy: ticketData.claimedBy,
        transactionComplete: Boolean(ticketData.transactionCompletedAt),
        serviceType: ticketData.serviceType,
      });
      
      await ticketMessage.edit({ 
        embeds: [embed],
        components: [row] 
      });
    }
    
    const reopenEmbed = createEmbed({
      title: 'Ticket Reopened',
      description: `🔓 ${reopener} has reopened this ticket!`,
      color: '#2ecc71'
    });

    const closeStatusMessage = messages.find(m =>
      m.embeds.length > 0 &&
      m.embeds[0].title === 'Ticket Closed' &&
      m.components.length > 0 &&
      m.components[0].components.some(c => c.customId === 'ticket_reopen')
    );

    if (closeStatusMessage) {
      await closeStatusMessage.edit({ embeds: [reopenEmbed], components: [] });
    } else {
      await channel.send({ embeds: [reopenEmbed] });
    }
    
    return { ticketData, movedToOpenCategory, openCategoryMoveFailed };
    
  } catch (error) {
    rethrowTicketError(error, 'reopenTicket', 'Failed to reopen ticket. Please try again in a moment.', { guildId: channel?.guild?.id, channelId: channel?.id, reopenerId: reopener?.id });
  }
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function generateTranscript(channel) {
  try {
    logger.debug('Generating transcript for channel', {
      channelId: channel.id,
      channelName: channel.name
    });

    const messages = [];
    let before = undefined;
    let batch;
    do {
      batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      if (batch.size === 0) break;
      messages.push(...batch.values());
      before = batch.last()?.id;
    } while (batch.size === 100);

    messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    const escape = (str) =>
      String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    const rows = messages.map((msg) => {
      const ts = new Date(msg.createdTimestamp).toISOString().replace('T', ' ').slice(0, 19);
      const author = escape(msg.author?.tag ?? msg.author?.username ?? 'Unknown');
      const content = escape(msg.content || (msg.embeds.length ? '[embed]' : '[attachment]'));
      return `<tr><td class="ts">${ts}</td><td class="author">${author}</td><td class="msg">${content}</td></tr>`;
    }).join('\n');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Transcript – #${escape(channel.name)}</title>
<style>
body{font-family:sans-serif;background:#36393f;color:#dcddde;margin:0;padding:16px}
h1{color:#fff;font-size:1.2rem;margin-bottom:8px}
table{width:100%;border-collapse:collapse;font-size:0.85rem}
th{background:#2f3136;color:#8e9297;padding:6px 8px;text-align:left;border-bottom:2px solid #202225}
td{padding:4px 8px;border-bottom:1px solid #40444b;vertical-align:top}
.ts{color:#72767d;white-space:nowrap;width:160px}
.author{color:#7289da;white-space:nowrap;width:160px}
.msg{word-break:break-word}
</style>
</head>
<body>
<h1>📜 Transcript – #${escape(channel.name)}</h1>
<p style="color:#72767d">${messages.length} message(s) exported on ${new Date().toUTCString()}</p>
<table>
<thead><tr><th>Timestamp (UTC)</th><th>Author</th><th>Message</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</body>
</html>`;

    const buffer = Buffer.from(html, 'utf8');
    const attachment = new AttachmentBuilder(buffer, { name: `ticket-${channel.id}.html` });

    logger.info('✅ Successfully generated transcript', {
      channelId: channel.id,
      channelName: channel.name,
      messageCount: messages.length,
      size: buffer.length
    });

    return attachment;
  } catch (error) {
    logger.error('❌ Failed to generate transcript:', {
      channelId: channel.id,
      channelName: channel.name,
      errorMessage: error.message,
      errorName: error.name,
      errorStack: error.stack
    });
    return null;
  }
}

export async function deleteTicket(channel, deleter) {
  try {
    const ticketData = requireTicket(await getTicketData(channel.guild.id, channel.id), channel);
    
    const deleteEmbed = createEmbed({
      title: 'Ticket Deleted',
      description: `🗑️ This ticket will be permanently deleted in ${TICKET_DELETE_DELAY_SECONDS} seconds.`,
      color: '#e74c3c',
      footer: { text: `Ticket ID: ${ticketData.id}` }
    });
    
    await channel.send({ embeds: [deleteEmbed] });
    
    await logTicketEvent({
      client: channel.client,
      guildId: channel.guild.id,
      event: {
        type: 'delete',
        ticketId: channel.id,
        ticketNumber: ticketData.id,
        userId: ticketData.userId,
        executorId: deleter.id,
        metadata: {
          deletedAt: new Date().toISOString()
        }
      }
    });

    setTimeout(async () => {
      try {
        logger.debug('Starting ticket deletion process', {
          channelId: channel.id,
          ticketId: ticketData.id
        });

        let attachment = null;
        try {
          attachment = await generateTranscript(channel);
          if (attachment) {
            logger.info('Transcript generated successfully, attempting to send', {
              channelId: channel.id,
              ticketNumber: ticketData.id
            });
          } else {
            logger.warn('Transcript generation returned null', {
              channelId: channel.id,
              ticketNumber: ticketData.id
            });
          }
        } catch (transcriptError) {
          logger.error('Error during transcript generation', {
            channelId: channel.id,
            ticketNumber: ticketData.id,
            error: transcriptError.message
          });
        }

        if (attachment) {
          try {
            const guildConfig = await getGuildConfig(channel.client, channel.guild.id);
            if (!guildConfig.ticketTranscriptChannelId) {
              logger.warn('No transcript channel configured, skipping transcript send', {
                channelId: channel.id,
                ticketNumber: ticketData.id
              });
            } else {
              const transcriptChannel = await channel.client.channels.fetch(guildConfig.ticketTranscriptChannelId).catch(() => null);
              
              if (!transcriptChannel) {
                logger.error('Could not fetch transcript channel', {
                  channelId: channel.id,
                  transcriptChannelId: guildConfig.ticketTranscriptChannelId
                });
              } else if (!transcriptChannel.isSendable()) {
                logger.error('Transcript channel exists but is not sendable', {
                  channelId: channel.id,
                  transcriptChannelId: transcriptChannel.id
                });
              } else {
                
                const transcriptEmbed = buildStandardLogEmbed({
                  color: 0x3498db,
                  title: 'Ticket Transcript',
                  description: [
                    formatLogLine('Ticket', `#${ticketData.id}`),
                    formatLogLine('Channel', `#${channel.name}`),
                    formatLogLine('Generated', `<t:${Math.floor(Date.now() / 1000)}:F>`),
                  ].join('\n'),
                  footer: deleter?.username
                    ? { text: `Deleted by ${deleter.username}`, iconURL: deleter.displayAvatarURL?.() }
                    : undefined,
                  timestamp: true,
                });

                await transcriptChannel.send({
                  embeds: [transcriptEmbed],
                  files: [attachment]
                });

                logger.info('✅ Transcript sent successfully', {
                  channelId: channel.id,
                  ticketNumber: ticketData.id,
                  transcriptChannelId: transcriptChannel.id
                });
              }
            }
          } catch (sendError) {
            logger.error('Failed to send transcript to channel:', {
              channelId: channel.id,
              ticketNumber: ticketData.id,
              error: sendError.message
            });
          }
        }

        try {
          await channel.delete('Ticket deleted permanently');
          logger.info('✅ Channel deleted', {
            channelId: channel.id,
            channelName: channel.name,
            ticketNumber: ticketData.id
          });
        } catch (deleteError) {
          logger.error('❌ Failed to delete ticket channel:', {
            channelId: channel.id,
            channelName: channel.name,
            ticketNumber: ticketData.id,
            errorMessage: deleteError.message,
            errorCode: deleteError.code,
            errorName: deleteError.name
          });
        }
      } catch (error) {
        logger.error('❌ Unexpected error during ticket deletion:', {
          channelId: channel.id,
          channelName: channel?.name,
          ticketNumber: ticketData?.id,
          errorMessage: error.message,
          errorName: error.name,
          errorStack: error.stack
        });
      }
    }, TICKET_DELETE_DELAY_MS);
    
    return ticketData;
    
  } catch (error) {
    rethrowTicketError(error, 'deleteTicket', 'Failed to delete ticket. Please try again in a moment.', { guildId: channel?.guild?.id, channelId: channel?.id, deleterId: deleter?.id });
  }
}

export async function unclaimTicket(channel, unclaimer) {
  try {
    const ticketData = requireTicket(await getTicketData(channel.guild.id, channel.id), channel);

    if (ticketData.transactionStatus === 'review_required') {
      ticketUserError(
        'Cannot unclaim a completed transaction',
        'The seller cannot be changed while the buyer’s required marketplace review is pending.',
        ErrorTypes.VALIDATION,
        { channelId: channel.id, operation: 'unclaimTicket' },
      );
    }
    
    if (!ticketData.claimedBy) {
      ticketUserError(
        'Ticket not claimed',
        'This ticket is not currently claimed.',
        ErrorTypes.VALIDATION,
        { channelId: channel.id, operation: 'unclaimTicket' }
      );
    }
    
    if (ticketData.claimedBy !== unclaimer.id && !unclaimer.permissions.has(PermissionFlagsBits.ManageChannels)) {
      ticketUserError(
        'Cannot unclaim ticket',
        'You can only unclaim your own tickets or need Manage Channels permission.',
        ErrorTypes.PERMISSION,
        { channelId: channel.id, operation: 'unclaimTicket' }
      );
    }
    
    const previousClaimer = ticketData.claimedBy;
    ticketData.claimedBy = null;
    ticketData.sellerId = null;
    ticketData.claimedAt = null;
    
    await saveTicketData(channel.guild.id, channel.id, ticketData);
    
    const messages = await channel.messages.fetch();
    const ticketMessage = messages.find(m => 
      m.embeds.length > 0 && 
      m.embeds[0].title?.startsWith('Ticket #')
    );
    
    if (ticketMessage) {
      const embed = ticketMessage.embeds[0];
      const claimedField = embed.fields?.find(f => f.name === 'Claimed By');
      const sellerField = embed.fields?.find(f => f.name === 'Seller');
      
      if (claimedField) {
        claimedField.value = 'Not claimed';
      }
      if (sellerField) {
        sellerField.value = 'Not claimed';
      }
      
      const row = buildTicketControlRow({
        transactionComplete: Boolean(ticketData.transactionCompletedAt),
        serviceType: ticketData.serviceType,
      });
      
      await ticketMessage.edit({ 
        embeds: [embed],
        components: [row] 
      });
    }
    
    const claimMessage = messages.find(m => 
      m.embeds.length > 0 && 
      (m.embeds[0].title === 'Ticket Claimed' || m.embeds[0].title === 'Ticket Unclaimed')
    );
    
    if (claimMessage) {
      const unclaimEmbed = createEmbed({
        title: 'Ticket Unclaimed',
        description: `🔓 ${unclaimer} has unclaimed this ticket!`,
        color: '#f39c12'
      });
      
      await claimMessage.edit({ 
        embeds: [unclaimEmbed],
        components: []
      });
    } else {
      const unclaimEmbed = createEmbed({
        title: 'Ticket Unclaimed',
        description: `🔓 ${unclaimer} has unclaimed this ticket!`,
        color: '#f39c12'
      });
      
      await channel.send({ embeds: [unclaimEmbed] });
    }
    
    await logTicketEvent({
      client: channel.client,
      guildId: channel.guild.id,
      event: {
        type: 'unclaim',
        ticketId: channel.id,
        ticketNumber: ticketData.id,
        userId: ticketData.userId,
        executorId: unclaimer.id,
        metadata: {
          previousClaimer: previousClaimer
        }
      }
    });
    
    return ticketData;
    
  } catch (error) {
    rethrowTicketError(error, 'unclaimTicket', 'Failed to unclaim ticket. Please try again in a moment.', { guildId: channel?.guild?.id, channelId: channel?.id, unclaimerId: unclaimer?.id });
  }
}

async function getNextTicketNumber(guildId) {
  return await incrementTicketCounter(guildId);
}

export async function updateTicketPriority(channel, priority, updater) {
  try {
    const ticketData = requireTicket(await getTicketData(channel.guild.id, channel.id), channel);
    
    const priorityInfo = PRIORITY_MAP[priority];
    if (!priorityInfo) {
      ticketUserError(
      'Invalid priority level',
      'Invalid priority level.',
      ErrorTypes.VALIDATION,
      { channelId: channel.id, priority, operation: 'updateTicketPriority' }
    );
    }
    
    ticketData.priority = priority;
    ticketData.priorityUpdatedBy = updater.id;
    ticketData.priorityUpdatedAt = new Date().toISOString();
    
    await saveTicketData(channel.guild.id, channel.id, ticketData);

    const currentName = channel.name;
    const priorityEmojis = [...new Set(Object.values(PRIORITY_MAP).map((item) => item.emoji).filter(Boolean))];
    const escapedPriorityEmojis = priorityEmojis.map((emoji) => emoji.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const cleanName = escapedPriorityEmojis.length > 0
      ? currentName.replace(new RegExp(`(?:${escapedPriorityEmojis.join('|')})`, 'g'), '').trim()
      : currentName.trim();
    const newName = priority === 'none' ? cleanName : `${priorityInfo.emoji} ${cleanName}`;

    if (newName && newName !== currentName) {
      try {
        await channel.setName(newName);
      } catch (nameError) {
        logger.warn(`Could not update channel name for priority: ${nameError.message}`);
      }
    }
    
    const messages = await channel.messages.fetch();
    const ticketMessage = messages.find(m => 
      m.embeds.length > 0 && 
      m.embeds[0].title?.startsWith('Ticket #')
    );
    
    if (ticketMessage) {
      const embed = ticketMessage.embeds[0];
      
      const updatedEmbed = createEmbed({
        title: embed.title || 'Ticket',
        description: embed.description?.split('\n**Priority:**')[0] + `\n**Priority:** ${priorityInfo.emoji} ${priorityInfo.label}`,
        color: priorityInfo.color,
        fields: embed.fields || [],
        footer: embed.footer
      });
      
      await ticketMessage.edit({ embeds: [updatedEmbed] });
    }
    
    const updateEmbed = createEmbed({
      title: 'Priority Updated',
      description: `📊 Ticket priority updated to **${priorityInfo.emoji} ${priorityInfo.label}** by ${updater}`,
      color: priorityInfo.color
    });
    
    await channel.send({ embeds: [updateEmbed] });
    
    await logTicketEvent({
      client: channel.client,
      guildId: channel.guild.id,
      event: {
        type: 'priority',
        ticketId: channel.id,
        ticketNumber: ticketData.id,
        userId: ticketData.userId,
        executorId: updater.id,
        priority: priority,
        metadata: {
          previousPriority: ticketData.priority,
          updatedAt: ticketData.priorityUpdatedAt
        }
      }
    });
    
    return ticketData;
    
  } catch (error) {
    rethrowTicketError(error, 'updateTicketPriority', 'Failed to update ticket priority. Please try again in a moment.', { guildId: channel?.guild?.id, channelId: channel?.id, updaterId: updater?.id, priority });
  }
}
