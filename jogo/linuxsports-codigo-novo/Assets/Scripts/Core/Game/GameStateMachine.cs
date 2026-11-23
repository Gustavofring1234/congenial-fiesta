// Fluxo do jogo: Boot -> Menu principal -> Modalidade -> Mii (.rcd) -> Opções -> Partida -> Resultados
// (recordes no PlayerPrefs) -> Recordes. Cada estado mostra os layouts NW4R do RPSportsTitle/RPCommon/
// SportsStatic listados em gameplay_data.json (stateLayouts) e um menu navegável por qualquer entrada.
// Basta pôr este componente numa cena vazia: ele cria câmera, HUD, InputRouter e AudioManager.
using System;
using System.Collections;
using System.Collections.Generic;
using LinuxSports.Activities;
using LinuxSports.Activities.Baseball;
using LinuxSports.Activities.Bowling;
using LinuxSports.Activities.Boxing;
using LinuxSports.Activities.Golf;
using LinuxSports.Activities.Tennis;
using LinuxSports.Engine;
using LinuxSports.Entities;
using LinuxSports.UI;
using UnityEngine;

namespace LinuxSports.Core
{
    public sealed class GameStateMachine : MonoBehaviour
    {
        public enum State { Boot, MainMenu, SportSelect, CharacterSelect, Options, Playing, Paused, Results, Records }

        public const string ProfilePref = "ls.profile";
        public string language = "us";
        public string titleScene = "src/core/shared/RPST/common/common.scene.json";
        public string menuScene = "src/core/shared/RPSportsCommon/common/common.scene.json";

        public State Current { get; private set; } = State.Boot;
        public event Action<State> StateChanged;
        public GameSession Session { get; private set; }
        public ActivityResult LastResult { get; private set; }

        private GameplayData data;
        private GameHud hud;
        private MenuView menu;
        private Camera cam;
        private SportActivity activity;
        private Nw4rSceneLoader background;
        private string backgroundPath;
        private List<string> profiles = new List<string>();
        private int profileIndex;
        private int opponentCount = 1;
        private readonly List<string> newRecords = new List<string>();
        private bool ready;

        // ------------------------------------------------------------------ inicialização
        private void Start()
        {
            Application.targetFrameRate = 60;
            cam = Camera.main;
            if (cam == null)
            {
                var go = new GameObject("Main Camera");
                go.tag = "MainCamera";
                cam = go.AddComponent<Camera>();
                go.AddComponent<AudioListener>();
            }
            cam.clearFlags = CameraClearFlags.SolidColor;
            cam.backgroundColor = new Color(0.45f, 0.65f, 0.9f);
            hud = GameHud.Ensure();
            menu = MenuView.Create(hud);
            // Cria os serviços de entrada e áudio já na primeira tela (o áudio é liberado no 1º gesto no WebGL).
            InputRouter.Instance.enabled = true;
            AudioManager.Instance.enabled = true;
            hud.SetTitle("Linux Sports");
            hud.SetHint("Carregando...");
            GameplayData.Load(d =>
            {
                data = d;
                RecordStore.SetValidFields(d.recordFields);
                profiles = MiiResources.ProfileIds();
                string saved = PlayerPrefs.GetString(ProfilePref, profiles.Count > 0 ? profiles[0] : "");
                profileIndex = Mathf.Max(0, profiles.IndexOf(saved));
                TextManager.Load(language, tm => { ready = true; Go(State.Boot); }, err => { Debug.LogWarning(err); ready = true; Go(State.Boot); });
            }, err => { hud.SetHint("Erro ao carregar dados de jogo: " + err); Debug.LogError(err); });
        }

        private string T(string file, int id, string fallback)
        {
            var tm = TextManager.Current;
            var m = tm != null ? tm.Get(file, id) : null;
            return m != null && !string.IsNullOrEmpty(m.text) ? m.text.Replace("\n", " ") : fallback;
        }

