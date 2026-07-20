/*
 * PORTAL BOT TEMPLATE — PROTECTED INTEGRATION BOUNDARY
 *
 * Do not replace this file with another bot, remove the bot-config.json loader,
 * or hardcode tokens/API keys. The portal generates bot-config.json, which is
 * the source of truth for selected providers, command families, ticket choices
 * and pricing. Future code updates must preserve that loader and merge changes
 * into this project through the private GitHub repository.
 */
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client, EmbedBuilder,
  GatewayIntentBits, PermissionFlagsBits, REST, Routes,
  SlashCommandBuilder, SlashCommandIntegerOption, SlashCommandStringOption, SlashCommandUserOption,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
} = require('discord.js');
const { createDatabase } = require('./db');
const fs = require('fs');
const crypto = require('crypto');

const required = ['DISCORD_TOKEN', 'CLIENT_ID'];
for (const key of required) if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);

const providerDefinitions = {
  emby: { label: 'Emby', command: 'emb', url: 'EMBY_URL', apiKey: 'EMBY_API_KEY', roles: 'EMBY_ROLE_IDS' },
  silo: { label: 'Silo', command: 'silo', url: 'SILO_URL', apiKey: 'SILO_API_KEY', roles: 'SILO_ROLE_IDS' },
  jellyfin: { label: 'Jellyfin', command: 'jelly', url: 'JELLYFIN_URL', apiKey: 'JELLYFIN_API_KEY', roles: 'JELLYFIN_ROLE_IDS' },
  plex: { label: 'Plex', command: 'plex', url: 'PLEX_URL', apiKey: 'PLEX_TOKEN', roles: 'PLEX_ROLE_IDS' },
};
const fileConfig = (() => { try { return JSON.parse(fs.readFileSync('./bot-config.json', 'utf8')); } catch { return {}; } })();
const pricing = fileConfig.pricing || (() => { try { return JSON.parse(process.env.PRICING_JSON || '{}'); } catch { return {}; } })();
const selectedProviderConfig = pricing.providers || {};
const providers = Object.fromEntries(Object.entries(providerDefinitions).filter(([key, p]) => process.env[p.url] && process.env[p.apiKey] && (!Object.keys(selectedProviderConfig).length || selectedProviderConfig[key]?.enabled !== false)));
const db = process.env.DATABASE_URL ? createDatabase() : null;
const portalUrl = String(process.env.PORTAL_URL || fileConfig.portalUrl || '').trim().replace(/\/+$/, '');

