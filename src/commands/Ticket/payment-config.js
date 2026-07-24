import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import {
  PAYMENT_METHOD_TYPES,
  PAYMENT_PROFILES,
} from '../../config/marketplace.js';
import {
  getPaymentProfile,
  removePaymentMethod,
  resetPaymentProfile,
  togglePaymentMethod,
  updatePaymentProfile,
  upsertPaymentMethod,
} from '../../services/marketplacePaymentService.js';
import {
  buildPaymentComponents,
  buildPaymentEmbed,
  canManageMarketplace,
} from '../Economy/pay.js';
import { createErrorEmbed, createSuccessEmbed } from '../../utils/embeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

const profileChoices = Object.values(PAYMENT_PROFILES).map(profile => ({
  name: profile.name,
  value: profile.key,
}));
const methodChoices = Object.entries(PAYMENT_METHOD_TYPES).map(([value, name]) => ({ name, value }));
const profileOption = option => option.setName('profile').setDescription('Payment profile').setRequired(true).addChoices(...profileChoices);
const methodKeyOption = option => option.setName('method_key').setDescription('Short method key, such as cashapp or backup-venmo').setRequired(true);

const data = new SlashCommandBuilder()
  .setName('payment-config')
  .setDescription('Manage approved marketplace payment profiles.')
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
  .addSubcommandGroup(group => group.setName('profile').setDescription('Manage a seller payment profile')
    .addSubcommand(sub => sub.setName('create').setDescription('Create or reset and enable a profile').addStringOption(profileOption))
    .addSubcommand(sub => sub.setName('edit').setDescription('Edit whether a profile is enabled')
      .addStringOption(profileOption)
      .addBooleanOption(option => option.setName('enabled').setDescription('Whether this profile can be published').setRequired(true)))
    .addSubcommand(sub => sub.setName('remove').setDescription('Clear and disable a payment profile').addStringOption(profileOption))
    .addSubcommand(sub => sub.setName('enable').setDescription('Enable a payment profile').addStringOption(profileOption))
    .addSubcommand(sub => sub.setName('disable').setDescription('Disable a payment profile').addStringOption(profileOption)))
  .addSubcommandGroup(group => group.setName('method').setDescription('Manage an individual payment method')
    .addSubcommand(sub => sub.setName('add').setDescription('Add or replace a payment method')
      .addStringOption(profileOption)
      .addStringOption(methodKeyOption)
      .addStringOption(option => option.setName('type').setDescription('Payment method type').setRequired(true).addChoices(...methodChoices))
      .addStringOption(option => option.setName('details').setDescription('Username, handle, email, phone number, or payment link').setRequired(true).setMaxLength(1000))
      .addStringOption(option => option.setName('label').setDescription('Public button label').setMaxLength(80))
      .addStringOption(option => option.setName('notes').setDescription('Private notes shown with the details').setMaxLength(500)))
    .addSubcommand(sub => sub.setName('edit').setDescription('Edit an existing payment method')
      .addStringOption(profileOption)
      .addStringOption(methodKeyOption)
      .addStringOption(option => option.setName('type').setDescription('Payment method type').addChoices(...methodChoices))
      .addStringOption(option => option.setName('details').setDescription('Username, handle, email, phone number, or payment link').setMaxLength(1000))
      .addStringOption(option => option.setName('label').setDescription('Public button label').setMaxLength(80))
      .addStringOption(option => option.setName('notes').setDescription('Private notes shown with the details').setMaxLength(500)))
    .addSubcommand(sub => sub.setName('remove').setDescription('Remove a payment method').addStringOption(profileOption).addStringOption(methodKeyOption))
    .addSubcommand(sub => sub.setName('enable').setDescription('Enable a payment method').addStringOption(profileOption).addStringOption(methodKeyOption))
    .addSubcommand(sub => sub.setName('disable').setDescription('Disable a payment method').addStringOption(profileOption).addStringOption(methodKeyOption)))
  .addSubcommand(sub => sub.setName('preview').setDescription('Privately preview a seller payment embed').addStringOption(profileOption));

export default {
  data,

  async execute(interaction, config) {
    if (!canManageMarketplace(interaction.member, config)) {
      return InteractionHelper.safeReply(interaction, {
        embeds: [createErrorEmbed('Only authorized marketplace staff can manage payment profiles.')],
        flags: MessageFlags.Ephemeral,
      });
    }

    const group = interaction.options.getSubcommandGroup(false);
    const action = interaction.options.getSubcommand(true);
    const profileKey = interaction.options.getString('profile', true);
    const staffId = interaction.user.id;

    try {
      if (!group && action === 'preview') {
        const profile = await getPaymentProfile(interaction.guildId, profileKey);
        return InteractionHelper.safeReply(interaction, {
          embeds: [buildPaymentEmbed(profile)],
          components: buildPaymentComponents(profile),
          flags: MessageFlags.Ephemeral,
        });
      }

      if (group === 'profile') {
        if (action === 'remove') {
          await resetPaymentProfile(interaction.guildId, profileKey, staffId);
        } else if (action === 'create') {
          await updatePaymentProfile(interaction.guildId, profileKey, { enabled: true, methods: {} }, staffId);
        } else {
          const enabled = action === 'enable'
            ? true
            : action === 'disable'
              ? false
              : interaction.options.getBoolean('enabled', true);
          await updatePaymentProfile(interaction.guildId, profileKey, { enabled }, staffId);
        }
      } else {
        const methodKey = interaction.options.getString('method_key', true);
        if (action === 'remove') {
          await removePaymentMethod(interaction.guildId, profileKey, methodKey, staffId);
        } else if (action === 'enable' || action === 'disable') {
          await togglePaymentMethod(interaction.guildId, profileKey, methodKey, action === 'enable', staffId);
        } else {
          const profile = await getPaymentProfile(interaction.guildId, profileKey);
          const current = profile?.methods?.[methodKey];
          if (action === 'edit' && !current) throw new Error('Payment method not found.');
          await upsertPaymentMethod(interaction.guildId, profileKey, {
            methodKey,
            type: interaction.options.getString('type') || current?.type,
            details: interaction.options.getString('details') ?? current?.details,
            label: interaction.options.getString('label') ?? current?.label,
            notes: interaction.options.getString('notes') ?? current?.notes,
            enabled: current?.enabled ?? true,
          }, staffId);
        }
      }

      return InteractionHelper.safeReply(interaction, {
        embeds: [createSuccessEmbed('🌷 Payment settings updated!', `${PAYMENT_PROFILES[profileKey].name}'s payment configuration has been saved.`)],
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
