#!/usr/bin/env python3
"""Run one bounded CLI job over an SSH channel; stdin EOF cancels ownership."""
import json
import os
import select
import signal
import subprocess
import sys
import tempfile
import shutil
import atexit
import uuid
import struct
import re
from urllib.parse import urlsplit


def proxy_environment(source, policy):
    env = dict(source)
    mode = policy.get('mode', 'system')
    if mode not in ('system', 'direct', 'custom'):
        raise ValueError('Invalid proxy mode.')
    if mode == 'system':
        return env
    names = ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy')
    for name in names + ('NO_PROXY', 'no_proxy'):
        env.pop(name, None)
    env['NO_PROXY'] = env['no_proxy'] = '*' if mode == 'direct' else 'localhost,127.0.0.1,::1'
    if mode == 'custom':
        url = policy.get('url', '')
        parsed = urlsplit(url)
        if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/'):
            raise ValueError('Invalid HTTP proxy URL.')
        for name in names:
            env[name] = url
    return env


def forward_acp(process, stop, stopping):
    source = sys.stdin.fileno()
    target = process.stdin.fileno()
    os.set_blocking(target, False)
    pending = bytearray()
    outgoing = bytearray()
    limit = 8 * 1024 * 1024
    while not stopping() and process.poll() is None:
        readable, writable, _ = select.select([source], [target] if outgoing else [], [], 0.25)
        if readable:
            data = os.read(source, 65536)
            if not data:
                stop()
                return
            pending.extend(data)
            end = pending.find(b'\n')
            while end != -1:
                frame = pending[:end]
                del pending[:end + 1]
                if frame in (b'cancel', b'force'):
                    stop(force=frame == b'force')
                    return
                outgoing.extend(frame + b'\n')
                end = pending.find(b'\n')
            if len(outgoing) + len(pending) > limit:
                raise ValueError('ACP input exceeds its size limit.')
        if writable:
            try:
                length = os.write(target, outgoing)
                del outgoing[:length]
            except BlockingIOError:
                pass
            except BrokenPipeError:
                return


