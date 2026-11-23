from hashlib import file_digest
from http.server import BaseHTTPRequestHandler, HTTPServer
from io import BytesIO
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from time import monotonic
import traceback


def use_native_runtime(engine, folder):
    folder = folder.resolve()
    native = json.loads((folder / 'manifest.json').read_text(encoding='utf-8-sig'))
    executable = (folder / native['executable']).resolve()
    if not executable.is_relative_to(folder) or native['protocol'] != engine.build['protocol']:
        raise RuntimeError('Drama 3 native runtime path or protocol is incompatible.')
    installed = engine.build['files']
    if any(installed.get(name) != digest for name, digest in native['files'].items() if name.lower().endswith('.dll')):
        raise RuntimeError('Drama 3 native runtime requires different CUDA DLLs.')
    with executable.open('rb') as file:
        if file_digest(file, 'sha256').hexdigest() != native['sha256']:
            raise RuntimeError('Drama 3 native executable checksum does not match its manifest.')
    engine.build.update(executable=str(executable), sha256=native['sha256'])


def main(port, checkpoint, native_runtime=None):
    root = Path.cwd()
    sys.path[:0] = [str(root / 'src'), str(root / 'vendor' / 'fish-speech')]

    import numpy as np
    import soundfile as sf
    from drama_low_vram.gguf_runtime import GGUFEngine
    from drama_low_vram.protocols import VoiceReference

    engine = GGUFEngine(checkpoint, root=root, storage='mapped', cache=8, decoder='cpu')
    if native_runtime:
        use_native_runtime(engine, Path(native_runtime))

    class Handler(BaseHTTPRequestHandler):
        def respond(self, status, data=b'', content_type='application/json'):
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == '/ready':
                self.respond(200, b'{"engine":"Drama 3"}')
            else:
                self.respond(404)

        def do_POST(self):
            if self.headers.get_content_type() != 'application/json':
                self.respond(415)
                return
            if self.path == '/shutdown':
                self.server.stopping = True
                self.respond(204)
                return
            if self.path != '/tts':
                self.respond(404)
                return
            try:
                length = int(self.headers.get('Content-Length', 0))
                if not 0 < length <= 65536:
                    raise ValueError('Invalid request length.')
                body = json.loads(self.rfile.read(length))
                reference_path = str(body.get('reference') or '').strip()
                references = [VoiceReference(reference_path, body.get('transcript') or '')] if reference_path else []
                deadline = monotonic() + 165
                with TemporaryDirectory(prefix='voice-desk-drama-') as folder:
                    path = Path(folder) / 'result.wav'
                    # Keep the direction and the spoken line in one native chunk.
                    # The default 160-character split cuts the direction off the line,
                    # so the first chunk is spoken aloud and the line starts twice.
                    result = engine.generate(body['text'], path, references=references, direction=body['style'],
                                             language=body['language'], chunk_size=1000,
                                             cancelled=lambda: monotonic() > deadline)
                    if not result['complete']:
                        raise RuntimeError('Drama 3 reached its frame limit before the end of the line.')
                    audio, rate = sf.read(path, dtype='float32')
                if audio.ndim != 1 or not audio.size or not np.isfinite(audio).all() or np.max(np.abs(audio)) < 0.001:
                    raise RuntimeError('Drama 3 returned silent or invalid mono audio.')
                with BytesIO() as out:
                    sf.write(out, audio, rate, format='WAV', subtype='PCM_16')
                    wave = out.getvalue()
                print(f'Drama 3 generated {audio.size / rate:.2f}s; native session reused: {result["session_reused"]}', flush=True)
            except Exception:
                traceback.print_exc()
                self.respond(500)
                return
            self.respond(200, wave, 'audio/wav')

    try:
        with HTTPServer(('127.0.0.1', port), Handler) as server:
            server.stopping = False
            while not server.stopping:
                server.handle_request()
    finally:
        engine.close()


if __name__ == '__main__':
    main(int(sys.argv[1]), Path(sys.argv[2]), *sys.argv[3:])