        // IDs do common_message.bmg (US): nomes das modalidades e títulos.
        private string SportName(Sport s)
        {
            switch (s)
            {
                case Sport.Tennis: return T("common_message", 77056, "Tênis");
                case Sport.Baseball: return T("common_message", 77312, "Beisebol");
                case Sport.Bowling: return T("common_message", 77568, "Boliche");
                case Sport.Golf: return T("common_message", 77824, "Golfe");
                default: return T("common_message", 78080, "Boxe");
            }
        }

        // ------------------------------------------------------------------ transições
        public void Go(State next)
        {
            if (!ready) return;
            menu.Close();
            hud.ClearMessage();
            if (next != State.Paused && Current != State.Paused) hud.ClearLayouts();
            var prev = Current;
            Current = next;
            if (data != null && next != State.Playing && next != State.Paused)
            {
                List<string> lyts;
                if (data.stateLayouts.TryGetValue(next.ToString(), out lyts)) hud.ShowLayouts(lyts);
            }
            switch (next)
            {
                case State.Boot: EnterBoot(); break;
                case State.MainMenu: EnterMainMenu(); break;
                case State.SportSelect: EnterSportSelect(); break;
                case State.CharacterSelect: EnterCharacterSelect(); break;
                case State.Options: EnterOptions(); break;
                case State.Playing: if (prev != State.Paused) StartActivity(); else Resume(); break;
                case State.Paused: EnterPause(); break;
                case State.Results: EnterResults(); break;
                case State.Records: EnterRecords(); break;
            }
            if (StateChanged != null) StateChanged(next);
        }

        private void Update()
        {
            if (!ready) return;
            var input = InputRouter.Instance;
            if (Current == State.Boot && (input.ConfirmThisFrame || bootGesture))
            {
                AudioManager.Instance.Play("SE_TR_Common_Sports_Decide");
                Go(State.MainMenu);
            }
            else if (Current == State.Playing && input.BackThisFrame && activity != null && !activity.IsFinished)
                Go(State.Paused);
        }

        private bool bootGesture;

        private void SetBackground(string path)
        {
            if (backgroundPath == path && background != null) return;
            if (background != null) Destroy(background.gameObject);
            background = null;
            backgroundPath = path;
            if (string.IsNullOrEmpty(path)) return;
            var go = new GameObject("MenuBackground");
            background = go.AddComponent<Nw4rSceneLoader>();
            background.loadOnStart = false;
            background.loadCollision = false;
            background.markersForUnknownTypes = false;
            background.Load("Scenes/" + path);
            if (cam != null)
            {
                cam.transform.position = new Vector3(0f, 20f, 120f);
                cam.transform.rotation = Quaternion.LookRotation(new Vector3(0f, 10f, 0f) - cam.transform.position);
                cam.fieldOfView = 45f;
            }
        }

        private void EnterBoot()
        {
            SetBackground(titleScene);
            hud.SetTitle("Linux Sports");
            hud.SetScore("");
            hud.SetHint("Pressione Confirmar (Enter, clique, toque ou botão A) para começar");
            bootGesture = false;
            InputRouter.Instance.Gesture += BootGesture;
        }

        private void BootGesture(GestureEvent g)
        {
            if (Current == State.Boot) bootGesture = true;
        }

        private void EnterMainMenu()
        {
            InputRouter.Instance.Gesture -= BootGesture;
            SetBackground(menuScene);
            hud.SetTitle("Linux Sports");
            hud.SetScore("Jogador: " + CurrentProfileName());
            hud.SetHint("^ v escolher   Confirmar   Voltar");
            menu.Open("Menu principal", new List<MenuView.Item>
            {
                new MenuView.Item { label = "Jogar", onSelect = () => Go(State.SportSelect) },
                new MenuView.Item { dynamicLabel = () => "Meu Mii: " + CurrentProfileName(), onSelect = () => Go(State.CharacterSelect) },
                new MenuView.Item { label = "Recordes", onSelect = () => Go(State.Records) },
            }, () => Go(State.Boot));
        }

