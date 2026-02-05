require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionsBitField, Events, MessageFlags, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } = require('discord.js');
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('crypto');
const fs = require('node:fs');
const path = require('node:path');

const configDb = new DatabaseSync('config.db');
const trackingDb = new DatabaseSync('tracking.db');
configDb.exec('PRAGMA foreign_keys = ON;');
trackingDb.exec('PRAGMA foreign_keys = ON;');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

// --- CONFIGURATION ---
const SUPPORT_URL = 'https://morrowshore.com';
const ADMIN_ROLE_IDS = ['967515235722358784', '968022066290913290'];
const ADMIN_USER_IDS = ['1103986864861478912', '1103958491015688282', '229315532283838464'];
const DEFAULT_EXPIRY_DAYS = 7;
const DEFAULT_COOLDOWN_DAYS = 3;

// --- DATABASE SETUP ---
const tryExec = (db, sql) => {
    try {
        db.exec(sql);
    } catch (error) {
        // Ignore migration errors (e.g., column already exists)
    }
};

configDb.exec(`
  CREATE TABLE IF NOT EXISTS roles (
    type TEXT NOT NULL,
    role_id TEXT NOT NULL,
    PRIMARY KEY (type, role_id)
  );
  CREATE TABLE IF NOT EXISTS categories (
    category_id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    approve_mode INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS category_targets (
    category_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    PRIMARY KEY (category_id, channel_id),
    FOREIGN KEY (category_id) REFERENCES categories(category_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS category_reports (
    category_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    PRIMARY KEY (category_id, channel_id),
    FOREIGN KEY (category_id) REFERENCES categories(category_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS debug_channels (
    channel_id TEXT PRIMARY KEY
  );
  CREATE TABLE IF NOT EXISTS guild_bans (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    banned_at INTEGER NOT NULL,
    banned_by TEXT,
    reason TEXT,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS category_bans (
    category_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    banned_at INTEGER NOT NULL,
    banned_by TEXT,
    reason TEXT,
    PRIMARY KEY (category_id, user_id),
    FOREIGN KEY (category_id) REFERENCES categories(category_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS channel_policies (
    channel_id TEXT PRIMARY KEY,
    expiry_days INTEGER,
    cooldown_days INTEGER
  );
  CREATE TABLE IF NOT EXISTS config_meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

trackingDb.exec(`
  CREATE TABLE IF NOT EXISTS gigs (
    gig_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    category_id TEXT,
    channel_id_created_in TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'approved'
  );
  CREATE TABLE IF NOT EXISTS gig_payloads (
    gig_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    pay TEXT NOT NULL,
    timeline TEXT,
    FOREIGN KEY (gig_id) REFERENCES gigs(gig_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS gig_instances (
    message_id TEXT PRIMARY KEY,
    gig_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (gig_id) REFERENCES gigs(gig_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS rate_limits (
    user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    last_post_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, channel_id)
  );
  CREATE TABLE IF NOT EXISTS applications (
    gig_id TEXT NOT NULL,
    applicant_id TEXT NOT NULL,
    PRIMARY KEY (gig_id, applicant_id),
    FOREIGN KEY (gig_id) REFERENCES gigs(gig_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS reports (
    gig_id TEXT NOT NULL,
    reporter_id TEXT NOT NULL,
    PRIMARY KEY (gig_id, reporter_id),
    FOREIGN KEY (gig_id) REFERENCES gigs(gig_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS cleanup_log (
    run_at INTEGER NOT NULL,
    deleted_gigs INTEGER,
    deleted_instances INTEGER
  );
`);

tryExec(configDb, 'ALTER TABLE categories ADD COLUMN approve_mode INTEGER DEFAULT 0;');
tryExec(trackingDb, 'ALTER TABLE gigs ADD COLUMN status TEXT NOT NULL DEFAULT "approved";');

// --- HELPER FUNCTIONS ---
const ROLE_TYPES = {
    MODERATOR: 'moderator',
    APPLICANT: 'applicant',
    DIRECT_APPLICANT: 'direct_applicant',
    CREATOR: 'creator'
};

const parseIdList = (value) =>
    (value || '')
        .split(',')
        .map(v => v.trim())
        .filter(Boolean);

// Config is managed via commands; no seeding from .env beyond DISCORD_TOKEN.

const configCache = {
    lastLoaded: 0,
    ttlMs: 15 * 1000,
    roles: new Map(),
    categories: new Map(),
    categoryTargets: new Map(),
    categoryReports: new Map(),
    channelPolicies: new Map(),
    debugChannels: new Set()
};

const loadConfig = (force = false) => {
    const now = Date.now();
    if (!force && now - configCache.lastLoaded < configCache.ttlMs) return;

    configCache.roles.clear();
    configCache.categories.clear();
    configCache.categoryTargets.clear();
    configCache.categoryReports.clear();
    configCache.channelPolicies.clear();
    configCache.debugChannels.clear();

    for (const { type, role_id } of configDb.prepare('SELECT type, role_id FROM roles').all()) {
        if (!configCache.roles.has(type)) configCache.roles.set(type, new Set());
        configCache.roles.get(type).add(role_id);
    }

    for (const { category_id, name, approve_mode } of configDb.prepare('SELECT category_id, name, approve_mode FROM categories').all()) {
        configCache.categories.set(category_id, { name, approveMode: Boolean(approve_mode) });
    }

    for (const { category_id, channel_id } of configDb.prepare('SELECT category_id, channel_id FROM category_targets').all()) {
        if (!configCache.categoryTargets.has(category_id)) configCache.categoryTargets.set(category_id, new Set());
        configCache.categoryTargets.get(category_id).add(channel_id);
    }

    for (const { category_id, channel_id } of configDb.prepare('SELECT category_id, channel_id FROM category_reports').all()) {
        if (!configCache.categoryReports.has(category_id)) configCache.categoryReports.set(category_id, new Set());
        configCache.categoryReports.get(category_id).add(channel_id);
    }

    for (const { channel_id, expiry_days, cooldown_days } of configDb.prepare('SELECT channel_id, expiry_days, cooldown_days FROM channel_policies').all()) {
        configCache.channelPolicies.set(channel_id, { expiryDays: expiry_days, cooldownDays: cooldown_days });
    }

    for (const { channel_id } of configDb.prepare('SELECT channel_id FROM debug_channels').all()) {
        configCache.debugChannels.add(channel_id);
    }

    configCache.lastLoaded = now;
};

const getRoleIds = (type) => Array.from(configCache.roles.get(type) || []);
const getCategoryIdByName = (name) => {
    const entry = Array.from(configCache.categories.entries()).find(([, data]) => data.name === name);
    return entry ? entry[0] : null;
};
const getCategoryName = (categoryId) => configCache.categories.get(categoryId)?.name;
const getCategoryApproveMode = (categoryId) => Boolean(configCache.categories.get(categoryId)?.approveMode);
const getCategoriesForChannel = (channelId) => {
    const result = [];
    for (const [categoryId, channels] of configCache.categoryTargets.entries()) {
        if (channels.has(channelId)) {
            const data = configCache.categories.get(categoryId);
            result.push({ categoryId, name: data?.name || categoryId, approveMode: Boolean(data?.approveMode) });
        }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
};
const getTargetChannelIds = () => {
    const ids = new Set();
    for (const channels of configCache.categoryTargets.values()) {
        for (const id of channels) ids.add(id);
    }
    return Array.from(ids);
};
const getReportChannelIds = () => {
    const ids = new Set();
    for (const channels of configCache.categoryReports.values()) {
        for (const id of channels) ids.add(id);
    }
    return Array.from(ids);
};
const getReportChannelIdsForCategory = (categoryId) =>
    Array.from(configCache.categoryReports.get(categoryId) || []);
const getChannelPolicy = (channelId) => configCache.channelPolicies.get(channelId) || {};
const getDebugChannelIds = () => Array.from(configCache.debugChannels);

const parseUserId = (input) => {
    if (!input) return null;
    const mention = input.match(/^<@!?(\d+)>$/);
    if (mention) return mention[1];
    if (/^\d{5,}$/.test(input)) return input;
    return null;
};

const isUserGuildBanned = (guildId, userId) => {
    if (!guildId || !userId) return false;
    return Boolean(configDb.prepare('SELECT 1 FROM guild_bans WHERE guild_id = ? AND user_id = ?').get(guildId, userId));
};

const isUserCategoryBanned = (categoryId, userId) => {
    if (!categoryId || !userId) return false;
    return Boolean(configDb.prepare('SELECT 1 FROM category_bans WHERE category_id = ? AND user_id = ?').get(categoryId, userId));
};

const banUser = (guildId, categoryId, userId, bannedBy, reason) => {
    const now = Date.now();
    if (guildId) {
        configDb.prepare('INSERT OR IGNORE INTO guild_bans (guild_id, user_id, banned_at, banned_by, reason) VALUES (?, ?, ?, ?, ?)').run(
            guildId, userId, now, bannedBy || null, reason || null
        );
    }
    if (categoryId) {
        configDb.prepare('INSERT OR IGNORE INTO category_bans (category_id, user_id, banned_at, banned_by, reason) VALUES (?, ?, ?, ?, ?)').run(
            categoryId, userId, now, bannedBy || null, reason || null
        );
    }
};

const getBannedCategoryForChannel = (channelId, userId) => {
    const categories = getCategoriesForChannel(channelId);
    for (const category of categories) {
        if (isUserCategoryBanned(category.categoryId, userId)) {
            return category;
        }
    }
    return null;
};

const isUserBannedForInteraction = (interaction, categoryId = null) => {
    if (!interaction?.user?.id) return false;
    if (isAdmin(interaction.member)) return false;
    if (isUserGuildBanned(interaction.guildId, interaction.user.id)) return true;
    if (categoryId && isUserCategoryBanned(categoryId, interaction.user.id)) return true;
    return false;
};

const sanitizeText = (text) => {
    if (!text) return '';
    let result = text.replace(/@everyone/gi, '@\u200beveryone').replace(/@here/gi, '@\u200bhere');
    result = result.replace(/[\\`*_~|>]/g, '\\$&');
    return result;
};

const SAFE_MENTIONS = { parse: [] };

const linkifyChannelRefs = (text) =>
    text.replace(/channel=(\d{5,})/g, 'channel=<#$1>');

const formatLogArgs = (args) => args.map((arg) => {
    if (arg instanceof Error) {
        const code = typeof arg.code !== 'undefined' ? ` code=${arg.code}` : '';
        const status = typeof arg.status !== 'undefined' ? ` status=${arg.status}` : '';
        return `${arg.name}: ${arg.message}${code}${status}`;
    }
    if (typeof arg === 'string') return arg;
    try {
        return JSON.stringify(arg);
    } catch {
        return String(arg);
    }
}).join(' ');

let debugSendInProgress = false;
const sendDebugLog = async (level, args) => {
    loadConfig();
    const channels = getDebugChannelIds();
    if (!channels.length || !client.isReady()) return;
    const raw = `[${level.toUpperCase()}] ${formatLogArgs(args)}`;
    const content = linkifyChannelRefs(raw).slice(0, 1900);
    if (debugSendInProgress) return;
    debugSendInProgress = true;
    try {
        for (const channelId of channels) {
            try {
                const channel = await client.channels.fetch(channelId);
                if (!channel || !channel.isTextBased()) continue;
                await channel.send({ content, allowedMentions: SAFE_MENTIONS });
            } catch (error) {
                // Avoid recursion into debug logger
            }
        }
    } finally {
        debugSendInProgress = false;
    }
};

const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error
};
console.log = (...args) => {
    originalConsole.log(...args);
    void sendDebugLog('log', args);
};
console.warn = (...args) => {
    originalConsole.warn(...args);
    void sendDebugLog('warn', args);
};
console.error = (...args) => {
    originalConsole.error(...args);
    void sendDebugLog('error', args);
};

const buildMessageLink = (guildId, channelId, messageId) =>
    `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;

const formatError = (error) => {
    if (error instanceof Error) {
        const code = typeof error.code !== 'undefined' ? ` code=${error.code}` : '';
        const status = typeof error.status !== 'undefined' ? ` status=${error.status}` : '';
        return `${error.name}: ${error.message}${code}${status}`;
    }
    return String(error);
};

const buildReportMessage = (context, error) => {
    const details = formatError(error);
    let message = `**Bot Error**\n**Context:** ${context}\n**Error:** ${details}`;
    if (error instanceof Error && error.stack) {
        const stack = error.stack.length > 800 ? `${error.stack.slice(0, 797)}...` : error.stack;
        const withStack = `${message}\n\`\`\`\n${stack}\n\`\`\``;
        if (withStack.length <= 1900) {
            return withStack;
        }
    }
    if (message.length > 1900) {
        message = `${message.slice(0, 1897)}...`;
    }
    return message;
};

const reportError = async (context, error) => {
    loadConfig();
    const debugChannels = getDebugChannelIds();
    if (!debugChannels.length || !client.isReady()) return;
    const content = linkifyChannelRefs(buildReportMessage(context, error));
    for (const channelId of debugChannels) {
        try {
            const channel = await client.channels.fetch(channelId);
            if (!channel || !channel.isTextBased()) continue;
            await channel.send({ content, allowedMentions: SAFE_MENTIONS });
        } catch (sendError) {
            console.error(`Failed to send error report to channel ${channelId}:`, sendError);
        }
    }
};

const findProhibitedText = (text) => {
    if (!text) return null;
    const lowered = text.toLowerCase();
    const phrases = [
        'dm me',
        'dm me at',
        'dm me on',
        'dm me via',
        'dm me through',
        'message me',
        'message me at',
        'message me on',
        'message me via',
        'contact me',
        'contact me at',
        'contact me on',
        'contact me via',
        'reach me',
        'reach me at',
        'reach me on',
        'reach me via',
        'hit me up',
        'hit me up at',
        'hit me up on',
        'add me',
        'add me at',
        'add me on',
        'ping me',
        'ping me at',
        'ping me on',
        'find me on',
        'message on discord',
        'dm on discord',
        'discord dm',
        'discord me',
        'discord tag',
        'discord:',
        'discord -',
        'discord tag:',
        'discord handle',
        'discord username',
        'my discord is',
        'my discord:',
        'my discord -',
        'my tag is',
        'my tag:',
        'my handle is',
        'my handle:',
        'my username is',
        'my username:',
        'reach out on',
        'reach out via',
        'reach out at',
        'send me a dm',
        'send me a message',
        'shoot me a dm',
        'shoot me a message',
        'drop me a dm',
        'drop me a message',
        'contact via'
    ];
    if (phrases.some(p => lowered.includes(p))) return 'external contact request';
    if (/(^|\\s)@\\w{2,32}/.test(text)) return 'discord username mention';
    if (/\\b[a-z0-9._-]{2,32}#[0-9]{4}\\b/i.test(text)) return 'discord username mention';
    if (/\b(whatsapp|wa\.me|telegram|t\.me|signal|wechat|line|kik|skype|viber)\b/i.test(text)) return 'external contact request';
    return null;
};

const getChannelAccessStatus = async (channelId) => {
    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel) return { channelId, status: 'not found' };
        if (!channel.isTextBased()) return { channelId, status: 'not text-based' };
        const perms = channel.permissionsFor(client.user);
        if (!perms) return { channelId, status: 'no perms info' };
        const canView = perms.has(PermissionsBitField.Flags.ViewChannel);
        const canSend = perms.has(PermissionsBitField.Flags.SendMessages);
        if (canView && canSend) return { channelId, status: 'ok' };
        if (!canView) return { channelId, status: 'missing view' };
        return { channelId, status: 'missing send' };
    } catch (error) {
        return { channelId, status: `error: ${formatError(error)}` };
    }
};

const BACKUP_DIR = path.join(__dirname, 'backups');

const maybeBackupConfigDb = () => {
    try {
        if (!fs.existsSync(BACKUP_DIR)) {
            fs.mkdirSync(BACKUP_DIR, { recursive: true });
        }
        const backups = fs.readdirSync(BACKUP_DIR)
            .filter(name => name.startsWith('config.db.') && name.endsWith('.bak'))
            .map(name => ({
                name,
                fullPath: path.join(BACKUP_DIR, name),
                mtime: fs.statSync(path.join(BACKUP_DIR, name)).mtimeMs
            }))
            .sort((a, b) => b.mtime - a.mtime);

        const lastBackup = backups[0];
        if (lastBackup && Date.now() - lastBackup.mtime < 7 * 24 * 60 * 60 * 1000) {
            return;
        }

        const stamp = new Date().toISOString().slice(0, 10);
        const backupName = `config.db.${stamp}.bak`;
        fs.copyFileSync('config.db', path.join(BACKUP_DIR, backupName));

        const updatedBackups = fs.readdirSync(BACKUP_DIR)
            .filter(name => name.startsWith('config.db.') && name.endsWith('.bak'))
            .map(name => ({
                name,
                fullPath: path.join(BACKUP_DIR, name),
                mtime: fs.statSync(path.join(BACKUP_DIR, name)).mtimeMs
            }))
            .sort((a, b) => b.mtime - a.mtime);

        for (const old of updatedBackups.slice(2)) {
            fs.unlinkSync(old.fullPath);
        }
    } catch (error) {
        console.error('Failed to backup config.db:', error);
    }
};

const cleanupExpiredGigs = async () => {
    const now = Date.now();
    const expiredGigs = trackingDb.prepare("SELECT gig_id FROM gigs WHERE expires_at < ? AND status = 'approved'").all(now);
    let deletedGigs = 0;
    let deletedInstances = 0;

    for (const gig of expiredGigs) {
        const instances = trackingDb.prepare('SELECT message_id, channel_id FROM gig_instances WHERE gig_id = ?').all(gig.gig_id);
        for (const inst of instances) {
            try {
                const channel = await client.channels.fetch(inst.channel_id);
                await channel.messages.delete(inst.message_id);
                deletedInstances += 1;
            } catch (error) {
                console.error(`Failed to delete expired gig message ${inst.message_id} in channel ${inst.channel_id}:`, error);
                void reportError(`delete expired gig message_id=${inst.message_id} channel=${inst.channel_id}`, error);
            }
        }
        trackingDb.prepare('DELETE FROM gigs WHERE gig_id = ?').run(gig.gig_id);
        deletedGigs += 1;
    }

    return { deletedGigs, deletedInstances };
};

const cleanupStaleInstances = async () => {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const stale = trackingDb.prepare('SELECT message_id, channel_id FROM gig_instances WHERE created_at < ?').all(cutoff);
    let deletedInstances = 0;

    for (const inst of stale) {
        try {
            const channel = await client.channels.fetch(inst.channel_id);
            await channel.messages.delete(inst.message_id);
        } catch (error) {
            console.error(`Failed to delete stale gig message ${inst.message_id} in channel ${inst.channel_id}:`, error);
            void reportError(`delete stale gig message_id=${inst.message_id} channel=${inst.channel_id}`, error);
        } finally {
            trackingDb.prepare('DELETE FROM gig_instances WHERE message_id = ?').run(inst.message_id);
            deletedInstances += 1;
        }
    }

    trackingDb.prepare('DELETE FROM gigs WHERE gig_id NOT IN (SELECT gig_id FROM gig_instances) AND created_at < ?').run(cutoff);
    return deletedInstances;
};

const runCleanup = async () => {
    const { deletedGigs, deletedInstances } = await cleanupExpiredGigs();
    const staleDeleted = await cleanupStaleInstances();
    trackingDb.prepare('INSERT INTO cleanup_log (run_at, deleted_gigs, deleted_instances) VALUES (?, ?, ?)').run(Date.now(), deletedGigs, deletedInstances + staleDeleted);
    trackingDb.prepare('DELETE FROM cleanup_log WHERE run_at < ?').run(Date.now() - 7 * 24 * 60 * 60 * 1000);
    maybeBackupConfigDb();
};

const runHealthCheck = async () => {
    loadConfig();
    const categoryEntries = Array.from(configCache.categories.entries())
        .map(([id, data]) => ({ id, name: data.name, approveMode: data.approveMode }))
        .sort((a, b) => a.name.localeCompare(b.name));

    const lines = ['**Health Check**'];
    for (const category of categoryEntries) {
        const targetIds = Array.from(configCache.categoryTargets.get(category.id) || []);
        const reportIds = Array.from(configCache.categoryReports.get(category.id) || []);
        const targetChecks = await Promise.all(targetIds.map(c => getChannelAccessStatus(c)));
        const reportChecks = await Promise.all(reportIds.map(c => getChannelAccessStatus(c)));

        const targetLine = targetChecks.length
            ? targetChecks.map(c => `<#${c.channelId}> (${c.status})`).join(', ')
            : 'none';
        const reportLine = reportChecks.length
            ? reportChecks.map(c => `<#${c.channelId}> (${c.status})`).join(', ')
            : 'none';

        lines.push(`**${category.name}** (approval ${category.approveMode ? 'on' : 'off'})`);
        lines.push(`Targets: ${targetLine}`);
        lines.push(`Reports: ${reportLine}`);
    }
    const content = lines.join('\n');
    for (const channelId of getReportChannelIds()) {
        try {
            const channel = await client.channels.fetch(channelId);
            if (!channel || !channel.isTextBased()) continue;
            await channel.send({ content, allowedMentions: SAFE_MENTIONS });
        } catch (error) {
            console.error(`Failed to send health check to channel ${channelId}:`, error);
        }
    }
};

const COMMAND_DEFS = [
    {
        name: 'health',
        description: 'Report bot channel access to report channels'
    },
    {
        name: 'category',
        description: 'Manage categories',
        options: [
            {
                type: 1,
                name: 'create',
                description: 'Create a category',
                options: [{ type: 3, name: 'name', description: 'Category name', required: true }]
            },
            {
                type: 1,
                name: 'delete',
                description: 'Delete a category',
                options: [{ type: 3, name: 'name', description: 'Category name', required: true, autocomplete: true }]
            },
            {
                type: 1,
                name: 'list',
                description: 'List categories'
            },
            {
                type: 1,
                name: 'show',
                description: 'Show category channels',
                options: [{ type: 3, name: 'name', description: 'Category name', required: true, autocomplete: true }]
            },
            {
                type: 1,
                name: 'add-target',
                description: 'Add target channels to a category',
                options: [
                    { type: 3, name: 'name', description: 'Category name', required: true, autocomplete: true },
                    { type: 3, name: 'channels', description: 'Channel mentions or IDs, comma separated', required: true }
                ]
            },
            {
                type: 1,
                name: 'remove-target',
                description: 'Remove target channels from a category',
                options: [
                    { type: 3, name: 'name', description: 'Category name', required: true, autocomplete: true },
                    { type: 3, name: 'channels', description: 'Channel mentions or IDs, comma separated', required: true }
                ]
            },
            {
                type: 1,
                name: 'add-report',
                description: 'Add report channels to a category',
                options: [
                    { type: 3, name: 'name', description: 'Category name', required: true, autocomplete: true },
                    { type: 3, name: 'channels', description: 'Channel mentions or IDs, comma separated', required: true }
                ]
            },
            {
                type: 1,
                name: 'remove-report',
                description: 'Remove report channels from a category',
                options: [
                    { type: 3, name: 'name', description: 'Category name', required: true, autocomplete: true },
                    { type: 3, name: 'channels', description: 'Channel mentions or IDs, comma separated', required: true }
                ]
            },
            {
                type: 1,
                name: 'set-approve',
                description: 'Enable or disable approval mode',
                options: [
                    { type: 3, name: 'name', description: 'Category name', required: true, autocomplete: true },
                    { type: 5, name: 'enabled', description: 'Enable approval mode', required: true }
                ]
            }
        ]
    },
    {
        name: 'roles',
        description: 'Manage role access',
        options: [
            { type: 1, name: 'add-moderator', description: 'Add moderator role', options: [{ type: 8, name: 'role', description: 'Role', required: true }] },
            { type: 1, name: 'remove-moderator', description: 'Remove moderator role', options: [{ type: 8, name: 'role', description: 'Role', required: true }] },
            { type: 1, name: 'add-applicant', description: 'Add applicant role', options: [{ type: 8, name: 'role', description: 'Role', required: true }] },
            { type: 1, name: 'remove-applicant', description: 'Remove applicant role', options: [{ type: 8, name: 'role', description: 'Role', required: true }] },
            { type: 1, name: 'add-direct-applicant', description: 'Add direct applicant role', options: [{ type: 8, name: 'role', description: 'Role', required: true }] },
            { type: 1, name: 'remove-direct-applicant', description: 'Remove direct applicant role', options: [{ type: 8, name: 'role', description: 'Role', required: true }] },
            { type: 1, name: 'add-creator', description: 'Add creator role', options: [{ type: 8, name: 'role', description: 'Role', required: true }] },
            { type: 1, name: 'remove-creator', description: 'Remove creator role', options: [{ type: 8, name: 'role', description: 'Role', required: true }] },
            { type: 1, name: 'list', description: 'List configured roles' }
        ]
    },
    {
        name: 'channel',
        description: 'Manage channel policies',
        options: [
            { type: 1, name: 'set-expiry', description: 'Set expiry days for a channel', options: [{ type: 4, name: 'days', description: 'Days', required: true }, { type: 7, name: 'channel', description: 'Channel', required: false }, { type: 3, name: 'channel_id', description: 'Channel mention or ID', required: false }] },
            { type: 1, name: 'clear-expiry', description: 'Clear expiry override', options: [{ type: 7, name: 'channel', description: 'Channel', required: false }, { type: 3, name: 'channel_id', description: 'Channel mention or ID', required: false }] },
            { type: 1, name: 'set-cooldown', description: 'Set cooldown days for a channel', options: [{ type: 4, name: 'days', description: 'Days', required: true }, { type: 7, name: 'channel', description: 'Channel', required: false }, { type: 3, name: 'channel_id', description: 'Channel mention or ID', required: false }] },
            { type: 1, name: 'clear-cooldown', description: 'Clear cooldown override', options: [{ type: 7, name: 'channel', description: 'Channel', required: false }, { type: 3, name: 'channel_id', description: 'Channel mention or ID', required: false }] }
        ]
    },
    {
        name: 'debug',
        description: 'Manage debug channels',
        options: [
            { type: 1, name: 'add', description: 'Add debug channels', options: [{ type: 3, name: 'channels', description: 'Channel mentions or IDs, comma separated', required: true }] },
            { type: 1, name: 'remove', description: 'Remove debug channels', options: [{ type: 3, name: 'channels', description: 'Channel mentions or IDs, comma separated', required: true }] },
            { type: 1, name: 'list', description: 'List debug channels' }
        ]
    },
    {
        name: 'unbanish',
        description: 'Remove a user from ban lists',
        options: [
            { type: 3, name: 'user', description: 'User mention or ID', required: true },
            { type: 3, name: 'scope', description: 'Which ban list to clear', required: true, choices: [
                { name: 'server', value: 'server' },
                { name: 'category', value: 'category' },
                { name: 'both', value: 'both' }
            ] },
            { type: 3, name: 'category', description: 'Category name (required for category/both)', required: false, autocomplete: true }
        ]
    }
];

const registerCommands = async () => {
    try {
        await client.application?.commands.set(COMMAND_DEFS);
    } catch (error) {
        console.error('Failed to register commands:', error);
        void reportError('register commands', error);
    }
};

const parseChannelList = (input) => {
    const ids = new Set();
    const mentionRegex = /<#(\d+)>/g;
    let match;
    while ((match = mentionRegex.exec(input)) !== null) {
        ids.add(match[1]);
    }
    for (const token of input.split(/[,\s]+/)) {
        if (/^\d{5,}$/.test(token)) ids.add(token);
    }
    return Array.from(ids);
};

const respondWithAutocomplete = async (interaction, options) => {
    await interaction.respond(options.slice(0, 25));
};

const createGigEmbed = (gig) => {
    const payString = sanitizeText(gig.pay);
    const payDisplay = /^\d+$/.test(payString.replace(/[,.]/g, '')) ? `${payString} USD` : payString;

    const embed = new EmbedBuilder()
        .setColor(0xb296ff)
        .setTitle(`Gig: ${sanitizeText(gig.title)}`)
        .setDescription(
            (gig.timeline ? `**Timeline:** ${sanitizeText(gig.timeline)}\n` : '') +
            `\n**Description:**\n${sanitizeText(gig.description)}\n\n` +
            `**Pay:** ${payDisplay}`
        );
    return embed;
};

const createGigActionRow = (messageId) => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`apply_${messageId}`).setLabel('Apply').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`report_${messageId}`).setLabel('Report').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`delete_gig_${messageId}`).setLabel('Delete').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`banish_gig_${messageId}`).setLabel('Banish').setStyle(ButtonStyle.Danger)
);

