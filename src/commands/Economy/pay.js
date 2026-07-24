import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    PermissionFlagsBits,
    SlashCommandBuilder,
} from 'discord.js';
import { PAYMENT_PROFILES } from '../../config/marketplace.js';
import { getPaymentProfile } from '../../services/marketplacePaymentService.js';
import { createMarketplaceEmbed, createErrorEmbed } from '../../utils/embeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

function addProfileSubcommand(builder, profile) {
    return builder.addSubcommand(subcommand =>
        subcommand
            .setName(profile.key)
            .setDescription(`Post ${profile.name}'s enabled payment methods.`),
    );
}

export function canManageMarketplace(member, config) {
    return Boolean(
        member?.permissions?.has(PermissionFlagsBits.ManageChannels)
        || (config?.ticketStaffRoleId && member?.roles?.cache?.has(config.ticketStaffRoleId)),
    );
}

export function buildPaymentComponents(profile) {
    const methods = Object.values(profile?.methods || {})
        .filter(method => method.enabled && method.details)
        .slice(0, 25);
    const rows = [];

    for (let index = 0; index < methods.length; index += 5) {
        rows.push(new ActionRowBuilder().addComponents(
            methods.slice(index, index + 5).map(method =>
                new ButtonBuilder()
                    .setCustomId(`perk_payment:${profile.key}:${method.key}`)
                    .setLabel(method.label)
                    .setStyle(ButtonStyle.Secondary),
            ),
        ));
    }
    return rows;
}

export function buildPaymentEmbed(profile) {
    return createMarketplaceEmbed({
        title: `💗 ${profile.name} Payment Methods`,
        description:
            'Please choose your preferred payment method below.\n\n'
            + '**Always confirm the payment username and amount with the seller before sending money.**',
    });
}

const data = new SlashCommandBuilder()
    .setName('pay')
    .setDescription('Post an approved seller payment profile.')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels);

for (const profile of Object.values(PAYMENT_PROFILES)) {
    addProfileSubcommand(data, profile);
}

export default {
    data,

    async execute(interaction, config) {
        if (!canManageMarketplace(interaction.member, config)) {
            return InteractionHelper.safeReply(interaction, {
                embeds: [createErrorEmbed('Only members with the configured Ticket Staff Role can use `/pay`.')],
                flags: MessageFlags.Ephemeral,
            });
        }

        const profileKey = interaction.options.getSubcommand(true);
        const profile = await getPaymentProfile(interaction.guildId, profileKey);
        const components = buildPaymentComponents(profile);

        if (!profile?.enabled) {
            return InteractionHelper.safeReply(interaction, {
                embeds: [createErrorEmbed(`${PAYMENT_PROFILES[profileKey].name}'s payment profile is currently disabled.`)],
                flags: MessageFlags.Ephemeral,
            });
        }
        if (components.length === 0) {
            return InteractionHelper.safeReply(interaction, {
                embeds: [createErrorEmbed('This profile has no enabled payment methods with payment details configured.')],
                flags: MessageFlags.Ephemeral,
            });
        }

        return InteractionHelper.safeReply(interaction, {
            embeds: [buildPaymentEmbed(profile)],
            components,
        });
    },
};
