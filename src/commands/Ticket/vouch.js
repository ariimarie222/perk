import {
    MessageFlags,
    PermissionFlagsBits,
    SlashCommandBuilder,
} from 'discord.js';
import { MARKETPLACE_SELLER_IDS, isMarketplaceSellerId } from '../../config/marketplace.js';
import { getGuildConfig } from '../../services/config/guildConfig.js';
import {
    getSellerMarketplaceStats,
    recordSellerMarketplaceReview,
    saveMarketplaceVouch,
} from '../../utils/database/tickets.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logger } from '../../utils/logger.js';
import { buildMarketplaceVouchEmbed } from '../../utils/marketplaceVouch.js';
import { createInfoEmbed, createSuccessEmbed } from '../../utils/embeds.js';

function isImageAttachment(attachment) {
    return attachment?.contentType?.startsWith('image/')
        || /\.(png|jpe?g|gif|webp)$/i.test(attachment?.name || '');
}

export default {
    data: new SlashCommandBuilder()
        .setName('vouch')
        .setDescription('Submit marketplace vouches or view your seller stats.')
        .setDMPermission(false)
        .addSubcommand(subcommand =>
            subcommand
                .setName('submit')
                .setDescription('Submit a vouch for a transaction completed outside a ticket.')
                .addStringOption(option =>
                    option
                        .setName('seller')
                        .setDescription('The staff member who completed your transaction.')
                        .setRequired(true)
                        .setAutocomplete(true),
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
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('stats')
                .setDescription('View your own marketplace vouch totals and rating.'),
        ),

    async execute(interaction, guildConfig, client) {
        const deferred = await InteractionHelper.safeDefer(interaction, {
            flags: MessageFlags.Ephemeral,
        });
        if (!deferred) return;

        const subcommand = interaction.options.getSubcommand();
        if (subcommand === 'stats') {
            if (!isMarketplaceSellerId(interaction.user.id)) {
                return await replyUserError(interaction, {
                    type: ErrorTypes.PERMISSION,
                    message: 'Only current approved marketplace sellers can view seller vouch stats.',
                });
            }

            const stats = await getSellerMarketplaceStats(interaction.guildId, interaction.user.id);
            const averageRating = stats.totalReviews > 0 && stats.averageRating != null
                ? `${stats.averageRating}/5`
                : 'No ratings yet';

            return await InteractionHelper.safeEditReply(interaction, {
                embeds: [
                    createInfoEmbed({
                        title: '🎀 Your Seller Vouch Stats',
                        description: `Stats for <@${interaction.user.id}>`,
                        fields: [
                            { name: 'Completed Transactions', value: String(stats.completedTransactions || 0), inline: true },
                            { name: 'Total Vouches', value: String(stats.totalReviews || 0), inline: true },
                            { name: 'Average Rating', value: averageRating, inline: true },
                        ],
                    }),
                ],
            });
        }

        const sellerId = interaction.options.getString('seller', true);
        const serviceType = interaction.options.getString('service', true);
        const rating = interaction.options.getInteger('rating', true);
        const review = interaction.options.getString('review', true).trim();
        const proof = interaction.options.getAttachment('proof', true);

        if (!isMarketplaceSellerId(sellerId)) {
            return await replyUserError(interaction, {
                type: ErrorTypes.VALIDATION,
                message: 'Please select a seller from the official marketplace seller list.',
            });
        }

        const seller = await client.users.fetch(sellerId).catch(() => null);
        if (!seller) {
            return await replyUserError(interaction, {
                type: ErrorTypes.VALIDATION,
                message: 'That marketplace seller is currently unavailable.',
            });
        }

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

        const submittedAt = new Date();
        const pendingVouch = {
            sellerId: seller.id,
            buyerId: interaction.user.id,
            serviceType,
            rating,
            review,
            proofUrl: proof.url,
            submittedAt: submittedAt.toISOString(),
            source: 'direct',
        };
        const vouchMessage = await vouchChannel.send({ embeds: [buildMarketplaceVouchEmbed(pendingVouch)] });
        const vouchRecord = await saveMarketplaceVouch(interaction.guildId, {
            ...pendingVouch,
            id: vouchMessage.id,
            guildId: interaction.guildId,
            vouchMessageId: vouchMessage.id,
            vouchChannelId: vouchChannel.id,
            messageUrl: vouchMessage.url,
        });
        await vouchMessage.edit({ embeds: [buildMarketplaceVouchEmbed(vouchRecord)] }).catch(() => {});
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
                createSuccessEmbed(
                    '🎀 Your vouch has been submitted!',
                        `Your vouch has been posted in ${vouchChannel}.\n\n`
                        + `Seller stats: **${sellerStats.completedTransactions}** completed transaction(s), `
                        + `**${sellerStats.averageRating}/5** average rating, `
                        + `**${sellerStats.totalReviews}** review(s).`,
                    ),
            ],
        });
    },

    async autocomplete(interaction) {
        const focused = interaction.options.getFocused().toLowerCase();
        const members = await Promise.all(
            MARKETPLACE_SELLER_IDS.map(sellerId =>
                interaction.guild.members.fetch(sellerId).catch(() => null)
            ),
        );
        const choices = members
            .filter(Boolean)
            .map(member => ({
                name: member.displayName || member.user.username,
                value: member.id,
            }))
            .filter(choice => choice.name.toLowerCase().includes(focused))
            .slice(0, 25);

        await interaction.respond(choices);
    },
};
