import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('ticket intake collects payment method for marketplace tickets', async () => {
  const source = await readFile(new URL('../src/handlers/ticketButtons.js', import.meta.url), 'utf8');

  assert.match(source, /setCustomId\('payment_method'\)/);
  assert.match(source, /\['purchase', 'cashout', 'middleman', 'preorder'\]\.includes\(ticketType\)/);
  assert.match(source, /getTextInputValue\('payment_method'\)/);
});

test('new ticket embeds use the compact customer-facing layout', async () => {
  const source = await readFile(new URL('../src/services/ticket.js', import.meta.url), 'utf8');
  const createSection = source.slice(
    source.indexOf('const embed = createEmbed({'),
    source.indexOf('const row = buildTicketControlRow', source.indexOf('const embed = createEmbed({')),
  );

  assert.match(createSection, /name: 'Reason'/);
  assert.match(createSection, /name: 'Payment Method'/);
  assert.match(createSection, /name: 'Service Type'/);
  assert.match(createSection, /name: 'Claimed By'/);
  assert.match(createSection, /name: 'Requested Seller'/);
  assert.doesNotMatch(createSection, /name: 'Status'/);
  assert.doesNotMatch(createSection, /name: 'Seller'/);
  assert.doesNotMatch(createSection, /name: 'Created'/);
  assert.match(createSection, /thumbnail: TICKET_SIDE_EMOJI_URL/);
});