function randomPassword() { return String(crypto.randomInt(100000, 1000000)); }
function safeUsername(raw, discordId) {
  const cleaned = String(raw || '').trim().replace(/[^A-Za-z0-9._'-]/g, '_').replace(/_+/g, '_').replace(/^[._'-]+|[._'-]+$/g, '');
  return cleaned || `user_${String(discordId || 'member').slice(-6)}`;
}
function durationDetails(provider, duration, trial = false) {
  const configured = pricing.providers?.[provider] || {};
  const trialDays = Number(configured.trial_days || configured.trialDays || 5) || 5;
  if (trial || duration === 'trial_5_days') return { label: `${trialDays}-day trial`, days: trialDays, isTrial: true, isLifetime: false };
  if (duration === 'lifetime') return { label: 'Lifetime', days: null, isTrial: false, isLifetime: true };
  const months = Number(String(duration || '').match(/^(\d+)/)?.[1] || 1);
  return { label: `${months} month${months === 1 ? '' : 's'}`, days: months * 30, isTrial: false, isLifetime: false };
}
function expiryFor(plan) { return plan.days == null ? null : new Date(Date.now() + plan.days * 86400000).toISOString(); }
function requireDatabase() { if (!db) throw new Error('DATABASE_URL are required so the portal can see bot-created accounts.'); }
async function jsonRequest(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const text = await response.text(); let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) throw new Error(`${response.status}: ${typeof data === 'string' ? data : JSON.stringify(data).slice(0, 300)}`);
  return data;
}
function mediaBase(url) { return String(url || '').trim().replace(/\/+$/, '').replace(/\/(emby|jellyfin)$/i, ''); }
async function embyLikeCreate(provider, username, password, streams) {
  const def = providerDefinitions[provider];
  const base = mediaBase(process.env[def.url]);
  const token = process.env[def.apiKey];
  const headers = { 'X-Emby-Token': token, 'X-Emby-Authorization': 'MediaBrowser Client="Portal Bot", Device="Discord", DeviceId="portal-bot", Version="1.0"' };
  const user = await jsonRequest(`${base}/Users/New?api_key=${encodeURIComponent(token)}`, { method: 'POST', headers, body: JSON.stringify({ Name: username }) });
  const id = user?.Id || user?.id;
  if (!id) throw new Error(`${def.label} did not return a user ID.`);
  await jsonRequest(`${base}/Users/${encodeURIComponent(id)}/Password?api_key=${encodeURIComponent(token)}`, { method: 'POST', headers, body: JSON.stringify({ Id: id, CurrentPw: '', NewPw: password }) });
  const current = await jsonRequest(`${base}/Users/${encodeURIComponent(id)}?api_key=${encodeURIComponent(token)}`, { headers });
  const policy = { ...(current.Policy || current.policy || {}), IsAdministrator: false, IsDisabled: false, SimultaneousStreamLimit: streams };
  await jsonRequest(`${base}/Users/${encodeURIComponent(id)}/Policy?api_key=${encodeURIComponent(token)}`, { method: 'POST', headers, body: JSON.stringify(policy) });
  return { id: String(id), username };
}
async function siloCreate(username, password, streams) {
  const base = mediaBase(process.env.SILO_URL); const token = process.env.SILO_API_KEY;
  const user = await jsonRequest(`${base}/api/admin/users`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ username, email: `${username.toLowerCase()}@portal.local`, password, role: 'user', max_streams: streams, max_transcodes: streams, transcode_allowed: true, audio_transcode_allowed: true, create_default_profile: true, default_profile_name: username }) });
  const id = user?.id ?? user?.user_id;
  if (id == null) throw new Error('Silo did not return a user ID.');
  return { id: String(id), username: user.username || username };
}
async function persistAccount(provider, input, created, plan) {
  requireDatabase();
  const discordId = String(input.discordUserId || '');
  const nativeTable = provider === 'emby' ? 'emby_accounts' : provider === 'silo' ? 'silo_accounts' : null;
  const native = nativeTable === 'emby' ? { discord_user_id: discordId, emby_user_id: created.id, parent_emby_user_id: input.parentProviderUserId || null, username: created.username, password: input.password, is_trial: plan.isTrial, is_lifetime: plan.isLifetime, connections: input.streams, total_pool: plan.isLifetime ? input.streams : null, expires_at: input.expiresAt } : nativeTable === 'silo' ? { discord_user_id: discordId, silo_user_id: created.id, parent_silo_user_id: input.parentProviderUserId || null, username: created.username, password: input.password, is_trial: plan.isTrial, is_lifetime: plan.isLifetime, connections: input.streams, total_pool: plan.isLifetime ? input.streams : null, expires_at: input.expiresAt } : null;
  if (native) { const { error } = await db.from(nativeTable).insert(native); if (error) throw new Error(`Portal account storage failed: ${error.message}`); }
  const { error } = await db.from('discord_bot_memberships').insert({ discord_user_id: discordId, provider, provider_user_id: created.id, username: created.username, plan_key: input.duration, is_trial: plan.isTrial, is_lifetime: plan.isLifetime, expires_at: input.expiresAt, connections: input.streams, parent_membership_id: input.parentMembershipId || null });
  if (error) throw new Error(`Bot membership storage failed: ${error.message}`);
}
async function findLifetimeParent(provider, discordUserId) {
  requireDatabase();
  const table = provider === 'emby' ? 'emby_accounts' : provider === 'silo' ? 'silo_accounts' : null;
  if (table) {
    const { data, error } = await db.from(table).select('*').eq('discord_user_id', String(discordUserId)).is(provider === 'emby' ? 'parent_emby_user_id' : 'parent_silo_user_id', null).eq('is_lifetime', true).maybeSingle();
    if (error) throw new Error(`Could not find the Lifetime parent: ${error.message}`);
    if (data) {
      const providerUserId = provider === 'emby' ? data.emby_user_id : data.silo_user_id;
      const { data: membership } = await db.from('discord_bot_memberships').select('id').eq('discord_user_id', String(discordUserId)).eq('provider', provider).eq('provider_user_id', String(providerUserId)).maybeSingle();
      return { ...data, provider_user_id: providerUserId, membership_id: membership?.id || null };
    }
  }
  const { data, error } = await db.from('discord_bot_memberships').select('*').eq('discord_user_id', String(discordUserId)).eq('provider', provider).eq('is_lifetime', true).is('parent_membership_id', null).maybeSingle();
  if (error) throw new Error(`Could not find the Lifetime parent: ${error.message}`);
  return data ? { ...data, membership_id: data.id } : null;
}
function accountEmbed(provider, input, created, plan) {
  const def = providerDefinitions[provider];
  const server = String(process.env[def.url] || '').replace(/\/+$/, '');
  const expiry = plan.isLifetime ? 'Never (Lifetime)' : `<t:${Math.floor(new Date(input.expiresAt).getTime() / 1000)}:F> (<t:${Math.floor(new Date(input.expiresAt).getTime() / 1000)}:R>)`;
  return new EmbedBuilder().setTitle(`✅ Your ${def.label} Account`).setDescription(`Here are your ${def.label} login details.\n\n**Username:** \`${created.username}\`\n**Password:** \`${input.password}\`\n**Server:** ${server}\n**Streams:** ${input.streams}\n**Plan:** ${plan.label}\n**Expires:** ${expiry}\n\n**Member Portal:** ${portalUrl || 'Set PORTAL_URL in the bot environment'}\nLog in with Discord to manage your linked services and subscription.`).setColor(0x7168f7).setTimestamp();
}