        private void EnterSportSelect()
        {
            hud.SetTitle("Escolha a modalidade");
            hud.SetScore("Jogador: " + CurrentProfileName());
            var items = new List<MenuView.Item>();
            foreach (Sport s in Enum.GetValues(typeof(Sport)))
            {
                var sport = s;
                var sd = data[s];
                bool available = sd != null && (s == Sport.Golf ? data.golfCourses.Count > 0 : (sd.scenes.Count > 0 || sd.commonScene != null));
                int skill = RecordStore.Skill(CurrentProfileId(), s);
                items.Add(new MenuView.Item
                {
                    label = SportName(s) + "   (habilidade " + skill + ")",
                    enabled = available,
                    onSelect = () => { NewSession(sport); Go(State.Options); },
                });
            }
            menu.Open("Modalidade", items, () => Go(State.MainMenu));
        }

        private void EnterCharacterSelect()
        {
            hud.SetTitle(T("common_message", 153601, "Escolha um Mii"));
            hud.SetScore("");
            menu.Open("Seu Mii (" + profiles.Count + " perfis .rcd)", new List<MenuView.Item>
            {
                new MenuView.Item
                {
                    dynamicLabel = () => CurrentProfileName() + "  (" + (profileIndex + 1) + "/" + profiles.Count + ")",
                    onAdjust = d => { if (profiles.Count > 0) profileIndex = (profileIndex + d + profiles.Count) % profiles.Count; ShowProfileInfo(); },
                },
                new MenuView.Item { label = "Confirmar", onSelect = () => { PlayerPrefs.SetString(ProfilePref, CurrentProfileId()); PlayerPrefs.Save(); Go(State.MainMenu); } },
            }, () => Go(State.MainMenu));
            ShowProfileInfo();
        }

        private void ShowProfileInfo()
        {
            var info = profiles.Count > 0 ? MiiResources.LoadProfile(CurrentProfileId()) : null;
            if (info == null) { hud.SetScore(""); return; }
            hud.SetScore(info.name + (info.female ? "  (F)" : "  (M)") + "\nAltura " + info.height + "/127   Peso " + info.build + "/127\nCor favorita " + info.favoriteColor);
        }

        private string CurrentProfileId() { return profiles.Count > 0 ? profiles[Mathf.Clamp(profileIndex, 0, profiles.Count - 1)] : "cpu_mii_000"; }

        private string CurrentProfileName()
        {
            var info = profiles.Count > 0 ? MiiResources.LoadProfile(CurrentProfileId()) : null;
            return info != null && !string.IsNullOrEmpty(info.name) ? info.name : CurrentProfileId();
        }

        // ------------------------------------------------------------------ sessão e opções
        private void NewSession(Sport s)
        {
            Session = new GameSession { sport = s, seed = Environment.TickCount & 0x7FFFFFFF };
            if (s == Sport.Golf && data.golfCourses.Count > 0)
            {
                int n = Mathf.Min(3, data.golfCourses.Count);
                for (int i = 0; i < n; i++) Session.golfHoles.Add(data.golfCourses[i].id);
            }
            opponentCount = 1;
            courseSet = 0;
        }