def main():
    # Read the first frame without buffering later keyboard frames ahead of select().
    line = sys.stdin.buffer.raw.readline(2 * 1024 * 1024 + 1)
    if len(line) > 2 * 1024 * 1024:
        raise ValueError('Request exceeds the input limit.')
    request = json.loads(line)
    cwd = os.path.expanduser(request['cwd'])
    if not os.path.isdir(cwd):
        raise ValueError('The project directory does not exist on this location.')
    command = request['command']
    if not isinstance(command, list) or not command or not all(isinstance(x, str) and '\0' not in x for x in command):
        raise ValueError('Invalid agent command.')
    job = str(uuid.UUID(request['jobId']))
    if request.get('nativeSessionId') and not re.fullmatch(r'[a-zA-Z0-9_-]{1,200}', str(request['nativeSessionId'])):
        raise ValueError('Invalid native session identifier.')
    container = None
    job_directory = tempfile.mkdtemp(prefix='relay-job-')
    atexit.register(shutil.rmtree, job_directory, ignore_errors=True)
    env = proxy_environment(os.environ, request.get('proxy', {}))
    interactive = request.get('interactive') is True
    acp = request.get('acp') is True
    if acp and (interactive or request.get('managed') or request['engine'] != 'antigravity'):
        raise ValueError('Unsupported remote ACP engine.')
    if interactive:
        if request['engine'] not in ('claude', 'codex'):
            raise ValueError('Unsupported interactive engine.')
        context_file = os.path.join(job_directory, 'context.txt')
        with open(context_file, 'w', encoding='utf-8') as output:
            output.write(request.get('context', ''))
        os.chmod(context_file, 0o600)
        command = [arg.replace('__RELAY_CONTEXT__', context_file) for arg in command]
        env['TERM'] = 'xterm-256color'
    if acp:
        for key in ('AGY_ADC_AUTH', 'GOOGLE_APPLICATION_CREDENTIALS', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'):
            env.pop(key, None)
    else:
        for key in list(env):
            if key.startswith(('OPENAI_', 'ANTHROPIC_', 'GEMINI_', 'DEEPSEEK_', 'CODEX_', 'CLAUDECODE')):
                del env[key]
    if interactive and request['engine'] == 'codex':
        env['CODEX_INTERNAL_ORIGINATOR_OVERRIDE'] = 'relay_desk_' + job.replace('-', '')
    mcp = {}
    for index, target in enumerate(request.get('mcpTargets', [])):
        name = 'location_' + str(index)
        variable = 'RELAY_MCP_' + str(index)
        env[variable] = target.get('token', '')
        mcp[name] = {'type': 'http', 'url': target['url'], 'headers': {'Authorization': 'Bearer ${' + variable + '}'}}
        if request['engine'] == 'codex':
            command[1:1] = ['-c', 'mcp_servers.' + name + '.url=' + json.dumps(target['url']),
                            '-c', 'mcp_servers.' + name + '.bearer_token_env_var=' + json.dumps(variable),
                            '-c', 'mcp_servers.' + name + '.default_tools_approval_mode="approve"']
    if mcp and request['engine'] == 'claude':
        config = os.path.join(job_directory, 'mcp.json')
        with open(config, 'w') as output:
            json.dump({'mcpServers': mcp}, output)
        os.chmod(config, 0o600)
        command += ['--mcp-config', config]
        for name in mcp:
            command += ['--allowedTools', 'mcp__' + name + '__*']
    if mcp and request['engine'] == 'opencode':
        env['OPENCODE_CONFIG_CONTENT'] = json.dumps({'mcp': {name: {'type': 'remote', 'url': config['url'], 'headers': {'Authorization': 'Bearer ' + env['RELAY_MCP_' + name.split('_')[-1]]}, 'enabled': True} for name, config in mcp.items()}})
    if request.get('managed'):
        engine = request['engine']
        if engine not in ('claude', 'codex'):
            raise ValueError('The managed server supports Claude and Codex.')
        folder = os.path.join(os.path.expanduser('~'), 'windows-mcp')
        state = os.path.expanduser('~/.local/state/windows-mcp/' + engine)
        container = 'relaywb-' + job
        docker = ['docker']
        if subprocess.run(docker + ['info'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5).returncode:
            docker = ['sudo', '-n', 'docker']
        command = docker + ['run', '--rm', '-i', '--init', '--name', container, '--network', 'host',
                            '--memory=896m', '--memory-swap=1088m', '--pids-limit=256', '--log-driver=none',
                            '--user', str(os.getuid()) + ':' + str(os.getgid()),
                            '--mount', 'type=bind,source=' + state + ',target=/home/' + engine + '/state',
                            '--mount', 'type=bind,source=' + folder + ',target=/opt/windows-mcp,readonly',
                            '--mount', 'type=bind,source=' + job_directory + ',target=' + job_directory + ',readonly',
                            '--mount', 'type=bind,source=' + cwd + ',target=' + cwd,
                            '--workdir', cwd] + sum((['--env', name] for name in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NO_PROXY', 'no_proxy', 'TERM', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE') if name in env), []) + sum((['--env', 'RELAY_MCP_' + str(i)] for i in range(len(mcp))), []) + ['windows-mcp-' + engine + ':local',
                            'bash', '/opt/windows-mcp/start-' + engine + '.sh'] + command[1:]
        if interactive:
            command.insert(len(docker) + 1, '-t')
    if not request.get('managed') and not acp:
        isolated = os.path.expanduser('~/.local/share/relay-desk/profiles/' + str(uuid.UUID(request['roleId'])))
        os.makedirs(isolated, mode=0o700, exist_ok=True)
        env['CODEX_HOME'] = isolated + '/codex'
        env['CLAUDE_CONFIG_DIR'] = isolated + '/claude'
        env['XDG_CONFIG_HOME'] = isolated + '/config'
        env['XDG_DATA_HOME'] = isolated + '/data'
    master = None
    history = None
    if interactive and request.get('syncHistory'):
        from native_history import NativeHistory
        history_root = state if request.get('managed') else env['CLAUDE_CONFIG_DIR' if request['engine'] == 'claude' else 'CODEX_HOME']

        def history_event(event):
            print(json.dumps(dict(type='relay-history', **event)), file=sys.stderr, flush=True)

        history = NativeHistory(request['engine'], history_root, request.get('nativeSessionId', job if request['engine'] == 'claude' else ''),
                                env.get('CODEX_INTERNAL_ORIGINATOR_OVERRIDE'), history_event,
                                start_at=request.get('nativeSessionStart', 0) / 1000 or None,
                                from_end=request.get('resuming') is True,
                                exact_session=request.get('resuming') is True)
        if request.get('resuming'):
            history.poll(force=True)
    if interactive:
        import pty
        import fcntl
        import termios
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))

        def session():
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)

        try:
            process = subprocess.Popen(command, cwd=cwd, env=env, stdin=slave,
                                       stdout=slave, stderr=slave, preexec_fn=session)
        finally:
            os.close(slave)
    elif acp:
        process = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.PIPE, start_new_session=True)
    else:
        # A slow CLI or Docker startup must not block reading the SSH cancel frame.
        with tempfile.TemporaryFile(dir=job_directory) as job_input:
            job_input.write(request['input'].encode('utf-8'))
            job_input.seek(0)
            process = subprocess.Popen(command, cwd=cwd, env=env, stdin=job_input, start_new_session=True)

    stop_status = None
    def stop(*_, force=False):
        nonlocal stop_status
        if stop_status is not None:
            return
        stop_status = 124

        def signal_group(value):
            try:
                os.killpg(process.pid, value)
            except ProcessLookupError:
                pass

        if not force:
            signal_group(signal.SIGTERM)
            try:
                process.wait(timeout=0.75)
            except subprocess.TimeoutExpired:
                pass
        signal_group(signal.SIGKILL)
        try:
            process.wait(timeout=0.75)
        except subprocess.TimeoutExpired:
            return
        if container:
            try:
                result = subprocess.run(docker + ['rm', '-f', container], stdout=subprocess.DEVNULL,
                                        stderr=subprocess.PIPE, timeout=4, text=True)
            except (OSError, subprocess.TimeoutExpired):
                return
            if result.returncode and 'No such container' not in result.stderr:
                return
        stop_status = 130

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGHUP, stop)
    try:
        if acp:
            forward_acp(process, stop, lambda: stop_status is not None)
            if stop_status is not None:
                return stop_status
            try:
                exit_code = process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                stop()
                return 1
            stop(force=True)
            return exit_code
        if interactive:
            pending = b''
            while stop_status is None:
                if history:
                    history.poll()
                readable, _, _ = select.select([sys.stdin.fileno(), master], [], [], 0.25)
                if process.poll() is not None and master not in readable:
                    break
                if master in readable:
                    try:
                        data = os.read(master, 65536)
                    except OSError:
                        break
                    if not data:
                        break
                    sys.stdout.buffer.write(data)
                    sys.stdout.buffer.flush()
                if sys.stdin.fileno() in readable:
                    data = os.read(sys.stdin.fileno(), 65536)
                    if not data:
                        stop()
                        break
                    pending += data
                    if len(pending) > 1024 * 1024:
                        raise ValueError('Interactive input exceeds the limit.')
                    while b'\n' in pending:
                        frame, pending = pending.split(b'\n', 1)
                        control = json.loads(frame)
                        if control.get('type') in ('close', 'force-close'):
                            stop(force=control['type'] == 'force-close')
                            break
                        if control.get('type') == 'input':
                            value = control.get('data')
                            if not isinstance(value, str) or len(value) > 100000:
                                raise ValueError('Invalid terminal input.')
                            os.write(master, value.encode('utf-8'))
                        elif control.get('type') == 'resize':
                            cols, rows = control.get('cols'), control.get('rows')
                            if isinstance(cols, int) and isinstance(rows, int) and 2 <= cols <= 500 and 2 <= rows <= 300:
                                fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
                                if container:
                                    subprocess.run(docker + ['exec', container, 'stty', '-F', '/dev/pts/0', 'cols', str(cols), 'rows', str(rows)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3)
            if process.poll() is None:
                stop()
            return stop_status if stop_status is not None else process.wait()
        pending = b''
        while stop_status is None and process.poll() is None:
            readable, _, _ = select.select([sys.stdin.fileno()], [], [], 0.25)
            if readable:
                # EOF and legacy control frames both request a graceful stop.
                data = os.read(sys.stdin.fileno(), 64)
                pending += data
                if not data or b'\n' in pending or len(pending) >= 64:
                    stop(force=pending.split(b'\n', 1)[0] == b'force')
        return stop_status if stop_status is not None else process.wait()
    finally:
        if history:
            history.poll(force=True)
        if process.poll() is None or acp:
            stop()
        if master is not None:
            os.close(master)
        shutil.rmtree(job_directory, ignore_errors=True)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
