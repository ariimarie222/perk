import assert from 'node:assert/strict';
import test from 'node:test';
import botShopCommand, {
  buildCustomBotPackagesEmbed,
  buildCustomBotSystemsEmbed,
} from '../src/commands/Ticket/bot-shop.js';
import {
  CUSTOM_BOT_OWNER_ID,
  CUSTOM_BOT_PACKAGES,
  CUSTOM_BOT_SYSTEMS,
} from '../src/config/customBotShop.js';

test('custom bot shop command exposes the expected packages and systems', () => {
  assert.equal(botShopCommand.data.toJSON().name, 'bot-shop');
  assert.equal(CUSTOM_BOT_OWNER_ID, '900918516855742497');
  assert.equal(CUSTOM_BOT_PACKAGES.length, 5);
  assert.equal(CUSTOM_BOT_SYSTEMS.length, 15);

  const packages = buildCustomBotPackagesEmbed().toJSON();
  const systems = buildCustomBotSystemsEmbed().toJSON();
  const rendered = JSON.stringify([packages, systems]);
  assert.equal(packages.title, '🎀 Arii’s Custom Bots');
  assert.equal(systems.title, '🌷 Systems & Features');
  assert.equal(rendered.includes('—'), false);
  assert.equal(rendered.includes('–'), false);
});