function providerCommands() {
  const months = Array.from({ length: 12 }, (_, i) => ({ name: `${i + 1} month${i ? 's' : ''}`, value: `${i + 1}_month${i ? 's' : ''}` }));
  const plans = [...months, { name: 'Lifetime', value: 'lifetime' }];
  const streams = [1, 2, 3, 4, 10].map(value => ({ name: `${value} stream${value === 1 ? '' : 's'}${value === 10 ? ' (Lifetime)' : ''}`, value }));
  return Object.entries(providers).flatMap(([key, p]) => {
    const user = (name = 'user', description = 'Discord member') => new SlashCommandUserOption().setName(name).setDescription(description).setRequired(true);
    const duration = (required = true) => new SlashCommandStringOption().setName('duration').setDescription('Subscription duration').setRequired(required).addChoices(...plans);
    const stream = (required = true) => new SlashCommandIntegerOption().setName('streams').setDescription('Stream limit').setRequired(required).setMinValue(1).setMaxValue(10).addChoices(...streams);
    return [
      new SlashCommandBuilder().setName(`${p.command}trial`).setDescription(`Create a 5-day ${p.label} trial`).addUserOption(user('member')),
      new SlashCommandBuilder().setName(`${p.command}add`).setDescription(`Create a ${p.label} membership account`).addUserOption(user('member')).addIntegerOption(o => o.setName('streams').setDescription('Stream count').setRequired(true).setMinValue(1).setMaxValue(10).addChoices(...streams)).addStringOption(o => o.setName('duration').setDescription('Duration or lifetime').setRequired(true).addChoices(...plans)),
      new SlashCommandBuilder().setName(`${p.command}delete`).setDescription(`Delete a ${p.label} account and linked membership`).addUserOption(o => o.setName('user').setDescription('Discord member').setRequired(false)).addStringOption(o => o.setName('userid').setDescription('Discord user ID').setRequired(false)),
      new SlashCommandBuilder().setName(`${p.command}renew`).setDescription(`Extend a ${p.label} subscription`).addUserOption(user()).addStringOption(duration()).addIntegerOption(o => o.setName('streams').setDescription('Optional new stream limit').setRequired(false).setMinValue(1).setMaxValue(4).addChoices(...streams.slice(0, 4))),
      new SlashCommandBuilder().setName(`${p.command}lookup`).setDescription(`Look up a ${p.label} membership`).addUserOption(user()),
      new SlashCommandBuilder().setName(`${p.command}addsub`).setDescription(`Add a sub-user to a ${p.label} Lifetime pool`).addUserOption(user('user', 'Lifetime parent')).addStringOption(o => o.setName('username').setDescription('Sub-user username').setRequired(true)).addIntegerOption(o => o.setName('streams').setDescription('Streams from pool').setRequired(true).setMinValue(1).setMaxValue(10)),
      new SlashCommandBuilder().setName(`${p.command}poollookup`).setDescription(`Show a ${p.label} Lifetime pool`).addUserOption(user('user', 'Lifetime parent')),
      new SlashCommandBuilder().setName(`${p.command}upgrade`).setDescription(`Upgrade a ${p.label} membership`).addUserOption(user()).addStringOption(o => o.setName('duration').setDescription('New plan').setRequired(true).addChoices(...plans)).addIntegerOption(o => o.setName('streams').setDescription('Stream limit').setRequired(true).setMinValue(1).setMaxValue(10).addChoices(...streams)),
      new SlashCommandBuilder().setName(`${p.command}reclaim`).setDescription(`Reclaim streams from a ${p.label} sub-user`).addUserOption(user('user', 'Lifetime parent')).addStringOption(o => o.setName('sub').setDescription('Sub-user username').setRequired(true)).addIntegerOption(o => o.setName('reduce_by').setDescription('Streams to reclaim').setRequired(true).setMinValue(1).setMaxValue(10)),
      new SlashCommandBuilder().setName(`${p.command}addstream`).setDescription(`Add streams to a ${p.label} sub-user`).addUserOption(user('user', 'Lifetime parent')).addStringOption(o => o.setName('sub').setDescription('Sub-user username').setRequired(true)).addIntegerOption(o => o.setName('add_by').setDescription('Streams to add').setRequired(true).setMinValue(1).setMaxValue(10)),
      new SlashCommandBuilder().setName(`${p.command}deletesub`).setDescription(`Delete a ${p.label} sub-user`).addStringOption(o => o.setName('username').setDescription('Exact sub-user username').setRequired(true)),
    ];
  });
}
const commands = [
  new SlashCommandBuilder().setName('pricing').setDescription('Show configured membership pricing'),
  new SlashCommandBuilder().setName('ticketpanel').setDescription('Post the support ticket panel').setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels.toString()),
  new SlashCommandBuilder().setName('ticketclose').setDescription('Close the current ticket').setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels.toString()),
  ...providerCommands(),
].map(c => c.toJSON());

