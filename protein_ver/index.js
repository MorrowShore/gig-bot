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
const ADMIN_USER_IDS = ['1103986864861478912', '1103958491015688282'];
const DEFAULT_EXPIRY_DAYS = 7;
const DEFAULT_COOLDOWN_DAYS = 3;

// --- DATABASE SETUP ---
configDb.exec(`
  CREATE TABLE IF NOT EXISTS roles (
    type TEXT NOT NULL,
    role_id TEXT NOT NULL,
    PRIMARY KEY (type, role_id)
  );
  CREATE TABLE IF NOT EXISTS categories (
    category_id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
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
    expires_at INTEGER NOT NULL
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
    channelPolicies: new Map()
};

const loadConfig = (force = false) => {
    const now = Date.now();
    if (!force && now - configCache.lastLoaded < configCache.ttlMs) return;

    configCache.roles.clear();
    configCache.categories.clear();
    configCache.categoryTargets.clear();
    configCache.categoryReports.clear();
    configCache.channelPolicies.clear();

    for (const { type, role_id } of configDb.prepare('SELECT type, role_id FROM roles').all()) {
        if (!configCache.roles.has(type)) configCache.roles.set(type, new Set());
        configCache.roles.get(type).add(role_id);
    }

    for (const { category_id, name } of configDb.prepare('SELECT category_id, name FROM categories').all()) {
        configCache.categories.set(category_id, name);
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

    configCache.lastLoaded = now;
};

const getRoleIds = (type) => Array.from(configCache.roles.get(type) || []);
const getCategoryIdByName = (name) => {
    const entry = Array.from(configCache.categories.entries()).find(([, categoryName]) => categoryName === name);
    return entry ? entry[0] : null;
};
const getCategoryName = (categoryId) => configCache.categories.get(categoryId);
const getCategoriesForChannel = (channelId) => {
    const result = [];
    for (const [categoryId, channels] of configCache.categoryTargets.entries()) {
        if (channels.has(channelId)) {
            result.push({ categoryId, name: configCache.categories.get(categoryId) || categoryId });
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
const getChannelPolicy = (channelId) => configCache.channelPolicies.get(channelId) || {};

const sanitizeText = (text) => {
    if (!text) return '';
    let result = text.replace(/@everyone/gi, '@\u200beveryone').replace(/@here/gi, '@\u200bhere');
    result = result.replace(/[\\`*_~|>]/g, '\\$&');
    return result;
};

