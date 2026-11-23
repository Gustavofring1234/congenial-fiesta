// Áudio do jogo no WebGL:
//   - carrega os .wav de StreamingAssets/Audio (audio_index.json, gerado por tools/export_audio.py) por
//     UnityWebRequestMultimedia; procura por nome de arquivo ou nome do som do .brsar (ex.: HOMESE_CONNECTED);
//   - bancos externos futuros entram por RegisterBank/RegisterClip (os 8 .brsar do jogo não estão no projeto;
//     o índice lista quais são, em missingBanks);
//   - sem clipe, cai na síntese procedural (ProceduralAudio -> AudioClip.Create + SetData, com cache);
//   - libera o AudioContext do navegador no primeiro gesto (o .jslib já faz isso no pointerup/touchend;
//     aqui o Update repete a chamada a cada clique/tecla até o contexto ficar "running").
using System;
using System.Collections;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.Networking;

namespace LinuxSports.Core
{
    public sealed class AudioManager : MonoBehaviour
    {
        public const string IndexPath = "Audio/audio_index.json";
        private static AudioManager instance;

        public static AudioManager Instance
        {
            get
            {
                if (instance == null)
                {
                    instance = FindObjectOfType<AudioManager>();
                    if (instance == null)
                    {
                        var go = new GameObject("[AudioManager]");
                        DontDestroyOnLoad(go);
                        instance = go.AddComponent<AudioManager>();
                    }
                }
                return instance;
            }
        }

        [Range(0f, 1f)] public float masterVolume = 1f;
        [Range(0f, 1f)] public float sfxVolume = 1f;
        [Range(0f, 1f)] public float ambientVolume = 0.6f;
        [Range(1, 32)] public int voices = 12;
        public bool loadIndexOnStart = true;

        /// <summary>Sons do .brsar sem clipe -> efeito sintetizado no lugar.</summary>
        public static readonly Dictionary<string, SfxKind> CueFallbacks = new Dictionary<string, SfxKind>
        {
            { "HOMESE_SELECT", SfxKind.Confirm }, { "HOMESE_CANCEL", SfxKind.Cancel }, { "HOMESE_FOCUS", SfxKind.Click },
            { "HOMESE_HOME_BUTTON", SfxKind.Confirm }, { "HOMESE_RETURN_APP", SfxKind.Cancel }, { "HOMESE_GOTO_MENU", SfxKind.Confirm },
            { "HOMESE_NOTHING_DONE", SfxKind.Click }, { "HOMESE_VOLUME_MINUS", SfxKind.Click },
            // Sons do rp_Common_Sports.brsar citados pelo código (strings.tsv); o banco não veio com o jogo.
            { "SE_TR_Common_Sports_Cursol", SfxKind.Click }, { "SE_TR_Common_Sports_Decide", SfxKind.Confirm },
            { "SE_TR_Common_Sports_Cancel", SfxKind.Cancel }, { "SE_TR_Common_Sports_Game_Start", SfxKind.Confirm },
            { "SE_TR_Common_Sports_Game_End", SfxKind.Confirm }, { "SE_TR_Common_Sports_Wipe", SfxKind.Whoosh },
            { "SE_TR_Common_Sports_MyBestRecord", SfxKind.Confirm }, { "SE_TR_Common_Sports_DemoSkipButton", SfxKind.Click },
            { "SE_TR_Common_Sports_Training_GoodLong", SfxKind.Confirm }, { "SE_TR_Common_Sports_Training_NotGood", SfxKind.Cancel },
            { "SE_TR_Common_Jyunban", SfxKind.Click }, { "SE_TR_Common_ModeChange_TVSP", SfxKind.Click },
        };

        public event Action<string> BankLoaded;
        public bool IsUnlocked { get; private set; }
        public IList<string> MissingBanks { get { return missingBanks; } }

