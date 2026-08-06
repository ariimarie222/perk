import {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  AttachmentBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import { MARKETPLACE_SELLER_IDS, isMarketplaceSellerId } from '../config/marketplace.js';
import { CUSTOM_BOT_OWNER_ID } from '../config/customBotShop.js';
import { createEmbed, successEmbed } from '../utils/embeds.js';
import {
  createTicket,
  closeTicket,
  claimTicket,
  completeMarketplaceTransaction,
  getUserTicketCount,
  updateTicketPriority,
} from '../services/ticket.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import { logTicketEvent } from '../utils/ticket/ticketLogging.js';
import { logger } from '../utils/logger.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { checkRateLimit } from '../utils/rateLimiter.js';
import { replyUserError, ErrorTypes, handleInteractionError, createError } from '../utils/errorHandler.js';
import { getTicketPermissionContext } from '../utils/ticket/ticketPermissions.js';

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function ensureGuildContext(interaction) {
  if (interaction.inGuild()) {
    return true;
  }

  if (!interaction.replied && !interaction.deferred) {
    await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'This action can only be used in a server.' });
  }

  return false;
}

async function openCreateTicketModal(interaction, ticketType, requestedSellerId = 'any') {
  const ticketTypeLabels = {
    purchase: 'Purchase',
    cashout: 'Cashout',
    middleman: 'Middleman',
    preorder: 'Preorder',
    support: 'Support',
    custom_bot: 'Custom Bot',
  };
  const label = ticketTypeLabels[ticketType];
  if (!label) {
    await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'Please choose a valid ticket type.' });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`create_ticket_modal:${ticketType}:${requestedSellerId}`)
    .setTitle(`Create ${label} Ticket`);
  const reasonInput = new TextInputBuilder()
    .setCustomId('reason')
    .setLabel(`Tell us about your ${label.toLowerCase()} request`)
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder(`Provide the details for your ${label.toLowerCase()} request...`)
    .setRequired(true)
    .setMaxLength(1000);

  modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
  await interaction.showModal(modal);
}

async function assertTicketPermission(interaction, client, actionLabel, options = {}, timeoutMs = 2500) {
  const { allowTicketCreator = false } = options;

  let context;
  try {
    const contextPromise = getTicketPermissionContext({ client, interaction });
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout')), timeoutMs)
    );
    context = await Promise.race([contextPromise, timeoutPromise]);
  } catch (error) {
    if (error.message === 'Timeout') {
      throw createError(
        'Ticket permission timeout',
        ErrorTypes.RATE_LIMIT,
        'The permission check took too long. Please try again.'
      );
    }
    throw createError(
      'Ticket permission check failed',
      ErrorTypes.UNKNOWN,
      `Failed to check permissions: ${error.message}`
    );
  }

  if (!context.ticketData) {
    throw createError(
      'Not a ticket channel',
      ErrorTypes.VALIDATION,
      'This action can only be used in a valid ticket channel.'
    );
  }

  const allowed = allowTicketCreator ? context.canCloseTicket : context.canManageTicket;
  if (!allowed) {
    const permissionMessage = allowTicketCreator
      ? 'You must have **Manage Channels**, the configured **Ticket Staff Role**, or be the **ticket creator**.'
      : 'You must have **Manage Channels** or the configured **Ticket Staff Role**.';
    throw createError(
      'Ticket permission denied',
      ErrorTypes.PERMISSION,
      `${permissionMessage}\n\nYou cannot ${actionLabel}.`
    );
  }

  return context;
}

async function ensureTicketPermission(interaction, client, actionLabel, options = {}) {
  const { allowTicketCreator = false } = options;

  const context = await getTicketPermissionContext({ client, interaction });

  if (!context.ticketData) {
    await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'This action can only be used in a valid ticket channel.' });
    return null;
  }

  const allowed = allowTicketCreator ? context.canCloseTicket : context.canManageTicket;
  if (!allowed) {
    const permissionMessage = allowTicketCreator
      ? 'You must have **Manage Channels**, the configured **Ticket Staff Role**, or be the **ticket creator**.'
      : 'You must have **Manage Channels** or the configured **Ticket Staff Role**.';

    await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: `${permissionMessage}\n\nYou cannot ${actionLabel}.` });
    return null;
  }

  return context;
}

