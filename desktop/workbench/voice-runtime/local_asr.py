import os
from pathlib import Path


MODELS = Path(os.environ['RELAY_VOICE_MODELS'])
SENSEVOICE = MODELS / 'sensevoice-small-int8'


def load_sensevoice():
    model = SENSEVOICE / 'model.int8.onnx'
    tokens = SENSEVOICE / 'tokens.txt'
    if not model.is_file() or not tokens.is_file():
        raise RuntimeError(f'SenseVoice weights are missing from {SENSEVOICE}. Run setup_local_asr.py.')
    try:
        import sherpa_onnx
    except ImportError as error:
        raise RuntimeError('SenseVoice dependencies are missing. Run setup_local_asr.py.') from error
    return sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=str(model), tokens=str(tokens), language='auto', use_itn=True, num_threads=4, provider='cpu',
    )


def recognize_file(recognizer, path):
    import av
    import numpy as np

    resampler = av.AudioResampler(format='fltp', layout='mono', rate=16000)
    with av.open(str(path)) as source:
        if not source.streams.audio:
            raise RuntimeError('The selected file contains no audio track.')
        samples = [
            output.to_ndarray()[0]
            for frame in source.decode(audio=0)
            for output in resampler.resample(frame)
        ]
    if not samples:
        return ''
    samples.extend(output.to_ndarray()[0] for output in resampler.resample(None))
    stream = recognizer.create_stream()
    stream.accept_waveform(16000, np.concatenate(samples))
    recognizer.decode_stream(stream)
    return stream.result.text.strip()
