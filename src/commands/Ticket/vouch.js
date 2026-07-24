import {
    EmbedBuilder,
    MessageFlags,
    PermissionFlagsBits,
    SlashCommandBuilder,
} from 'discord.js';
import { getGuildConfig } from '../../services/config/guildConfig.js';
import { recordSellerMarketplaceReview } from '../../utils/database/tickets.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logger } from '../../utils/logger.js';

const SERVICE_LABELS = Object.freeze({
    purchase: 'Purchase',
    cashout: 'Cashout',
    preorder: 'Preorder',
    middleman: 'Middleman',
});

function isImageAttachment(attachment) {
    return attachment?.contentType?.startsWith('image/')
        || /\.(png|jpe?g|gif|webp)$/i.test(attachment?.name || '');
}

export default {
    data: new SlashCommandBuilder()
        .setName('vouch')
        .setDescription('Submit a marketplace vouch for a transaction completed outside a ticket.')
        .setDMPermission(false)
        .addUserOption(option =>
            option
                .setName('seller')
                .setDescription('The staff member who completed your transaction.')
                .setRequired(true),
        )
        .addStringOption(option =>
            option
                .setName('service')
                .setDescription('The type of marketplace transaction.')
                .setRequired(true)
                .addChoices(
                    { name: 'Purchase', value: 'purchase' },
                    { name: 'Cashout', value: 'cashout' },
                    { name: 'Preorder', value: 'preorder' },
                    { name: 'Middleman', value: 'middleman' },
                ),
        )
        .addIntegerOption(option =>
            option
                .setName('rating')
                .setDescription('Your rating from 1 to 5 stars.')
                .setMinValue(1)
                .setMaxValue(5)
                .setRequired(true),
        )
        .addStringOption(option =>
            option
                .setName('review')
                .setDescription('Describe your experience with the transaction.')
                .setMinLength(1)
                .setMaxLength(1000)
                .setRequired(true),
        )
        .addAttachmentOption(option =>
            option
                .setName('proof')
                .setDescription('A screenshot of the transaction or trade history.')
                .setRequired(true),
        ),

    async execute(interaction, guildConfig, client) {
        const deferred = await InteractionHelper.safeDefer(interaction, {
            flags: MessageFlags.Ephemeral,
        });
        if (!deferred) return;

        const seller = interaction.options.getUser('seller', true);
        const serviceType = interaction.options.getString('service', true);
        const rating = interaction.options.getInteger('rating', true);
        const review = interaction.options.getString('review', true).trim();
        const proof = interaction.options.getAttachment('proof', true);

        if (seller.id === interaction.user.id) {
            return await replyUserError(interaction, {
                type: ErrorTypes.VALIDATION,
                message: 'You cannot submit a marketplace vouch for yourself.',
            });
        }
        if (seller.bot) {
            return await replyUserError(interaction, {
                type: ErrorTypes.VALIDATION,
                message: 'Please select the staff member who personally completed your transaction, not a bot.',
            });
        }
        if (!isImageAttachment(proof)) {
            return await replyUserError(interaction, {
                type: ErrorTypes.VALIDATION,
                message: 'Image proof is required. Upload a PNG, JPG, GIF, or WEBP screenshot of the transaction or trade history.',
            });
        }

        const config = await getGuildConfig(client, interaction.guildId);
        const vouchChannel = config.vouchChannelId
            ? await client.channels.fetch(config.vouchChannelId).catch(() => null)
            : null;
        if (!vouchChannel?.isSendable()) {
            return await replyUserError(interaction, {
                type: ErrorTypes.CONFIGURATION,
                message: 'The marketplace vouch channel is not configured or is unavailable. Please ask staff to check `/ticket dashboard`.',
            });
        }

        const sellerMember = await interaction.guild.members.fetch(seller.id).catch(() => null);
        if (!sellerMember) {
            return await replyUserError(interaction, {
                type: ErrorTypes.VALIDATION,
                message: 'The selected seller is not currently in this server.',
            });
        }

        if (config.ticketStaffRoleId) {
            const isMarketplaceStaff =
                sellerMember.roles.cache.has(config.ticketStaffRoleId)
                || sellerMember.permissions.has(PermissionFlagsBits.ManageChannels);
            if (!isMarketplaceStaff) {
                return await replyUserError(interaction, {
                    type: ErrorTypes.VALIDATION,
                    message: 'The selected seller does not have the configured Ticket Staff Role.',
                });
            }
        }

        const serviceLabel = SERVICE_LABELS[serviceType];
        const submittedAt = new Date();
        const vouchEmbed = new EmbedBuilder()
            .setTitle('⭐ New Marketplace Vouch')
            .setColor('#F1C40F')
            .addFields(
                { name: 'Seller', value: `<@${seller.id}>`, inline: true },
                { name: 'Buyer', value: `<@${interaction.user.id}>`, inline: true },
                { name: 'Service', value: serviceLabel, inline: true },
                { name: 'Rating', value: '⭐'.repeat(rating), inline: true },
                { name: 'Review', value: review.slice(0, 1024), inline: false },
            )
            .setImage(proof.url)
            .setTimestamp(submittedAt);

        const vouchMessage = await vouchChannel.send({ embeds: [vouchEmbed] });
        const sellerStats = await recordSellerMarketplaceReview(
            interaction.guildId,
            seller.id,
            rating,
        );

        logger.info('Direct marketplace vouch submitted', {
            guildId: interaction.guildId,
            buyerId: interaction.user.id,
            sellerId: seller.id,
            serviceType,
            rating,
            vouchChannelId: vouchChannel.id,
            vouchMessageId: vouchMessage.id,
        });

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [
                new EmbedBuilder()
                    .setTitle('✅ Marketplace Vouch Submitted')
                    .setDescription(
                        `Your vouch has been posted in ${vouchChannel}.\n\n`
                        + `Seller stats: **${sellerStats.completedTransactions}** completed transaction(s), `
                        + `**${sellerStats.averageRating}/5** average rating, `
                        + `**${sellerStats.totalReviews}** review(s).`,
                    )
                    .setColor('#2ECC71'),
            ],
        });
    },
};
