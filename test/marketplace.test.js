import assert from 'node:assert/strict';
import test from 'node:test';
import { EmbedBuilder, MessageFlags } from 'discord.js';
import payCommand, {
  buildPaymentComponents,
  buildPaymentEmbed,
  canManageMarketplace,
} from '../src/commands/Economy/pay.js';
import paymentConfigCommand from '../src/commands/Ticket/payment-config.js';
import vouchCommand from '../src/commands/Ticket/vouch.js';
import paymentButton, {
  formatPaymentDetails,
  formatPaymentNotes,
} from '../src/interactions/buttons/marketplace/payment.js';
import { MemoryStorage } from '../src/utils/memoryStorage.js';
import { db } from '../src/utils/database/wrapper.js';
import {
  getPaymentProfile,
  updatePaymentProfile,
  upsertPaymentMethod,
} from '../src/services/marketplacePaymentService.js';
import {
  adjustSellerMarketplaceStats,
  appendMarketplaceVouchAudit,
  getSellerMarketplaceStats,
  saveMarketplaceVouch,
} from '../src/utils/database/tickets.js';
import { PERK_THEME } from '../src/config/perkTheme.js';
import { MARKETPLACE_SELLER_IDS, MARKETPLACE_SELLER_ROLE_ID } from '../src/config/marketplace.js';
import { parseMarketplaceVouchMessage } from '../src/services/marketplaceVouchHistoryService.js';
import '../src/utils/embeds.js';

function resetDatabase() {
  db.db = new MemoryStorage();
  db.initialized = true;
  db.useFallback = true;
}

test('pay exposes exactly the four approved profile subcommands', () => {
  const command = payCommand.data.toJSON();
  assert.equal(command.default_member_permissions, undefined);
  assert.deepEqual(
    command.options.map(option => option.name),
    ['arii-josi', 'burhan', 'maj', 'flix'],
  );
});

test('demoted sellers are absent from the approved marketplace seller list', () => {
  assert.equal(MARKETPLACE_SELLER_IDS.includes('1417926531577151622'), false);
});

test('vouch exposes submit and self-service stats subcommands', () => {
  const command = vouchCommand.data.toJSON();
  assert.deepEqual(command.options.map(option => option.name), ['submit', 'stats']);
  assert.equal(command.options.find(option => option.name === 'stats').options?.length || 0, 0);
});

test('seller vouch stats defer publicly', async () => {
  resetDatabase();
  let deferOptions = null;
  const interaction = {
    id: 'stats-interaction',
    createdTimestamp: Date.now(),
    guildId: 'guild',
    user: { id: MARKETPLACE_SELLER_IDS[0] },
    replied: false,
    deferred: false,
    options: { getSubcommand: () => 'stats' },
    deferReply: async options => {
      deferOptions = options;
      interaction.deferred = true;
    },
    editReply: async () => {},
  };

  await vouchCommand.execute(interaction, {}, {});
  assert.deepEqual(deferOptions, {});
});

test('historical marketplace vouch embeds are matched to approved sellers', () => {
  const sellerId = MARKETPLACE_SELLER_IDS[0];
  const parsed = parseMarketplaceVouchMessage({
    id: '123456789012345678',
    channelId: '1444261518068682763',
    content: '',
    author: { id: 'bot', bot: true },
    createdAt: new Date('2026-07-01T12:00:00.000Z'),
    url: 'https://discord.com/channels/guild/channel/message',
    embeds: [{
      fields: [
        { name: 'Seller', value: `<@${sellerId}>` },
        { name: 'Buyer', value: '<@111111111111111111>' },
        { name: 'Service', value: 'Purchase' },
        { name: 'Rating', value: '⭐⭐⭐⭐⭐' },
        { name: 'Review', value: 'perfect tysm' },
      ],
      image: { url: 'https://example.com/proof.png' },
    }],
  });

  assert.equal(parsed.record.sellerId, sellerId);
  assert.equal(parsed.record.rating, 5);
  assert.equal(parsed.record.serviceType, 'purchase');
  assert.equal(parsed.record.review, 'perfect tysm');
});

test('historical seller-tagged vouches without ratings are kept as unrated vouches', () => {
  const sellerId = MARKETPLACE_SELLER_IDS[0];
  const parsed = parseMarketplaceVouchMessage({
    id: '223456789012345678',
    channelId: '1444261518068682763',
    content: `vouch for <@${sellerId}> tysm!`,
    author: { id: '111111111111111111', bot: false },
    createdAt: new Date('2026-06-01T12:00:00.000Z'),
    url: 'https://discord.com/channels/guild/channel/message',
    embeds: [],
  });

  assert.equal(parsed.record.sellerId, sellerId);
  assert.equal(parsed.record.rating, null);
});

test('payment configuration exposes simple add and remove commands', () => {
  const command = paymentConfigCommand.data.toJSON();
  assert.deepEqual(command.options.map(option => option.name), ['add', 'remove']);
  assert.deepEqual(
    command.options[0].options.map(option => option.name),
    ['seller', 'payment_type', 'payment_info', 'notes'],
  );
  assert.equal(
    command.options[0].options.find(option => option.name === 'payment_type')
      .choices.some(choice => choice.value === 'crypto'),
    true,
  );
  assert.equal(JSON.stringify(command).includes('custom'), false);
  assert.equal(JSON.stringify(command).includes('method_key'), false);
});