const createReportActionRow = (gigId) => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`report_delete_${gigId}`).setLabel('Delete').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`report_banish_${gigId}`).setLabel('Banish').setStyle(ButtonStyle.Danger)
);

const createApprovalActionRow = (gigId) => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`approve_accept_${gigId}`).setLabel('Accept').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`approve_reject_${gigId}`).setLabel('Reject').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`approve_banish_${gigId}`).setLabel('Banish').setStyle(ButtonStyle.Danger)
);

const createApplicationActionRow = (gigId, applicantId) => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`contact_applicant_${gigId}_${applicantId}`).setLabel('Contact Me').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`report_applicant_${gigId}_${applicantId}`).setLabel('Report').setStyle(ButtonStyle.Danger)
);

const createPostGigMessage = () => ({
    embeds: [new EmbedBuilder()
        .setTitle('Post a Gig')
        .setDescription('Click the buttons below to manage your gigs.')
        .setColor(0xb296ff)],
    components: [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('create_gig').setLabel('Create a Gig').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('delete_all_my_gigs').setLabel('Delete All My Gigs').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setLabel('Support').setStyle(ButtonStyle.Link).setURL(SUPPORT_URL)
        )
    ],
    allowedMentions: SAFE_MENTIONS
});

const showGigModal = async (interaction, categoryId) => {
    const modal = new ModalBuilder().setCustomId(`gig_form_${categoryId}`).setTitle('Create a Gig');
    modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('Gig Title').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Description (DO NOT ADD CONTACT DETAILS)').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1024)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('pay').setLabel('Pay (min $20)').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('timeline').setLabel('Timeline').setStyle(TextInputStyle.Short).setRequired(false))
    );
    await interaction.showModal(modal);
};

