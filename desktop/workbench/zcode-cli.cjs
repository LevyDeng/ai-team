const { terminal } = require('./activity.cjs');

function taskArgs(role, session, prompt) {
  const modes = { 'read-only': 'plan', 'workspace-write': 'edit', 'danger-full-access': 'yolo' };
  const mode = Object.hasOwn(modes, role.permission) ? modes[role.permission] : 'plan';
  // Windows quotes arguments and counts UTF-16 code units, including the runtime path.
  if (process.platform === 'win32' && prompt.replace(/[\\"]/g, '$&$&').length > 28000) {
    throw new Error('这次发送的内容超出 ZCode 在 Windows 上的命令长度限制。请缩短消息或新建对话。');
  }
  return ['--prompt', prompt, '--mode', mode, '--output-format', 'stream-json', '--no-color',
    ...(session?.resumed ? ['--resume', session.id] : [])];
}

function parseEvent(event, state, emit) {
  if (event.type === 'model.streaming' && event.payload?.kind === 'text_delta' && typeof event.payload.delta === 'string') {
    state.text += event.payload.delta;
    terminal(state, event.payload.delta);
    emit(state.text);
  }
  if (event.type === 'result' && typeof event.response === 'string' && /^sess_[a-z0-9_-]+$/i.test(event.sessionId || '')) {
    state.nativeSessionId = event.sessionId;
    state.text = event.response || state.text;
    state.completed = true;
    emit(state.text);
  }
}

module.exports = { taskArgs, parseEvent };
