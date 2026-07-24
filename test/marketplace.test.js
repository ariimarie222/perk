import assert from 'node:assert/strict';
import test from 'node:test';
import { EmbedBuilder, MessageFlags, PermissionFlagsBits } from 'discord.js';
import payCommand, {
  buildPaymentComponents,
  buildPaymentEmbed,
  canManageMarketplace,
} from '../src/commands/Economy/pay.js';
import paymentButton from '../src/interactions/buttons/marketplace/payment.js';
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
import '../src/utils/embeds.js';

function resetDatabase() {
  db.db = new MemoryStorage();
  db.initialized = true;
  db.useFallback = true;
}

test('pay exposes exactly the five approved profile subcommands', () => {
  const command = payCommand.data.toJSON();
  assert.equal(command.default_member_permissions, String(PermissionFlagsBits.ManageChannels));
  assert.deepEqual(
    command.options.map(option => option.name),
    ['arii-josi', 'burhan', 'maj', 'flix', 'cici'],
  );
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
  await updatePaymentProfile('guild', 'arii-josi', { enabled: true }, 'staff');
  await upsertPaymentMethod('guild', 'arii-josi', {
    methodKey: 'cashapp',
    type: 'cashapp',
    details: '$PrivateHandle',
    notes: 'Confirm first.',
    enabled: true,
  }, 'staff');
  const profile = await getPaymentProfile('guild', 'arii-josi');
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
