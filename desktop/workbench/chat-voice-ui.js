((root) => {
  const localModels = ['Fish Audio Drama 3', 'Qwen TTS 0.6B Base', 'Qwen TTS 1.7B Base', 'Qwen TTS 1.7B VoiceDesign'];
  let modelStatus = {};
  let renderModelControls;

  function updateModelStatus(status) {
    modelStatus = status;
    renderModelControls?.();
  }

  function modelFields(prefix) {
    return `<label>语音模型来源<select id="${prefix}-source"></select></label>
      <label id="${prefix}-model-row">语音合成模型<input id="${prefix}-id" maxlength="200" autocomplete="off" placeholder="填写服务提供的模型 ID"></label>
      <label id="${prefix}-local-row">本地语音合成模型<select id="${prefix}-local"></select></label>`;
  }

  function bindModel($, options, prefix, value, inherit, changed) {
    const source = $(prefix + '-source'), remote = $(prefix + '-id'), local = $(prefix + '-local');
    source.innerHTML = options([...(inherit ? [['inherit', '继承对话模型']] : []), ['remote', '远程服务'], ['local', '本地模型']], value?.source || (inherit ? 'inherit' : 'remote'));
    remote.value = value?.source === 'remote' ? value.id : '';
    local.innerHTML = options(localModels.map(id => [id, id]), value?.source === 'local' ? value.id : localModels[0]);
    const read = () => ({ source: source.value, id: source.value === 'local' ? local.value : remote.value.trim() });
    const sync = () => {
      $(prefix + '-model-row').hidden = source.value !== 'remote';
      $(prefix + '-local-row').hidden = source.value !== 'local';
      changed?.(read());
    };
    source.onchange = remote.oninput = local.onchange = sync;
    sync();
    return read;
  }

  function confirmInput() {
    return window.confirm('开启语音输入后，麦克风会收音，说完后自动转写并发送。期间暂时无法手动播放单条回复。\n\n可在聊天底栏关闭语音输入，恢复手动播放。现在开启吗？');
  }

  function openSettings(c, { $, api, dialog, options, action, whenPlaybackIdle }) {
    const value = c.voice || {};
    dialog(`<h2>对话语音</h2>
      <label class="voice-check"><input type="checkbox" id="voice-input" aria-describedby="voice-input-hint">语音输入 · 说完自动发送</label>
      <p class="hint" id="voice-input-hint" hidden>语音输入开启时，暂时无法手动播放单条回复。可在聊天底栏关闭语音输入。</p>
      <label class="voice-check"><input type="checkbox" id="voice-enabled">语音输出 · 自动播报角色回复</label>
      <div id="voice-settings-fields">
        <div id="voice-output-fields">${modelFields('voice-default')}</div>
        <div id="voice-input-fields">
          <label>麦克风转写<select id="voice-transcribe-mode"></select></label>
          <label id="voice-asr-model-row">远程转写模型<input id="voice-asr-model" maxlength="200" placeholder="填写服务提供的模型 ID"></label>
        </div>
        <details><summary>远程服务</summary>
          <label>API 地址<input id="voice-url" placeholder="https://服务地址/v1" maxlength="2048"></label>
          <label>API 密钥<input id="voice-key" type="password" autocomplete="new-password" maxlength="2000"></label>
          <label class="voice-check" id="voice-key-clear-row" hidden><input type="checkbox" id="voice-key-clear">清除已保存的密钥</label>
          <p class="hint">使用远程服务时，待转写的录音或待播报的回复会发送到此地址。</p>
        </details>
        <p class="hint">点击对话中的角色头像，为各角色分别设置声音和模型覆盖。</p>
      </div>
      <details id="voice-local-settings"><summary>本地语音</summary>
        <div id="voice-model-controls" hidden>
          <p class="hint" id="voice-model-status" role="status"></p>
          <div class="voice-model-actions">
            <button type="button" id="voice-model-warmup">预热本地模型</button>
            <button type="button" id="voice-model-release">释放本地模型</button>
          </div>
          <p class="hint" id="voice-model-help">预热使用已保存的会话默认合成模型。释放后，下次播报会自动重新加载。</p>
        </div>
        <label>Python 路径（可选）<div class="voice-path"><input id="voice-python" maxlength="4096" placeholder="默认使用 Python 3.12"><button type="button" id="voice-python-pick">选择</button></div></label>
        <p class="hint">本地转写和手机配对依赖可用 <code>py -3.12 desktop/workbench/voice-runtime/setup_local_asr.py</code> 安装。合成需要已配置相应模型。</p>
      </details>`, async () => {
      const inputEnabled = $('voice-input').checked;
      if (inputEnabled && value.inputEnabled !== true && !confirmInput()) return false;
      return api['chat-voice-settings'](c.id, {
        enabled: $('voice-enabled').checked, inputEnabled, model: readModel(),
        transcription: $('voice-transcribe-mode').value, transcriptionModel: $('voice-asr-model').value,
        baseUrl: $('voice-url').value, apiKey: $('voice-key').value, clearKey: $('voice-key-clear').checked,
        directory: value.directory || '', python: $('voice-python').value,
      });
    });
    let update = () => {};
    const readModel = bindModel($, options, 'voice-default', value.model, false, () => update());
    $('voice-enabled').checked = value.enabled === true;
    $('voice-input').checked = value.inputEnabled === true;
    $('voice-transcribe-mode').innerHTML = options([['local', '本地 SenseVoice'], ['remote', '远程服务']], value.transcription === 'remote' ? 'remote' : 'local');
    $('voice-asr-model').value = value.transcriptionModel || '';
    $('voice-url').value = value.baseUrl || '';
    $('voice-key').placeholder = value.hasKey ? '已加密保存；留空保持原密钥' : '按服务要求填写';
    $('voice-key-clear-row').hidden = !value.hasKey;
    $('voice-python').value = value.python || '';
    $('voice-python-pick').onclick = () => action(async () => {
      const input = $('voice-python');
      const [file] = await api.pick('file');
      if (file) {
        input.value = file;
        input.dispatchEvent(new Event('input'));
      }
    });
    const panel = $('voice-model-controls');
    let pending;
    renderModelControls = () => {
      if (!panel.isConnected) return;
      const model = readModel(), saved = value.model;
      const usable = model.source === 'local' && saved?.source === 'local' &&
        saved.id === model.id && (value.python || '') === $('voice-python').value.trim();
      const busy = pending || modelStatus.operation;
      panel.hidden = model.source !== 'local';
      $('voice-model-warmup').disabled = !usable || Boolean(busy || modelStatus.loading);
      $('voice-model-release').disabled = !(modelStatus.model || modelStatus.loading) || Boolean(busy);
      $('voice-model-status').textContent = modelStatus.operation === 'warming' ? '正在预热本地模型…' :
        modelStatus.operation === 'releasing' ? '等待播报结束并释放模型…' :
        pending ? '等待当前播报结束…' :
        modelStatus.loading ? '正在加载 ' + modelStatus.loading + '…' :
        modelStatus.model ? '已加载 ' + modelStatus.model : '尚未加载本地合成模型';
      $('voice-model-help').textContent = usable ?
        '将预热 ' + model.id + '。释放后，下次播报会自动重新加载。' :
        '请先保存默认本地合成模型和 Python 设置，再预热。';
    };
    for (const command of ['voice-model-warmup', 'voice-model-release']) {
      $(command).onclick = () => action(async () => {
        pending = true;
        renderModelControls();
        try {
          await whenPlaybackIdle();
          await api[command](c.id);
        } finally { pending = false; renderModelControls(); }
      });
    }
    void action(async () => updateModelStatus(await api['voice-model-status']()));
    $('voice-python').oninput = renderModelControls;
    update = () => {
      $('voice-settings-fields').hidden = !$('voice-enabled').checked && !$('voice-input').checked;
      $('voice-local-settings').hidden = $('voice-settings-fields').hidden && readModel().source !== 'local';
      $('voice-output-fields').hidden = !$('voice-enabled').checked;
      $('voice-input-fields').hidden = !$('voice-input').checked;
      $('voice-input-hint').hidden = !$('voice-input').checked;
      $('voice-asr-model-row').hidden = $('voice-transcribe-mode').value !== 'remote';
      renderModelControls();
    };
    $('voice-enabled').onchange = $('voice-input').onchange = $('voice-transcribe-mode').onchange = update;
    update();
  }

  function roleFields() {
    return `<details id="chat-role-voice"><summary>本对话语音</summary>
      ${modelFields('role-voice')}
      <p class="hint" id="role-voice-hint"></p>
      <label id="role-voice-name-row">音色 ID<input id="role-voice-name" maxlength="200" placeholder="填写当前模型支持的音色"></label>
      <label>声音描述或说话风格<textarea id="role-voice-style" maxlength="2000" rows="2"></textarea></label>
      <label id="role-voice-reference-row">参考录音<div class="voice-path"><input id="role-voice-reference" maxlength="4096"><button type="button" id="role-voice-reference-pick">选择</button></div></label>
      <label id="role-voice-transcript-row">参考录音的逐字稿<textarea id="role-voice-transcript" maxlength="4000" rows="2"></textarea></label>
      <label id="role-voice-language-row">本地合成语言<select id="role-voice-language"><option value="zh">普通话</option><option value="en">英语</option></select></label>
    </details>`;
  }

  function bindRole(c, id, { $, api, options, action }) {
    const original = c.roleVoices?.[id] || {};
    const reference = $('role-voice-reference'), transcript = $('role-voice-transcript');
    const name = $('role-voice-name'), style = $('role-voice-style'), language = $('role-voice-language');
    const resolve = selected => selected.source === 'inherit' ? c.voice?.model || { source: 'remote', id: '' } : selected;
    const key = model => JSON.stringify([model?.source, model?.id || '']);
    const drafted = new Map();
    if (original.voiceModel) drafted.set(key(original.voiceModel), original);
    let activeKey;
    const readFields = () => ({ voice: name.value, style: style.value, reference: reference.value, transcript: transcript.value, language: language.value });
    const readModel = bindModel($, options, 'role-voice', original.model, true, selection => {
      const model = resolve(selection), nextKey = key(model);
      if (activeKey !== nextKey) {
        if (activeKey) drafted.set(activeKey, readFields());
        const fields = drafted.get(nextKey) || {};
        name.value = fields.voice || '';
        style.value = fields.style || '';
        reference.value = fields.reference || '';
        transcript.value = fields.transcript || '';
        language.value = fields.language || 'zh';
        activeKey = nextKey;
      }
      const local = model.source === 'local';
      const drama = model.id === 'Fish Audio Drama 3';
      let hint = model.id ? '当前模型：' + model.id + '。请为该角色单独设置声音。' : '请先在对话语音设置中选择模型，或为此角色指定模型。';
      if (local && selection.source === 'local' && model.id !== c.voice?.model?.id) hint += '切换到其他本地模型时，可能需要重新加载。';
      $('role-voice-hint').textContent = hint;
      $('role-voice-name-row').hidden = local;
      $('role-voice-reference-row').hidden = !local || !(drama || model.id?.endsWith(' Base'));
      $('role-voice-transcript-row').hidden = !drama;
      $('role-voice-language-row').hidden = !local;
    });
    $('role-voice-reference-pick').onclick = () => action(async () => {
      const [file] = await api.pick('voice-reference', reference.value);
      if (file) reference.value = file;
    });
    const read = () => {
      const selected = readModel();
      return { model: selected, voiceModel: resolve(selected), ...readFields() };
    };
    const initial = JSON.stringify(read());
    return () => {
      const value = read();
      return JSON.stringify(value) === initial ? undefined : value;
    };
  }

  function playable(chat, message) {
    return chat.voice?.enabled && !chat.disbandedAt && message.kind === 'assistant' &&
      message.status === 'complete' && !message.moderatorTask && !message.branchContext &&
      message.text?.trim() && chat.roleIds.includes(message.roleId);
  }

  function createPlayback({ api, activeChat, notify, update }) {
    const queue = [];
    let current;

    function stop() {
      queue.length = 0;
      current?.controller.abort();
      current = undefined;
      update(false);
    }

    async function playNext() {
      if (current) return;
      while (!current && queue.length) {
        const { chatId, messageId } = queue.shift();
        if (activeChat()?.id !== chatId) continue;
        const controller = new AbortController(), requestId = crypto.randomUUID();
        const finished = Promise.withResolvers();
        const job = { chatId, controller, finished: finished.promise };
        current = job;
        update(true);
        let url;
        try {
          controller.signal.addEventListener('abort', () => api['chat-voice-cancel'](requestId).catch(() => {}), { once: true });
          const bytes = await api['chat-voice-speak'](chatId, requestId, messageId);
          if (!bytes || controller.signal.aborted) continue;
          url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
          const audio = new Audio(url);
          await new Promise((resolve, reject) => {
            audio.onended = resolve;
            audio.onerror = () => reject(new Error('无法播放这条回复的语音。'));
            controller.signal.addEventListener('abort', () => { audio.pause(); resolve(); }, { once: true });
            audio.play().catch(() => reject(new Error('无法播放语音，请点击消息下方的「播放语音」重试。')));
          });
        } catch (error) {
          if (!controller.signal.aborted) notify(error);
        } finally {
          finished.resolve();
          if (url) URL.revokeObjectURL(url);
          if (current === job) {
            current = undefined;
            update(false);
          }
        }
      }
    }

    return {
      stop,
      async whenIdle() { while (current) await current.finished; },
      sync() {
        const chat = activeChat();
        if (current && (!chat?.voice?.enabled || chat.voice.inputEnabled || current.chatId !== chat.id)) stop();
      },
      replay(chatId, messageId) {
        stop();
        queue.push({ chatId, messageId });
        void playNext();
      },
    };
  }

  function createLive({ api, activeChat, paired, status, notify, beforePlayback }) {
    let current;

    function releaseMicrophone(entry) {
      entry.context?.close().catch(() => {});
      entry.stream?.getTracks().forEach(track => track.stop());
      entry.context = entry.stream = undefined;
    }

    function stop() {
      if (!current) return;
      const entry = current;
      current = undefined;
      releaseMicrophone(entry);
      entry.audio?.pause();
      if (entry.url) URL.revokeObjectURL(entry.url);
      api['voice-live-stop'](entry.chatId).catch(() => {});
    }

    async function microphone(entry) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        if (current !== entry) { stream.getTracks().forEach(track => track.stop()); return; }
        entry.stream = stream;
        const context = entry.context = new AudioContext({ sampleRate: 16000 });
        const input = context.createMediaStreamSource(stream);
        const processor = context.createScriptProcessor(1024, 1, 1);
        let frame = new Int16Array(1600), offset = 0;
        processor.onaudioprocess = event => {
          if (entry.phase !== 'listening' || current !== entry) { offset = 0; return; }
          const samples = event.inputBuffer.getChannelData(0);
          for (const value of samples) {
            frame[offset++] = Math.round(Math.max(-1, Math.min(1, value)) * 32767);
            if (offset === frame.length) {
              api['voice-live-frame'](entry.chatId, frame.buffer).catch(() => {});
              frame = new Int16Array(1600);
              offset = 0;
            }
          }
        };
        input.connect(processor);
        processor.connect(context.destination);
        setPhase(entry, entry.phase);
        await context.resume();
      } catch {
        if (current !== entry) return;
        releaseMicrophone(entry);
        entry.micFailed = true;
        status('麦克风不可用，请检查权限后重新开启语音输入');
      }
    }

    function setPhase(entry, phase) {
      entry.phase = phase;
      entry.stream?.getAudioTracks().forEach(track => { track.enabled = phase === 'listening'; });
      const labels = { listening: '正在听，说完自动发送', transcribing: '正在转写', waiting: '等待角色回复',
        playing: '正在播报角色回复', ready: '语音输出已开启', off: '' };
      if (!entry.micFailed || phase === 'playing') status(labels[phase] || '');
    }

    api.on('voice-live', event => {
      const entry = current;
      if (!entry || event.chatId !== entry.chatId) return;
      if (event.kind === 'error') {
        notify(event.message);
        return;
      }
      if (event.kind === 'phase') {
        if (event.phase === 'off') { stop(); return; }
        setPhase(entry, event.phase);
        return;
      }
      if (event.kind !== 'audio') return;
      beforePlayback();
      const url = URL.createObjectURL(new Blob([event.audio], { type: 'audio/wav' }));
      const audio = entry.audio = new Audio(url);
      entry.url = url;
      const finish = () => {
        if (entry.audio !== audio) return;
        entry.audio = entry.url = undefined;
        URL.revokeObjectURL(url);
        api['voice-live-played'](entry.chatId, event.messageId, event.index).catch(() => {});
      };
      audio.onended = finish;
      audio.onerror = finish;
      audio.play().catch(finish);
    });

    return {
      busy: () => ['waiting', 'playing', 'transcribing'].includes(current?.phase),
      sync() {
        const chat = activeChat(), config = chat?.voice, phone = chat && paired(chat.id);
        const allowed = chat && !chat.disbandedAt && !chat.workflow && (config?.inputEnabled || config?.enabled);
        const key = allowed && !phone ? JSON.stringify([chat.id, config]) : null;
        if (current?.key === key) return;
        stop();
        if (!key) { status(phone && allowed ? '语音由手机接收' : ''); return; }
        const entry = current = { chatId: chat.id, key, phase: 'off' };
        api['voice-live-start'](chat.id).then(phase => {
          if (current !== entry) return;
          setPhase(entry, phase);
          if (config.inputEnabled) void microphone(entry);
        }).catch(error => {
          if (current !== entry) return;
          current = undefined;
          notify(error.message);
        });
      },
    };
  }

  root.deskChatVoice = { openSettings, updateModelStatus, confirmInput, roleFields, bindRole, playable, createPlayback, createLive };
})(globalThis);
