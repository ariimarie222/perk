import { MessageFlags } from 'discord.js';
import { CUSTOM_BOT_OWNER_ID } from '../../config/customBotShop.js';
import { getTicketData } from '../../utils/database.js';
import { createMarketplaceEmbed, createSuccessEmbed } from '../../utils/embeds.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';

export default {
  name: 'bot_order_modal',

  async execute(interaction, _client, args = []) {
    const expectedUserId = args[0];
    const ticketData = await getTicketData(interaction.guildId, interaction.channelId);

    if (
      !interaction.inGuild()
      || !ticketData
      || ticketData.serviceType !== 'custom_bot'
      || String(ticketData.userId) !== String(interaction.user.id)
      || String(expectedUserId) !== String(interaction.user.id)
    ) {
      return replyUserError(interaction, {
        type: ErrorTypes.PERMISSION,
        message: 'This order form can only be submitted by the person who opened this custom bot ticket.',
      });
    }

    const systems = interaction.fields.getTextInputValue('systems').trim();
    const theme = interaction.fields.getTextInputValue('theme').trim();
    const botName = interaction.fields.getTextInputValue('bot_name').trim();
    const targetServer = interaction.fields.getTextInputValue('target_server').trim();
    const details = interaction.fields.getTextInputValue('details').trim();

    const embed = createMarketplaceEmbed({
      title: '🎀 Custom Bot Order Form',
      description: `<@${interaction.user.id}> filled out their custom bot order details ♡`,
      fields: [
        { name: '🌷 Systems / Features', value: systems, inline: false },
        { name: '🎨 Theme / Colors / Aesthetic', value: theme, inline: false },
        { name: '🤖 Bot Name', value: botName, inline: false },
        { name: '🏠 Server', value: targetServer, inline: false },
        { name: '✨ Extra Details / Deadline', value: details || 'None provided', inline: false },
        {
          name: '🖼️ Bot Profile Picture / Logo',
          value: 'Please attach the image you want to use in this ticket after submitting the form.',
          inline: false,
        },
      ],
    });

    await interaction.channel.send({
      content: `<@${CUSTOM_BOT_OWNER_ID}>`,
      embeds: [embed],
      allowedMentions: { users: [CUSTOM_BOT_OWNER_ID], roles: [] },
    });

    await interaction.reply({
      embeds: [createSuccessEmbed(
        '🌸 Custom bot form submitted!',
        'Your answers were posted in this ticket. If you have a bot profile picture or logo, attach it here next.',
      )],
      flags: MessageFlags.Ephemeral,
    });
  },
};

