const { setTimeout: delay } = require('node:timers/promises');

const engine = 'slack-chat';
const maxText = 4000;
const tokenKey = id => `slack:${id}`;

function conversationId(value) {
  const input = typeof value === 'string' ? value.trim() : '';
  const id = /^https:\/\/app\.slack\.com\/client\/T[A-Z0-9]+\/(D[A-Z0-9]+)\/?$/.exec(input)?.[1] || input;
  if (!/^D[A-Z0-9]{2,31}$/.test(id)) throw new Error('请输入 Slack 私信的 D 开头会话 ID，或粘贴它的 Slack 链接。');
  return id;
}

function userToken(value) {
  const token = typeof value === 'string' ? value.trim() : '';
  if (!/^xoxp-[a-z\d-]+$/i.test(token) || token.length > 4096) {
    throw new Error('请输入 Slack 应用授权后生成的 User OAuth Token（xoxp- 开头）。');
  }
  return token;
}

function slackError(code) {
  if (['invalid_auth', 'not_authed', 'token_revoked', 'account_inactive'].includes(code)) {
    return new Error('Slack 用户授权失效。请在角色设置更新授权令牌。');
  }
  if (code === 'missing_scope') return new Error('Slack 授权需要 chat:write、im:read 和 im:history 用户权限。');
  if (['channel_not_found', 'not_in_channel', 'thread_not_found'].includes(code)) {
    return new Error('Slack 找不到私信或消息线程。请检查会话 ID 和登录的 Slack 账号。');
  }
  return new Error('Slack 请求失败。请检查网络和 Slack 应用的访问权限。');
}

class SlackChat {
  constructor({ store, vault, emit, fetchFor, timeoutMs = 120000, wait = delay }) {
    Object.assign(this, { store, vault, emit, fetchFor, timeoutMs, wait });
    this.active = new Set();
  }

  async request(fetch, token, method, values, signal, post = false) {
    const url = new URL(method, 'https://slack.com/api/');
    if (!post) url.search = new URLSearchParams(values).toString();
    const response = await fetch(url.toString(), {
      method: post ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, ...(post ? { 'Content-Type': 'application/json' } : {}) },
      body: post ? JSON.stringify(values) : undefined,
      redirect: 'error', signal,
    });
    if (response.status === 429) {
      const seconds = Number(response.headers.get('Retry-After'));
      if (!post) return { retryMs: (seconds > 0 ? seconds : 30) * 1000 };
      throw new Error('Slack 暂时限制了发送频率，请稍后再试。');
    }
    if (!response.ok) throw slackError();
    const data = await response.json();
    if (!data.ok) throw slackError(data.error);
    const scopes = response.headers.get('x-oauth-scopes');
    if (method === 'conversations.info' && scopes !== null) {
      const available = scopes.split(',').map(scope => scope.trim());
      const canWrite = available.includes('chat:write') || available.includes('chat:write:user');
      if (!canWrite || !available.includes('im:read') || !available.includes('im:history')) throw slackError('missing_scope');
    }
    return data;
  }

  async connect(role, signal) {
    const channel = conversationId(role.slackChannel);
    const token = userToken(this.vault.get(tokenKey(role.id)));
    const fetch = await this.fetchFor(role);
    const info = await this.request(fetch, token, 'conversations.info', { channel }, signal);
    if (info.retryMs) throw new Error('Slack 暂时限制了请求频率，请稍后再试。');
    if (info.channel?.id !== channel || !info.channel.is_im || !info.channel.user) {
      throw new Error('这个角色只能使用一对一 Slack 私信。请核对会话 ID。');
    }
    return { channel, peer: info.channel.user, fetch, token };
  }

  async send({ channel, fetch, token }, text, signal) {
    const sent = await this.request(fetch, token, 'chat.postMessage', {
      channel, text, mrkdwn: false, unfurl_links: false, unfurl_media: false,
    }, signal, true);
    if (sent.channel !== channel || !/^\d+\.\d+$/.test(sent.ts)) throw slackError();
    return sent.ts;
  }

  async reply({ channel, peer, fetch, token }, ts, signal) {
    let answer = '';
    let anchor = '';
    const replyText = message => message.user === peer && typeof message.text === 'string' ? message.text.trim() : '';
    while (!signal.aborted) {
      const thread = await this.request(fetch, token, 'conversations.replies', { channel, ts, limit: '15' }, signal);
      let retryMs = thread.retryMs;
      let source = ts;
      let value = (thread.messages || []).filter(message => message.thread_ts === ts && message.ts !== ts)
        .map(replyText).filter(Boolean).join('\n\n');
      if (!value && !retryMs) {
        const history = await this.request(fetch, token, 'conversations.history', { channel, oldest: ts, limit: '15' }, signal);
        retryMs = history.retryMs;
        const newer = (history.messages || []).filter(message => Number(message.ts) > Number(ts) &&
          (!message.thread_ts || message.thread_ts === message.ts));
        // With no thread ID, attribute only a sole top-level response in this time window.
        // A newer message from the owner or multiple possible responses make the match ambiguous.
        if (!history.has_more && !history.response_metadata?.next_cursor && newer.length === 1) {
          source = newer[0].ts;
          value = replyText(newer[0]);
        }
      }
      if (value && value === answer && source === anchor) return value;
      answer = value;
      anchor = source;
      await this.wait(retryMs || 3500, undefined, { signal });
    }
    signal.throwIfAborted();
  }

  async run(chat, role, text, signal) {
    if (signal.aborted) return { status: 'cancelled' };
    const channel = conversationId(role.slackChannel);
    const fields = { kind: 'assistant', roleId: role.id, roleName: role.name, locationId: 'local', text: '' };
    if (this.active.has(channel)) {
      const message = this.store.message(chat.id, { ...fields, status: 'failed', note: '这条 Slack 私信正在等待另一条消息的回复。' });
      this.emit({ chatId: chat.id, message });
      return message;
    }
    this.active.add(channel);
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = AbortSignal.any([signal, deadline]);
    try {
      const message = this.store.message(chat.id, { ...fields, status: 'running' });
      this.emit({ chatId: chat.id, message });
      let stage = 'connect';
      try {
        const connection = await this.connect(role, requestSignal);
        stage = 'send';
        const ts = await this.send(connection, text, requestSignal);
        stage = 'reply';
        message.note = 'Slack 已接收消息，正在等助手回复。';
        this.emit({ chatId: chat.id, message });
        message.text = await this.reply(connection, ts, requestSignal);
        message.status = 'complete';
        delete message.note;
      } catch (error) {
        message.status = signal.aborted ? 'cancelled' : 'failed';
        if (signal.aborted) {
          if (stage === 'reply') message.note = 'Slack 已接收消息，已停止等待回复。';
          else if (stage === 'send') message.note = '已停止等待发送确认。请在 Slack 核对这条消息。';
        } else if (deadline.aborted) {
          message.note = {
            connect: '连接 Slack 超时，消息尚未提交。',
            send: '等待 Slack 发送确认超时。请在 Slack 核对这条消息。',
            reply: 'Slack 已接收消息，但没有在等待时间内读到可确认的回复。',
          }[stage];
        } else {
          const detail = error instanceof TypeError || error instanceof SyntaxError ? slackError().message : error.message;
          message.note = stage === 'reply' ? 'Slack 已接收消息。查询回复时出错。' + detail : detail;
        }
      }
      this.store.save();
      this.emit({ chatId: chat.id, message });
      return message;
    } finally {
      this.active.delete(channel);
    }
  }
}

module.exports = { SlackChat, engine, maxText, conversationId, tokenKey, userToken };
