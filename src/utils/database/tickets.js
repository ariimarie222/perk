import { logger } from '../logger.js';
import { Mutex } from '../mutex.js';
import { db, getFromDb } from './wrapper.js';
import {
    getMarketplaceVouchAuditKey,
    getMarketplaceVouchKey,
    getMarketplaceVouchesPrefix,
    getSellerMarketplaceStatsKey,
    getTicketCounterKey,
    getTicketKey,
} from './keys.js';

export { getTicketKey, getTicketCounterKey } from './keys.js';

export async function getTicketData(guildId, channelId) {
    if (!db.initialized) {
        await db.initialize();
    }

    const key = getTicketKey(guildId, channelId);
    return await db.get(key);
}

export async function getOpenTicketCountForUser(guildId, userId) {
    try {
        if (!db.initialized) {
            await db.initialize();
        }

        if (db.db?.pool && typeof db.db.isAvailable === 'function' && db.db.isAvailable()) {
            const { pgConfig } = await import('../../config/database/postgres.js');
            const result = await db.db.pool.query(
                `SELECT COUNT(*)::int AS count FROM ${pgConfig.tables.tickets}
                 WHERE guild_id = $1
                   AND data->>'userId' = $2
                   AND data->>'status' = 'open'`,
                [guildId, userId],
            );

            return Number(result.rows?.[0]?.count || 0);
        }

        if (typeof db.list === 'function') {
            const ticketKeys = await db.list(`guild:${guildId}:ticket:`);
            let count = 0;

            for (const key of ticketKeys) {
                if (key.endsWith(':counter')) continue;
                const ticket = await getFromDb(key, null);
                if (ticket && ticket.userId === userId && ticket.status === 'open') {
                    count += 1;
                }
            }

            return count;
        }

        return 0;
    } catch (error) {
        logger.error(`Error counting open tickets for user ${userId} in guild ${guildId}:`, error);
        return 0;
    }
}

export async function saveTicketData(guildId, channelId, data) {
    if (!db.initialized) {
        await db.initialize();
    }

    const key = getTicketKey(guildId, channelId);
    await db.set(key, data);
}

export async function deleteTicketData(guildId, channelId) {
    if (!db.initialized) {
        await db.initialize();
    }

    const key = getTicketKey(guildId, channelId);
    await db.delete(key);
}

export async function getTicketCounter(guildId) {
    if (!db.initialized) {
        await db.initialize();
    }

    const key = getTicketCounterKey(guildId);
    const counter = await db.get(key);
    return counter || 0;
}

export async function incrementTicketCounter(guildId) {
    if (!db.initialized) {
        await db.initialize();
    }

    const key = getTicketCounterKey(guildId);
    const currentCounter = await getTicketCounter(guildId);
    const nextCounter = currentCounter + 1;

    await db.set(key, nextCounter);

    return nextCounter.toString().padStart(3, '0');
}

export async function getSellerMarketplaceStats(guildId, sellerId) {
    if (!db.initialized) {
        await db.initialize();
    }

    const stats = await db.get(getSellerMarketplaceStatsKey(guildId, sellerId), {
        sellerId,
        completedTransactions: 0,
        totalReviews: 0,
        ratedReviews: 0,
        ratingTotal: 0,
        averageRating: null,
    });
    return {
        ...stats,
        ratedReviews: Number(stats.ratedReviews ?? stats.totalReviews ?? 0),
    };
}

export async function recordSellerMarketplaceReview(guildId, sellerId, rating) {
    if (!db.initialized) {
        await db.initialize();
    }

    return Mutex.runExclusive(`marketplace-stats:${guildId}:${sellerId}`, async () => {
        const current = await getSellerMarketplaceStats(guildId, sellerId);
        const totalReviews = Number(current.totalReviews || 0) + 1;
        const ratedReviews = Number(current.ratedReviews ?? current.totalReviews ?? 0) + 1;
        const ratingTotal = Number(current.ratingTotal || 0) + Number(rating);
        const stats = {
            sellerId,
            completedTransactions: Number(current.completedTransactions || 0) + 1,
            totalReviews,
            ratedReviews,
            ratingTotal,
            averageRating: Math.round((ratingTotal / ratedReviews) * 100) / 100,
            updatedAt: new Date().toISOString(),
        };

        await db.set(getSellerMarketplaceStatsKey(guildId, sellerId), stats);
        return stats;
    });
}

