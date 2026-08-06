import assert from 'node:assert/strict';
import test from 'node:test';
import botCommand from '../src/commands/Ticket/bot.js';
import customBotOrderModal from '../src/interactions/modals/customBotOrder.js';
import { readFile } from 'node:fs/promises';

test('custom bot order command exposes the begin form flow', () => {
  const command = botCommand.data.toJSON();
  assert.equal(command.name, 'bot');
  assert.deepEqual(command.options.map(option => option.name), ['begin']);
  assert.equal(customBotOrderModal.name, 'bot_order_modal');
});

test('custom bot ticket selection skips the duplicate pre-ticket order modal', async () => {
  const source = await readFile(new URL('../src/handlers/ticketButtons.js', import.meta.url), 'utf8');
  assert.match(source, /createCustomBotTicketFromSelection\(interaction\)/);
  assert.doesNotMatch(source, /openCreateTicketModal\(interaction, ticketType, CUSTOM_BOT_OWNER_ID\)/);
});
