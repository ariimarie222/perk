// embeds.js

import { EmbedBuilder } from 'discord.js';
import { getColor, botConfig } from '../config/bot.js';
import { PERK_THEME, getPerkColor, normalizePerkColor } from '../config/perkTheme.js';

const EMBED_FOOTER_SYMBOL = Symbol('titanbotFooterText');
const EMBED_BASE_DESCRIPTION_SYMBOL = Symbol('titanbotBaseDescription');

function sanitizeEmbedText(text = '') {
  if (typeof text !== 'string') {
    return text;
  }

  return text
    .replace(/[ \t]+/g, ' ')  // Replace consecutive spaces/tabs with single space
    .replace(/[ \t]\n/g, '\n')  // Remove spaces before newlines
    .replace(/\n[ \t]/g, '\n')  // Remove spaces after newlines
    .replace(/\n{3,}/g, '\n\n')  // Limit consecutive newlines to 2
    .trim();
}

function sanitizeEmbedField(field) {
  if (!field || typeof field !== 'object') {
    return field;
  }

  return {
    ...field,
    name: sanitizeEmbedText(field.name),
    value: sanitizeEmbedText(field.value),
  };
}

const originalSetTitle = EmbedBuilder.prototype.setTitle;
const originalSetAuthor = EmbedBuilder.prototype.setAuthor;
const originalAddFields = EmbedBuilder.prototype.addFields;

EmbedBuilder.prototype.setTitle = function setSanitizedTitle(title) {
  return originalSetTitle.call(this, sanitizeEmbedText(title));
};

EmbedBuilder.prototype.setAuthor = function setSanitizedAuthor(author) {
  if (typeof author === 'string') {
    return originalSetAuthor.call(this, sanitizeEmbedText(author));
  }

  if (author && typeof author.name === 'string') {
    return originalSetAuthor.call(this, {
      ...author,
      name: sanitizeEmbedText(author.name),
    });
  }

  return originalSetAuthor.call(this, author);
};

EmbedBuilder.prototype.addFields = function addSanitizedFields(...fields) {
  const normalized = fields.flatMap((field) => (Array.isArray(field) ? field : [field]));
  const sanitized = normalized.map(sanitizeEmbedField);
  return originalAddFields.call(this, sanitized);
};

function normalizeFooterText(footer) {
  if (!footer) {
    return '';
  }

  if (typeof footer === 'string') {
    return footer.trim();
  }

  if (footer && typeof footer.text === 'string') {
    return footer.text.trim();
  }

  return '';
}

function isImportantFooter(footerText) {
  if (!footerText) {
    return false;
  }

  const normalized = footerText.toLowerCase();
  return /\b(close|closes|closed|expire|expires|available in|page\s+\d+|dashboard closes|ticket id)\b/.test(normalized);
}

const originalSetDescription = EmbedBuilder.prototype.setDescription;
const originalSetFooter = EmbedBuilder.prototype.setFooter;
const originalSetTimestamp = EmbedBuilder.prototype.setTimestamp;
const originalSetColor = EmbedBuilder.prototype.setColor;
const originalToJSON = EmbedBuilder.prototype.toJSON;

EmbedBuilder.prototype.setColor = function setPerkColor(color) {
  return originalSetColor.call(this, normalizePerkColor(color));
};

EmbedBuilder.prototype.toJSON = function toPerkJSON(validationOverride) {
  if (this.data?.color == null) {
    originalSetColor.call(this, getPerkColor('general'));
  } else {
    const normalized = normalizePerkColor(this.data.color);
    if (normalized !== this.data.color) originalSetColor.call(this, normalized);
  }
  if (!this.data?.footer) {
    originalSetFooter.call(this, {
      text: PERK_THEME.footer,
      ...(PERK_THEME.footerIcon ? { iconURL: PERK_THEME.footerIcon } : {}),
    });
  }
  return originalToJSON.call(this, validationOverride);
};

EmbedBuilder.prototype.setDescription = function(description = '') {
  const descString = sanitizeEmbedText(description || '');
  this[EMBED_BASE_DESCRIPTION_SYMBOL] = descString;
  return originalSetDescription.call(this, descString);
};

EmbedBuilder.prototype.setFooter = function(footer) {
  const footerText = sanitizeEmbedText(normalizeFooterText(footer));
  if (!footerText) {
    return this;
  }

  this[EMBED_FOOTER_SYMBOL] = footerText;
  const iconURL = typeof footer === 'object' ? footer.iconURL : null;
  return originalSetFooter.call(this, { text: footerText, ...(iconURL ? { iconURL } : {}) });
};

EmbedBuilder.prototype.setTimestamp = function(timestamp) {
  return originalSetTimestamp.call(this, timestamp);
};