export async function setSellerMarketplaceStats(guildId, sellerId, {
    completedTransactions = 0,
    totalReviews = 0,
    ratedReviews = totalReviews,
    ratingTotal = 0,
} = {}) {
    if (!db.initialized) await db.initialize();
    return Mutex.runExclusive(`marketplace-stats:${guildId}:${sellerId}`, async () => {
        const normalizedTransactions = Math.max(0, Number(completedTransactions) || 0);
        const normalizedReviews = Math.max(0, Number(totalReviews) || 0);
        const normalizedRatedReviews = Math.min(normalizedReviews, Math.max(0, Number(ratedReviews) || 0));
        const normalizedRatingTotal = Math.max(0, Number(ratingTotal) || 0);
        const stats = {
            sellerId,
            completedTransactions: normalizedTransactions,
            totalReviews: normalizedReviews,
            ratedReviews: normalizedRatedReviews,
            ratingTotal: normalizedRatingTotal,
            averageRating: normalizedRatedReviews > 0
                ? Math.round((normalizedRatingTotal / normalizedRatedReviews) * 100) / 100
                : null,
            updatedAt: new Date().toISOString(),
        };
        await db.set(getSellerMarketplaceStatsKey(guildId, sellerId), stats);
        return stats;
    });
}

export async function adjustSellerMarketplaceStats(guildId, sellerId, {
    transactionDelta = 0,
    reviewDelta = 0,
    ratingCountDelta = reviewDelta,
    ratingDelta = 0,
} = {}) {
    if (!db.initialized) await db.initialize();
    return Mutex.runExclusive(`marketplace-stats:${guildId}:${sellerId}`, async () => {
        const current = await getSellerMarketplaceStats(guildId, sellerId);
        const completedTransactions = Math.max(0, Number(current.completedTransactions || 0) + Number(transactionDelta));
        const totalReviews = Math.max(0, Number(current.totalReviews || 0) + Number(reviewDelta));
        const ratedReviews = Math.min(totalReviews, Math.max(0, Number(current.ratedReviews ?? current.totalReviews ?? 0) + Number(ratingCountDelta)));
        const ratingTotal = Math.max(0, Number(current.ratingTotal || 0) + Number(ratingDelta));
        const stats = {
            sellerId,
            completedTransactions,
            totalReviews,
            ratedReviews,
            ratingTotal,
            averageRating: ratedReviews > 0 ? Math.round((ratingTotal / ratedReviews) * 100) / 100 : null,
            updatedAt: new Date().toISOString(),
        };
        await db.set(getSellerMarketplaceStatsKey(guildId, sellerId), stats);
        return stats;
    });
}

export async function saveMarketplaceVouch(guildId, vouch) {
    if (!db.initialized) await db.initialize();
    const id = String(vouch.id || vouch.vouchMessageId || '');
    if (!id) throw new Error('A vouch ID is required.');
    const record = { ...vouch, id, guildId, updatedAt: new Date().toISOString() };
    await db.set(getMarketplaceVouchKey(guildId, id), record);
    return record;
}

export async function getMarketplaceVouch(guildId, vouchId) {
    if (!db.initialized) await db.initialize();
    return db.get(getMarketplaceVouchKey(guildId, vouchId));
}