async function register() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const route = process.env.DISCORD_GUILD_ID ? Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.DISCORD_GUILD_ID) : Routes.applicationCommands(process.env.CLIENT_ID);
  await rest.put(route, { body: commands });
  console.log(`Registered ${commands.length} commands; providers: ${Object.keys(providers).join(', ') || 'none'}.`);
}
if (process.argv[2] === 'register') { register().catch(error => { console.error(error); process.exit(1); }); return; }

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers] });
const providerCreateForCommand = name => Object.entries(providers).find(([, p]) => name === `${p.command}trial` || name === `${p.command}add` || name === `${p.command}addsub`);
async function saveMembership(row) { if (db) await db.from('discord_bot_memberships').upsert(row, { onConflict: 'discord_user_id,provider,provider_user_id' }); }
function priceText(provider) {
  const rows = pricing.providers?.[provider]?.prices || pricing[provider] || {};
  const lines = [];
  for (const [streams, durations] of Object.entries(rows)) for (const [duration, price] of Object.entries(durations || {})) if (String(price).trim()) lines.push(`${streams} streams · ${duration.replace('_', ' ')} · ${price}`);
  return lines.length ? lines.join('\n') : 'No paid prices configured.';
}
async function createProviderAccount(provider, input) {
  const plan = durationDetails(provider, input.duration, input.trial);
  if (plan.isLifetime && input.streams !== 10) throw new Error('Lifetime accounts must use 10 streams.');
  if (!plan.isLifetime && input.streams === 10) throw new Error('10 streams is reserved for Lifetime accounts.');
  const username = safeUsername(input.username || input.memberDisplayName, input.discordUserId);
  const password = randomPassword();
  const created = provider === 'silo'
    ? await siloCreate(username, password, input.streams)
    : provider === 'emby' || provider === 'jellyfin'
      ? await embyLikeCreate(provider, username, password, input.streams)
      : (() => { throw new Error('Plex account creation requires a provider-specific invite/claim adapter and was not guessed in the sanitized template.'); })();
  const expiresAt = expiryFor(plan);
  await persistAccount(provider, { ...input, username, password, expiresAt }, created, plan);
  return { created, plan, password, expiresAt, username };
}