const createTicketHandler = {
  name: 'create_ticket',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      const ticketTypeMenu = new StringSelectMenuBuilder()
        .setCustomId('ticket_type:select')
        .setPlaceholder('Choose a ticket type...')
        .addOptions(
          new StringSelectMenuOptionBuilder().setLabel('Custom Bot').setDescription('Order a fully custom-coded Discord bot').setValue('custom_bot').setEmoji('🎀'),
          new StringSelectMenuOptionBuilder().setLabel('Purchase').setDescription('Get help with a purchase').setValue('purchase').setEmoji('🛒'),
          new StringSelectMenuOptionBuilder().setLabel('Cashout').setDescription('Request a cashout').setValue('cashout').setEmoji('💸'),
          new StringSelectMenuOptionBuilder().setLabel('Middleman').setDescription('Request a middleman for a trade').setValue('middleman').setEmoji('🤝'),
          new StringSelectMenuOptionBuilder().setLabel('Preorder').setDescription('Ask about a preorder').setValue('preorder').setEmoji('📦'),
          new StringSelectMenuOptionBuilder().setLabel('Support').setDescription('Get help from the support team').setValue('support').setEmoji('🛟'),
        );

      await interaction.reply({
        content: 'What can we help you with?',
        components: [new ActionRowBuilder().addComponents(ticketTypeMenu)],
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      logger.error('Error creating ticket modal:', error);
      if (!interaction.replied && !interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Could not open ticket creation form.' });
      }
    }
  }
};

const ticketTypeHandler = {
  name: 'ticket_type',
  async execute(interaction) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      const ticketType = interaction.values[0];
      const ticketTypeLabels = {
        purchase: 'Purchase',
        cashout: 'Cashout',
        middleman: 'Middleman',
        preorder: 'Preorder',
        support: 'Support',
        custom_bot: 'Custom Bot',
      };
      const label = ticketTypeLabels[ticketType];
      if (!label) {
        await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'Please choose a valid ticket type.' });
        return;
      }

      if (ticketType === 'purchase' || ticketType === 'cashout') {
        const sellerMembers = await Promise.all(
          MARKETPLACE_SELLER_IDS.map(sellerId =>
            interaction.guild.members.fetch(sellerId).catch(() => null)
          ),
        );
        const sellerOptions = sellerMembers
          .filter(member => member && !member.user.bot)
          .map(member =>
            new StringSelectMenuOptionBuilder()
              .setLabel((member.displayName || member.user.username).slice(0, 100))
              .setDescription(`@${member.user.username}`.slice(0, 100))
              .setValue(member.id)
          );
        sellerOptions.push(
          new StringSelectMenuOptionBuilder()
            .setLabel('Any Seller')
            .setDescription('Let any available seller claim this ticket')
            .setValue('any')
            .setEmoji('🙋'),
        );

        const sellerSelect = new StringSelectMenuBuilder()
          .setCustomId(`ticket_seller:${ticketType}`)
          .setPlaceholder('Choose a seller or select Any Seller...')
          .setMinValues(1)
          .setMaxValues(1)
          .addOptions(sellerOptions);

        await interaction.update({
          content: `Do you want a specific seller for this ${label.toLowerCase()}?`,
          components: [
            new ActionRowBuilder().addComponents(sellerSelect),
          ],
        });
        return;
      }

      if (ticketType === 'custom_bot') {
        await openCreateTicketModal(interaction, ticketType, CUSTOM_BOT_OWNER_ID);
        return;
      }

      await openCreateTicketModal(interaction, ticketType);
    } catch (error) {
      logger.error('Error choosing ticket type:', error);
      if (!interaction.replied && !interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Could not open the ticket form.' });
      }
    }
  },
};