        private void EnterOptions()
        {
            var s = Session;
            hud.SetTitle(SportName(s.sport));
            hud.SetScore("");
            var items = new List<MenuView.Item>();
            switch (s.sport)
            {
                case Sport.Tennis:
                    items.Add(new MenuView.Item { dynamicLabel = () => "Games: " + s.tennisGames, onAdjust = d => s.tennisGames = Step(s.tennisGames, d, new[] { 1, 3, 5 }) });
                    items.Add(new MenuView.Item { dynamicLabel = () => s.tennisDoubles ? "Duplas (você + CPU)" : "Simples", onAdjust = d => s.tennisDoubles = !s.tennisDoubles });
                    break;
                case Sport.Baseball:
                    items.Add(new MenuView.Item { dynamicLabel = () => "Entradas: " + s.baseballInnings, onAdjust = d => s.baseballInnings = Step(s.baseballInnings, d, new[] { 1, 3, 9 }) });
                    break;
                case Sport.Bowling:
                    items.Add(new MenuView.Item { dynamicLabel = () => "Adversários CPU: " + opponentCount, onAdjust = d => opponentCount = Mathf.Clamp(opponentCount + d, 0, 3) });
                    items.Add(new MenuView.Item { dynamicLabel = () => "Quadros: " + s.bowlingFrames, onAdjust = d => s.bowlingFrames = Step(s.bowlingFrames, d, new[] { 3, 5, 10 }) });
                    break;
                case Sport.Golf:
                    items.Add(new MenuView.Item { dynamicLabel = () => "Percurso: " + CourseLabel(), onAdjust = d => CycleCourses(d) });
                    items.Add(new MenuView.Item { dynamicLabel = () => "Adversários CPU: " + opponentCount, onAdjust = d => opponentCount = Mathf.Clamp(opponentCount + d, 0, 3) });
                    break;
                case Sport.Boxing:
                    items.Add(new MenuView.Item { dynamicLabel = () => "Rounds: " + s.boxingRounds, onAdjust = d => s.boxingRounds = Step(s.boxingRounds, d, new[] { 1, 3, 5 }) });
                    break;
            }
            items.Add(new MenuView.Item { label = "Começar", onSelect = () => { BuildPlayers(); Go(State.Playing); } });
            menu.Open("Opções", items, () => Go(State.SportSelect), items.Count - 1);
        }

        private static int Step(int v, int d, int[] options)
        {
            int i = Array.IndexOf(options, v);
            if (i < 0) i = 0;
            return options[Mathf.Clamp(i + d, 0, options.Length - 1)];
        }

        private int courseSet;

        private void CycleCourses(int d)
        {
            int sets = CourseSets();
            courseSet = (courseSet + d + sets) % sets;
            Session.golfHoles.Clear();
            var all = data.golfCourses;
            if (courseSet == sets - 1) foreach (var c in all) Session.golfHoles.Add(c.id);
            else for (int i = courseSet * 3; i < Mathf.Min(all.Count, courseSet * 3 + 3); i++) Session.golfHoles.Add(all[i].id);
        }

        private int CourseSets() { return (data.golfCourses.Count + 2) / 3 + 1; }

        private string CourseLabel()
        {
            if (Session.golfHoles.Count == data.golfCourses.Count) return "todos os " + data.golfCourses.Count + " buracos";
            int par = 0;
            foreach (var id in Session.golfHoles) { var c = data.golfCourses.Find(g => g.id == id); if (c != null) par += c.par; }
            return string.Join(", ", Session.golfHoles.ToArray()) + "  (par " + par + ")";
        }

        private void BuildPlayers()
        {
            var s = Session;
            s.players.Clear();
            string me = CurrentProfileId();
            int mySkill = RecordStore.Skill(me, s.sport);
            var meInfo = MiiResources.LoadProfile(me);
            s.players.Add(new PlayerSlot { profileId = me, name = meInfo != null ? meInfo.name : "Você", human = true, info = meInfo, ai = AiProfile.FromMii(meInfo, me, 0.6f) });
            int cpus;
            switch (s.sport)
            {
                case Sport.Tennis: cpus = s.tennisDoubles ? 3 : 1; break;
                case Sport.Baseball: case Sport.Boxing: cpus = 1; break;
                default: cpus = opponentCount; break;
            }
            var rng = new System.Random(s.seed);
            var pool = new List<string>(profiles);
            pool.Remove(me);
            // Em duplas, o 2º jogador do time 0 é um parceiro CPU; os adversários vêm depois.
            for (int i = 0; i < cpus && pool.Count > 0; i++)
            {
                string id = pool[rng.Next(pool.Count)];
                pool.Remove(id);
                var info = MiiResources.LoadProfile(id);
                float skill = AiProfile.SkillForOpponent(mySkill, i);
                s.players.Add(new PlayerSlot { profileId = id, name = info != null ? info.name : id, human = false, info = info, ai = AiProfile.FromMii(info, id, skill) });
            }
        }