client.once('ready', () => console.log(`Online as ${client.user.tag}; enabled providers: ${Object.keys(providers).join(', ') || 'none'}`));
client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'pricing') return interaction.reply({ embeds: [new EmbedBuilder().setTitle('Membership pricing').setDescription(Object.keys(providers).map(key => `**${providerDefinitions[key].label}**\n${priceText(key)}`).join('\n\n') || 'No media servers are configured.')], ephemeral: true });
      if (interaction.commandName === 'ticketpanel') {
        const options = [new StringSelectMenuOptionBuilder().setLabel('General support').setValue('general').setDescription('Questions and account help')];
        for (const [key, provider] of Object.entries(providers)) options.push(new StringSelectMenuOptionBuilder().setLabel(`${provider.label} support`).setValue(key).setDescription(`${provider.label} account and membership help`));
        const menu = new StringSelectMenuBuilder().setCustomId('portal_ticket_category').setPlaceholder('Choose a support category').addOptions(options.slice(0, 25));
        return interaction.reply({ embeds: [new EmbedBuilder().setTitle('Support tickets').setDescription('Choose a category below to open a private support ticket.')], components: [new ActionRowBuilder().addComponents(menu)] });
      }
      if (interaction.commandName === 'ticketclose') { if (!interaction.channel?.name?.startsWith('ticket-')) return interaction.reply({ content: 'This is not a ticket channel.', ephemeral: true }); await interaction.reply('Closing ticket…'); return interaction.channel.delete().catch(() => null); }
      const match = providerCreateForCommand(interaction.commandName);
      if (match) {
        const [key, p] = match;
        await interaction.deferReply({ ephemeral: true });
        const isSub = interaction.commandName === `${p.command}addsub`;
        const parentMember = isSub ? interaction.options.getUser('user') : null;
        const member = isSub ? parentMember : interaction.options.getUser('member');
        if (!member) return interaction.editReply({ content: 'Choose the Discord member to link to this account.' });
        const parentRecord = isSub ? await findLifetimeParent(key, parentMember.id) : null;
        if (isSub && !parentRecord) return interaction.editReply({ content: `No Lifetime ${p.label} parent account was found for ${parentMember}.` });
        const input = {
          discordUserId: member.id,
          memberDisplayName: member.globalName || member.username,
          streams: interaction.commandName === `${p.command}trial` ? 2 : interaction.options.getInteger('streams'),
          duration: interaction.commandName === `${p.command}trial` ? 'trial_5_days' : interaction.options.getString('duration'),
          trial: interaction.commandName === `${p.command}trial`,
          username: isSub ? interaction.options.getString('username') : null,
          parentProviderUserId: parentRecord?.provider_user_id || parentRecord?.emby_user_id || parentRecord?.silo_user_id || null,
          parentMembershipId: parentRecord?.membership_id || null,
        };
        if (!input.streams) return interaction.editReply({ content: 'Choose a stream count.' });
        const result = await createProviderAccount(key, input);
        const embed = accountEmbed(key, { ...input, password: result.password, expiresAt: result.expiresAt }, result.created, result.plan);
        await interaction.channel.send({ content: `${member}`, embeds: [embed], allowedMentions: { users: [member.id] } });
        const dm = await member.send({ embeds: [embed] }).then(() => true).catch(() => false);
        const roleId = String(process.env[p.roles] || '').split(',').map(value => value.trim()).find(value => /^\d{15,25}$/.test(value));
        if (roleId && !isSub) { const guildMember = await interaction.guild.members.fetch(member.id).catch(() => null); if (guildMember) await guildMember.roles.add(roleId).catch(() => null); }
        return interaction.editReply({ content: `✅ ${p.label} account **${result.username}** created, stored with Discord ID **${member.id}**, posted in this channel and ${dm ? 'DM sent.' : 'DM could not be sent (the user may have DMs disabled).'}` });
      }
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'portal_ticket_category') { const category = interaction.values[0]; const channel = await interaction.guild.channels.create({ name: `ticket-${category}-${interaction.user.username}`.slice(0, 90), type: ChannelType.GuildText, permissionOverwrites: [{ id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }, { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }] }); const close = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('portal_ticket_close').setLabel('Close ticket').setStyle(ButtonStyle.Danger)); await channel.send({ content: `Support ticket category: **${category}**\nA staff member will be with you shortly.`, components: [close] }); return interaction.reply({ content: `Your ticket is ready: ${channel}`, ephemeral: true }); }
    if (interaction.isButton() && interaction.customId === 'portal_ticket_close') { if (!interaction.channel?.name?.startsWith('ticket-')) return interaction.reply({ content: 'This is not a ticket channel.', ephemeral: true }); await interaction.reply('Closing ticket…'); return interaction.channel.delete().catch(() => null); }
  } catch (error) { console.error(error); if (interaction.replied || interaction.deferred) await interaction.followUp({ content: error.message, ephemeral: true }).catch(() => null); else await interaction.reply({ content: error.message, ephemeral: true }).catch(() => null); }
});
client.login(process.env.DISCORD_TOKEN);