const ticketSellerHandler = {
  name: 'ticket_seller',
  async execute(interaction, client, args = []) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      const ticketType = args[0];
      if (ticketType !== 'purchase' && ticketType !== 'cashout') {
        await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'This seller selection is invalid.' });
        return;
      }

      const sellerId = interaction.values[0];
      if (sellerId === 'any') {
        await openCreateTicketModal(interaction, ticketType, 'any');
        return;
      }
      if (!isMarketplaceSellerId(sellerId)) {
        await replyUserError(interaction, {
          type: ErrorTypes.VALIDATION,
          message: 'Please select a seller from the official marketplace seller list.',
        });
        return;
      }
      const sellerMember = await interaction.guild.members.fetch(sellerId).catch(() => null);
      if (!sellerMember || sellerMember.user.bot) {
        await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'Please select a valid staff seller.' });
        return;
      }

      const config = await getGuildConfig(client, interaction.guildId);
      const isSeller =
        sellerMember.permissions.has(PermissionFlagsBits.ManageChannels)
        || Boolean(config.ticketStaffRoleId && sellerMember.roles.cache.has(config.ticketStaffRoleId));
      if (!isSeller) {
        await replyUserError(interaction, {
          type: ErrorTypes.VALIDATION,
          message: 'That user is not a marketplace seller. Choose someone with the configured Ticket Staff Role, or select **Any Seller**.',
        });
        return;
      }

      await openCreateTicketModal(interaction, ticketType, sellerId);
    } catch (error) {
      logger.error('Error choosing requested ticket seller:', error);
      if (!interaction.replied && !interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Could not open the ticket form.' });
      }
    }
  },
};

const ticketSellerAnyHandler = {
  name: 'ticket_seller_any',
  async execute(interaction, client, args = []) {
    try {
      if (!(await ensureGuildContext(interaction))) return;
      const ticketType = args[0];
      if (ticketType !== 'purchase' && ticketType !== 'cashout') {
        await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'This seller selection is invalid.' });
        return;
      }
      await openCreateTicketModal(interaction, ticketType, 'any');
    } catch (error) {
      logger.error('Error choosing any ticket seller:', error);
      if (!interaction.replied && !interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Could not open the ticket form.' });
      }
    }
  },
};

const createTicketModalHandler = {
  name: 'create_ticket_modal',
  async execute(interaction, client, args = []) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      const rateLimitKey = `${interaction.user.id}:create_ticket`;
      const allowed = await checkRateLimit(rateLimitKey, 3, 60000);
      if (!allowed) {
        await replyUserError(interaction, { type: ErrorTypes.RATE_LIMIT, message: 'You are creating tickets too quickly. Please wait a minute and try again.' });
        return;
      }

      const config = await getGuildConfig(client, interaction.guildId);
      const maxTicketsPerUser = config.maxTicketsPerUser || 3;
      const currentTicketCount = await getUserTicketCount(interaction.guildId, interaction.user.id);
      if (currentTicketCount >= maxTicketsPerUser) {
        await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: `You have reached the maximum number of open tickets (${maxTicketsPerUser}).\n\nPlease close your existing tickets before creating a new one.\n\n**Current Tickets:** ${currentTicketCount}/${maxTicketsPerUser}` });
        return;
      }

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      
      const ticketType = args[0] || 'support';
      const requestedSellerId = args[1] || 'any';
      const reason = interaction.fields.getTextInputValue('reason');
      const categoryId = config.ticketCategoryId || null;
      
      const { channel } = await createTicket(
        interaction.guild,
        interaction.member,
        categoryId,
        reason,
        'none',
        ticketType,
        requestedSellerId,
      );
      await interaction.editReply({
        embeds: [successEmbed(
          'Ticket Created',
          `Your ticket has been created in ${channel}!`
        )]
      });
    } catch (error) {
      await handleInteractionError(interaction, error, { type: 'modal', handler: 'create_ticket_modal', customId: interaction.customId });
    }
  }
};

