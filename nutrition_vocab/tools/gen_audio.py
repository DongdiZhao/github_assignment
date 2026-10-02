"""Generate per-word audio clips for the nutrition vocab app.

Each word gets 4 clips (all 24 kHz mono 32 kbps CBR MP3, raw frames, no ID3/Xing,
so the app can concatenate them byte-for-byte):
  audio/en/<slug>.mp3    English headword (American voice)
  audio/zh/<slug>.mp3    Chinese meaning
  audio/ex/<slug>.mp3    English example sentence
  audio/exzh/<slug>.mp3  Chinese translation of the example
Plus audio/sil/<ms>.mp3 silences and audio/sil/ding.mp3.
Usage: python gen_audio.py OUT_DIR [worker_index worker_count]
"""
import json, os, re, sys
import numpy as np
import lameenc

SR = 24000
KBPS = 32

def slug(en):
    s = en.lower().replace("'", "")
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s

# ---------- English text preparation ----------
EN_REPL = [
    ("Plan-Do-Study-Act", "Plan, Do, Study, Act"),
    ("Mifflin-St Jeor", "Mifflin Saint Jore"),
    ("mise en place", "meez ahn plahss"),
    ("Mise en place", "Meez ahn plahss"),
    ("laissez-faire", "lessay fair"),
    ("Maillard", "my yard"),
    ("Wernicke", "Vernicka"),
    ("quinoa", "keen wah"),
    ("Quinoa", "Keen wah"),
    ("acetyl-CoA", "acetyl co A"),
    ("Acetyl-CoA", "Acetyl co A"),
    ("hemoglobin A1c", "hemoglobin A one C"),
    ("Hemoglobin A1c", "Hemoglobin A one C"),
    ("glucagon-like peptide-1", "glucagon-like peptide one"),
    ("Glucagon-like peptide-1", "Glucagon-like peptide one"),
    ("omega-3", "omega three"), ("Omega-3", "Omega three"),
    ("omega-6", "omega six"), ("Omega-6", "Omega six"),
    ("type 1", "type one"), ("Type 1", "Type one"),
    ("type 2", "type two"), ("Type 2", "Type two"),
    ("24-hour", "twenty-four hour"),
    ("rule of 15", "rule of fifteen"),
    ("p-value", "P value"),
    ("E. coli", "E coli"),
    ("MyPlate", "My Plate"),
    ("VO2 max", "V O 2 max"),
    ("FODMAP", "fod map"),
    ("ADIME", "A dime"),
    ("SOAP note", "soap note"),
    ("SWOT", "swot"),
    ("WIC", "wick"),
    ("RDs", "R D's"),
    ("mg/dL", " milligrams per deciliter"),
    ("°F", " degrees Fahrenheit"),
    ("°C", " degrees Celsius"),
    ("&", " and "),
]

def prep_en(t):
    for a, b in EN_REPL:
        t = t.replace(a, b)
    t = re.sub(r"\bpH\b", "P H", t)
    t = re.sub(r"(\d+(?:\.\d+)?)\s*%", r"\1 percent", t)
    return t

# ---------- Chinese text preparation ----------
LETTERS = {
    'A': '诶', 'B': '比', 'C': '西', 'D': '迪', 'E': '伊', 'F': '艾弗', 'G': '吉', 'H': '艾尺',
    'I': '艾', 'J': '杰', 'K': '开', 'L': '艾勒', 'M': '艾姆', 'N': '恩', 'O': '欧', 'P': '批',
    'Q': '扣', 'R': '阿尔', 'S': '艾斯', 'T': '提', 'U': '优', 'V': '维', 'W': '达不留',
    'X': '艾克斯', 'Y': '歪', 'Z': '贼',
}

def prep_zh(t):
    t = t.replace('（', '，').replace('）', '，').replace('(', '，').replace(')', '，')
    t = re.sub(r'[“”"「」]', '', t)
    t = t.replace('mg/dL', '毫克每分升').replace('°C', '摄氏度').replace('°F', '华氏度').replace('&', '和')
    t = t.replace('；', '，').replace(';', '，').replace('/', '，').replace('、', '，')
    t = t.replace('β', '贝塔').replace('α', '阿尔法').replace('ω', '欧米伽')
    t = t.replace('≥', '大于等于').replace('≤', '小于等于').replace('>', '大于').replace('<', '小于')
    t = re.sub(r'%DV', '百分比DV', t)
    t = re.sub(r'(\d+(?:\.\d+)?)%', r'百分之\1', t)
    t = re.sub(r'(\d)\s*[–-]\s*(\d)', r'\1到\2', t)
    t = re.sub(r'[–\-]', '', t)
    t = re.sub(r'[A-Za-z]', lambda m: LETTERS[m.group(0).upper()], t)
    t = re.sub(r'，\s*，+', '，', t)
    t = re.sub(r'\s+', '', t).strip('，')
    if not re.search(r'[。！？]$', t):
        t += '。'
    return t