const storeGigPayload = (gigId, payload) => {
    trackingDb.prepare('INSERT OR REPLACE INTO gig_payloads (gig_id, title, description, pay, timeline) VALUES (?, ?, ?, ?, ?)').run(
        gigId, payload.title, payload.description, payload.pay, payload.timeline ?? null
    );
};

const getGigPayload = (gigId) =>
    trackingDb.prepare('SELECT title, description, pay, timeline FROM gig_payloads WHERE gig_id = ?').get(gigId);

const postGigToTargets = async (gig, payload) => {
    const targetChannels = Array.from(configCache.categoryTargets.get(gig.category_id) || []);
    for (const channelId of targetChannels) {
        try {
            const channel = await client.channels.fetch(channelId);
            if (!channel || !channel.isTextBased()) continue;
            const gigMessage = await channel.send({
                embeds: [createGigEmbed(payload)],
                components: [createGigActionRow('TEMP_ID')],
                allowedMentions: SAFE_MENTIONS
            });

            await gigMessage.edit({ components: [createGigActionRow(gigMessage.id)], allowedMentions: SAFE_MENTIONS });

            trackingDb.prepare('INSERT INTO gig_instances (message_id, gig_id, guild_id, channel_id, created_at) VALUES (?, ?, ?, ?, ?)').run(
                gigMessage.id, gig.gig_id, gigMessage.guildId, channelId, Date.now()
            );
        } catch (error) {
            console.error(`Failed to post gig in channel ${channelId}:`, error);
            void reportError(`post gig channel=${channelId}`, error);
        }
    }
};