const closeTicketHandler = {
  name: 'ticket_close',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      await assertTicketPermission(interaction, client, 'close this ticket', { allowTicketCreator: true }, 2000);

      const modal = new ModalBuilder()
        .setCustomId('ticket_close_modal')
        .setTitle('Close Ticket');

      const reasonInput = new TextInputBuilder()
        .setCustomId('reason')
        .setLabel('Reason for closing (optional)')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Add an optional reason for closing this ticket...')
        .setRequired(false)
        .setMaxLength(1000);

      const actionRow = new ActionRowBuilder().addComponents(reasonInput);
      modal.addComponents(actionRow);

      await interaction.showModal(modal);
    } catch (error) {
      logger.error('Error closing ticket:', error);

      if (!interaction.replied && !interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Could not open ticket close form.' });
      }
    }
  }
};

const closeTicketModalHandler = {
  name: 'ticket_close_modal',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      await assertTicketPermission(interaction, client, 'close this ticket', { allowTicketCreator: true }, 2000);

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;

      const providedReason = interaction.fields.getTextInputValue('reason')?.trim();
      const reason = providedReason || 'Closed via ticket button without a specific reason.';

      await closeTicket(interaction.channel, interaction.user, reason);
      await interaction.editReply({ embeds: [successEmbed('Ticket Closed', 'This ticket has been closed.')] });
    } catch (error) {
      logger.error('Error submitting close ticket modal:', error);
      if (!interaction.replied && !interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while closing the ticket.' });
      } else if (interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while closing the ticket.' });
      }
    }
  }
};

const claimTicketHandler = {
  name: 'ticket_claim',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      await assertTicketPermission(interaction, client, 'claim tickets', {}, 2000);

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      
      await claimTicket(interaction.channel, interaction.user);
      await interaction.editReply({ embeds: [successEmbed('Ticket Claimed', 'You are now the seller for this ticket.')] });
    } catch (error) {
      logger.error('Error claiming ticket:', error);
      if (!interaction.replied && !interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while claiming the ticket.' });
      } else if (interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while claiming the ticket.' });
      }
    }
  }
};

const completeMarketplaceTransactionHandler = {
  name: 'ticket_complete_transaction',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      await assertTicketPermission(interaction, client, 'complete marketplace transactions', {}, 2000);
      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;

      await completeMarketplaceTransaction(interaction.channel, interaction.user);
      await interaction.editReply({
        embeds: [successEmbed('Transaction Complete', 'The buyer has been asked to submit their required rating, written vouch, and image proof before this ticket can be closed.')],
      });
    } catch (error) {
      logger.error('Error completing marketplace transaction:', error);
      if (!interaction.replied && !interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: error.userMessage || 'Could not complete this transaction.' });
      } else if (interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: error.userMessage || 'Could not complete this transaction.' });
      }
    }
  },
};

const priorityTicketHandler = {
  name: 'ticket_priority',
  async execute(interaction, client, args) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      await assertTicketPermission(interaction, client, 'change ticket priority', {}, 2000);

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      
      const priority = args?.[0];
      if (!priority) {
        await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'A priority value is required.' });
        return;
      }

      await updateTicketPriority(interaction.channel, priority, interaction.user);
      await interaction.editReply({ embeds: [successEmbed('Priority Updated', `Ticket priority set to **${priority.toUpperCase()}**.`)] });
    } catch (error) {
      logger.error('Error updating ticket priority:', error);
      if (!interaction.replied && !interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while updating the priority.' });
      } else if (interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while updating the priority.' });
      }
    }
  }
};

