import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
from tempfile import TemporaryDirectory
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent
RUNTIME = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT.parents[2] / '.runtime' / 'workbench' / 'voice'
os.environ.setdefault('RELAY_VOICE_MODELS', str(RUNTIME / 'asr-models'))
from local_asr import MODELS, SENSEVOICE

SENSEVOICE_RELEASE = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17'
SENSEVOICE_URL = f'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/{SENSEVOICE_RELEASE}.tar.bz2'
SENSEVOICE_FILES = {
    'model.int8.onnx': 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51',
    'tokens.txt': 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc',
}


def download(url, path):
    with urlopen(url, timeout=60) as source, path.open('wb') as target:
        shutil.copyfileobj(source, target)


def matches_hash(path, expected):
    if not path.is_file():
        return False
    with path.open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest() == expected


def main():
    if not shutil.which('uv'):
        raise SystemExit('Install uv before setting up local speech recognition.')
    subprocess.run([
        'uv', 'pip', 'install', '--python', sys.executable, '--target', str(RUNTIME / 'deps'),
        '--only-binary', ':all:', 'sherpa-onnx==1.12.40', 'av==16.1.0', 'numpy==1.26.4',
        'cryptography', 'qrcode',
    ], check=True)

    MODELS.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=MODELS) as folder:
        temp = Path(folder)
        if not all(matches_hash(SENSEVOICE / name, digest) for name, digest in SENSEVOICE_FILES.items()):
            print('Downloading SenseVoiceSmall INT8 weights...', flush=True)
            archive = temp / 'sensevoice.tar.bz2'
            download(SENSEVOICE_URL, archive)
            with tarfile.open(archive) as release:
                for name, digest in SENSEVOICE_FILES.items():
                    path = temp / name
                    with release.extractfile(f'{SENSEVOICE_RELEASE}/{name}') as source, path.open('wb') as target:
                        shutil.copyfileobj(source, target)
                    if not matches_hash(path, digest):
                        raise RuntimeError(f'SenseVoice checksum mismatch for {name}.')
            SENSEVOICE.mkdir(exist_ok=True)
            for name in SENSEVOICE_FILES:
                (temp / name).replace(SENSEVOICE / name)
    print(f'Local speech recognition and phone pairing dependencies are ready in {RUNTIME}.')


if __name__ == '__main__':
    main()
