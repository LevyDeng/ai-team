import os
from pathlib import Path
import sys


root = Path(__file__).resolve().parent
bench = Path(os.getenv('RELAY_VOICE_QWEN_BENCH') or os.getenv('VOICE_DESK_QWEN_BENCH')
             or root.parents[3] / 'tts-realtime-bench')
sys.path.insert(0, str(bench / 'packages'))

from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from faster_qwen3_tts import FasterQwen3TTS
from pydantic import BaseModel
import torch
import uvicorn

from wav_stream import wav_stream


MODELS = {
    'Qwen TTS 0.6B Base': 'Qwen3-TTS-12Hz-0.6B-Base',
    'Qwen TTS 1.7B Base': 'Qwen3-TTS-12Hz-1.7B-Base',
    'Qwen TTS 1.7B VoiceDesign': 'Qwen3-TTS-12Hz-1.7B-VoiceDesign',
}


class Speech(BaseModel):
    text: str
    reference: str
    style: str
    language: str


def main(port, voice):
    torch.set_num_threads(2)
    path = Path.cwd() / 'models' / MODELS[voice]
    model = FasterQwen3TTS.from_pretrained(str(path), device='cuda', dtype=torch.bfloat16,
                                         max_seq_len=1024, local_files_only=True)
    app = FastAPI()

    @app.get('/ready')
    def ready():
        return {'model': voice}

    @app.post('/tts')
    def synthesize(speech: Speech):
        language = 'English' if speech.language == 'en' else 'Chinese'
        options = {'text': speech.text, 'language': language, 'chunk_size': 8, 'max_new_tokens': 512}
        if voice.endswith('VoiceDesign'):
            parts = model.generate_voice_design_streaming(**options, instruct=speech.style)
        else:
            parts = model.generate_voice_clone_streaming(**options, ref_audio=speech.reference, xvec_only=True)
        return StreamingResponse(wav_stream((samples, rate) for samples, rate, _ in parts), media_type='audio/wav')

    uvicorn.run(app, host='127.0.0.1', port=port)


if __name__ == '__main__':
    main(int(sys.argv[1]), sys.argv[2])