const pinTicketHandler = {
  name: 'ticket_pin',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      await assertTicketPermission(interaction, client, 'pin tickets', {}, 2000);

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;

      const channel = interaction.channel;
      const category = channel.parent;

      if (!category) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'This ticket is not in a category.' });
        return;
      }

      const hasPingEmoji = channel.name.startsWith('📌');
      
      if (hasPingEmoji) {
        
        const newName = channel.name.replace(/^📌\s*/, '');
        await channel.edit({
          name: newName,
          position: 999 
        });

        await interaction.editReply({
          embeds: [createEmbed({
            title: '📌 Ticket Unpinned',
            description: 'This ticket has been unpinned and moved back to normal position.',
            color: 0x95A5A6
          })],
          flags: MessageFlags.Ephemeral
        });

        logger.info('Ticket unpinned', {
          guildId: interaction.guildId,
          channelId: channel.id,
          channelName: newName,
          userId: interaction.user.id
        });
      } else {
        
        const pinnedName = `📌 ${channel.name}`;
        await channel.edit({
          name: pinnedName,
          position: 0 
        });

        await interaction.editReply({
          embeds: [createEmbed({
            title: '📌 Ticket Pinned',
            description: 'This ticket has been pinned to the top of the category.',
            color: 0x3498db
          })],
          flags: MessageFlags.Ephemeral
        });

        logger.info('Ticket pinned', {
          guildId: interaction.guildId,
          channelId: channel.id,
          channelName: pinnedName,
          userId: interaction.user.id
        });
      }

      await logTicketEvent({
        client: interaction.client,
        guildId: interaction.guildId,
        event: {
          type: hasPingEmoji ? 'unpin' : 'pin',
          ticketId: channel.id,
          ticketNumber: channel.name.replace(/[^0-9]/g, ''),
          userId: interaction.user.id,
          executorId: interaction.user.id,
          metadata: {
            isPinned: !hasPingEmoji,
            newChannelName: hasPingEmoji ? channel.name.replace(/^📌\s*/, '') : `📌 ${channel.name}`
          }
        }
      });

    } catch (error) {
      logger.error('Error pinning/unpinning ticket:', error);
      if (!interaction.replied && !interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Failed to pin/unpin the ticket.' });
      } else if (interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Failed to pin/unpin the ticket.' });
      }
    }
  }
};

const unclaimTicketHandler = {
  name: 'ticket_unclaim',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      await assertTicketPermission(interaction, client, 'unclaim tickets', {}, 2000);

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      
      const { unclaimTicket } = await import('../services/ticket.js');
      await unclaimTicket(interaction.channel, interaction.member);
      await interaction.editReply({ embeds: [successEmbed('Ticket Unclaimed', 'This ticket has been unclaimed.')] });
    } catch (error) {
      logger.error('Error unclaiming ticket:', error);
      if (!interaction.replied && !interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while unclaiming the ticket.' });
      } else if (interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while unclaiming the ticket.' });
      }
    }
  }
};

const reopenTicketHandler = {
  name: 'ticket_reopen',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      await assertTicketPermission(interaction, client, 'reopen tickets', {}, 2000);

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      
      const { reopenTicket } = await import('../services/ticket.js');
      const { movedToOpenCategory, openCategoryMoveFailed } = await reopenTicket(interaction.channel, interaction.member);
      let reopenMessage = 'This ticket has been reopened.';
      if (openCategoryMoveFailed) {
        reopenMessage += ' Note: Could not move the channel back to the open tickets category.';
      }
      await interaction.editReply({ embeds: [successEmbed('Ticket Reopened', reopenMessage)] });
    } catch (error) {
      logger.error('Error reopening ticket:', error);
      if (!interaction.replied && !interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while reopening the ticket.' });
      } else if (interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while reopening the ticket.' });
      }
    }
  }
};

const deleteTicketHandler = {
  name: 'ticket_delete',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      await assertTicketPermission(interaction, client, 'delete tickets', {}, 2000);

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      
      const { deleteTicket } = await import('../services/ticket.js');
      await deleteTicket(interaction.channel, interaction.member);
      await interaction.editReply({ embeds: [successEmbed('Ticket Deleted', 'This ticket will be deleted shortly.')] });
    } catch (error) {
      logger.error('Error deleting ticket:', error);
      if (!interaction.replied && !interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while deleting the ticket.' });
      } else if (interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while deleting the ticket.' });
      }
    }
  }
};

export default createTicketHandler;
export { 
  ticketTypeHandler,
  ticketSellerHandler,
  ticketSellerAnyHandler,
  createTicketModalHandler, 
  closeTicketModalHandler,
  closeTicketHandler, 
  claimTicketHandler, 
  completeMarketplaceTransactionHandler,
  priorityTicketHandler,
  pinTicketHandler,
  unclaimTicketHandler,
  reopenTicketHandler,
  deleteTicketHandler 
};