export function createEmbed({
  title = '',
  description = '',
  color = 'primary',
  fields = [],
  author = null,
  footer = null,
  thumbnail = null,
  image = null,
  timestamp = false,
  url = null
} = {}) {
  const embed = new EmbedBuilder();

  if (title && typeof title === 'string' && title.length > 0) {
    embed.setTitle(title.substring(0, 256));
  }

  if (description && typeof description === 'string' && description.length > 0) {
    embed.setDescription(description.substring(0, 4096));
  }

  try {
    embed.setColor(getColor(color, getPerkColor(color)));
  } catch (error) {
    embed.setColor('#000000');
  }

  if (Array.isArray(fields) && fields.length > 0) {
    const validFields = fields.filter(f => f && f.name && f.value);
    if (validFields.length > 0) {
      embed.addFields(validFields.slice(0, 25)); 
    }
  }

  if (author) {
    try {
      if (typeof author === 'string' && author.length > 0) {
        embed.setAuthor({ name: author.substring(0, 256) });
      } else if (author && typeof author.name === 'string') {
        embed.setAuthor(author);
      }
    } catch (error) {
      
    }
  } else if (botConfig.embeds?.author?.name) {
    embed.setAuthor({
      name: botConfig.embeds.author.name,
      ...(botConfig.embeds.author.icon ? { iconURL: botConfig.embeds.author.icon } : {}),
      ...(botConfig.embeds.author.url ? { url: botConfig.embeds.author.url } : {}),
    });
  }

  if (footer) {
    try {
      if (typeof footer === 'string' && footer.length > 0) {
        embed.setFooter({ text: footer.substring(0, 2048) });
      } else if (footer && typeof footer.text === 'string') {
        embed.setFooter(footer);
      }
    } catch (error) {
      
    }
  } else {
    const defaultFooter = {
      text: PERK_THEME.footer,
      ...(PERK_THEME.footerIcon ? { iconURL: PERK_THEME.footerIcon } : {}),
    };
    embed.setFooter(defaultFooter);
  }

  if (thumbnail) {
    try {
      if (typeof thumbnail === 'string' && thumbnail.length > 0) {
        embed.setThumbnail(thumbnail);
      } else if (thumbnail && typeof thumbnail.url === 'string') {
        embed.setThumbnail(thumbnail.url);
      }
    } catch (error) {
      
    }
  } else if (PERK_THEME.logo || botConfig.embeds?.thumbnail) {
    embed.setThumbnail(PERK_THEME.logo || botConfig.embeds.thumbnail);
  }

  if (image) {
    try {
      if (typeof image === 'string' && image.length > 0) {
        embed.setImage(image);
      } else if (image && typeof image.url === 'string') {
        embed.setImage(image.url);
      }
    } catch (error) {
      
    }
  }

  if (timestamp === true) {
    embed.setTimestamp();
  } else if (timestamp instanceof Date) {
    embed.setTimestamp(timestamp);
  }

  if (url && typeof url === 'string' && url.length > 0) {
    try {
      embed.setURL(url);
    } catch (error) {
      
    }
  }

  return embed;
}

const NOTIFICATION_DEFAULT_TITLES = {
  success: '✨ Action completed successfully!',
  error: '⚠️ Something went wrong',
  info: '💕 Perk information',
  warning: '🌷 Please note',
  primary: '🌸 Perk update',
};

export const USER_ERROR_TITLES = {
  validation: 'Invalid Input',
  permission: 'Permission Denied',
  configuration: 'Configuration Error',
  database: 'Database Error',
  network: 'Network Error',
  discord_api: 'Discord API Error',
  user_input: 'Input Error',
  rate_limit: 'Too Fast',
  unknown: 'Something Went Wrong',
};

const USER_ERROR_COLORS = {
  rate_limit: 'warning',
};

/**
 * Build a consistent user-facing error embed.
 * @param {string} errorType - Error category key (e.g. validation, permission)
 * @param {string} [description] - Specific, actionable message for the user
 * @param {{ titleOverride?: string }} [options]
 */
export function buildUserErrorEmbed(errorType, description = '', options = {}) {
  const type = errorType || 'unknown';
  const title = options.titleOverride || USER_ERROR_TITLES[type] || USER_ERROR_TITLES.unknown;
  const color = USER_ERROR_COLORS[type] || 'error';
  const body = description ? String(description).trim() : undefined;

  return createEmbed({
    title,
    description: body,
    color,
  });
}

function containsDiscordRenderable(content = '') {
  return /<@!?&?\d+>|<#\d+>|\b\d{17,19}\b/.test(String(content));
}

