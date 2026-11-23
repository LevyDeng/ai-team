"""Serve the bundled voice runtime over a private JSON-lines pipe."""

import base64
from contextlib import redirect_stdout
import io
from itertools import chain
import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import wave


def transcribe(engines, value):
    with TemporaryDirectory(prefix="relay-voice-") as directory:
        recording = Path(directory) / "recording"
        recording.write_bytes(base64.b64decode(value["audio"], validate=True))
        return {"text": engines.recognize(recording)}


def synthesize(engines, value):
    samples = engines.synthesize(value)
    first = next(samples, None)
    if first is None:
        raise RuntimeError("The model returned no audio.")
    rate = first[0]
    data = io.BytesIO()
    size = 0
    with wave.open(data, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(rate)
        for sample_rate, pcm in chain((first,), samples):
            size += len(pcm)
            if sample_rate != rate or size > 24 * 1024 * 1024:
                raise RuntimeError("Audio exceeded the supported size or changed sample rate.")
            audio.writeframesraw(pcm)
        if not size:
            raise RuntimeError("The model returned no audio.")
    return {"wav": base64.b64encode(data.getvalue()).decode("ascii")}


def main():
    runtime = Path(sys.argv[1]).resolve()
    runtime.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault('RELAY_VOICE_MODELS', str(runtime / 'asr-models'))
    sys.path[:0] = [str(Path(__file__).with_name('voice-runtime')),
                    os.environ.get('RELAY_VOICE_DEPS', str(runtime / 'deps'))]
    protocol = sys.stdout
    with redirect_stdout(sys.stderr):
        from local_voice import LocalVoice
        engines = LocalVoice(runtime)
        try:
            for line in sys.stdin:
                try:
                    value = json.loads(line)
                    if value["type"] == "transcription":
                        result = transcribe(engines, value)
                    elif value["type"] == "speech":
                        result = synthesize(engines, value)
                    elif value["type"] == "warmup":
                        if not sum(len(pcm) for _, pcm in engines.synthesize(value)):
                            raise RuntimeError("The model returned no audio during warmup.")
                        result = {}
                    elif value["type"] == "release-speech":
                        engines.close()
                        result = {}
                    else:
                        raise ValueError("Unknown voice request.")
                except Exception as error:
                    result = {"error": str(error)[:2000]}
                result["model"] = engines.loaded_model
                print(json.dumps(result), file=protocol, flush=True)
        finally:
            engines.close()


if __name__ == "__main__":
    main()