const deleteGigById = async (gigId) => {
    const gig = trackingDb.prepare('SELECT * FROM gigs WHERE gig_id = ?').get(gigId);
    if (!gig) return { found: false };
    const allInstances = trackingDb.prepare('SELECT * FROM gig_instances WHERE gig_id = ?').all(gigId);
    for (const inst of allInstances) {
        try {
            const channel = await client.channels.fetch(inst.channel_id);
            if (channel?.isTextBased()) {
                await channel.messages.delete(inst.message_id);
            }
        } catch (error) {
            console.error(`Failed to delete gig message ${inst.message_id} in channel ${inst.channel_id}:`, error);
            void reportError(`delete gig message_id=${inst.message_id} channel=${inst.channel_id}`, error);
        }
    }
    trackingDb.prepare('DELETE FROM gigs WHERE gig_id = ?').run(gigId);
    return { found: true, gig, instances: allInstances.length };
};

async function ensurePostGigMessageForChannel(channelId) {
    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel || !channel.isTextBased()) return;

        const messages = await channel.messages.fetch({ limit: 50 });
        const botMessages = messages.filter(m => m.author.id === client.user.id && m.embeds[0]?.title === 'Post a Gig');

        if (botMessages.size > 1 || (botMessages.size === 1 && botMessages.first()?.id !== messages.first()?.id)) {
            await channel.bulkDelete(botMessages);
            await channel.send(createPostGigMessage());
        } else if (botMessages.size === 0) {
            await channel.send(createPostGigMessage());
        }
    } catch (error) {
        console.error(`Could not ensure post gig message in channel ${channelId}:`, error);
        void reportError(`ensurePostGigMessage channel=${channelId}`, error);
    }
}

async function ensurePostGigMessage() {
    loadConfig();
    for (const channelId of getTargetChannelIds()) {
        try {
            await ensurePostGigMessageForChannel(channelId);
        } catch (error) {
            console.error(`Could not ensure post gig message in channel ${channelId}:`, error);
            void reportError(`ensurePostGigMessage channel=${channelId}`, error);
        }
    }
}

const hasRole = (member, roleIds) => {
    if (!member?.roles?.cache) return false;
    return roleIds.some(roleId => member.roles.cache.has(roleId));
};

const isAdmin = (member) => {
    if (!member?.id) return false;
    return ADMIN_USER_IDS.includes(member.id) || hasRole(member, ADMIN_ROLE_IDS);
};

const isModeratorOrAdmin = (member) =>
    isAdmin(member) || hasRole(member, getRoleIds(ROLE_TYPES.MODERATOR));

const checkPermissions = (interaction, gigUserId) => {
    const member = interaction.member;
    return isModeratorOrAdmin(member) || interaction.user.id === gigUserId;
};

const hasDirectApplicantRole = (member) => hasRole(member, getRoleIds(ROLE_TYPES.DIRECT_APPLICANT));
const hasApplicantRole = (member) => hasRole(member, getRoleIds(ROLE_TYPES.APPLICANT));
const hasCreatorRole = (member) => hasRole(member, getRoleIds(ROLE_TYPES.CREATOR));

const applicantRolesConfigured = () =>
    getRoleIds(ROLE_TYPES.DIRECT_APPLICANT).length > 0 || getRoleIds(ROLE_TYPES.APPLICANT).length > 0;

const canCreateGig = (interaction) => {
    const member = interaction.member;
    if (isModeratorOrAdmin(member)) return true;
    if (getRoleIds(ROLE_TYPES.CREATOR).length === 0) return true;
    return hasCreatorRole(member);
};

const canApply = (interaction) => {
    const member = interaction.member;
    if (isAdmin(member)) return true;
    if (!applicantRolesConfigured()) return true;
    return hasDirectApplicantRole(member) || hasApplicantRole(member);
}

const getApplicantType = (member) => {
    if (hasDirectApplicantRole(member)) return 'direct';
    if (hasApplicantRole(member)) return 'normal';
    if (isAdmin(member)) return 'normal';
    if (!applicantRolesConfigured()) return 'normal';
    return null;
};

const checkRateLimit = (userId, channelId) => {
    const policy = getChannelPolicy(channelId);
    const cooldownDays = policy.cooldownDays ?? DEFAULT_COOLDOWN_DAYS;
    if (!cooldownDays || cooldownDays <= 0) return true;
    const row = trackingDb.prepare('SELECT last_post_at FROM rate_limits WHERE user_id = ? AND channel_id = ?').get(userId, channelId);
    if (row && (Date.now() - row.last_post_at) < cooldownDays * 24 * 60 * 60 * 1000) {
        return false;
    }
    return true;
};

client.on(Events.Error, (error) => {
    console.error('Client error event:', error);
    void reportError('Client error event', error);
});

client.on(Events.ShardError, (error, shardId) => {
    console.error(`Shard error (shard ${shardId}):`, error);
    void reportError(`Shard error shard=${shardId}`, error);
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
    void reportError('Unhandled promise rejection', reason);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    void reportError('Uncaught exception', error);
});

// --- EVENTS ---
client.once(Events.ClientReady, async () => {
    console.log(`Logged in as ${client.user.tag}!`);

    loadConfig(true);
    await registerCommands();
    await runCleanup();
    setInterval(() => {
        runCleanup().catch((error) => {
            console.error('Cleanup failed:', error);
            void reportError('cleanup failed', error);
        });
    }, 24 * 60 * 60 * 1000);

    await ensurePostGigMessage();
});

client.on(Events.GuildCreate, guild => {
    console.log(`Joined server: ${guild.name} (${guild.id})`);
});

const lastEnsureByChannel = new Map();

client.on(Events.MessageCreate, async message => {
    if (message.author?.bot) return;
    if (!message.channelId) return;
    loadConfig();
    const isTargetChannel = getTargetChannelIds().includes(message.channelId);
    if (!isTargetChannel) return;

    const now = Date.now();
    const last = lastEnsureByChannel.get(message.channelId) || 0;
    if (now - last < 5000) return;
    lastEnsureByChannel.set(message.channelId, now);

    await ensurePostGigMessageForChannel(message.channelId);
});