function buildNotificationEmbed(title, body = '', color = 'primary') {
  const defaultTitle = NOTIFICATION_DEFAULT_TITLES[color] || NOTIFICATION_DEFAULT_TITLES.primary;
  let titleText = String(title || '').trim();
  let bodyText = body ? String(body).trim() : '';

  if (titleText && containsDiscordRenderable(titleText)) {
    bodyText = bodyText ? `${titleText}\n\n${bodyText}` : titleText;
    titleText = defaultTitle;
  }

  return createEmbed({
    title: titleText || defaultTitle,
    description: bodyText || undefined,
    color,
  });
}

/**
 * @deprecated Prefer buildUserErrorEmbed or replyUserError from errorHandler.js.
 */
export function errorEmbed(title, detail = null, options = {}) {
  const { showDetails = process.env.NODE_ENV !== 'production' } = options;
  let body = detail;

  if (detail && showDetails && typeof detail !== 'string') {
    const detailText = detail.message || String(detail);
    body = formatCodeBlock(detailText);
  }

  const description = body ? String(body).trim() : '';
  const titleOverride = title && title !== 'Error' ? title : undefined;

  return buildUserErrorEmbed('unknown', description, { titleOverride });
}

/** @param {string} titleOrBody - With one arg: body text. With two args: title and body. */
export function successEmbed(title, body = '') {
  if (arguments.length === 1) {
    return buildNotificationEmbed('Success', title, 'success');
  }

  return buildNotificationEmbed(title || 'Success', body, 'success');
}

/** @param {string} titleOrBody - With one arg: body text. With two args: title and body. */
export function infoEmbed(title, body = '') {
  if (arguments.length === 1) {
    return buildNotificationEmbed('Information', title, 'info');
  }

  return buildNotificationEmbed(title || 'Information', body, 'info');
}

/** @param {string} titleOrBody - With one arg: body text. With two args: title and body. */
export function warningEmbed(title, body = '') {
  if (arguments.length === 1) {
    return buildNotificationEmbed('Warning', title, 'warning');
  }

  return buildNotificationEmbed(title || 'Warning', body, 'warning');
}

export function createPerkEmbed(options = {}) {
  return createEmbed({ ...options, color: options.color || 'general' });
}

export function createSuccessEmbed(titleOrBody, body = '') {
  return arguments.length === 1
    ? createEmbed({ title: '✨ Action completed successfully!', description: titleOrBody, color: 'success' })
    : createEmbed({ title: titleOrBody, description: body, color: 'success' });
}

export function createErrorEmbed(titleOrBody, body = '') {
  return arguments.length === 1
    ? createEmbed({ title: '⚠️ Something went wrong', description: titleOrBody, color: 'error' })
    : createEmbed({ title: titleOrBody, description: body, color: 'error' });
}

export function createWarningEmbed(titleOrBody, body = '') {
  return arguments.length === 1
    ? createEmbed({ title: '🌷 Please note', description: titleOrBody, color: 'warning' })
    : createEmbed({ title: titleOrBody, description: body, color: 'warning' });
}

export function createInfoEmbed(options = {}) {
  if (typeof options === 'string') return createEmbed({ title: '💕 Perk information', description: options, color: 'important' });
  return createEmbed({ ...options, color: options.color || 'important' });
}

export function createMarketplaceEmbed(options = {}) {
  return createEmbed({ ...options, color: 'marketplace' });
}

export function createModerationEmbed(options = {}) {
  return createEmbed({ ...options, color: 'moderation' });
}

export function formatUser(user) {
  return `${user} (${user.tag} | ${user.id})`;
}

export function formatDate(date) {
  return `<t:${Math.floor(date.getTime() / 1000)}:F>`;
}

export function formatRelativeTime(date) {
  return `<t:${Math.floor(date.getTime() / 1000)}:R>`;
}

export function formatCodeBlock(content, language = '') {
  return `\`\`\`${language}\n${content}\n\`\`\``;
}

export function formatInlineCode(content) {
  return `\`${content}\``;
}

export function formatBold(content) {
  return `**${content}**`;
}

export function formatItalic(content) {
  return `*${content}*`;
}

export function formatUnderline(content) {
  return `__${content}__`;
}

export function formatStrikethrough(content) {
  return `~~${content}~~`;
}

export function formatSpoiler(content) {
  return `||${content}||`;
}

export function formatQuote(content) {
  return `> ${content}`;
}

export function formatList(items, ordered = false) {
  return items
    .map((item, index) => (ordered ? `${index + 1}.` : '•') + `${item}`)
    .join('\n');
}

export function formatDuration(ms) {
  if (ms < 0) return '0s';

  const seconds = Math.floor(ms / 1000) % 60;
  const minutes = Math.floor(ms / (1000 * 60)) % 60;
  const hours = Math.floor(ms / (1000 * 60 * 60)) % 24;
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);

  return parts.join('');
}

export function formatProgressBar(current, max, size = 10) {
  const progress = Math.min(Math.max(0, current / max), 1);
  const filled = Math.round(size * progress);
  const empty = size - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${Math.round(progress * 100)}%`;
}
