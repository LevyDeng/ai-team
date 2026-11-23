import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import time
from urllib.request import ProxyHandler, Request, build_opener

from local_asr import load_sensevoice, recognize_file


SCRIPTS = Path(__file__).resolve().parent
INSTALLS = SCRIPTS.parents[3]
HTTP = build_opener(ProxyHandler({}))


def request(port, route, body=None, timeout=165):
    return HTTP.open(Request(f'http://127.0.0.1:{port}/{route}',
                             data=None if body is None else json.dumps(body).encode(),
                             headers={'Content-Type': 'application/json'}), timeout=timeout)


def pcm(source):
    header = source.read(12)
    if len(header) != 12 or header[:4] != b'RIFF' or header[8:] != b'WAVE':
        raise RuntimeError('Expected PCM WAV from the synthesis engine.')
    rate = None
    while True:
        chunk = source.read(8)
        if len(chunk) != 8:
            raise RuntimeError('WAV stream is missing its audio data.')
        tag, size = struct.unpack('<4sI', chunk)
        if tag == b'data' and rate:
            break
        if size > 65536:
            raise RuntimeError('Invalid WAV metadata.')
        data = source.read(size + size % 2)
        if tag == b'fmt ' and len(data) >= 16:
            codec, channels, rate, _, _, bits = struct.unpack('<HHIIHH', data[:16])
            if (codec, channels, bits) != (1, 1, 16) or not 8000 <= rate <= 192000:
                raise RuntimeError('Expected mono 16-bit PCM.')
    for block in iter(lambda: source.read(rate // 10), b''):
        yield rate, block


class LocalVoice:
    def __init__(self, runtime):
        self.runtime = runtime
        self.recognizer = None
        self.process = None
        self.model = None
        self.port = None

    @property
    def loaded_model(self):
        return self.model if self.process is not None and self.process.poll() is None else None

    def recognize(self, recording):
        if self.recognizer is None:
            self.recognizer = load_sensevoice()
        return recognize_file(self.recognizer, recording)

    def launch(self, model):
        if self.process and self.process.poll() is None and model == self.model:
            return
        self.close()
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
        if model == 'Fish Audio Drama 3':
            manifest = INSTALLS / 'Drama3-Studio' / 'installation.json'
            install = json.loads(manifest.read_text(encoding='utf-8-sig')) if manifest.is_file() else {}
            root = Path(os.getenv('RELAY_VOICE_DRAMA') or os.getenv('VOICE_DESK_DRAMA') or install.get('app_root', ''))
            checkpoint = Path(os.getenv('RELAY_VOICE_DRAMA_MODEL') or os.getenv('VOICE_DESK_DRAMA_MODEL')
                              or install.get('checkpoint', {}).get('path', ''))
            native = os.getenv('RELAY_VOICE_DRAMA_RUNTIME') or os.getenv('VOICE_DESK_DRAMA_RUNTIME')
            cached = manifest.parent / '.downloads' / 'studio140-runtime'
            if not native and install.get('release') == 'v1.3.0' and (cached / 'manifest.json').is_file():
                native = str(cached)
            exe = root / 'runtime' / 'python' / 'python.exe'
            if not checkpoint.is_file() or not exe.is_file():
                raise RuntimeError('Drama 3 runtime or model is missing. Set RELAY_VOICE_DRAMA and RELAY_VOICE_DRAMA_MODEL.')
            command = [str(exe), '-I', str(SCRIPTS / 'drama_worker.py'), str(port), str(checkpoint)]
            if native:
                command.append(native)
            log = self.runtime / 'drama3.log'
        else:
            root = Path(os.getenv('RELAY_VOICE_QWEN') or os.getenv('VOICE_DESK_QWEN') or INSTALLS / 'qwen-tts')
            exe = root / '.venv' / 'Scripts' / 'python.exe'
            if not exe.is_file():
                raise RuntimeError('Qwen TTS runtime is missing. Set RELAY_VOICE_QWEN to its installation directory.')
            command = [str(exe), str(SCRIPTS / 'qwen_worker.py'), str(port), model]
            log = self.runtime / 'qwen-tts.log'
        with log.open('wb') as output:
            self.process = subprocess.Popen(command, cwd=root, stdin=subprocess.DEVNULL, stdout=output,
                                            stderr=subprocess.STDOUT,
                                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
                                            env={**os.environ, 'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1',
                                                 'PYTHONUNBUFFERED': '1'})
        self.model, self.port = model, port
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline and self.process.poll() is None:
            try:
                with request(port, 'ready', timeout=1):
                    return
            except OSError:
                time.sleep(0.25)
        self.close()
        raise RuntimeError(f'The synthesis engine did not start. See {log}.')

    def synthesize(self, value):
        model = value['model']['id']
        self.launch(model)
        body = {key: value.get(key, '') for key in ('style', 'reference', 'transcript', 'language')}
        body['text'] = value['input']
        if body['reference'] and not Path(body['reference']).is_file():
            raise RuntimeError('The selected reference recording is missing.')
        with request(self.port, 'tts', body) as response:
            yield from pcm(response)

    def close(self):
        process, self.process = self.process, None
        if process is None or process.poll() is not None:
            return
        if self.model == 'Fish Audio Drama 3':
            try:
                with request(self.port, 'shutdown', {}, 2):
                    pass
                process.wait(timeout=10)
                return
            except (OSError, subprocess.TimeoutExpired):
                pass
        process.terminate()
        try:
            process.wait(timeout=4)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
