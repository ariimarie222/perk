import {
  ActionRowBuilder,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { getTicketData } from '../../utils/database.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';

function buildOrderModal(userId) {
  const systems = new TextInputBuilder()
    .setCustomId('systems')
    .setLabel('Systems / features you want')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('Tickets, verification, payments, vouches, moderation, etc.')
    .setRequired(true)
    .setMaxLength(1000);

  const theme = new TextInputBuilder()
    .setCustomId('theme')
    .setLabel('Theme / colors / aesthetic')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('Colors, aesthetic, emojis, branding, or a reference style...')
    .setRequired(true)
    .setMaxLength(500);

  const botName = new TextInputBuilder()
    .setCustomId('bot_name')
    .setLabel('Bot name')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('What do you want your bot to be called?')
    .setRequired(true)
    .setMaxLength(100);

  const targetServer = new TextInputBuilder()
    .setCustomId('target_server')
    .setLabel('Server name or invite')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Where will your custom bot be used?')
    .setRequired(true)
    .setMaxLength(200);

  const details = new TextInputBuilder()
    .setCustomId('details')
    .setLabel('Extra details / deadline')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('References, special behavior, deadline, or anything else I should know...')
    .setRequired(false)
    .setMaxLength(1000);

  return new ModalBuilder()
    .setCustomId(`bot_order_modal:${userId}`)
    .setTitle('🎀 Custom Bot Order')
    .addComponents(
      new ActionRowBuilder().addComponents(systems),
      new ActionRowBuilder().addComponents(theme),
      new ActionRowBuilder().addComponents(botName),
      new ActionRowBuilder().addComponents(targetServer),
      new ActionRowBuilder().addComponents(details),
    );
}

export default {
  data: new SlashCommandBuilder()
    .setName('bot')
    .setDescription('Custom bot order tools.')
    .addSubcommand(subcommand =>
      subcommand
        .setName('begin')
        .setDescription('Fill out your custom bot order form.'),
    ),

  async execute(interaction) {
    if (!interaction.inGuild()) {
      return replyUserError(interaction, {
        type: ErrorTypes.VALIDATION,
        message: 'Please use this command inside your custom bot ticket.',
      });
    }

    const ticketData = await getTicketData(interaction.guildId, interaction.channelId);
    if (!ticketData || ticketData.serviceType !== 'custom_bot') {
      return replyUserError(interaction, {
        type: ErrorTypes.VALIDATION,
        message: 'Please use `/bot begin` inside your custom bot ticket.',
      });
    }

    if (String(ticketData.userId) !== String(interaction.user.id)) {
      return replyUserError(interaction, {
        type: ErrorTypes.PERMISSION,
        message: 'Only the person who opened this custom bot ticket can fill out its order form.',
      });
    }

    await interaction.showModal(buildOrderModal(interaction.user.id));
  },
};

