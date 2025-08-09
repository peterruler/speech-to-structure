# transcribe.py
import sys, json, os
from faster_whisper import WhisperModel

if len(sys.argv) < 2:
    print(json.dumps({"error": "no audio path given"}))
    sys.exit(1)

audio_path = sys.argv[1]
model_size = os.getenv("WHISPER_MODEL_SIZE", "tiny")

# CPU ist auf dem Mac ok; int8 ist schnell genug
model = WhisperModel(model_size, device="cpu", compute_type="int8")

segments, info = model.transcribe(
    audio_path,
    beam_size=1,           # schnell
    vad_filter=True,       # robust gegen Stille
    language=None          # autodetect; setze "de" wenn gewünscht
)

text = "".join(seg.text for seg in segments).strip()
print(json.dumps({"text": text}, ensure_ascii=False))