test('central theme brands legacy embeds while preserving custom colors', () => {
  const unstyled = new EmbedBuilder().setTitle('Old embed').toJSON();
  assert.equal(unstyled.color, Number.parseInt(PERK_THEME.colors.general.slice(1), 16));
  assert.equal(unstyled.footer.text, PERK_THEME.footer);

  const legacyError = new EmbedBuilder().setColor('#ED4245').toJSON();
  assert.equal(legacyError.color, Number.parseInt(PERK_THEME.colors.error.slice(1), 16));

  const intentionalCustom = new EmbedBuilder().setColor('#123456').toJSON();
  assert.equal(intentionalCustom.color, 0x123456);
});

test('payment details are absent publicly and ephemeral when revealed', async () => {
  resetDatabase();
  await upsertPaymentMethod('guild', 'arii-josi', {
    methodKey: 'cashapp',
    type: 'cashapp',
    details: '$PrivateHandle',
    notes: 'Confirm first.',
    enabled: true,
  }, 'staff');
  const profile = await getPaymentProfile('guild', 'arii-josi');
  assert.equal(profile.enabled, true);
  const publicPayload = JSON.stringify({
    embed: buildPaymentEmbed(profile).toJSON(),
    components: buildPaymentComponents(profile).map(row => row.toJSON()),
  });
  assert.equal(publicPayload.includes('$PrivateHandle'), false);

  let response = null;
  await paymentButton.execute({
    id: 'interaction',
    createdTimestamp: Date.now(),
    guildId: 'guild',
    user: { id: 'buyer' },
    replied: false,
    deferred: false,
    reply: async payload => {
      response = payload;
      return payload;
    },
  }, {}, ['arii-josi', 'cashapp']);
  assert.equal(response.flags, MessageFlags.Ephemeral);
  assert.equal(JSON.stringify(response).includes('$PrivateHandle'), true);
});

test('payment links are clickable and payment notes are split into lines', () => {
  assert.equal(
    formatPaymentDetails('1. https://cash.app/$first 2. https://cash.app/$second'),
    '1. <https://cash.app/$first>\n2. <https://cash.app/$second>',
  );
  assert.equal(
    formatPaymentDetails('0x123456789abcdef', 'crypto'),
    '```\n0x123456789abcdef\n```',
  );
  assert.equal(
    formatPaymentNotes('$1-5 - twix $5-15 - Mc Donald’s $15-50+ - sushi $50-100 - seafood'),
    '$1-5 - twix\n$5-15 - Mc Donald’s\n$15-50+ - sushi\n$50-100 - seafood',
  );
  assert.equal(
    formatPaymentNotes('first line\\nsecond line'),
    'first line\nsecond line',
  );
});

test('pay publishes the payment menu publicly for customers', async () => {
  resetDatabase();
  await upsertPaymentMethod('guild', 'arii-josi', {
    methodKey: 'cashapp',
    type: 'cashapp',
    details: '$PrivateHandle',
  }, 'staff');

  let response = null;
  await payCommand.execute({
    id: 'interaction',
    createdTimestamp: Date.now(),
    guildId: 'guild',
    user: { id: 'staff' },
    member: {
      permissions: { has: () => true },
      roles: { cache: { has: () => false } },
    },
    options: { getSubcommand: () => 'arii-josi' },
    replied: false,
    deferred: false,
    reply: async payload => {
      response = payload;
      return payload;
    },
  }, {});

  assert.equal(response.ephemeral, false);
  assert.equal(response.flags, undefined);
  assert.equal(JSON.stringify(response).includes('$PrivateHandle'), false);
  assert.equal(response.components.length, 1);
});

test('marketplace permission accepts configured staff and rejects members', () => {
  const config = { ticketStaffRoleId: 'staff-role' };
  assert.equal(canManageMarketplace({
    permissions: { has: () => false },
    roles: { cache: { has: id => id === 'staff-role' } },
  }, config), true);
  assert.equal(canManageMarketplace({
    permissions: { has: () => false },
    roles: { cache: { has: () => false } },
  }, config), false);
  assert.equal(canManageMarketplace({
    permissions: { has: () => false },
    roles: { cache: { has: id => id === MARKETPLACE_SELLER_ROLE_ID } },
  }, config), true);
});

test('vouch transfer and removal deltas keep totals and audit records correct', async () => {
  resetDatabase();
  await adjustSellerMarketplaceStats('guild', 'seller-a', {
    transactionDelta: 1,
    reviewDelta: 1,
    ratingDelta: 5,
  });
  await saveMarketplaceVouch('guild', {
    id: 'vouch-1',
    sellerId: 'seller-a',
    rating: 5,
    review: 'Great.',
  });

  await adjustSellerMarketplaceStats('guild', 'seller-a', {
    transactionDelta: -1,
    reviewDelta: -1,
    ratingDelta: -5,
  });
  await adjustSellerMarketplaceStats('guild', 'seller-b', {
    transactionDelta: 1,
    reviewDelta: 1,
    ratingDelta: 5,
  });
  assert.equal((await getSellerMarketplaceStats('guild', 'seller-a')).totalReviews, 0);
  assert.equal((await getSellerMarketplaceStats('guild', 'seller-b')).averageRating, 5);

  const audit = await appendMarketplaceVouchAudit('guild', {
    action: 'transfer',
    vouchId: 'vouch-1',
    staffId: 'staff',
    reason: 'Wrong seller.',
  });
  assert.equal(audit.action, 'transfer');
  assert.equal(audit.reason, 'Wrong seller.');
});
