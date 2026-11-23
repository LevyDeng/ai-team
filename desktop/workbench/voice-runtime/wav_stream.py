import struct

import numpy as np


def wav_stream(parts):
    rate_written = None
    for samples, rate in parts:
        if not len(samples):
            continue
        if not np.isfinite(samples).all():
            raise RuntimeError('The voice engine generated non-finite audio samples.')
        if rate_written is None:
            yield struct.pack('<4sI4s4sIHHIIHH4sI', b'RIFF', 36, b'WAVE', b'fmt ', 16, 1, 1,
                              rate, rate * 2, 2, 16, b'data', 0)
            rate_written = rate
        elif rate != rate_written:
            raise RuntimeError('The voice engine changed its sample rate.')
        yield (np.clip(samples, -1, 1) * 32767).astype('<i2').tobytes()
    if rate_written is None:
        raise RuntimeError('The voice engine did not produce audio.')