        // ------------------------------------------------------------------ partida
        private void StartActivity()
        {
            SetBackground(null);
            hud.ClearAll();
            var go = new GameObject("Activity_" + Session.sport);
            switch (Session.sport)
            {
                case Sport.Tennis: activity = go.AddComponent<TennisActivity>(); break;
                case Sport.Baseball: activity = go.AddComponent<BaseballActivity>(); break;
                case Sport.Bowling: activity = go.AddComponent<BowlingActivity>(); break;
                case Sport.Golf: activity = go.AddComponent<GolfActivity>(); break;
                default: activity = go.AddComponent<BoxingActivity>(); break;
            }
            activity.Finished += OnActivityFinished;
            activity.Begin(Session, data, cam);
        }

        private void EnterPause()
        {
            if (activity != null) activity.Paused = true;
            Time.timeScale = 0f;
            List<string> pauseLayouts;
            if (data.stateLayouts.TryGetValue(State.Paused.ToString(), out pauseLayouts)) hud.ShowLayouts(pauseLayouts);
            menu.Open("Pausa", new List<MenuView.Item>
            {
                new MenuView.Item { label = "Continuar", onSelect = () => Go(State.Playing) },
                new MenuView.Item { label = "Recalibrar sensores", onSelect = () => { InputRouter.Instance.CalibrateTilt(); Go(State.Playing); } },
                new MenuView.Item { label = "Sair da partida", onSelect = () => { Time.timeScale = 1f; if (activity != null) activity.Abort(); } },
            }, () => Go(State.Playing));
        }

        private void Resume()
        {
            Time.timeScale = 1f;
            if (activity != null) activity.Paused = false;
            List<string> pauseLayouts;
            if (data.stateLayouts.TryGetValue(State.Paused.ToString(), out pauseLayouts))
                foreach (var id in pauseLayouts) hud.HideLayout(id);
        }

        private void OnActivityFinished(ActivityResult r)
        {
            Time.timeScale = 1f;
            LastResult = r;
            newRecords.Clear();
            if (!r.aborted) SubmitRecords(r);
            if (activity != null) Destroy(activity.gameObject);
            activity = null;
            AudioManager.Instance.StopAmbient();
            hud.ClearAll();
            Go(r.aborted ? State.SportSelect : State.Results);
        }

        private void SubmitRecords(ActivityResult r)
        {
            string me = CurrentProfileId();
            foreach (var rec in r.records)
                if (RecordStore.Submit(me, rec)) newRecords.Add(RecordLabel(rec.field) + ": " + rec.value);
            RecordStore.Submit(me, new RecordSubmission { field = "StandardPlayCount", value = 1, mode = RecordMode.Add });
            // Habilidade: compara com a força média dos adversários CPU.
            float opp = 0f; int n = 0;
            foreach (var p in Session.players) if (!p.human && p.ai != null) { opp += p.ai.skill; n++; }
            if (n > 0)
            {
                float outcome = r.winner < 0 ? 0.5f : r.humanWon ? 1f : 0f;
                int delta = RecordStore.UpdateSkill(me, Session.sport, opp / n, outcome);
                r.lines.Add("Habilidade " + (delta >= 0 ? "+" : "") + delta + " = " + RecordStore.Skill(me, Session.sport));
            }
            RecordStore.Save();
        }

        private static string RecordLabel(string field)
        {
            switch (field)
            {
                case "BowStandardBest": return "Melhor pontuação no boliche";
                case "BowPerfectCount": return "Jogos perfeitos";
                case "GolStandardBest": return "Melhor resultado no golfe";
                case "GolAceCount": return "Hole in one";
                case "BsbRenzokuBest": return "Rebatidas seguidas";
                case "TnsSuccess": return "Vitórias no tênis";
                default: return field;
            }
        }

