#!/usr/bin/env python3
"""Etapa 4 — áudio: copia os 5 .wav do menu Home para StreamingAssets/Audio e grava audio_index.json.

O jogo carrega 8 bancos .brsar (strings do main.dol: rp_Common_Sports, rp_Tns_sound, rp_Bsb_sound,
rp_Gol_sound, rp_Box_sound, rp_Bow_sound, rp_Health_sound e HomeButtonSe). Nenhum está no projeto; só
existem 5 efeitos do HomeButtonSe já decodificados em raw/assets/audio/decoded. O índice registra esses
bancos como `missing` (gancho para bancos externos: AudioManager.RegisterBank) e liga os .wav aos nomes
de som do bloco SYMB do HomeButtonSe.brsar (HOMESE_CONNECTED..4, HOMESE_VOLUME_*).
Uso: python3 tools/export_audio.py
"""
import sys
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from nw4r.paths import INDEX, SRC, STREAMING, write_bytes, write_json  # noqa: E402

DECODED = SRC / 'raw/assets/audio/decoded'
OUT = STREAMING / 'Audio'
MISSING_BANKS = ['rp_Common_Sports', 'rp_Tns_sound', 'rp_Bsb_sound', 'rp_Gol_sound', 'rp_Box_sound',
                 'rp_Bow_sound', 'rp_Health_sound', 'HomeButtonSe']
# arquivo decodificado -> nome do som no SYMB de HomeButtonSe.brsar
CUES = {'SpeakerSe_connect1': 'HOMESE_CONNECTED', 'SpeakerSe_connect2': 'HOMESE_CONNECTED2',
        'SpeakerSe_connect3': 'HOMESE_CONNECTED3', 'SpeakerSe_connect4': 'HOMESE_CONNECTED4',
        'SpeakerSe_volume': 'HOMESE_VOLUME_PLUS'}


def main():
    clips = []
    for f in sorted(DECODED.glob('*.wav')):
        with wave.open(str(f)) as w:
            ch, width, rate, frames = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        if width != 2:
            raise ValueError(f'{f.name}: {8 * width} bits (o AudioManager espera PCM 16 bits)')
        write_bytes(OUT / 'home' / f.name, f.read_bytes())
        clips.append({'name': f.stem, 'cue': CUES.get(f.stem), 'file': f'Audio/home/{f.name}', 'channels': ch,
                      'sampleRate': rate, 'frames': frames, 'seconds': round(frames / rate, 4)})
    index = {'format': 'linuxsports-audio-index', 'version': 1,
             'banks': [{'name': 'home', 'source': 'raw/assets/audio/decoded (HomeButtonSe.brsar)', 'clips': clips}],
             'missingBanks': MISSING_BANKS}
    write_json(OUT / 'audio_index.json', index)
    write_json(INDEX / 'audio-export.json', {'clips': len(clips), 'missingBanks': MISSING_BANKS})
    print(f'clipes: {len(clips)} · bancos ausentes: {len(MISSING_BANKS)}')


if __name__ == '__main__':
    main()