export async function findMarketplaceVouch(guildId, vouchId) {
    const stored = await getMarketplaceVouch(guildId, vouchId);
    if (stored) return stored;

    const tickets = await listGuildTickets(guildId);
    const ticket = tickets.find(item =>
        String(item?.marketplaceReview?.vouchMessageId || '') === String(vouchId),
    );
    if (!ticket?.marketplaceReview) return null;

    const review = ticket.marketplaceReview;
    return saveMarketplaceVouch(guildId, {
        id: String(vouchId),
        guildId,
        sellerId: review.sellerId || ticket.sellerId,
        buyerId: review.buyerId || ticket.userId,
        serviceType: review.serviceType || ticket.serviceType,
        rating: review.rating,
        review: review.review,
        proofUrl: review.image?.url,
        submittedAt: review.submittedAt,
        transactionReference: ticket.id || ticket.channelId,
        ticketChannelId: ticket.id || ticket.channelId,
        vouchMessageId: review.vouchMessageId,
        vouchChannelId: review.vouchChannelId,
        source: 'ticket',
        importedFromTicket: true,
    });
}

export async function deleteMarketplaceVouch(guildId, vouchId) {
    if (!db.initialized) await db.initialize();
    await db.delete(getMarketplaceVouchKey(guildId, vouchId));
}

export async function listMarketplaceVouches(guildId) {
    if (!db.initialized) await db.initialize();
    if (typeof db.list !== 'function') return [];
    const keys = await db.list(getMarketplaceVouchesPrefix(guildId));
    const records = await Promise.all(keys.map(key => getFromDb(key, null)));
    return records.filter(Boolean);
}

export async function appendMarketplaceVouchAudit(guildId, entry) {
    if (!db.initialized) await db.initialize();
    return Mutex.runExclusive(`marketplace-vouch-audit:${guildId}`, async () => {
        const key = getMarketplaceVouchAuditKey(guildId);
        const current = await db.get(key, []);
        const entries = Array.isArray(current) ? current : [];
        entries.push({
            ...entry,
            guildId,
            timestamp: entry.timestamp || new Date().toISOString(),
        });
        await db.set(key, entries.slice(-2000));
        return entries.at(-1);
    });
}

async function listGuildTickets(guildId) {
    if (!db.initialized) {
        await db.initialize();
    }

    if (db.db?.pool && typeof db.db.isAvailable === 'function' && db.db.isAvailable()) {
        const { pgConfig } = await import('../../config/database/postgres.js');
        const result = await db.db.pool.query(
            `SELECT data FROM ${pgConfig.tables.tickets} WHERE guild_id = $1`,
            [guildId],
        );
        return result.rows.map((row) => row.data).filter(Boolean);
    }

    if (typeof db.list !== 'function') {
        return [];
    }

    const ticketKeys = await db.list(`guild:${guildId}:ticket:`);
    const tickets = [];

    for (const key of ticketKeys) {
        if (key.endsWith(':counter')) continue;
        const ticket = await getFromDb(key, null);
        if (ticket) tickets.push(ticket);
    }

    return tickets;
}

export async function getGuildTicketStats(guildId) {
    try {
        const tickets = await listGuildTickets(guildId);
        let openCount = 0;
        let closedCount = 0;
        let totalCloseMs = 0;
        let closeSamples = 0;
        let feedbackCount = 0;
        let ratingSum = 0;

        for (const ticket of tickets) {
            if (ticket.status === 'open') {
                openCount += 1;
            } else if (ticket.status === 'closed') {
                closedCount += 1;
                if (ticket.createdAt && ticket.closedAt) {
                    const duration = new Date(ticket.closedAt) - new Date(ticket.createdAt);
                    if (Number.isFinite(duration) && duration >= 0) {
                        totalCloseMs += duration;
                        closeSamples += 1;
                    }
                }
            }

            const rating = ticket.feedback?.rating;
            if (rating != null && Number.isFinite(Number(rating))) {
                feedbackCount += 1;
                ratingSum += Number(rating);
            }
        }

        return {
            openCount,
            closedCount,
            avgCloseTimeMs: closeSamples > 0 ? Math.round(totalCloseMs / closeSamples) : null,
            feedbackCount,
            avgRating: feedbackCount > 0 ? Math.round((ratingSum / feedbackCount) * 10) / 10 : null,
        };
    } catch (error) {
        logger.error(`Error computing ticket stats for guild ${guildId}:`, error);
        return {
            openCount: 0,
            closedCount: 0,
            avgCloseTimeMs: null,
            feedbackCount: 0,
            avgRating: null,
        };
    }
}
