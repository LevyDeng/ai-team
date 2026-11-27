const {historyFor} = require('./conversations.cjs');
const discussion = require('./discussion.cjs');
const { describeProjectDirectories, fileReferenceInstruction } = require('./project-directories.cjs');

const home = 'https://gemini.google.com/app';
const engine = 'gemini-web';

function conversationUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) return '';
  try {
    const url = new URL(value.trim());
    if (url.origin !== 'https://gemini.google.com' || url.username || url.password) return '';
    if (!/^\/(?:u\/\d{1,3}\/)?app\/[a-zA-Z0-9_-]{1,128}\/?$/.test(url.pathname)) return '';
    return url.origin + url.pathname.replace(/\/$/, '');
  } catch { return ''; }
}

function promptFor(chat, role, project, context, summary) {
  const original = historyFor({...chat, relayReplies:context.relayReplies, ignoreModeratorMemory:context.ignoreModeratorMemory}, role, summary);
  const latest = original.findLast(message => message.kind === 'user');
  const recent = [];
  let remaining = 24000;
  for (const message of original.slice(-20).reverse()) {
    if (message.id === latest?.id || !message.text?.trim()) continue;
    const line = `${message.kind === 'user' ? 'User' : message.roleName || 'Assistant'}: ${message.text || ''}`;
    if (line.length > remaining) break;
    recent.unshift(line);
    remaining -= line.length;
  }
  return [
    `Your role is ${role.name}. Respond to the current request in the user's language.`,
    role.persona && `Role instructions:\n${role.persona}`,
    require('./agent-invitations.cjs').dutyPrompt(context.teamAssignments),
    role.examples && `Style examples:\n${role.examples}`,
    context.skillInstructions && `Requested skill instructions:\n${context.skillInstructions}`,
    describeProjectDirectories(project),
    fileReferenceInstruction,
    recent.length && `Recent chat context for reference:\n${recent.join('\n\n')}`,
    `Current user request:\n${latest?.text || ''}`,
    discussion.instruction(context.discussion)
  ].filter(Boolean).join('\n\n');
}

class GeminiWeb {
  constructor({store, emit, open, copy, readClipboard}) {
    Object.assign(this, {store, emit, open, copy, readClipboard});
    this.pending = new Map();
  }

  saveLink(chatId, roleId, value) {
    const chat = this.store.get('chats', chatId);
    if (!chat.roleIds.includes(roleId) || this.store.get('roles', roleId).engine !== engine) {
      throw new Error('请选择本对话中的 Gemini 网页版角色。');
    }
    const url = conversationUrl(value);
    if (typeof value !== 'string' || !url && value.trim()) throw new Error('请粘贴 Gemini 地址栏里的私有对话链接（gemini.google.com/app/…）。');
    chat.geminiWebChats ||= {};
    if (url) chat.geminiWebChats[roleId] = url;
    else delete chat.geminiWebChats[roleId];
    this.store.save();
    return url;
  }

  openChat(chatId, roleId) {
    const chat = this.store.get('chats', chatId);
    if (!chat.roleIds.includes(roleId) && !chat.messages.some(message=>message.geminiWeb && message.roleId===roleId && this.pending.has(message.id))) {
      throw new Error('请选择本对话中的 Gemini 网页版角色。');
    }
    return this.open(conversationUrl(chat.geminiWebChats?.[roleId]) || home);
  }

  getTurn(chatId, messageId) {
    const turn = this.pending.get(messageId);
    if (turn?.chatId !== chatId) throw new Error('这次转接已结束。');
    return turn;
  }

  async openTurn(chatId, messageId) {
    const turn=this.getTurn(chatId,messageId);
    await this.copy(turn.prompt);
    this.getTurn(chatId,messageId);
    return this.openChat(chatId,turn.roleId);
  }

  validateReply(turn, reply) {
    if (typeof reply !== 'string' || !reply.trim() || reply.length > 150000) {
      throw new Error('请输入 Gemini 的文字回复，最多 150,000 个字符。');
    }
    const normalize=text=>text.replace(/\r\n/g,'\n').trim();
    if(normalize(reply)===normalize(turn.prompt))throw new Error('剪贴板里还是提示词，请复制 Gemini 的回复。');
    return reply;
  }

  async clipboardReply(chatId, messageId) {
    this.getTurn(chatId,messageId);
    const reply=await this.readClipboard();
    if(!reply?.trim())throw new Error('剪贴板没有文字。可以在输入框里手动粘贴。');
    return this.validateReply(this.getTurn(chatId,messageId),reply);
  }

  submitReply(chatId, messageId, reply) {
    const turn=this.getTurn(chatId,messageId);
    turn.finish(this.validateReply(turn,reply));
  }

  async run(chat, role, signal, context, summary) {
    if (signal.aborted) return {status:'cancelled'};
    const prompt = promptFor(chat, role, this.store.get('projects', chat.projectId), context, summary);
    const message = this.store.message(chat.id, {
      kind:'assistant', roleId:role.id, roleName:role.name, locationId:'local',
      geminiWeb:true, text:'', status:'running'
    });
    return new Promise(resolve => {
      const cancel = () => finish('');
      const finish = reply => {
        this.pending.delete(message.id);
        signal.removeEventListener('abort', cancel);
        message.status = reply ? 'complete' : 'cancelled';
        const answer = discussion.project(reply, context.discussion, true);
        message.text = answer.text;
        if (answer.vote) message.discussionVote = answer.vote;
        this.store.save();
        this.emit({chatId:chat.id, message});
        resolve(message);
      };
      this.pending.set(message.id, {chatId:chat.id, roleId:role.id, prompt, finish});
      signal.addEventListener('abort', cancel, {once:true});
      this.emit({chatId:chat.id, message});
    });
  }
}

module.exports = {engine, home, conversationUrl, GeminiWeb};
