// EGG::DrawPathBloom (.pblm) -> Bloom do URP (Volume global).
//
// No Wii (internalDraw @ 8008a678): PostEffectMask tira o limiar (TEV: textura - limiar × cor_do_limiar,
// saturado), até 3 estágios de blur (PostEffectBlur/BlurGather, raio e intensidade por estágio) são
// somados e o resultado volta à tela multiplicado pela cor do bloom (alfa = força).
// O URP faz o mesmo encadeamento (pré-filtro por limiar, pirâmide de blur, soma × intensidade × tint), então:
//   threshold = limiar (o Wii trabalha em gama, como o parâmetro do URP)
//   intensity = alfa/255 × Σ intensidade dos estágios usados × intensityScale
//   scatter   = espalhamento a partir do raio do maior estágio usado (raio 1 -> 0,4 ... raio 16 -> 0,95)
//   tint      = rgb da cor do bloom
// intensityScale (4 por padrão) compensa a normalização diferente das duas pirâmides de blur; é a única
// constante calibrada aqui (escolhida para que o tênis, alfa 255 e 1 estágio de 0,25, dê intensidade 1).
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

namespace LinuxSports.Engine
{
    public struct Nw4rBloomSettings
    {
        public bool active;
        public float threshold, intensity, scatter;
        public Color tint;
    }

    public static class Nw4rBloom
    {
        public const float DefaultIntensityScale = 4f;

        public static Nw4rBloomSettings Map(Nw4rBloomData b, float intensityScale = DefaultIntensityScale)
        {
            var s = new Nw4rBloomSettings { tint = Color.white, threshold = 1f, scatter = 0.7f };
            if (b == null || !b.Enabled) return s;
            int n = Mathf.Clamp(b.stageCount, 0, 3);
            float sum = 0f, radius = 0f;
            for (int k = 0; k < n; k++) { sum += Mathf.Max(0f, b.stageIntensity[k]); radius = Mathf.Max(radius, b.stageRadius[k]); }
            s.active = sum > 0f;
            s.threshold = Mathf.Max(0f, b.threshold);
            s.intensity = b.color.a / 255f * sum * intensityScale;
            s.scatter = Mathf.Clamp(0.4f + 0.55f * Mathf.Log(Mathf.Max(1f, radius), 16f), 0.05f, 0.95f);
            s.tint = new Color(b.color.r / 255f, b.color.g / 255f, b.color.b / 255f, 1f);
            return s;
        }

        /// <summary>Cria (ou atualiza) um Volume global com Bloom e liga o pós-processamento da câmera.</summary>
        public static Volume Apply(Transform parent, Nw4rBloomData data, Camera camera, float intensityScale = DefaultIntensityScale)
        {
            var s = Map(data, intensityScale);
            var t = parent.Find("[Nw4rBloomVolume]");
            GameObject go = t != null ? t.gameObject : new GameObject("[Nw4rBloomVolume]");
            go.transform.SetParent(parent, false);
            var vol = go.GetComponent<Volume>();
            if (vol == null) vol = go.AddComponent<Volume>();
            vol.isGlobal = true;
            vol.priority = 10f;
            if (vol.sharedProfile == null) vol.sharedProfile = ScriptableObject.CreateInstance<VolumeProfile>();
            Bloom bloom;
            if (!vol.sharedProfile.TryGet(out bloom)) bloom = vol.sharedProfile.Add<Bloom>(true);
            bloom.active = s.active;
            bloom.threshold.Override(s.threshold);
            bloom.intensity.Override(s.active ? s.intensity : 0f);
            bloom.scatter.Override(s.scatter);
            bloom.tint.Override(s.tint);
            if (camera != null) camera.GetUniversalAdditionalCameraData().renderPostProcessing = true;
            return vol;
        }
    }
}
