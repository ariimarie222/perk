import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import {
  PAYMENT_METHOD_TYPES,
  PAYMENT_PROFILES,
} from '../../config/marketplace.js';
import {
  removePaymentMethod,
  upsertPaymentMethod,
} from '../../services/marketplacePaymentService.js';
import { canManageMarketplace } from '../Economy/pay.js';
import { createErrorEmbed, createSuccessEmbed } from '../../utils/embeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

const profileChoices = Object.values(PAYMENT_PROFILES).map(profile => ({
  name: profile.name,
  value: profile.key,
}));
const methodChoices = Object.entries(PAYMENT_METHOD_TYPES).map(([value, name]) => ({ name, value }));
const profileOption = option => option
  .setName('seller')
  .setDescription('Which seller is this payment for?')
  .setRequired(true)
  .addChoices(...profileChoices);
const detailsOption = option => option
  .setName('payment_info')
  .setDescription('The private username, phone number, email, wallet, or payment link')
  .setRequired(true)
  .setMaxLength(1000);
const notesOption = option => option
  .setName('notes')
  .setDescription('Optional private payment instructions')
  .setMaxLength(500);

const data = new SlashCommandBuilder()
  .setName('payment-config')
  .setDescription('Add or remove seller payment information.')
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
  .addSubcommand(sub => sub
    .setName('add')
    .setDescription('Add or replace a seller payment option')
    .addStringOption(profileOption)
    .addStringOption(option => option
      .setName('payment_type')
      .setDescription('Which payment option are you adding?')
      .setRequired(true)
      .addChoices(...methodChoices))
    .addStringOption(detailsOption)
    .addStringOption(notesOption))
  .addSubcommand(sub => sub
    .setName('remove')
    .setDescription('Remove one payment option from a seller')
    .addStringOption(profileOption)
    .addStringOption(option => option
      .setName('payment_type')
      .setDescription('Which payment option should be removed?')
      .setRequired(true)
      .addChoices(...methodChoices)));

export default {
  data,

  async execute(interaction, config) {
    if (!canManageMarketplace(interaction.member, config)) {
      return InteractionHelper.safeReply(interaction, {
        embeds: [createErrorEmbed('Only authorized marketplace staff can manage payment profiles.')],
        flags: MessageFlags.Ephemeral,
      });
    }

    const action = interaction.options.getSubcommand(true);
    const profileKey = interaction.options.getString('seller', true);
    const staffId = interaction.user.id;

    try {
      const methodKey = interaction.options.getString('payment_type', true);
      if (action === 'remove') {
        await removePaymentMethod(interaction.guildId, profileKey, methodKey, staffId);
      } else {
        await upsertPaymentMethod(interaction.guildId, profileKey, {
          methodKey,
          type: methodKey,
          details: interaction.options.getString('payment_info', true),
          label: null,
          notes: interaction.options.getString('notes'),
          enabled: true,
        }, staffId);
      }

      return InteractionHelper.safeReply(interaction, {
        embeds: [createSuccessEmbed(
          '🌷 Payment settings updated!',
          action === 'remove'
            ? `${PAYMENT_METHOD_TYPES[methodKey]} was removed from ${PAYMENT_PROFILES[profileKey].name}.`
            : `${PAYMENT_METHOD_TYPES[methodKey]} is ready for ${PAYMENT_PROFILES[profileKey].name}.`,
        )],
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      return InteractionHelper.safeReply(interaction, {
        embeds: [createErrorEmbed(error.message)],
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
