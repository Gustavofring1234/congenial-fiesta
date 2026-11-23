// Síntese de efeitos sem bancos de som (os 8 .brsar do jogo não estão no projeto). Gera amostras mono
// float -1..1 de forma determinística (ruído xorshift com semente), para virar AudioClip via
// AudioClip.Create(stream: false) + SetData — o único caminho de áudio gerado que funciona no WebGL
// (lá não existe OnAudioFilterRead nem PCMReaderCallback em streaming).
using System;

namespace LinuxSports.Core
{
    public enum SfxKind
    {
        Impact,     // batida (bola na raquete/taco, pino, soco): tom amortecido + estalo de ruído
        Whoosh,     // deslocamento de ar (swing): ruído com filtro passa-banda que varre
        Click,      // interface: clique curto
        Confirm,    // interface: dois bipes subindo
        Cancel,     // interface: dois bipes descendo
        Crowd,      // ambiente: murmúrio de plateia (loop)
        Wind,       // ambiente: vento (loop)
    }

    public struct SfxParams
    {
        public SfxKind kind;
        public float duration;   // s
        public float pitch;      // Hz base (Impact/Click/UI) ou centro do filtro (Whoosh/Wind)
        public float hardness;   // 0..1: mais estalo / brilho
        public float gain;       // 0..1
        public int seed;

        public static SfxParams Of(SfxKind k)
        {
            switch (k)
            {
                case SfxKind.Impact: return new SfxParams { kind = k, duration = 0.35f, pitch = 180f, hardness = 0.6f, gain = 0.9f, seed = 1 };
                case SfxKind.Whoosh: return new SfxParams { kind = k, duration = 0.45f, pitch = 900f, hardness = 0.5f, gain = 0.6f, seed = 2 };
                case SfxKind.Click: return new SfxParams { kind = k, duration = 0.05f, pitch = 1800f, hardness = 0.8f, gain = 0.5f, seed = 3 };
                case SfxKind.Confirm: return new SfxParams { kind = k, duration = 0.22f, pitch = 880f, hardness = 0.3f, gain = 0.5f, seed = 4 };
                case SfxKind.Cancel: return new SfxParams { kind = k, duration = 0.22f, pitch = 660f, hardness = 0.3f, gain = 0.5f, seed = 5 };
                case SfxKind.Crowd: return new SfxParams { kind = k, duration = 4f, pitch = 500f, hardness = 0.3f, gain = 0.35f, seed = 6 };
                default: return new SfxParams { kind = SfxKind.Wind, duration = 4f, pitch = 400f, hardness = 0.2f, gain = 0.3f, seed = 7 };
            }
        }

        public string CacheKey()
        {
            return kind + "|" + duration.ToString("0.###") + "|" + pitch.ToString("0.#") + "|" + hardness.ToString("0.##") + "|" + gain.ToString("0.##") + "|" + seed;
        }
    }

    public static class ProceduralAudio
    {
        public static bool IsLoop(SfxKind k) { return k == SfxKind.Crowd || k == SfxKind.Wind; }