client.on(Events.InteractionCreate, async interaction => {
    if (interaction.isAutocomplete()) {
        if (interaction.commandName === 'category' || interaction.commandName === 'unbanish') {
            loadConfig();
            const focused = interaction.options.getFocused(true);
            if (focused.name === 'name' || focused.name === 'category') {
                const needle = focused.value.toLowerCase();
                const options = Array.from(configCache.categories.values())
                    .map(c => c.name)
                    .filter(name => name.toLowerCase().includes(needle))
                    .slice(0, 25)
                    .map(name => ({ name, value: name }));
                return respondWithAutocomplete(interaction, options);
            }
        }
        return;
    }

    loadConfig();

    if (!interaction.isAutocomplete() && !interaction.isChatInputCommand()) {
        if (interaction.guildId && !isAdmin(interaction.member) && isUserGuildBanned(interaction.guildId, interaction.user.id)) {
            return interaction.reply({ content: 'You are banned from using this bot.', flags: MessageFlags.Ephemeral });
        }
    }

    if (interaction.isChatInputCommand()) {
        if (!isAdmin(interaction.member)) {
            return interaction.reply({ content: 'You do not have permission to use this command.', flags: MessageFlags.Ephemeral });
        }
        if (isUserBannedForInteraction(interaction)) {
            return interaction.reply({ content: 'You are banned from using this bot.', flags: MessageFlags.Ephemeral });
        }

        if (interaction.commandName === 'health') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            await runHealthCheck();
            return interaction.editReply({ content: 'Health check posted to report channels.' });
        }

        if (interaction.commandName === 'category') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const sub = interaction.options.getSubcommand();
            const name = interaction.options.getString('name');
            if (sub === 'create') {
                const existing = getCategoryIdByName(name);
                if (existing) return interaction.editReply({ content: 'Category already exists.' });
                const categoryId = randomUUID();
                configDb.prepare('INSERT INTO categories (category_id, name) VALUES (?, ?)').run(categoryId, name);
                loadConfig(true);
                await ensurePostGigMessage();
                return interaction.editReply({ content: `Created category **${name}**.` });
            }
            if (sub === 'delete') {
                const categoryId = getCategoryIdByName(name);
                if (!categoryId) return interaction.editReply({ content: 'Category not found.' });
                configDb.prepare('DELETE FROM categories WHERE category_id = ?').run(categoryId);
                loadConfig(true);
                await ensurePostGigMessage();
                return interaction.editReply({ content: `Deleted category **${name}**.` });
            }
            if (sub === 'list') {
                loadConfig();
                const names = Array.from(configCache.categories.values()).map(c => c.name).sort();
                return interaction.editReply({ content: names.length ? names.join(', ') : 'No categories configured.' });
            }
            if (sub === 'show') {
                const categoryId = getCategoryIdByName(name);
                if (!categoryId) return interaction.editReply({ content: 'Category not found.' });
                const targets = Array.from(configCache.categoryTargets.get(categoryId) || []).map(id => `<#${id}>`).join(', ') || 'none';
                const reports = Array.from(configCache.categoryReports.get(categoryId) || []).map(id => `<#${id}>`).join(', ') || 'none';
                const approveMode = getCategoryApproveMode(categoryId) ? 'enabled' : 'disabled';
                return interaction.editReply({ content: `**${name}**\nTargets: ${targets}\nReports: ${reports}\nApproval: ${approveMode}`, allowedMentions: SAFE_MENTIONS });
            }

            const categoryId = getCategoryIdByName(name);
            if (!categoryId) return interaction.editReply({ content: 'Category not found.' });
            if (sub === 'set-approve') {
                const enabled = interaction.options.getBoolean('enabled');
                configDb.prepare('UPDATE categories SET approve_mode = ? WHERE category_id = ?').run(enabled ? 1 : 0, categoryId);
                loadConfig(true);
                return interaction.editReply({ content: `Approval mode for **${name}** is now ${enabled ? 'enabled' : 'disabled'}.` });
            }
            const channelsInput = interaction.options.getString('channels');
            const channelIds = parseChannelList(channelsInput);
            if (!channelIds.length) return interaction.editReply({ content: 'No valid channels provided.' });

            if (sub === 'add-target') {
                const stmt = configDb.prepare('INSERT OR IGNORE INTO category_targets (category_id, channel_id) VALUES (?, ?)');
                for (const channelId of channelIds) stmt.run(categoryId, channelId);
                loadConfig(true);
                await ensurePostGigMessage();
                return interaction.editReply({ content: `Added target channels to **${name}**.` });
            }
            if (sub === 'remove-target') {
                const stmt = configDb.prepare('DELETE FROM category_targets WHERE category_id = ? AND channel_id = ?');
                for (const channelId of channelIds) stmt.run(categoryId, channelId);
                loadConfig(true);
                await ensurePostGigMessage();
                const remaining = Array.from(configCache.categoryTargets.get(categoryId) || []);
                const remainingList = remaining.length ? remaining.map(id => `<#${id}>`).join(', ') : 'none';
                return interaction.editReply({ content: `Removed target channels from **${name}**.\nCurrent targets: ${remainingList}`, allowedMentions: SAFE_MENTIONS });
            }
            if (sub === 'add-report') {
                const stmt = configDb.prepare('INSERT OR IGNORE INTO category_reports (category_id, channel_id) VALUES (?, ?)');
                for (const channelId of channelIds) stmt.run(categoryId, channelId);
                loadConfig(true);
                return interaction.editReply({ content: `Added report channels to **${name}**.` });
            }
            if (sub === 'remove-report') {
                const stmt = configDb.prepare('DELETE FROM category_reports WHERE category_id = ? AND channel_id = ?');
                for (const channelId of channelIds) stmt.run(categoryId, channelId);
                loadConfig(true);
                const remaining = Array.from(configCache.categoryReports.get(categoryId) || []);
                const remainingList = remaining.length ? remaining.map(id => `<#${id}>`).join(', ') : 'none';
                return interaction.editReply({ content: `Removed report channels from **${name}**.\nCurrent reports: ${remainingList}`, allowedMentions: SAFE_MENTIONS });
            }
        }

        if (interaction.commandName === 'roles') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const sub = interaction.options.getSubcommand();
            if (sub === 'list') {
                loadConfig();
                const lines = [
                    `Admins: ${ADMIN_ROLE_IDS.map(id => `<@&${id}>`).join(', ') || 'none'}`,
                    `Moderators: ${getRoleIds(ROLE_TYPES.MODERATOR).map(id => `<@&${id}>`).join(', ') || 'none'}`,
                    `Creators: ${getRoleIds(ROLE_TYPES.CREATOR).map(id => `<@&${id}>`).join(', ') || 'none'}`,
                    `Applicants: ${getRoleIds(ROLE_TYPES.APPLICANT).map(id => `<@&${id}>`).join(', ') || 'none'}`,
                    `Direct Applicants: ${getRoleIds(ROLE_TYPES.DIRECT_APPLICANT).map(id => `<@&${id}>`).join(', ') || 'none'}`
                ];
                return interaction.editReply({ content: lines.join('\n'), allowedMentions: SAFE_MENTIONS });
            }

            const role = interaction.options.getRole('role');
            const map = {
                'add-moderator': ROLE_TYPES.MODERATOR,
                'remove-moderator': ROLE_TYPES.MODERATOR,
                'add-applicant': ROLE_TYPES.APPLICANT,
                'remove-applicant': ROLE_TYPES.APPLICANT,
                'add-direct-applicant': ROLE_TYPES.DIRECT_APPLICANT,
                'remove-direct-applicant': ROLE_TYPES.DIRECT_APPLICANT,
                'add-creator': ROLE_TYPES.CREATOR,
                'remove-creator': ROLE_TYPES.CREATOR
            };
            const type = map[sub];
            if (!type) return interaction.editReply({ content: 'Unknown role command.' });

            if (sub.startsWith('add-')) {
                configDb.prepare('INSERT OR IGNORE INTO roles (type, role_id) VALUES (?, ?)').run(type, role.id);
                loadConfig(true);
                return interaction.editReply({ content: `Added <@&${role.id}> to ${type} roles.`, allowedMentions: SAFE_MENTIONS });
            }
            configDb.prepare('DELETE FROM roles WHERE type = ? AND role_id = ?').run(type, role.id);
            loadConfig(true);
            return interaction.editReply({ content: `Removed <@&${role.id}> from ${type} roles.`, allowedMentions: SAFE_MENTIONS });
        }

        if (interaction.commandName === 'channel') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const sub = interaction.options.getSubcommand();
            const channelOption = interaction.options.getChannel('channel');
            let channelId = channelOption?.id;
            if (!channelId) {
                const channelInput = interaction.options.getString('channel_id');
                if (channelInput) {
                    const parsed = parseChannelList(channelInput);
                    channelId = parsed[0];
                }
            }
            if (!channelId) return interaction.editReply({ content: 'Channel not found. Provide a channel or channel ID.' });

            const existing = configDb.prepare('SELECT expiry_days, cooldown_days FROM channel_policies WHERE channel_id = ?').get(channelId) || {};

            if (sub === 'set-expiry') {
                const days = interaction.options.getInteger('days');
                configDb.prepare('INSERT INTO channel_policies (channel_id, expiry_days, cooldown_days) VALUES (?, ?, ?) ON CONFLICT(channel_id) DO UPDATE SET expiry_days = excluded.expiry_days').run(channelId, days, existing.cooldown_days ?? null);
                loadConfig(true);
                return interaction.editReply({ content: `Set expiry for <#${channelId}> to ${days} days.`, allowedMentions: SAFE_MENTIONS });
            }
            if (sub === 'clear-expiry') {
                configDb.prepare('INSERT INTO channel_policies (channel_id, expiry_days, cooldown_days) VALUES (?, ?, ?) ON CONFLICT(channel_id) DO UPDATE SET expiry_days = excluded.expiry_days').run(channelId, null, existing.cooldown_days ?? null);
                loadConfig(true);
                return interaction.editReply({ content: `Cleared expiry override for <#${channelId}>.`, allowedMentions: SAFE_MENTIONS });
            }
            if (sub === 'set-cooldown') {
                const days = interaction.options.getInteger('days');
                configDb.prepare('INSERT INTO channel_policies (channel_id, expiry_days, cooldown_days) VALUES (?, ?, ?) ON CONFLICT(channel_id) DO UPDATE SET cooldown_days = excluded.cooldown_days').run(channelId, existing.expiry_days ?? null, days);
                loadConfig(true);
                return interaction.editReply({ content: `Set cooldown for <#${channelId}> to ${days} days.`, allowedMentions: SAFE_MENTIONS });
            }
            if (sub === 'clear-cooldown') {
                configDb.prepare('INSERT INTO channel_policies (channel_id, expiry_days, cooldown_days) VALUES (?, ?, ?) ON CONFLICT(channel_id) DO UPDATE SET cooldown_days = excluded.cooldown_days').run(channelId, existing.expiry_days ?? null, null);
                loadConfig(true);
                return interaction.editReply({ content: `Cleared cooldown override for <#${channelId}>.`, allowedMentions: SAFE_MENTIONS });
            }
        }

        if (interaction.commandName === 'debug') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const sub = interaction.options.getSubcommand();
            if (sub === 'list') {
                loadConfig();
                const channels = getDebugChannelIds();
                const list = channels.length ? channels.map(id => `<#${id}>`).join(', ') : 'none';
                return interaction.editReply({ content: `Debug channels: ${list}`, allowedMentions: SAFE_MENTIONS });
            }
            const channelsInput = interaction.options.getString('channels');
            const channelIds = parseChannelList(channelsInput);
            if (!channelIds.length) return interaction.editReply({ content: 'No valid channels provided.' });

            if (sub === 'add') {
                const stmt = configDb.prepare('INSERT OR IGNORE INTO debug_channels (channel_id) VALUES (?)');
                for (const channelId of channelIds) stmt.run(channelId);
                loadConfig(true);
                return interaction.editReply({ content: 'Added debug channels.', allowedMentions: SAFE_MENTIONS });
            }
            if (sub === 'remove') {
                const stmt = configDb.prepare('DELETE FROM debug_channels WHERE channel_id = ?');
                for (const channelId of channelIds) stmt.run(channelId);
                loadConfig(true);
                const remaining = getDebugChannelIds();
                const list = remaining.length ? remaining.map(id => `<#${id}>`).join(', ') : 'none';
                return interaction.editReply({ content: `Removed debug channels. Current: ${list}`, allowedMentions: SAFE_MENTIONS });
            }
        }

        if (interaction.commandName === 'unbanish') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const rawUser = interaction.options.getString('user');
            const userId = parseUserId(rawUser);
            if (!userId) return interaction.editReply({ content: 'Invalid user. Provide a mention or user ID.' });
            const scope = interaction.options.getString('scope');
            const categoryName = interaction.options.getString('category');

            if ((scope === 'category' || scope === 'both') && !categoryName) {
                return interaction.editReply({ content: 'Category name is required for category or both scope.' });
            }

            let removed = 0;
            if (scope === 'server' || scope === 'both') {
                const info = configDb.prepare('DELETE FROM guild_bans WHERE guild_id = ? AND user_id = ?').run(interaction.guildId, userId);
                removed += info.changes || 0;
            }
            if (scope === 'category' || scope === 'both') {
                const categoryId = getCategoryIdByName(categoryName);
                if (!categoryId) return interaction.editReply({ content: 'Category not found.' });
                const info = configDb.prepare('DELETE FROM category_bans WHERE category_id = ? AND user_id = ?').run(categoryId, userId);
                removed += info.changes || 0;
            }
            loadConfig(true);
            return interaction.editReply({ content: removed ? `Unbanished <@${userId}>.` : 'No matching ban entries found.', allowedMentions: SAFE_MENTIONS });
        }

        return;
    }

    if (interaction.isStringSelectMenu()) {
        if (interaction.customId === 'select_category') {
            const categoryId = interaction.values[0];
            if (isUserBannedForInteraction(interaction, categoryId)) {
                return interaction.reply({ content: 'You are banned from using this bot.', flags: MessageFlags.Ephemeral });
            }
            return showGigModal(interaction, categoryId);
        }
        return;
    }

    if (!interaction.isButton() && !interaction.isModalSubmit()) return;

    // --- BUTTONS ---
    if (interaction.isButton()) {
        const { customId } = interaction;

        if (customId.startsWith('report_delete_') || customId.startsWith('report_banish_')) {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            if (!isModeratorOrAdmin(interaction.member)) {
                return interaction.editReply({ content: 'You do not have permission to use this action.' });
            }
            const parts = customId.split('_');
            const action = parts[1];
            const gigId = parts[2];
            const gig = trackingDb.prepare('SELECT * FROM gigs WHERE gig_id = ?').get(gigId);
            if (!gig) return interaction.editReply({ content: 'Gig not found.' });

            if (action === 'banish') {
                banUser(interaction.guildId, gig.category_id, gig.user_id, interaction.user.id, 'report banish');
            }
            await deleteGigById(gigId);
            await ensurePostGigMessage();
            await interaction.editReply({ content: action === 'banish' ? 'Gig deleted and user banished.' : 'Gig deleted.' });
            try {
                await interaction.message.edit({ components: [] });
            } catch {}
            return;
        }

        if (customId.startsWith('approve_')) {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            if (!isModeratorOrAdmin(interaction.member)) {
                return interaction.editReply({ content: 'You do not have permission to use this action.' });
            }
            const parts = customId.split('_');
            const action = parts[1];
            const gigId = parts[2];
            const gig = trackingDb.prepare('SELECT * FROM gigs WHERE gig_id = ?').get(gigId);
            if (!gig) return interaction.editReply({ content: 'Gig not found.' });

            if (action === 'accept') {
                const payload = getGigPayload(gigId);
                if (!payload) return interaction.editReply({ content: 'Gig payload not found.' });
                loadConfig();
                const expiryDays = getChannelPolicy(gig.channel_id_created_in).expiryDays ?? DEFAULT_EXPIRY_DAYS;
                const expiresAt = Date.now() + (expiryDays * 24 * 60 * 60 * 1000);
                trackingDb.prepare("UPDATE gigs SET status = 'approved', expires_at = ? WHERE gig_id = ?").run(expiresAt, gigId);
                await postGigToTargets({ ...gig, status: 'approved' }, payload);
                await ensurePostGigMessage();
                await interaction.editReply({ content: 'Gig approved and posted.' });
            } else if (action === 'reject') {
                await deleteGigById(gigId);
                await ensurePostGigMessage();
                await interaction.editReply({ content: 'Gig rejected and deleted.' });
            } else if (action === 'banish') {
                banUser(interaction.guildId, gig.category_id, gig.user_id, interaction.user.id, 'approval banish');
                await deleteGigById(gigId);
                await ensurePostGigMessage();
                await interaction.editReply({ content: 'Gig deleted and user banished.' });
            }
            try {
                await interaction.message.edit({ components: [] });
            } catch {}
            return;
        }

        if (customId.startsWith('contact_applicant_') || customId.startsWith('report_applicant_')) {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const parts = customId.split('_');
            const action = parts[0];
            const gigId = parts[2];
            const applicantId = parts[3];
            const gig = trackingDb.prepare('SELECT * FROM gigs WHERE gig_id = ?').get(gigId);
            if (!gig) return interaction.editReply({ content: 'Gig not found.' });

            if (interaction.user.id !== gig.user_id && !isModeratorOrAdmin(interaction.member)) {
                return interaction.editReply({ content: 'You do not have permission to use this action.' });
            }

            if (action === 'contact') {
                try {
                    const applicant = await client.users.fetch(applicantId);
                    await applicant.send({
                        content: `The gig poster is interested in your application. Please DM <@${gig.user_id}> to follow up.`,
                        allowedMentions: SAFE_MENTIONS
                    });
                    return interaction.editReply({ content: 'Applicant notified.' });
                } catch (error) {
                    console.error('Failed to DM applicant:', error);
                    void reportError('contact applicant', error);
                    return interaction.editReply({ content: 'Failed to contact applicant.' });
                }
            }

            if (action === 'report') {
                loadConfig();
                const reportChannels = getReportChannelIdsForCategory(gig.category_id);
                if (!reportChannels.length) {
                    return interaction.editReply({ content: 'No report channels are configured for this category.' });
                }
                const instance = trackingDb.prepare('SELECT message_id, channel_id, guild_id FROM gig_instances WHERE gig_id = ?').get(gigId);
                const messageLink = instance ? buildMessageLink(instance.guild_id, instance.channel_id, instance.message_id) : 'Unavailable';
                for (const channelId of reportChannels) {
                    try {
                        const channel = await client.channels.fetch(channelId);
                        if (!channel || !channel.isTextBased()) continue;
                        await channel.send({
                            embeds: [new EmbedBuilder()
                                .setColor(0xff0000)
                                .setTitle('Application Reported')
                                .setDescription(`**Reported by:** <@${interaction.user.id}> (${interaction.user.id})\n**Applicant:** <@${applicantId}> (${applicantId})\n**Gig ID:** ${gig.gig_id}\n**Context:** ${messageLink}`)
                                .setTimestamp()
                            ],
                            allowedMentions: SAFE_MENTIONS
                        });
                    } catch (error) {
                        console.error(`Failed to send application report to channel ${channelId}:`, error);
                    }
                }
                return interaction.editReply({ content: 'Report sent to moderators.' });
            }
            return;
        }
        
        if (customId === 'create_gig') {
            try {
                loadConfig();
                if (isUserBannedForInteraction(interaction)) {
                    return interaction.reply({ content: 'You are banned from using this bot.', flags: MessageFlags.Ephemeral });
                }
                const isValidChannel = getTargetChannelIds().includes(interaction.channelId);
                if (!isValidChannel) {
                    console.log(`Create gig attempt in invalid channel: ${interaction.channelId}`);
                    console.log('Valid channels:', getTargetChannelIds());
                    return interaction.reply({ content: 'You can\'t create a gig in this channel.', flags: MessageFlags.Ephemeral });
                }
                if (!canCreateGig(interaction)) {
                    return interaction.reply({ content: 'You do not have the required role to create gigs.', flags: MessageFlags.Ephemeral });
                }
                
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('accept_and_create_gig').setLabel('Accept and Create Gig').setStyle(ButtonStyle.Primary)
                );
                await interaction.reply({ content: 'Terms of Use: ...', components: [row], flags: MessageFlags.Ephemeral });
            } catch (error) {
                console.error('Error in create_gig button:', error);
                void reportError('create_gig button', error);
                await interaction.reply({ content: 'An error occurred. Please try again.', flags: MessageFlags.Ephemeral }).catch(() => {});
            }

        } else if (customId === 'accept_and_create_gig') {
            if (isUserBannedForInteraction(interaction)) {
                return interaction.reply({ content: 'You are banned from using this bot.', flags: MessageFlags.Ephemeral });
            }
            if (!isModeratorOrAdmin(interaction.member) && !checkRateLimit(interaction.user.id, interaction.channelId)) {
                return interaction.reply({ content: 'You can only post one gig every 3 days in this channel.', flags: MessageFlags.Ephemeral });
            }
            loadConfig();
            const categories = getCategoriesForChannel(interaction.channelId)
                .filter(category => !isUserCategoryBanned(category.categoryId, interaction.user.id));
            if (categories.length === 0) {
                return interaction.reply({ content: 'No available categories are configured for this channel.', flags: MessageFlags.Ephemeral });
            }
            if (categories.length === 1) {
                return showGigModal(interaction, categories[0].categoryId);
            }
            const menu = new StringSelectMenuBuilder()
                .setCustomId('select_category')
                .setPlaceholder('Select a category')
                .addOptions(categories.map(c => new StringSelectMenuOptionBuilder().setLabel(c.name).setValue(c.categoryId)));
            const row = new ActionRowBuilder().addComponents(menu);
            await interaction.reply({ content: 'Select a category for this gig:', components: [row], flags: MessageFlags.Ephemeral });

        } else if (customId.startsWith('banish_gig_')) {
            const messageId = customId.split('_')[2];
            const instance = trackingDb.prepare('SELECT * FROM gig_instances WHERE message_id = ?').get(messageId);
            if (!instance) {
                return interaction.reply({ content: 'This gig instance could not be found.', flags: MessageFlags.Ephemeral });
            }
            const gig = trackingDb.prepare('SELECT * FROM gigs WHERE gig_id = ?').get(instance.gig_id);
            if (!gig) {
                return interaction.reply({ content: 'This gig could not be found.', flags: MessageFlags.Ephemeral });
            }
            if (!isModeratorOrAdmin(interaction.member)) {
                return interaction.reply({ content: 'You do not have permission to banish this user.', flags: MessageFlags.Ephemeral });
            }
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            banUser(interaction.guildId, gig.category_id, gig.user_id, interaction.user.id, 'gig banish');
            await deleteGigById(gig.gig_id);
            await ensurePostGigMessage();
            return interaction.editReply({ content: 'Gig deleted and user banished.' });

        } else if (customId.startsWith('delete_gig_')) {
            const messageId = customId.split('_')[2];

            const instance = trackingDb.prepare('SELECT * FROM gig_instances WHERE message_id = ?').get(messageId);
            if (!instance) {
                return interaction.reply({ content: 'This gig instance could not be found.', flags: MessageFlags.Ephemeral });
            }

            const gig = trackingDb.prepare('SELECT * FROM gigs WHERE gig_id = ?').get(instance.gig_id);
            if (!gig || !checkPermissions(interaction, gig.user_id)) {
                return interaction.reply({ content: 'You do not have permission to delete this gig.', flags: MessageFlags.Ephemeral });
            }

            const isModerator = isModeratorOrAdmin(interaction.member);

            if (isModerator && interaction.user.id !== gig.user_id) {
                // Ask for reason via modal
                const modal = new ModalBuilder().setCustomId(`delete_reason_${gig.gig_id}`).setTitle('Delete Reason');
                modal.addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder().setCustomId('reason').setLabel('Reason for deletion').setStyle(TextInputStyle.Paragraph).setRequired(true)
                    )
                );
                return interaction.showModal(modal);
            }

            // Delete for non-moderators or poster themselves
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            await deleteGigById(gig.gig_id);
            await ensurePostGigMessage();
            await interaction.editReply({ content: 'Gig deleted successfully from all servers.' });

        } else if (customId === 'delete_all_my_gigs') {
            if (isUserBannedForInteraction(interaction)) {
                return interaction.reply({ content: 'You are banned from using this bot.', flags: MessageFlags.Ephemeral });
            }
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const userGigs = trackingDb.prepare('SELECT gig_id FROM gigs WHERE user_id = ?').all(interaction.user.id);
            if (userGigs.length === 0) {
                return interaction.editReply({ content: 'You have no active gigs to delete.' });
            }

            for (const gig of userGigs) {
                await deleteGigById(gig.gig_id);
            }
            await ensurePostGigMessage(); // Refresh "Post a Gig" messages
            await interaction.editReply({ content: `Successfully deleted ${userGigs.length} gigs from all locations.` });

        } else if (customId.startsWith('apply_')) {
            if (!canApply(interaction)) {
                return interaction.reply({ content: 'You do not have the required role to apply for gigs.', flags: MessageFlags.Ephemeral });
            }
            
            const messageId = customId.split('_')[1];
            const instance = trackingDb.prepare('SELECT gig_id, channel_id, guild_id FROM gig_instances WHERE message_id = ?').get(messageId);
            if (!instance) return interaction.reply({ content: 'This gig is no longer available.', flags: MessageFlags.Ephemeral });
            
            const gig = trackingDb.prepare('SELECT * FROM gigs WHERE gig_id = ?').get(instance.gig_id);
            if (!gig) return interaction.reply({ content: 'This gig is no longer available.', flags: MessageFlags.Ephemeral });
            if (gig.status !== 'approved') return interaction.reply({ content: 'This gig is not currently available.', flags: MessageFlags.Ephemeral });
            if (isUserBannedForInteraction(interaction, gig.category_id)) {
                return interaction.reply({ content: 'You are banned from using this bot.', flags: MessageFlags.Ephemeral });
            }

            // Check if already applied
            const existingApplication = trackingDb.prepare('SELECT 1 FROM applications WHERE gig_id = ? AND applicant_id = ?').get(gig.gig_id, interaction.user.id);
            if (existingApplication) {
                const posterDisplay = client.users.cache.get(gig.user_id)?.tag || gig.user_id;
                const isDirectApplicant = hasDirectApplicantRole(interaction.member);
                const message = isDirectApplicant
                    ? `You have already applied for this gig. You can directly message the poster: ${posterDisplay}.`
                    : 'You have already applied for this gig. Please wait for the poster to reach out.';
                return interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
            }

            const isDirectApplicant = hasDirectApplicantRole(interaction.member);
            let applicationLabel = 'Application to Poster';
            if (isDirectApplicant) {
                const posterDisplay = client.users.cache.get(gig.user_id)?.tag || gig.user_id;
                applicationLabel = `Application to Poster (Poster: ${posterDisplay})`;
            }

            const modal = new ModalBuilder()
                .setCustomId(`apply_form_${messageId}`)
                .setTitle('Apply to Gig');
            modal.addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('apply_name')
                        .setLabel('Your Name')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                        .setMaxLength(100)
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('apply_message')
                        .setLabel(applicationLabel)
                        .setStyle(TextInputStyle.Paragraph)
                        .setRequired(true)
                        .setMaxLength(1024)
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('apply_resume')
                        .setLabel('Resume / Portfolio / CV')
                        .setStyle(TextInputStyle.Paragraph)
                        .setRequired(true)
                        .setMaxLength(1024)
                )
            );
            await interaction.showModal(modal);
        
        } else if (customId.startsWith('report_')) {
            const messageId = customId.split('_')[1];
            
            const isModerator = isModeratorOrAdmin(interaction.member);
            
            if (isModerator) {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                const instance = trackingDb.prepare('SELECT gig_id FROM gig_instances WHERE message_id = ?').get(messageId);
                if (!instance) return interaction.editReply({ content: 'This gig could not be found.' });
                
                const gig = trackingDb.prepare('SELECT user_id, category_id FROM gigs WHERE gig_id = ?').get(instance.gig_id);
                if (!gig) return interaction.editReply({ content: 'This gig could not be found.' });
                
                await interaction.editReply({ content: `**Poster Info:**\nUser ID: ${gig.user_id}\nUser: <@${gig.user_id}>` });
            } else {
                const instance = trackingDb.prepare('SELECT gig_id FROM gig_instances WHERE message_id = ?').get(messageId);
                if (!instance) return interaction.reply({ content: 'This gig could not be found.', flags: MessageFlags.Ephemeral });
                const gig = trackingDb.prepare('SELECT category_id FROM gigs WHERE gig_id = ?').get(instance.gig_id);
                if (!gig) return interaction.reply({ content: 'This gig could not be found.', flags: MessageFlags.Ephemeral });
                if (isUserBannedForInteraction(interaction, gig.category_id)) {
                    return interaction.reply({ content: 'You are banned from using this bot.', flags: MessageFlags.Ephemeral });
                }
                const modal = new ModalBuilder().setCustomId(`report_modal_${messageId}`).setTitle('Report Gig');
                modal.addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder().setCustomId('report_reason').setLabel('Reason for report').setStyle(TextInputStyle.Paragraph).setRequired(true)
                    )
                );
                await interaction.showModal(modal);
            }
        }
    }

    // --- MODAL SUBMIT ---
    if (interaction.isModalSubmit()) {
        const { customId } = interaction;
        
        if (customId.startsWith('gig_form_')) {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const categoryId = customId.split('_')[2];
            const title = interaction.fields.getTextInputValue('title');
            const description = interaction.fields.getTextInputValue('description');
            const payInput = interaction.fields.getTextInputValue('pay');
            const timeline = interaction.fields.getTextInputValue('timeline');

            if (isUserBannedForInteraction(interaction, categoryId)) {
                return interaction.editReply({ content: 'You are banned from using this bot.' });
            }

            const prohibitedMatch = findProhibitedText([title, description, payInput, timeline].filter(Boolean).join(' '));
            if (prohibitedMatch) {
                const errorMessage = `**Error:** For your security, contact details are not allowed in gig posts. The bot handles contact automatically. Please remove any contact info or usernames.\n\n**Your submitted data:**\n**Title:** ${title}\n**Description:** ${description}\n**Pay:** ${payInput}\n` + (timeline ? `**Timeline:** ${timeline}` : '');
                return interaction.editReply({ content: errorMessage });
            }
            
            // Validate description length
            if (description.length < 100) {
                const errorMessage = `**Error:** Description must be at least 100 characters. Current length: ${description.length}\n\n**Your submitted data:**\n**Title:** ${title}\n**Description:** ${description}\n**Pay:** ${payInput}\n` + (timeline ? `**Timeline:** ${timeline}` : '');
                return interaction.editReply({ content: errorMessage });
            }
            
            // Validate pay (extract number)
            const payMatch = payInput.match(/\d+/);
            if (!payMatch || parseInt(payMatch[0]) < 20) {
                const errorMessage = `**Error:** Pay must contain a number of at least 20.\n\n**Your submitted data:**\n**Title:** ${title}\n**Description:** ${description}\n**Pay:** ${payInput}\n` + (timeline ? `**Timeline:** ${timeline}` : '');
                return interaction.editReply({ content: errorMessage });
            }

            loadConfig();
            const approveMode = getCategoryApproveMode(categoryId);
            if (approveMode) {
                const reportChannels = getReportChannelIdsForCategory(categoryId);
                if (reportChannels.length === 0) {
                    return interaction.editReply({ content: 'This category requires approval, but no report channels are configured.' });
                }
            }
            const gigData = {
                gig_id: randomUUID(),
                user_id: interaction.user.id,
                category_id: categoryId,
                channel_id_created_in: interaction.channelId,
                created_at: Date.now(),
                expires_at: Date.now() + ((getChannelPolicy(interaction.channelId).expiryDays ?? DEFAULT_EXPIRY_DAYS) * 24 * 60 * 60 * 1000),
                status: approveMode ? 'pending' : 'approved'
            };

            trackingDb.prepare('INSERT INTO gigs (gig_id, user_id, category_id, channel_id_created_in, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
                gigData.gig_id, gigData.user_id, gigData.category_id, gigData.channel_id_created_in, gigData.created_at, gigData.expires_at, gigData.status
            );
            
            // Update rate limit
            trackingDb.prepare('INSERT OR REPLACE INTO rate_limits (user_id, channel_id, last_post_at) VALUES (?, ?, ?)').run(interaction.user.id, interaction.channelId, Date.now());

            const sanitizedGig = {
                title: sanitizeText(title),
                description: sanitizeText(description),
                pay: sanitizeText(payInput),
                timeline: timeline ? sanitizeText(timeline) : null
            };
            storeGigPayload(gigData.gig_id, sanitizedGig);

            if (approveMode) {
                const reportChannels = getReportChannelIdsForCategory(categoryId);
                const embed = createGigEmbed(sanitizedGig).addFields({ name: 'Poster', value: `<@${gigData.user_id}> (${gigData.user_id})` });
                for (const channelId of reportChannels) {
                    try {
                        const channel = await client.channels.fetch(channelId);
                        if (!channel || !channel.isTextBased()) continue;
                        await channel.send({
                            content: 'Pending gig approval',
                            embeds: [embed],
                            components: [createApprovalActionRow(gigData.gig_id)],
                            allowedMentions: SAFE_MENTIONS
                        });
                    } catch (error) {
                        console.error(`Failed to post approval in channel ${channelId}:`, error);
                        void reportError(`post approval channel=${channelId}`, error);
                    }
                }
                await interaction.editReply({ content: 'Your gig is pending approval.' });
                return;
            }

            await postGigToTargets(gigData, sanitizedGig);
            await ensurePostGigMessage();
            await interaction.editReply({ content: 'Your gig has been posted successfully to all configured channels!' });
        
        } else if (customId.startsWith('apply_form_')) {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const parts = customId.split('_');
            const messageId = parts[2];

            const instance = trackingDb.prepare('SELECT gig_id, channel_id, guild_id FROM gig_instances WHERE message_id = ?').get(messageId);
            if (!instance) return interaction.editReply({ content: 'This gig is no longer available.' });
            
            const gig = trackingDb.prepare('SELECT * FROM gigs WHERE gig_id = ?').get(instance.gig_id);
            if (!gig) return interaction.editReply({ content: 'This gig is no longer available.' });
            if (gig.status !== 'approved') return interaction.editReply({ content: 'This gig is not currently available.' });
            if (isUserBannedForInteraction(interaction, gig.category_id)) {
                return interaction.editReply({ content: 'You are banned from using this bot.' });
            }

            const existingApplication = trackingDb.prepare('SELECT 1 FROM applications WHERE gig_id = ? AND applicant_id = ?').get(gig.gig_id, interaction.user.id);
            const isDirectApplicant = hasDirectApplicantRole(interaction.member);
            const applicantType = isDirectApplicant ? 'direct' : 'normal';
            if (existingApplication) {
                const posterDisplay = client.users.cache.get(gig.user_id)?.tag || gig.user_id;
                const message = isDirectApplicant
                    ? `You have already applied for this gig. You can directly message the poster: ${posterDisplay}.`
                    : 'You have already applied for this gig. Please wait for the poster to reach out.';
                return interaction.editReply({ content: message });
            }

            const name = sanitizeText(interaction.fields.getTextInputValue('apply_name'));
            const application = sanitizeText(interaction.fields.getTextInputValue('apply_message'));
            const resume = sanitizeText(interaction.fields.getTextInputValue('apply_resume'));
            const messageLink = buildMessageLink(instance.guild_id, instance.channel_id, messageId);
            const categoryName = getCategoryName(gig.category_id) || 'Uncategorized';

            try {
                const poster = await client.users.fetch(gig.user_id);
                const embed = new EmbedBuilder()
                    .setColor(0x2bb673)
                    .setTitle('New Gig Application')
                    .setDescription(`**Category:** ${sanitizeText(categoryName)}\n**Gig:** ${messageLink}`)
                    .addFields(
                        { name: 'Applicant', value: `<@${interaction.user.id}> (${interaction.user.tag}, ${interaction.user.id})` },
                        { name: 'Name', value: name },
                        { name: 'Application', value: application.substring(0, 1024) },
                        { name: 'Resume / Portfolio / CV', value: resume.substring(0, 1024) }
                    )
                    .setTimestamp();
                await poster.send({ embeds: [embed], components: [createApplicationActionRow(gig.gig_id, interaction.user.id)], allowedMentions: SAFE_MENTIONS });

                trackingDb.prepare('INSERT INTO applications (gig_id, applicant_id) VALUES (?, ?)').run(gig.gig_id, interaction.user.id);
            } catch (error) {
                console.error('Failed to DM poster:', error);
                void reportError('apply_form DM poster', error);
                if (applicantType === 'direct') {
                    const posterDisplay = client.users.cache.get(gig.user_id)?.tag || gig.user_id;
                    return interaction.editReply({ content: `I couldn't deliver your application. You can message the poster directly: ${posterDisplay}.` });
                }
                return interaction.editReply({ content: 'I could not deliver your application. Please try again later.' });
            }

            if (applicantType === 'direct') {
                const posterDisplay = client.users.cache.get(gig.user_id)?.tag || gig.user_id;
                return interaction.editReply({ content: `Your application was sent. You can also message the poster directly: ${posterDisplay}.` });
            }
            return interaction.editReply({ content: 'Your application was sent. The poster will reach out if interested.' });

        } else if (customId.startsWith('report_modal_')) {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const messageId = customId.split('_')[2];
            const reason = interaction.fields.getTextInputValue('report_reason');
            
            const instance = trackingDb.prepare('SELECT gig_id, channel_id, guild_id FROM gig_instances WHERE message_id = ?').get(messageId);
            if (!instance) return interaction.editReply({ content: 'This gig could not be found.' });
            
            const gig = trackingDb.prepare('SELECT * FROM gigs WHERE gig_id = ?').get(instance.gig_id);
            if (!gig) return interaction.editReply({ content: 'This gig could not be found.' });
            if (isUserBannedForInteraction(interaction, gig.category_id)) {
                return interaction.editReply({ content: 'You are banned from using this bot.' });
            }

            const existingReport = trackingDb.prepare('SELECT 1 FROM reports WHERE gig_id = ? AND reporter_id = ?').get(gig.gig_id, interaction.user.id);
            if (existingReport) {
                return interaction.editReply({ content: 'You have already reported this gig.' });
            }

            trackingDb.prepare('INSERT INTO reports (gig_id, reporter_id) VALUES (?, ?)').run(gig.gig_id, interaction.user.id);
            
            // Send to report channels
            loadConfig();
            const reportChannels = getReportChannelIdsForCategory(gig.category_id);
            const messageLink = buildMessageLink(instance.guild_id, instance.channel_id, messageId);
            const categoryName = getCategoryName(gig.category_id) || 'Uncategorized';
            for (const channelId of reportChannels) {
                try {
                    const channel = await client.channels.fetch(channelId);
                    if (!channel || !channel.isTextBased()) {
                        console.error(`Report channel ${channelId} not found or is not a text channel.`);
                        continue;
                    }
                    await channel.send({
                        embeds: [new EmbedBuilder()
                            .setColor(0xff0000)
                            .setTitle('Gig Reported')
                            .setDescription(`**Reported by:** ${interaction.user.tag} (${interaction.user.id})\n**Poster:** <@${gig.user_id}> (${gig.user_id})\n**Category:** ${sanitizeText(categoryName)}\n**Gig:** ${messageLink}\n**Reason:** ${sanitizeText(reason)}`)
                            .addFields(
                                { name: 'Report ID', value: `${gig.gig_id}` }
                            )
                        .setTimestamp()]
                        ,
                        components: [createReportActionRow(gig.gig_id)],
                        allowedMentions: SAFE_MENTIONS
                    });
                } catch (error) {
                    console.error(`Failed to send report to channel ${channelId}:`, error);
                }
            }
            
            await interaction.editReply({ content: 'Thank you for your report. The moderators have been notified.' });
        
        } else if (customId.startsWith('delete_reason_')) {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const gigId = customId.split('_')[2];
            const reason = interaction.fields.getTextInputValue('reason');
            
            const gig = trackingDb.prepare('SELECT * FROM gigs WHERE gig_id = ?').get(gigId);
            if (!gig) return interaction.editReply({ content: 'This gig could not be found.' });
            
            const allInstances = trackingDb.prepare('SELECT * FROM gig_instances WHERE gig_id = ?').all(gigId);
            await deleteGigById(gigId);
            
            // DM poster
            let dmFailed = false;
            try {
                const poster = await client.users.fetch(gig.user_id);
                const messageLink = allInstances.length
                    ? buildMessageLink(allInstances[0].guild_id, allInstances[0].channel_id, allInstances[0].message_id)
                    : 'Unavailable';
                await poster.send({
                    embeds: [new EmbedBuilder()
                        .setColor(0xff0000)
                        .setTitle('Your Gig Was Removed')
                        .setDescription(`**Reason:** ${sanitizeText(reason)}\n**Gig:** ${messageLink}`)
                        .setTimestamp()]
                    ,
                    allowedMentions: SAFE_MENTIONS
                });
            } catch (error) {
                dmFailed = true;
                console.error('Failed to DM poster:', error);
            }
            
            await ensurePostGigMessage();
            const replyMessage = dmFailed ? 'Gig deleted, but I could not DM the poster.' : 'Gig deleted and poster notified.';
            await interaction.editReply({ content: replyMessage });
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
