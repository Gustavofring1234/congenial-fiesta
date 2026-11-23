// Base das modalidades: carrega as cenas (.scene.json com modelos, MeshColliders das malhas .glb e objetos
// .pmp), a iluminação URP da cena (Nw4rEnvironment), escala a gravidade para 10 u/m, oferece utilidades de
// gesto/espera/efeito/som e devolve um ActivityResult à GameStateMachine.
using System;
using System.Collections;
using System.Collections.Generic;
using LinuxSports.Core;
using LinuxSports.Engine;
using LinuxSports.UI;
using UnityEngine;

namespace LinuxSports.Activities
{
    public abstract class SportActivity : MonoBehaviour
    {
        public GameSession Session { get; private set; }
        public GameplayData Data { get; private set; }
        public SportData Sport { get; private set; }
        public GameHud Hud { get; private set; }
        public Camera Cam { get; private set; }
        public bool Paused { get; set; }
        public bool IsFinished { get; private set; }
        public event Action<ActivityResult> Finished;

        protected System.Random Rng;
        protected readonly List<Nw4rSceneLoader> Scenes = new List<Nw4rSceneLoader>();
        private Vector3 savedGravity;
        private bool gravitySaved;
        private GestureEvent? pendingGesture;

        protected float U => Data.unitsPerMeter;
        protected float M(float meters) { return meters * Data.unitsPerMeter; }
        protected InputRouter Input => InputRouter.Instance;
        protected AudioManager Audio => AudioManager.Instance;

        public void Begin(GameSession session, GameplayData data, Camera cam)
        {
            Session = session;
            Data = data;
            Sport = data[session.sport];
            Hud = GameHud.Ensure();
            Cam = cam;
            Rng = new System.Random(session.seed);
            savedGravity = Physics.gravity;
            gravitySaved = true;
            Physics.gravity = new Vector3(0f, -BallFlight.GravityMS2 * U, 0f);
            Input.Gesture += OnGesture;
            StartCoroutine(Main());
        }

        private IEnumerator Main()
        {
            yield return Run();
        }

        /// <summary>Partida completa (carregar, jogar, chamar Finish).</summary>
        protected abstract IEnumerator Run();

        /// <summary>Encerra sem resultado (menu de pausa > sair).</summary>
        public void Abort()
        {
            if (IsFinished) return;
            var r = new ActivityResult { sport = Session.sport, aborted = true };
            Finish(r);
        }

        protected void Finish(ActivityResult r)
        {
            if (IsFinished) return;
            IsFinished = true;
            r.sport = Session.sport;
            StopAllCoroutines();
            RestoreGravity();
            if (Finished != null) Finished(r);
        }

        private void RestoreGravity()
        {
            if (gravitySaved) { Physics.gravity = savedGravity; gravitySaved = false; }
        }

        protected virtual void OnDestroy()
        {
            RestoreGravity();
            if (InputRouter.Instance != null) InputRouter.Instance.Gesture -= OnGesture;
        }

        private void OnGesture(GestureEvent e) { if (!Paused) pendingGesture = e; }

        // ---------------------------------------------------------------- cenas e ambiente
        /// <summary>Carrega uma .scene.json como filha desta atividade. `lighting` liga o Nw4rEnvironment da cena.</summary>
        protected IEnumerator LoadScene(string path, bool collision, bool lighting, Action<Nw4rSceneLoader> got = null, Func<string, bool> keepModel = null)
        {
            if (string.IsNullOrEmpty(path)) { if (got != null) got(null); yield break; }
            string shortName = path.Substring(path.LastIndexOf('/') + 1).Replace(".scene.json", "");
            var go = new GameObject("Scene_" + shortName);
            go.transform.SetParent(transform, false);
            var loader = go.AddComponent<Nw4rSceneLoader>();
            loader.loadOnStart = false;
            loader.loadCollision = collision;
            loader.markersForUnknownTypes = false;
            bool done = false;
            loader.Loaded += l => done = true;
            loader.Load("Scenes/" + path);
            float timeout = Time.time + 30f;
            while (!done && Time.time < timeout) yield return null;
            if (!done) Debug.LogWarning("Cena não carregou: " + path);
            if (done && keepModel != null && loader.ModelsRoot != null)
                foreach (Transform m in loader.ModelsRoot)
                    if (!keepModel(m.name.Substring(m.name.LastIndexOf('/') + 1))) Destroy(m.gameObject);
            if (lighting)
            {
                var env = go.AddComponent<Nw4rEnvironment>();
                env.loadOnStart = false;
                env.targetCamera = Cam;
                env.LoadForScene("Scenes/" + path);
            }
            Scenes.Add(loader);
            if (got != null) got(loader);
        }

        /// <summary>Instancia um modelo do esporte pelo nome NW4R (gameplay_data -> models).</summary>
        protected GameObject Model(string name, Transform parent, PrimitiveType fallback, Vector3 fallbackScale, Color color)
        {
            var go = ModelSpawner.Spawn(Sport.ModelPrefab(name), parent != null ? parent : transform, fallback, fallbackScale, color, name);
            ModelSpawner.StripColliders(go);
            return go;
        }