        private readonly Dictionary<string, AudioClip> clips = new Dictionary<string, AudioClip>(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, AudioClip> synthCache = new Dictionary<string, AudioClip>();
        private readonly List<string> missingBanks = new List<string>();
        private readonly HashSet<string> warned = new HashSet<string>();
        private readonly List<AudioSource> pool = new List<AudioSource>();
        private AudioSource ambient;
        private int next;

        private void Awake()
        {
            if (instance != null && instance != this) { Destroy(this); return; }
            instance = this;
            WebGLSensors.Start(false);
            for (int k = 0; k < voices; k++) pool.Add(NewSource("voice" + k));
            ambient = NewSource("ambient");
            ambient.loop = true;
        }

        private void Start()
        {
            if (loadIndexOnStart) LoadIndex();
        }

        private AudioSource NewSource(string n)
        {
            var go = new GameObject(n);
            go.transform.SetParent(transform, false);
            var s = go.AddComponent<AudioSource>();
            s.playOnAwake = false;
            s.spatialBlend = 0f;
            return s;
        }

        private void Update()
        {
            if (IsUnlocked) return;
            if (WebGLSensors.AudioRunning) { IsUnlocked = true; return; }
            bool gesture = (Pointer.current != null && Pointer.current.press.wasPressedThisFrame)
                           || (Keyboard.current != null && Keyboard.current.anyKey.wasPressedThisFrame)
                           || (Touchscreen.current != null && Touchscreen.current.primaryTouch.press.wasPressedThisFrame);
            if (gesture) WebGLSensors.UnlockAudio();
        }

        // ---------------------------------------------------------------- bancos

        public void LoadIndex()
        {
            StreamingAssetLoader.Instance.LoadJson(IndexPath, root =>
            {
                missingBanks.Clear();
                missingBanks.AddRange(J.Strings(root, "missingBanks") ?? new List<string>());
                foreach (var bank in J.Objs(root, "banks"))
                {
                    var entries = new List<KeyValuePair<string[], string>>();
                    foreach (var c in J.Objs(bank, "clips"))
                        entries.Add(new KeyValuePair<string[], string>(new[] { J.Str(c, "name"), J.Str(c, "cue") }, J.Str(c, "file")));
                    StartCoroutine(LoadBank(J.Str(bank, "name"), entries));
                }
            }, err => Debug.LogWarning("AudioManager: " + err));
        }

        private IEnumerator LoadBank(string bank, List<KeyValuePair<string[], string>> entries)
        {
            foreach (var e in entries)
            {
                using (var req = UnityWebRequestMultimedia.GetAudioClip(StreamingAssetLoader.Url(e.Value), AudioType.WAV))
                {
                    yield return req.SendWebRequest();
                    if (req.result != UnityWebRequest.Result.Success)
                    {
                        Debug.LogWarning("AudioManager: " + e.Value + ": " + req.error);
                        continue;
                    }
                    var clip = DownloadHandlerAudioClip.GetContent(req);
                    clip.name = e.Key[0];
                    foreach (var key in e.Key) if (!string.IsNullOrEmpty(key)) clips[key] = clip;
                }
            }
            if (BankLoaded != null) BankLoaded(bank);
        }

        /// <summary>Gancho para bancos externos (ex.: um .brsar convertido no futuro).</summary>
        public void RegisterBank(string bank, IDictionary<string, AudioClip> bankClips)
        {
            foreach (var kv in bankClips) if (kv.Value != null) clips[kv.Key] = kv.Value;
            missingBanks.Remove(bank);
            if (BankLoaded != null) BankLoaded(bank);
        }

        public void RegisterClip(string name, AudioClip clip) { if (clip != null) clips[name] = clip; }

        public bool HasClip(string name) { return name != null && clips.ContainsKey(name); }

        // ---------------------------------------------------------------- reprodução

        /// <summary>Toca por nome de clipe ou de som do .brsar; sem clipe usa CueFallbacks (síntese).</summary>
        public AudioSource Play(string nameOrCue, float volume = 1f, float pitch = 1f)
        {
            AudioClip clip;
            if (nameOrCue != null && clips.TryGetValue(nameOrCue, out clip)) return PlayClip(clip, volume, pitch);
            SfxKind fb;
            if (nameOrCue != null && CueFallbacks.TryGetValue(nameOrCue, out fb)) return PlaySfx(fb, volume, pitch);
            if (nameOrCue != null && warned.Add(nameOrCue)) Debug.LogWarning("AudioManager: som sem clipe nem síntese: " + nameOrCue);
            return null;
        }

        public AudioSource PlayClip(AudioClip clip, float volume = 1f, float pitch = 1f)
        {
            if (clip == null) return null;
            var s = pool[next];
            next = (next + 1) % pool.Count;
            s.Stop();
            s.clip = clip;
            s.volume = Mathf.Clamp01(volume) * sfxVolume * masterVolume;
            s.pitch = Mathf.Clamp(pitch, 0.1f, 3f);
            s.Play();
            return s;
        }

        public AudioSource PlaySfx(SfxKind kind, float volume = 1f, float pitch = 1f)
        {
            return PlayClip(Synth(SfxParams.Of(kind)), volume, pitch);
        }

        public AudioSource PlaySfx(SfxParams p, float volume = 1f, float pitch = 1f)
        {
            return PlayClip(Synth(p), volume, pitch);
        }

        /// <summary>Batida com força 0..1 (volume e brilho) e dureza 0..1 (madeira/plástico -> metal).
        /// Força é quantizada em 4 níveis para reaproveitar clipes do cache.</summary>
        public AudioSource PlayImpact(float strength, float hardness = 0.6f, float pitchHz = 180f)
        {
            float s = Mathf.Clamp01(strength);
            var p = SfxParams.Of(SfxKind.Impact);
            p.hardness = Mathf.Round(Mathf.Clamp01(hardness) * 4f) / 4f;
            p.pitch = Mathf.Round(pitchHz / 10f) * 10f;
            p.duration = 0.2f + 0.25f * Mathf.Round(s * 3f) / 3f;
            return PlaySfx(p, 0.3f + 0.7f * s, UnityEngine.Random.Range(0.96f, 1.04f));
        }

        public void PlayAmbient(SfxKind kind, float volume = 1f)
        {
            var clip = Synth(SfxParams.Of(kind));
            if (ambient.clip == clip && ambient.isPlaying) { ambient.volume = volume * ambientVolume * masterVolume; return; }
            ambient.clip = clip;
            ambient.volume = Mathf.Clamp01(volume) * ambientVolume * masterVolume;
            ambient.Play();
        }

        public void PlayAmbient(AudioClip clip, float volume = 1f)
        {
            if (clip == null) return;
            ambient.clip = clip;
            ambient.volume = Mathf.Clamp01(volume) * ambientVolume * masterVolume;
            ambient.Play();
        }

        public void StopAmbient() { ambient.Stop(); }

        public void StopAll()
        {
            foreach (var s in pool) s.Stop();
            ambient.Stop();
        }

        /// <summary>Clipe sintetizado (cache por parâmetros). Funciona no WebGL: AudioClip.Create sem stream.</summary>
        public AudioClip Synth(SfxParams p)
        {
            string key = p.CacheKey();
            AudioClip c;
            if (synthCache.TryGetValue(key, out c) && c != null) return c;
            int rate = AudioSettings.outputSampleRate > 0 ? AudioSettings.outputSampleRate : 44100;
            float[] data = ProceduralAudio.Render(p, rate);
            c = AudioClip.Create("sfx_" + key, data.Length, 1, rate, false);
            c.SetData(data, 0);
            synthCache[key] = c;
            return c;
        }
    }
}
