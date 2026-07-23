import { getColor } from '../../config/bot.js';
import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } from 'discord.js';
import { successEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { getTicketPermissionContext } from '../../utils/ticket/ticketPermissions.js';
import { closeTicket } from '../../services/ticket.js';
export default {
    data: new SlashCommandBuilder()
        .setName("close")
        .setDescription("Closes the current ticket.")
        .setDMPermission(false)
        .addStringOption((option) =>
            option
                .setName("reason")
                .setDescription("The reason for closing the ticket.")
                .setRequired(false),
        )
        .addBooleanOption((option) =>
            option
                .setName("override_vouch")
                .setDescription("Staff only: close even if a marketplace vouch is still required.")
                .setRequired(false),
        ),

    async execute(interaction, guildConfig, client) {
        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) {
            return;
        }

        const permissionContext = await getTicketPermissionContext({ client, interaction });
        if (!permissionContext.ticketData) {
            return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'This command can only be used in a valid ticket channel.' });
        }

        if (!permissionContext.canCloseTicket) {
            return await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'You need the `Manage Channels` permission, the configured `Ticket Staff Role`, or be the ticket creator to close this ticket.' });
        }

        const reason =
            interaction.options?.getString("reason") ||
            "Closed via command without a specific reason.";
        const overrideVouch = interaction.options?.getBoolean("override_vouch") || false;

        if (overrideVouch && !permissionContext.canManageTicket) {
            return await replyUserError(interaction, {
                type: ErrorTypes.PERMISSION,
                message: 'Only members with **Manage Channels** or the configured **Ticket Staff Role** can override a required vouch.',
            });
        }

        if (overrideVouch && !interaction.options?.getString("reason")?.trim()) {
            return await replyUserError(interaction, {
                type: ErrorTypes.VALIDATION,
                message: 'A reason is required when overriding a marketplace vouch, such as `Buyer did not respond`.',
            });
        }

        if (overrideVouch && permissionContext.ticketData.transactionStatus !== 'review_required') {
            return await replyUserError(interaction, {
                type: ErrorTypes.VALIDATION,
                message: 'A vouch override is not needed for this ticket. Run `/close` normally with your reason.',
            });
        }

        await closeTicket(interaction.channel, interaction.user, reason, {
            overrideMarketplaceReview: overrideVouch,
        });

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [
                successEmbed(
                    "Ticket Closed!",
                    overrideVouch
                        ? "This ticket has been closed successfully with a staff vouch override."
                        : "This ticket has been closed successfully.",
                ),
            ],
        });

        logger.info('Ticket closed successfully', {
            userId: interaction.user.id,
            userTag: interaction.user.tag,
            channelId: interaction.channel.id,
            channelName: interaction.channel.name,
            guildId: interaction.guildId,
            reason: reason,
            overrideVouch,
            commandName: 'close'
        });
    },
};