        // ---------------------------------------------------------------- jogadores
        protected SportActor SpawnActor(PlayerSlot slot, Vector3 pos, Vector3 forward, Color team)
        {
            var a = SportActor.Create(slot, Sport, Data, transform, pos, forward);
            a.TeamColor = team;
            return a;
        }

        protected static readonly Color[] TeamColors =
        {
            new Color(0.2f, 0.45f, 1f), new Color(1f, 0.25f, 0.25f), new Color(0.2f, 0.85f, 0.35f), new Color(1f, 0.85f, 0.15f),
        };

        // ---------------------------------------------------------------- entrada e tempo
        /// <summary>Espera um gesto do tipo pedido (Swing/Throw/Strike). `onFrame` roda a cada quadro enquanto espera
        /// (mirar, mover); devolver false nele cancela a espera.</summary>
        protected IEnumerator WaitGesture(GestureKind kind, Action<GestureEvent> got, Func<bool> onFrame = null, float timeout = -1f)
        {
            Input.gestureKind = kind;
            pendingGesture = null;
            float t0 = Time.time;
            while (true)
            {
                if (!Paused)
                {
                    if (pendingGesture.HasValue)
                    {
                        var g = pendingGesture.Value;
                        pendingGesture = null;
                        got(g);
                        yield break;
                    }
                    if (onFrame != null && !onFrame()) yield break;
                    if (timeout > 0f && Time.time - t0 > timeout) yield break;
                }
                yield return null;
            }
        }

        /// <summary>Gesto pendente sem bloquear (para modalidades em tempo real como tênis e boxe).</summary>
        protected bool TakeGesture(out GestureEvent g)
        {
            if (pendingGesture.HasValue && !Paused) { g = pendingGesture.Value; pendingGesture = null; return true; }
            g = default(GestureEvent);
            return false;
        }

        protected void ClearGesture() { pendingGesture = null; }

        protected IEnumerator Wait(float seconds)
        {
            float t = 0f;
            while (t < seconds)
            {
                if (!Paused) t += Time.deltaTime;
                yield return null;
            }
        }

        protected IEnumerator WaitConfirm(float maxSeconds = 4f)
        {
            float t = 0f;
            yield return null;
            while (t < maxSeconds)
            {
                if (!Paused)
                {
                    t += Time.deltaTime;
                    if (Input.ConfirmThisFrame) yield break;
                }
                yield return null;
            }
        }

        protected IEnumerator Banner(string text, float seconds)
        {
            Hud.ShowMessage(text, seconds);
            yield return Wait(seconds);
        }

        protected float Dt => Paused ? 0f : Time.deltaTime;

        // ---------------------------------------------------------------- efeitos, som, câmera
        protected ParticleSystem Fx(string emitter, Vector3 pos, Quaternion? rot = null)
        {
            if (!Sport.HasEffect(emitter)) return null;
            return Nw4rEffectLibrary.Instance.Spawn(emitter, pos, rot ?? Quaternion.identity, transform);
        }

        protected void Sfx(SfxKind k, float vol = 1f, float pitch = 1f) { Audio.PlaySfx(k, vol, pitch); }
        protected void Impact(float strength, float hardness = 0.6f, float hz = 180f) { Audio.PlayImpact(strength, hardness, hz); }
        protected void Cue(string cue) { Audio.Play(cue); }

        protected void CameraSet(Vector3 pos, Vector3 lookAt, float fov = 45f)
        {
            if (Cam == null) return;
            Cam.transform.position = pos;
            Cam.transform.rotation = Quaternion.LookRotation(lookAt - pos, Vector3.up);
            Cam.fieldOfView = fov;
            Cam.nearClipPlane = 0.5f;
            Cam.farClipPlane = 20000f;
        }

        protected void CameraFollow(Vector3 pos, Vector3 lookAt, float sharpness, float fov = 45f)
        {
            if (Cam == null) return;
            float k = 1f - Mathf.Exp(-sharpness * Time.deltaTime);
            Cam.transform.position = Vector3.Lerp(Cam.transform.position, pos, k);
            var q = Quaternion.LookRotation(lookAt - Cam.transform.position, Vector3.up);
            Cam.transform.rotation = Quaternion.Slerp(Cam.transform.rotation, q, k);
            Cam.fieldOfView = Mathf.Lerp(Cam.fieldOfView, fov, k);
        }

        // ---------------------------------------------------------------- resultado
        protected ActivityResult NewResult()
        {
            var r = new ActivityResult { sport = Session.sport };
            return r;
        }

        protected PlayerResult AddPlayer(ActivityResult r, PlayerSlot s, int score, string text)
        {
            var p = new PlayerResult { profileId = s.profileId, name = s.name, human = s.human, score = score, scoreText = text };
            r.players.Add(p);
            return p;
        }

        protected static string Name(PlayerSlot s) { return s != null && !string.IsNullOrEmpty(s.name) ? s.name : "CPU"; }
    }
}
