import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { CUSTOM_BOT_PACKAGES, CUSTOM_BOT_SYSTEMS } from '../../config/customBotShop.js';
import { createMarketplaceEmbed, createSuccessEmbed } from '../../utils/embeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';

export function buildCustomBotPackagesEmbed() {
  return createMarketplaceEmbed({
    title: '🎀 Arii’s Custom Bots',
    description:
      'Fully custom-coded Discord bots made specifically for your server ♡\n\n'
      + 'No premade public bots are used - your bot is built & customized to your liking.',
    fields: CUSTOM_BOT_PACKAGES,
  });
}

export function buildCustomBotSystemsEmbed() {
  return createMarketplaceEmbed({
    title: '🌷 Systems & Features',
    description:
      'Mix & match systems to create the bot you want ♡\n\n'
      + CUSTOM_BOT_SYSTEMS.map(system => `> ${system}`).join('\n'),
  });
}

export default {
  data: new SlashCommandBuilder()
    .setName('bot-shop')
    .setDescription('Post the custom bot packages and available systems.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  async execute(interaction) {
    if (!interaction.member?.permissions?.has(PermissionFlagsBits.ManageChannels)) {
      return replyUserError(interaction, {
        type: ErrorTypes.PERMISSION,
        message: 'You need the `Manage Channels` permission to post the custom bot shop.',
      });
    }

    const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    if (!deferred) return;

    if (!interaction.channel?.isSendable?.()) {
      return replyUserError(interaction, {
        type: ErrorTypes.VALIDATION,
        message: 'Please run this command in a text channel where I can send messages.',
      });
    }

    await interaction.channel.send({
      embeds: [buildCustomBotPackagesEmbed(), buildCustomBotSystemsEmbed()],
    });

    return InteractionHelper.safeEditReply(interaction, {
      embeds: [createSuccessEmbed('🌷 Custom bot shop posted!', 'The packages and systems are ready in this channel.')],
    });
  },
};