        public static float[] Render(SfxParams p, int sampleRate)
        {
            int n = Math.Max(1, (int)(Math.Max(0.01f, p.duration) * sampleRate));
            var o = new float[n];
            uint rng = (uint)(p.seed * 2654435761u) | 1u;
            Func<float> noise = () => { rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5; return (rng / 4294967295f) * 2f - 1f; };
            double sr = sampleRate;
            float hard = Clamp01(p.hardness), gain = Clamp01(p.gain);
            switch (p.kind)
            {
                case SfxKind.Impact:
                {
                    // tom com queda de altura + ruído muito curto (estalo); decaimento exponencial
                    float lp = 0f;
                    for (int i = 0; i < n; i++)
                    {
                        double t = i / sr;
                        double f = p.pitch * (1.0 + 1.5 * Math.Exp(-t * 40.0));
                        double body = Math.Sin(2 * Math.PI * f * t) * Math.Exp(-t * (12.0 + 10.0 * hard));
                        float nz = noise();
                        lp += (nz - lp) * (0.2f + 0.7f * hard);
                        double click = lp * Math.Exp(-t * (300.0 - 150.0 * hard));
                        o[i] = (float)((body * (1.0 - 0.4 * hard) + click * (0.4 + 0.8 * hard)) * gain);
                    }
                    break;
                }
                case SfxKind.Whoosh:
                {
                    // ruído em passa-banda (state variable filter) com centro varrendo e envelope em sino
                    float low = 0f, band = 0f;
                    for (int i = 0; i < n; i++)
                    {
                        double x = (double)i / n;
                        double env = Math.Sin(Math.PI * x); env *= env;
                        double fc = p.pitch * (0.5 + 1.5 * x);
                        float f = (float)(2 * Math.Sin(Math.PI * Math.Min(fc, sr / 6) / sr));
                        float q = 1.2f - 0.8f * hard;
                        float input = noise();
                        low += f * band;
                        float high = input - low - q * band;
                        band += f * high;
                        o[i] = (float)(band * env * gain * 1.6);
                    }
                    break;
                }
                case SfxKind.Click:
                    for (int i = 0; i < n; i++)
                    {
                        double t = i / sr;
                        o[i] = (float)((Math.Sin(2 * Math.PI * p.pitch * t) * (1 - hard) + noise() * hard * 0.5) * Math.Exp(-t * 120.0) * gain);
                    }
                    break;
                case SfxKind.Confirm:
                case SfxKind.Cancel:
                {
                    double ratio = p.kind == SfxKind.Confirm ? 1.5 : 1 / 1.5;
                    int half = n / 2;
                    for (int i = 0; i < n; i++)
                    {
                        int k = i < half ? i : i - half;
                        double t = k / sr;
                        double f = i < half ? p.pitch : p.pitch * ratio;
                        double env = Math.Min(1.0, t * 400.0) * Math.Exp(-t * 18.0);
                        double tone = Math.Sin(2 * Math.PI * f * t) + 0.3 * hard * Math.Sin(4 * Math.PI * f * t);
                        o[i] = (float)(tone * env * gain * 0.8);
                    }
                    break;
                }
                default:
                {
                    // Crowd / Wind: ruído filtrado com modulação lenta; ponta cruzada para loop sem estalo
                    bool crowd = p.kind == SfxKind.Crowd;
                    float low = 0f, band = 0f;
                    double lfoRate = crowd ? 0.7 : 0.23;
                    for (int i = 0; i < n; i++)
                    {
                        double t = i / sr;
                        double lfo = 0.6 + 0.4 * Math.Sin(2 * Math.PI * lfoRate * t + p.seed);
                        double fc = p.pitch * (crowd ? (0.8 + 0.4 * Math.Sin(2 * Math.PI * 3.1 * t)) : (0.6 + 0.8 * lfo));
                        float f = (float)(2 * Math.Sin(Math.PI * Math.Min(fc, sr / 6) / sr));
                        float input = noise();
                        low += f * band;
                        float high = input - low - (crowd ? 0.9f : 0.5f) * band;
                        band += f * high;
                        o[i] = (float)((crowd ? band : low * 0.7) * lfo * gain);
                    }
                    int fade = Math.Min(n / 4, sampleRate / 4);
                    for (int i = 0; i < fade; i++)
                    {
                        float a = (float)i / fade;
                        o[i] = o[i] * a + o[n - fade + i] * (1f - a);
                    }
                    Array.Resize(ref o, n - fade);
                    break;
                }
            }
            Normalize(o, 0.95f * Math.Max(gain, 1e-3f));
            return o;
        }

        private static float Clamp01(float v) { return v < 0f ? 0f : v > 1f ? 1f : v; }

        private static void Normalize(float[] s, float peakTarget)
        {
            float peak = 0f;
            for (int i = 0; i < s.Length; i++) peak = Math.Max(peak, Math.Abs(s[i]));
            if (peak <= 1e-6f) return;
            float k = Math.Min(peakTarget / peak, 4f);
            if (peak * k > 1f) k = 1f / peak;
            for (int i = 0; i < s.Length; i++) s[i] *= k;
        }
    }
}