const SAFE_MENTIONS = { parse: [] };

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
    const reportChannels = getReportChannelIds();
    if (!reportChannels.length || !client.isReady()) return;
    const content = buildReportMessage(context, error);
    for (const channelId of reportChannels) {
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
    const expiredGigs = trackingDb.prepare('SELECT gig_id FROM gigs WHERE expires_at < ?').all(now);
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
    const targetChecks = await Promise.all(getTargetChannelIds().map(c => getChannelAccessStatus(c)));
    const reportChecks = await Promise.all(getReportChannelIds().map(c => getChannelAccessStatus(c)));

    const lines = [
        '**Health Check**',
        `**Targets:** ${targetChecks.map(c => `${c.channelId} (${c.status})`).join(', ') || 'none'}`,
        `**Reports:** ${reportChecks.map(c => `${c.channelId} (${c.status})`).join(', ') || 'none'}`
    ];
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
            { type: 1, name: 'set-expiry', description: 'Set expiry days for a channel', options: [{ type: 7, name: 'channel', description: 'Channel', required: true }, { type: 4, name: 'days', description: 'Days', required: true }] },
            { type: 1, name: 'clear-expiry', description: 'Clear expiry override', options: [{ type: 7, name: 'channel', description: 'Channel', required: true }] },
            { type: 1, name: 'set-cooldown', description: 'Set cooldown days for a channel', options: [{ type: 7, name: 'channel', description: 'Channel', required: true }, { type: 4, name: 'days', description: 'Days', required: true }] },
            { type: 1, name: 'clear-cooldown', description: 'Clear cooldown override', options: [{ type: 7, name: 'channel', description: 'Channel', required: true }] }
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

const hasRole = (member, roleIds) => roleIds.some(roleId => member.roles.cache.has(roleId));

const isAdmin = (member) =>
    ADMIN_USER_IDS.includes(member.id) ||
    hasRole(member, ADMIN_ROLE_IDS);

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
        if (interaction.commandName === 'category') {
            loadConfig();
            const focused = interaction.options.getFocused(true);
            if (focused.name === 'name') {
                const needle = focused.value.toLowerCase();
                const options = Array.from(configCache.categories.values())
                    .filter(name => name.toLowerCase().includes(needle))
                    .slice(0, 25)
                    .map(name => ({ name, value: name }));
                return respondWithAutocomplete(interaction, options);
            }
        }
        return;
    }

    loadConfig();

    if (interaction.isChatInputCommand()) {
        if (!isAdmin(interaction.member)) {
            return interaction.reply({ content: 'You do not have permission to use this command.', flags: MessageFlags.Ephemeral });
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
                const names = Array.from(configCache.categories.values()).sort();
                return interaction.editReply({ content: names.length ? names.join(', ') : 'No categories configured.' });
            }
            if (sub === 'show') {
                const categoryId = getCategoryIdByName(name);
                if (!categoryId) return interaction.editReply({ content: 'Category not found.' });
                const targets = Array.from(configCache.categoryTargets.get(categoryId) || []).map(id => `<#${id}>`).join(', ') || 'none';
                const reports = Array.from(configCache.categoryReports.get(categoryId) || []).map(id => `<#${id}>`).join(', ') || 'none';
                return interaction.editReply({ content: `**${name}**\nTargets: ${targets}\nReports: ${reports}`, allowedMentions: SAFE_MENTIONS });
            }

            const categoryId = getCategoryIdByName(name);
            if (!categoryId) return interaction.editReply({ content: 'Category not found.' });
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
                return interaction.editReply({ content: `Removed target channels from **${name}**.` });
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
                return interaction.editReply({ content: `Removed report channels from **${name}**.` });
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
            const channel = interaction.options.getChannel('channel');
            if (!channel) return interaction.editReply({ content: 'Channel not found.' });

            const existing = configDb.prepare('SELECT expiry_days, cooldown_days FROM channel_policies WHERE channel_id = ?').get(channel.id) || {};

            if (sub === 'set-expiry') {
                const days = interaction.options.getInteger('days');
                configDb.prepare('INSERT INTO channel_policies (channel_id, expiry_days, cooldown_days) VALUES (?, ?, ?) ON CONFLICT(channel_id) DO UPDATE SET expiry_days = excluded.expiry_days').run(channel.id, days, existing.cooldown_days ?? null);
                loadConfig(true);
                return interaction.editReply({ content: `Set expiry for <#${channel.id}> to ${days} days.`, allowedMentions: SAFE_MENTIONS });
            }
            if (sub === 'clear-expiry') {
                configDb.prepare('INSERT INTO channel_policies (channel_id, expiry_days, cooldown_days) VALUES (?, ?, ?) ON CONFLICT(channel_id) DO UPDATE SET expiry_days = excluded.expiry_days').run(channel.id, null, existing.cooldown_days ?? null);
                loadConfig(true);
                return interaction.editReply({ content: `Cleared expiry override for <#${channel.id}>.`, allowedMentions: SAFE_MENTIONS });
            }
            if (sub === 'set-cooldown') {
                const days = interaction.options.getInteger('days');
                configDb.prepare('INSERT INTO channel_policies (channel_id, expiry_days, cooldown_days) VALUES (?, ?, ?) ON CONFLICT(channel_id) DO UPDATE SET cooldown_days = excluded.cooldown_days').run(channel.id, existing.expiry_days ?? null, days);
                loadConfig(true);
                return interaction.editReply({ content: `Set cooldown for <#${channel.id}> to ${days} days.`, allowedMentions: SAFE_MENTIONS });
            }
            if (sub === 'clear-cooldown') {
                configDb.prepare('INSERT INTO channel_policies (channel_id, expiry_days, cooldown_days) VALUES (?, ?, ?) ON CONFLICT(channel_id) DO UPDATE SET cooldown_days = excluded.cooldown_days').run(channel.id, existing.expiry_days ?? null, null);
                loadConfig(true);
                return interaction.editReply({ content: `Cleared cooldown override for <#${channel.id}>.`, allowedMentions: SAFE_MENTIONS });
            }
        }

        return;
    }

    if (interaction.isStringSelectMenu()) {
        if (interaction.customId === 'select_category') {
            const categoryId = interaction.values[0];
            return showGigModal(interaction, categoryId);
        }
        return;
    }

    if (!interaction.isButton() && !interaction.isModalSubmit()) return;

    // --- BUTTONS ---
    if (interaction.isButton()) {
        const { customId } = interaction;
        
        if (customId === 'create_gig') {
            try {
                loadConfig();
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
            if (!isModeratorOrAdmin(interaction.member) && !checkRateLimit(interaction.user.id, interaction.channelId)) {
                return interaction.reply({ content: 'You can only post one gig every 3 days in this channel.', flags: MessageFlags.Ephemeral });
            }
            loadConfig();
            const categories = getCategoriesForChannel(interaction.channelId);
            if (categories.length === 0) {
                return interaction.reply({ content: 'No categories are configured for this channel.', flags: MessageFlags.Ephemeral });
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
            const allInstances = trackingDb.prepare('SELECT * FROM gig_instances WHERE gig_id = ?').all(gig.gig_id);
            for (const inst of allInstances) {
                try {
                    const channel = await client.channels.fetch(inst.channel_id);
                    await channel.messages.delete(inst.message_id);
                } catch (error) {
                    console.error(`Failed to delete gig message ${inst.message_id} in channel ${inst.channel_id}:`, error);
                    void reportError(`delete gig message_id=${inst.message_id} channel=${inst.channel_id}`, error);
                }
            }
            trackingDb.prepare('DELETE FROM gigs WHERE gig_id = ?').run(gig.gig_id);
            await ensurePostGigMessage();
            await interaction.editReply({ content: 'Gig deleted successfully from all servers.' });

        } else if (customId === 'delete_all_my_gigs') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const userGigs = trackingDb.prepare('SELECT gig_id FROM gigs WHERE user_id = ?').all(interaction.user.id);
            if (userGigs.length === 0) {
                return interaction.editReply({ content: 'You have no active gigs to delete.' });
            }

            for (const gig of userGigs) {
                const allInstances = trackingDb.prepare('SELECT * FROM gig_instances WHERE gig_id = ?').all(gig.gig_id);
                for (const inst of allInstances) {
                    try {
                        const channel = await client.channels.fetch(inst.channel_id);
                        await channel.messages.delete(inst.message_id);
                    } catch (error) {
                        console.error(`Failed to delete gig message ${inst.message_id} in channel ${inst.channel_id}:`, error);
                        void reportError(`delete user gig message_id=${inst.message_id} channel=${inst.channel_id}`, error);
                    }
                }
            }
            trackingDb.prepare('DELETE FROM gigs WHERE user_id = ?').run(interaction.user.id);
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
                
                const gig = trackingDb.prepare('SELECT user_id FROM gigs WHERE gig_id = ?').get(instance.gig_id);
                if (!gig) return interaction.editReply({ content: 'This gig could not be found.' });
                
                await interaction.editReply({ content: `**Poster Info:**\nUser ID: ${gig.user_id}\nUser: <@${gig.user_id}>` });
            } else {
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
            const gigData = {
                gig_id: randomUUID(),
                user_id: interaction.user.id,
                category_id: categoryId,
                channel_id_created_in: interaction.channelId,
                created_at: Date.now(),
                expires_at: Date.now() + ((getChannelPolicy(interaction.channelId).expiryDays ?? DEFAULT_EXPIRY_DAYS) * 24 * 60 * 60 * 1000)
            };

            trackingDb.prepare('INSERT INTO gigs (gig_id, user_id, category_id, channel_id_created_in, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(
                gigData.gig_id, gigData.user_id, gigData.category_id, gigData.channel_id_created_in, gigData.created_at, gigData.expires_at
            );
            
            // Update rate limit
            trackingDb.prepare('INSERT OR REPLACE INTO rate_limits (user_id, channel_id, last_post_at) VALUES (?, ?, ?)').run(interaction.user.id, interaction.channelId, Date.now());

            const targetChannels = Array.from(configCache.categoryTargets.get(categoryId) || []);
            const sanitizedGig = {
                title: sanitizeText(title),
                description: sanitizeText(description),
                pay: sanitizeText(payInput),
                timeline: timeline ? sanitizeText(timeline) : null
            };
            for (const channelId of targetChannels) {
                try {
                    const channel = await client.channels.fetch(channelId);
                    const gigMessage = await channel.send({
                        embeds: [createGigEmbed(sanitizedGig)],
                        components: [
                            new ActionRowBuilder().addComponents(
                                new ButtonBuilder().setCustomId(`apply_${'TEMP_ID'}`).setLabel('Apply').setStyle(ButtonStyle.Primary),
                                new ButtonBuilder().setCustomId(`report_${'TEMP_ID'}`).setLabel('Report').setStyle(ButtonStyle.Secondary),
                                new ButtonBuilder().setCustomId(`delete_gig_${'TEMP_ID'}`).setLabel('Delete').setStyle(ButtonStyle.Danger)
                            )
                        ],
                        allowedMentions: SAFE_MENTIONS
                    });
                    
                    const updatedComponents = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`apply_${gigMessage.id}`).setLabel('Apply').setStyle(ButtonStyle.Primary),
                        new ButtonBuilder().setCustomId(`report_${gigMessage.id}`).setLabel('Report').setStyle(ButtonStyle.Secondary),
                        new ButtonBuilder().setCustomId(`delete_gig_${gigMessage.id}`).setLabel('Delete').setStyle(ButtonStyle.Danger)
                    );
                    await gigMessage.edit({ components: [updatedComponents], allowedMentions: SAFE_MENTIONS });

                    trackingDb.prepare('INSERT INTO gig_instances (message_id, gig_id, guild_id, channel_id, created_at) VALUES (?, ?, ?, ?, ?)').run(
                        gigMessage.id, gigData.gig_id, gigMessage.guildId, channelId, Date.now()
                    );
                } catch (error) {
                    console.error(`Failed to post gig in channel ${channelId}:`, error);
                    void reportError(`post gig channel=${channelId}`, error);
                }
            }

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
                        { name: 'Applicant', value: `${interaction.user.tag} (${interaction.user.id})` },
                        { name: 'Name', value: name },
                        { name: 'Application', value: application.substring(0, 1024) },
                        { name: 'Resume / Portfolio / CV', value: resume.substring(0, 1024) }
                    )
                    .setTimestamp();
                await poster.send({ embeds: [embed], allowedMentions: SAFE_MENTIONS });

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

            const existingReport = trackingDb.prepare('SELECT 1 FROM reports WHERE gig_id = ? AND reporter_id = ?').get(gig.gig_id, interaction.user.id);
            if (existingReport) {
                return interaction.editReply({ content: 'You have already reported this gig.' });
            }

            trackingDb.prepare('INSERT INTO reports (gig_id, reporter_id) VALUES (?, ?)').run(gig.gig_id, interaction.user.id);
            
            // Send to report channels
            loadConfig();
            const reportChannels = getReportChannelIds();
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
            for (const inst of allInstances) {
                try {
                    const channel = await client.channels.fetch(inst.channel_id);
                    await channel.messages.delete(inst.message_id);
                } catch (error) {
                    console.error(`Failed to delete gig message ${inst.message_id}:`, error);
                    void reportError(`delete gig message_id=${inst.message_id}`, error);
                }
            }
            trackingDb.prepare('DELETE FROM gigs WHERE gig_id = ?').run(gigId);
            
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