# ---------- audio helpers ----------
def trim(x, thr=0.01, pad=int(0.06 * SR)):
    idx = np.where(np.abs(x) > thr)[0]
    if len(idx) == 0:
        return x
    return x[max(0, idx[0] - pad): min(len(x), idx[-1] + pad)]

def normalize(x, target_rms=0.08, peak=0.95):
    rms = float(np.sqrt(np.mean(x ** 2))) or 1e-6
    x = x * (target_rms / rms)
    m = float(np.max(np.abs(x))) or 1e-6
    if m > peak:
        x = x * (peak / m)
    return x

def to_mp3(x):
    enc = lameenc.Encoder()
    enc.set_bit_rate(KBPS)
    enc.set_in_sample_rate(SR)
    enc.set_out_sample_rate(SR)
    enc.set_channels(1)
    enc.set_quality(2)
    pcm = (np.clip(x, -1, 1) * 32767).astype('<i2').tobytes()
    return bytes(enc.encode(pcm) + enc.flush())

def write(path, data):
    tmp = path + '.tmp'
    with open(tmp, 'wb') as f:
        f.write(data)
    os.replace(tmp, path)

def main():
    out = sys.argv[1]
    wi = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    wc = int(sys.argv[3]) if len(sys.argv) > 3 else 1
    for d in ('en', 'zh', 'ex', 'exzh', 'sil'):
        os.makedirs(os.path.join(out, d), exist_ok=True)

    if wi == 0:
        for ms in (300, 600, 1000, 1500, 2000, 3000, 5000, 8000):
            write(os.path.join(out, 'sil', f'{ms}.mp3'), to_mp3(np.zeros(int(SR * ms / 1000), dtype=np.float32)))
        t = np.arange(int(SR * 0.18)) / SR
        tone = 0.25 * np.sin(2 * np.pi * 880 * t) * np.exp(-t * 18)
        write(os.path.join(out, 'sil', 'ding.mp3'), to_mp3(np.concatenate([tone, np.zeros(int(SR * 0.25))]).astype(np.float32)))

    words = json.load(open('/home/user/tts/words.json'))
    slugs = [slug(w[0]) for w in words]
    assert len(set(slugs)) == len(slugs), 'duplicate slugs'
    todo = [w for i, w in enumerate(words) if i % wc == wi]

    from kokoro_onnx import Kokoro
    from misaki import zh
    import onnxruntime as rt
    def sess(path):
        o = rt.SessionOptions()
        o.intra_op_num_threads = int(os.getenv('TTS_THREADS', '1'))
        o.inter_op_num_threads = 1
        return rt.InferenceSession(path, o, providers=['CPUExecutionProvider'])
    k_en = Kokoro.from_session(sess('/home/user/tts/kokoro-v1.0.onnx'), '/home/user/tts/voices-v1.0.bin')
    k_zh = Kokoro.from_session(sess('/home/user/tts/kokoro-v1.1-zh.onnx'), '/home/user/tts/voices-v1.1-zh.bin')
    g2p = zh.ZHG2P(version='1.1')

    def en_audio(text, speed):
        s, _ = k_en.create(prep_en(text), voice='af_heart', speed=speed, lang='en-us')
        return normalize(trim(s))

    def zh_audio(text, speed=1.0):
        ph, _ = g2p(prep_zh(text))
        s, _ = k_zh.create(ph, voice='zf_001', speed=speed, is_phonemes=True)
        return normalize(trim(s))

    for n, (en, ipa, zhm, ex, exzh) in enumerate(todo):
        sl = slug(en)
        jobs = [
            ('en', lambda: en_audio(en, 0.85)),
            ('zh', lambda: zh_audio(zhm)),
            ('ex', lambda: en_audio(ex, 0.92)),
            ('exzh', lambda: zh_audio(exzh)),
        ]
        for kind, fn in jobs:
            p = os.path.join(out, kind, sl + '.mp3')
            if os.path.exists(p):
                continue
            try:
                write(p, to_mp3(fn()))
            except Exception as e:  # keep going; report at the end
                print('FAIL', kind, en, repr(e), flush=True)
        if n % 25 == 0:
            print(f'[{wi}] {n}/{len(todo)} {en}', flush=True)
    print(f'[{wi}] done', flush=True)

if __name__ == '__main__':
    main()