        private void EnterResults()
        {
            SetBackground(menuScene);
            var r = LastResult;
            hud.SetTitle("Resultado - " + SportName(r.sport));
            var sb = new System.Text.StringBuilder();
            for (int i = 0; i < r.players.Count; i++)
                sb.Append(i == r.winner ? "* " : "  ").Append(r.players[i].name).Append(": ").Append(r.players[i].scoreText).Append('\n');
            foreach (var l in r.lines) sb.Append(l).Append('\n');
            if (newRecords.Count > 0)
            {
                sb.Append("\nNOVO RECORDE!\n");
                foreach (var n in newRecords) sb.Append(n).Append('\n');
                AudioManager.Instance.Play("SE_TR_Common_Sports_MyBestRecord");
            }
            hud.SetScore(sb.ToString());
            hud.ShowMessage(r.winner < 0 ? "Empate" : r.humanWon ? "Vitória!" : "Derrota", 2.5f);
            menu.Open("", new List<MenuView.Item>
            {
                new MenuView.Item { label = "Jogar de novo", onSelect = () => { BuildPlayers(); Go(State.Playing); } },
                new MenuView.Item { label = "Outra modalidade", onSelect = () => Go(State.SportSelect) },
                new MenuView.Item { label = "Recordes", onSelect = () => Go(State.Records) },
                new MenuView.Item { label = "Menu principal", onSelect = () => Go(State.MainMenu) },
            }, () => Go(State.MainMenu));
        }

        private void EnterRecords()
        {
            SetBackground(menuScene);
            string me = CurrentProfileId();
            hud.SetTitle("Recordes - " + CurrentProfileName());
            var sb = new System.Text.StringBuilder();
            Line(sb, "Boliche - melhor pontuação", me, "BowStandardBest");
            Line(sb, "Boliche - jogos perfeitos", me, "BowPerfectCount");
            Line(sb, "Golfe - hole in one", me, "GolAceCount");
            if (data != null)
            {
                foreach (var key in GolfRecordKeys())
                    if (RecordStore.Has(me, "GolStandardBest", key))
                        sb.Append("Golfe ").Append(key).Append(": ").Append(LinuxSports.Activities.Rules.GolfScorecard.ToParText(RecordStore.Get(me, "GolStandardBest", key))).Append('\n');
            }
            Line(sb, "Beisebol - rebatidas seguidas", me, "BsbRenzokuBest");
            Line(sb, "Tênis - vitórias", me, "TnsSuccess");
            Line(sb, "Partidas jogadas", me, "StandardPlayCount");
            foreach (Sport s in Enum.GetValues(typeof(Sport))) sb.Append("Habilidade em ").Append(SportName(s)).Append(": ").Append(RecordStore.Skill(me, s)).Append('\n');
            hud.SetScore(sb.ToString());
            menu.Open("", new List<MenuView.Item> { new MenuView.Item { label = "Voltar", onSelect = () => Go(State.MainMenu) } }, () => Go(State.MainMenu));
        }

        private IEnumerable<string> GolfRecordKeys()
        {
            var all = data.golfCourses;
            for (int i = 0; i < all.Count; i += 3)
            {
                var ids = new List<string>();
                for (int k = i; k < Mathf.Min(all.Count, i + 3); k++) ids.Add(all[k].id);
                yield return string.Join("-", ids.ToArray());
            }
            var every = new List<string>();
            foreach (var c in all) every.Add(c.id);
            yield return string.Join("-", every.ToArray());
        }

        private static void Line(System.Text.StringBuilder sb, string label, string profile, string field)
        {
            sb.Append(label).Append(": ").Append(RecordStore.Has(profile, field) ? RecordStore.Get(profile, field).ToString() : "-").Append('\n');
        }
    }
}
