import assert from 'node:assert/strict';
import test from 'node:test';
import botCommand from '../src/commands/Ticket/bot.js';
import customBotOrderModal from '../src/interactions/modals/customBotOrder.js';

test('custom bot order command exposes the begin form flow', () => {
  const command = botCommand.data.toJSON();
  assert.equal(command.name, 'bot');
  assert.deepEqual(command.options.map(option => option.name), ['begin']);
  assert.equal(customBotOrderModal.name, 'bot_order_modal');
});

