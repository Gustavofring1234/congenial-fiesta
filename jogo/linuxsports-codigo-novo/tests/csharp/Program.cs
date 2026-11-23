// Testes da Etapa 5 sem o Editor: regras das 5 modalidades, Elo/IA, balística e solucionadores de tiro.
// Saída: uma linha por verificação e o total; código de saída 1 se alguma falhar.
using System;
using System.Collections.Generic;
using System.IO;
using LinuxSports.Activities;
using LinuxSports.Activities.Baseball;
using LinuxSports.Activities.Golf;
using LinuxSports.Activities.Rules;
using LinuxSports.Activities.Tennis;
using LinuxSports.Core;
using UnityEngine;

internal static class Program
{
    private static int pass, fail;

    private static void Check(bool ok, string what)
    {
        if (ok) pass++; else fail++;
        Console.WriteLine((ok ? "ok   " : "FAIL ") + what);
    }

    private static int Main(string[] args)
    {
        string root = args.Length > 0 ? args[0] : Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../.."));
        Bowling();
        Tennis();
        Baseball();
        Golf();
        Boxing();
        SkillAndAi(root);
        Ballistics();
        Console.WriteLine();
        Console.WriteLine(pass + " ok, " + fail + " falha(s)");
        return fail == 0 ? 0 : 1;
    }

    // ------------------------------------------------------------------ boliche
    private static RollOutcome Roll(BowlingScore s, int knocked)
    {
        int standing = s.StandingMask;
        for (int i = 0; i < 10 && knocked > 0; i++)
            if ((standing >> i & 1) != 0) { standing &= ~(1 << i); knocked--; }
        return s.Roll(standing);
    }

    private static void Bowling()
    {
        var perfect = new BowlingScore();
        for (int i = 0; i < 12; i++) Roll(perfect, 10);
        Check(perfect.IsGameOver && perfect.Total == 300 && perfect.Strikes == 12, "boliche: jogo perfeito = 300");

        var spares = new BowlingScore();
        for (int i = 0; i < 21; i++) Roll(spares, 5);
        Check(spares.IsGameOver && spares.Total == 150, "boliche: 21 bolas de 5 (só spares) = 150");

        var gutter = new BowlingScore();
        for (int i = 0; i < 20; i++) Roll(gutter, 0);
        Check(gutter.IsGameOver && gutter.Total == 0 && gutter.Rolls.Count == 20, "boliche: só canaletas = 0 em 20 bolas");

        var game = new BowlingScore();
        foreach (int k in new[] { 10, 7, 3, 9, 0, 10, 0, 8, 8, 2, 0, 6, 10, 10, 10, 8, 1 }) Roll(game, k);
        Check(game.IsGameOver && game.Total == 167, "boliche: X 7/ 9- X -8 8/ -6 X X X81 = 167 (deu " + game.Total + ")");
        Check(game.CumulativeScore(0) == 20 && game.CumulativeScore(3) == 66 && game.FrameMarks(1) == "7/" && game.FrameMarks(9) == "X81", "boliche: parciais e marcas da súmula");

        var pending = new BowlingScore();
        Roll(pending, 10);
        Check(pending.FrameScore(0) == null && pending.CurrentFrame == 1, "boliche: strike fica pendente até as 2 bolas seguintes");

        Check(BowlingScore.IsSplit((1 << 6) | (1 << 9)), "boliche: 7-10 é split");
        Check(BowlingScore.IsSplit((1 << 1) | (1 << 6)), "boliche: 2-7 (baby split) é split");
        Check(!BowlingScore.IsSplit((1 << 3) | (1 << 4)), "boliche: 4-5 vizinhos não é split");
        Check(!BowlingScore.IsSplit(1 | (1 << 6) | (1 << 9)), "boliche: com o pino 1 em pé não é split");
        var tenth = new BowlingScore();
        for (int i = 0; i < 18; i++) Roll(tenth, 0);
        Roll(tenth, 3); Roll(tenth, 4);
        Check(tenth.IsGameOver && tenth.Rolls.Count == 20, "boliche: 10º quadro aberto não dá bola extra");
    }

    // ------------------------------------------------------------------ tênis
    private static void Tennis()
    {
        var s = new TennisScore(3, 1, 0);
        for (int i = 0; i < 3; i++) s.PointTo(0);
        Check(s.PointText(0) == "40-0" && s.IsGamePoint(0), "tênis: 40-0 é game point");
        Check(s.PointTo(0) == TennisEvent.Game && s.Games(0) == 1 && s.ServingTeam == 1, "tênis: game e troca de saque");

        var d = new TennisScore(1, 1, 0);
        for (int i = 0; i < 3; i++) { d.PointTo(0); d.PointTo(1); }
        Check(d.PointText(0) == "Iguais", "tênis: 40-40 = iguais");
        Check(d.PointTo(0) == TennisEvent.Advantage, "tênis: vantagem");
        Check(d.PointTo(1) == TennisEvent.Deuce, "tênis: volta para iguais");
        d.PointTo(1);
        Check(d.PointTo(1) == TennisEvent.MatchOver && d.Winner == 1, "tênis: partida de 1 game termina no 1º game");

        var m = new TennisScore(3, 2, 0);
        int[] serverSeq = new int[6];
        for (int g = 0; g < 6 && !m.IsMatchOver; g++)
        {
            serverSeq[g] = m.ServingTeam * 10 + m.ServerIndex;
            int w = g % 2;
            for (int p = 0; p < 4; p++) m.PointTo(w);
        }
        Check(serverSeq[0] == 0 && serverSeq[1] == 10 && serverSeq[2] == 1 && serverSeq[3] == 11, "tênis: rodízio de saque nas duplas (A1, B1, A2, B2)");
        Check(!m.IsMatchOver && m.Games(0) == 3 && m.Games(1) == 3, "tênis: 3-3 continua (precisa de 2 de vantagem)");
        for (int p = 0; p < 4; p++) m.PointTo(0);
        Check(m.IsMatchOver && m.Winner == 0 && m.Games(0) == 4, "tênis: 4-3 decide no game N+1");
        var f = new TennisScore(3);
        Check(!f.Fault() && f.FaultCount == 1 && f.Fault() && f.Points(1) == 1, "tênis: dupla falta dá ponto ao recebedor");
    }

    // ------------------------------------------------------------------ beisebol
    private static void Baseball()
    {
        var g = new BaseballGame(3);
        for (int i = 0; i < 4; i++) g.Apply(PitchResult.Ball);
        Check(g.Bases == 1 && g.Balls == 0, "beisebol: 4 bolas = base por bolas");
        g.Apply(PitchResult.Single);
        Check(g.Bases == 3, "beisebol: simples avança o corredor da 1ª para a 2ª");
        g.Apply(PitchResult.Single);
        Check(g.Bases == 7 && g.Runs(0) == 0, "beisebol: bases lotadas");
        int r = g.Apply(PitchResult.HomeRun);
        Check(r == 4 && g.Runs(0) == 4 && g.Bases == 0, "beisebol: grand slam = 4 corridas");
        Check(g.BestConsecutiveHits(0) == 3, "beisebol: 3 rebatidas seguidas");
        g.Apply(PitchResult.Foul); g.Apply(PitchResult.Foul); g.Apply(PitchResult.Foul);
        Check(g.Strikes == 2, "beisebol: foul com 2 strikes não elimina");
        g.Apply(PitchResult.SwingingStrike);
        Check(g.Outs == 1, "beisebol: 3º strike elimina");
        g.Apply(PitchResult.Out); g.Apply(PitchResult.Out);
        Check(g.Bottom && g.Outs == 0 && g.BattingTeam == 1, "beisebol: 3 eliminações trocam a metade");

        var w = new BaseballGame(1);
        for (int i = 0; i < 3; i++) w.Apply(PitchResult.Out);
        w.Apply(PitchResult.HomeRun);
        Check(w.IsGameOver && w.Winner == 1, "beisebol: walk-off no baixo da última entrada");

        var e = new BaseballGame(1);
        e.Apply(PitchResult.HomeRun);
        for (int i = 0; i < 3; i++) e.Apply(PitchResult.Out);
        for (int i = 0; i < 3; i++) e.Apply(PitchResult.Out);
        Check(e.IsGameOver && e.Winner == 0, "beisebol: visitante vence ao fim da última entrada");

        var dp = new BaseballGame(3);
        dp.Apply(PitchResult.Single);
        dp.Apply(PitchResult.DoublePlay);
        Check(dp.Outs == 2 && dp.Bases == 0, "beisebol: queimada dupla");
        var sf = new BaseballGame(3);
        sf.Apply(PitchResult.Triple);
        sf.MarkSacrificeFly();
        Check(sf.Apply(PitchResult.Out) == 1 && sf.Outs == 1, "beisebol: voo de sacrifício marca da 3ª");
    }

    // ------------------------------------------------------------------ golfe
    private static void Golf()
    {
        var c = new GolfScorecard(new[] { 3, 4, 5 }, 2, 10);
        c.AddStroke(0, 0); c.Hole(0, 0);
        Check(c.ToPar(0) == -2 && GolfScorecard.ResultName(1, 3) == "Hole in one!", "golfe: hole in one no par 3 = −2");
        for (int i = 0; i < 4; i++) c.AddStroke(1, 0);
        c.Hole(1, 0);
        Check(c.HoleComplete(0) && c.ToPar(1) == 1 && GolfScorecard.ResultName(4, 3) == "Bogey", "golfe: bogey e buraco concluído");
        bool capped = false;
        for (int i = 0; i < 10 && !capped; i++) capped = c.AddStroke(0, 1);
        Check(capped && c.Strokes(0, 1) == 10 && c.Holed(0, 1), "golfe: limite de 10 tacadas encerra o buraco");
        Check(GolfScorecard.ToParText(0) == "E" && GolfScorecard.ToParText(-3) == "-3" && GolfScorecard.ToParText(2) == "+2", "golfe: texto relativo ao par");
        Check(GolfClub.Suggest(240f, "tee", true) == GolfClubKind.Driver && GolfClub.Suggest(5f, "green", false) == GolfClubKind.Putter && GolfClub.Suggest(60f, "bunker", false) == GolfClubKind.Wedge, "golfe: sugestão de taco");
    }

    // ------------------------------------------------------------------ boxe
    private static void Boxing()
    {
        var b = new BoxingBout(3, 60f, 7);
        bool down = false;
        for (int i = 0; i < 10 && !down; i++) down = b.Land(0, 12f);
        Check(down && b.DownFighter == 1 && b.Knockdowns(1) == 1, "boxe: vida zerada = queda");
        int count = b.ResolveCount();
        Check(count >= 3 && count <= 10 && !b.IsOver && b.Health(1) >= 15f, "boxe: 1ª queda levanta na contagem " + count);
        var b2 = new BoxingBout(3, 60f, 7);
        for (int k = 0; k < 3 && !b2.IsOver; k++)
        {
            while (b2.DownFighter < 0 && !b2.IsOver) b2.Land(0, 50f);
            if (!b2.IsOver) { if (b2.ResolveCount() == 11) break; }
        }
        Check(b2.IsOver && b2.Winner == 0 && (b2.End == BoutEnd.TKO || b2.End == BoutEnd.KO), "boxe: 3 quedas no round (ou KO) encerram a luta");
        var b3 = new BoxingBout(2, 10f, 1);
        b3.Land(0, 20f);
        for (int i = 0; i < 30; i++) b3.Tick(1f);
        Check(b3.IsOver && b3.End == BoutEnd.Decision && b3.Winner == 0, "boxe: decisão por pontos após o último round");
        var r1 = new BoxingBout(3, 60f, 42); var r2 = new BoxingBout(3, 60f, 42);
        r1.Land(0, 200f); r2.Land(0, 200f);
        Check(r1.ResolveCount() == r2.ResolveCount(), "boxe: contagem reproduzível com a mesma semente");
    }

    // ------------------------------------------------------------------ habilidade e IA
    private static void SkillAndAi(string root)
    {
        int up = SkillRating.Delta(0, 0.5f, 1f), down = SkillRating.Delta(1500, 0.2f, 0f);
        Check(up > 0 && up <= 60 && down < 0 && down >= -60, "Elo: vitória sobe, derrota desce (" + up + ", " + down + ")");
        Check(SkillRating.Delta(1000, 0.5f, 0.5f) == 0, "Elo: empate contra força igual não muda");
        var weak = AiProfile.Create(0.5f, 0.5f, false, 123, 0.1f);
        var strong = AiProfile.Create(0.5f, 0.5f, false, 123, 0.9f);
        Check(strong.accuracy > weak.accuracy && strong.reaction < weak.reaction && strong.power > weak.power, "IA: força maior = mais precisa, rápida e forte");
        var tall = AiProfile.Create(1f, 0.5f, false, 1, 0.5f);
        var small = AiProfile.Create(0f, 0.5f, false, 1, 0.5f);
        Check(tall.reach > small.reach, "IA: altura do Mii aumenta o alcance");
        Check(AiProfile.StableHash("cpu_mii_000") == AiProfile.StableHash("cpu_mii_000") && AiProfile.StableHash("a") != AiProfile.StableHash("b"), "IA: hash estável por perfil");

        // Perfis .rcd reais (altura, peso, sexo e nome decodificados pela Etapa 3) -> AiProfile (mesma conta de FromMii)
        string dir = Path.Combine(root, "Assets/Resources/Mii/Profiles");
        int n = 0, ok = 0;
        var styles = new HashSet<int>();
        if (Directory.Exists(dir))
            foreach (var f in Directory.GetFiles(dir, "cpu_mii_*.json"))
            {
                var doc = Json.Parse(File.ReadAllText(f));
                var info = J.Obj(doc, "info");
                string id = Path.GetFileNameWithoutExtension(f);
                var ai = AiProfile.Create(J.Int(info, "height") / 127f, J.Int(info, "build") / 127f, J.Int(info, "sex") == 1,
                                          AiProfile.StableHash(J.Str(info, "name", "") + "|" + id), 0.5f);
                n++;
                if (ai.reach >= 0.85f && ai.reach <= 1.15f && ai.accuracy > 0f && ai.accuracy <= 1f && ai.speed > 0f && ai.power > 0f) ok++;
                styles.Add((int)(ai.aggression * 10));
            }
        Check(n == 60 && ok == 60, "IA: 60 perfis .rcd viram AiProfile coerente (" + ok + "/" + n + ")");
        Check(styles.Count >= 4, "IA: estilos variados entre os perfis (" + styles.Count + " níveis de agressividade)");
    }

    // ------------------------------------------------------------------ balística
    private static float Carry(GolfClub c, float upm = 10f)
    {
        float r = c.launchDeg * Mathf.Deg2Rad;
        Vector3 v = new Vector3(0f, Mathf.Sin(r), Mathf.Cos(r)) * c.maxSpeedMS * upm;
        float t;
        Vector3 land = BallFlight.PredictLanding(Vector3.zero, v, BallFlight.BackspinAxis(Vector3.forward) * c.backspin, Vector3.zero, BallParams.Golf, upm, 0f, out t);
        return land.z / upm;
    }

    private static void Ballistics()
    {
        float drv = Carry(GolfClub.Get(GolfClubKind.Driver)), iron = Carry(GolfClub.Get(GolfClubKind.Iron)), wedge = Carry(GolfClub.Get(GolfClubKind.Wedge));
        Console.WriteLine("     carry: driver " + drv.ToString("0") + " m, ferro " + iron.ToString("0") + " m, wedge " + wedge.ToString("0") + " m");
        Check(drv > 195f && drv < 250f, "golfe: carry do driver entre 195 e 250 m");
        Check(iron > 120f && iron < 165f, "golfe: carry do ferro entre 120 e 165 m");
        Check(wedge > 55f && wedge < 95f, "golfe: carry do wedge entre 55 e 95 m");
        float nospin;
        {
            var c = GolfClub.Get(GolfClubKind.Driver);
            float r = c.launchDeg * Mathf.Deg2Rad, t;
            Vector3 v = new Vector3(0f, Mathf.Sin(r), Mathf.Cos(r)) * c.maxSpeedMS * 10f;
            nospin = BallFlight.PredictLanding(Vector3.zero, v, Vector3.zero, Vector3.zero, BallParams.Golf, 10f, 0f, out t).z / 10f;
        }
        Check(nospin < drv, "golfe: backspin sustenta a bola (sem spin " + nospin.ToString("0") + " m)");
        {
            var c = GolfClub.Get(GolfClubKind.Iron);
            float r = c.launchDeg * Mathf.Deg2Rad, t;
            Vector3 v = new Vector3(0f, Mathf.Sin(r), Mathf.Cos(r)) * c.maxSpeedMS * 10f;
            Vector3 spin = BallFlight.BackspinAxis(Vector3.forward) * c.backspin + Vector3.up * 200f;
            Vector3 land = BallFlight.PredictLanding(Vector3.zero, v, spin, Vector3.zero, BallParams.Golf, 10f, 0f, out t);
            Check(land.x > 30f, "golfe: spin em +Y curva a bola para +X (slice), desvio " + (land.x / 10f).ToString("0.0") + " m");
        }
        float speed = BallFlight.SolveSpeed(1500f, 20f, 420f, BallParams.Golf, 10f);
        {
            float r = 20f * Mathf.Deg2Rad, t;
            Vector3 land = BallFlight.PredictLanding(Vector3.zero, new Vector3(0f, Mathf.Sin(r), Mathf.Cos(r)) * speed, BallFlight.BackspinAxis(Vector3.forward) * 420f, Vector3.zero, BallParams.Golf, 10f, 0f, out t);
            Check(Mathf.Abs(land.z - 1500f) < 5f, "golfe: SolveSpeed acerta 150 m (caiu em " + (land.z / 10f).ToString("0.0") + " m)");
        }
        float putt = GolfClub.PuttSpeed(10f, 0.065f);
        Check(Mathf.Abs(putt * putt / (2f * 0.065f * 9.81f) - 10f) < 0.01f, "golfe: velocidade do putt para 10 m");

        Vector3 spinB = Vector3.zero;
        Vector3 vb = BallFlight.Bounce(new Vector3(0f, -100f, 50f), Vector3.up, ref spinB, BallParams.Tennis, 10f);
        Check(Mathf.Abs(vb.y - 75f) < 0.01f && vb.z < 50f && vb.z > 0f, "quique: restituição 0,75 e atrito tangencial");

        var court = new TennisCourt { doubles = false };
        var prm = BallParams.Tennis;
        Vector3 from = new Vector3(5f, 10f, 120f), target = new Vector3(-20f, 0f, -90f);
        Vector3 vel = court.SolveShot(from, target, 300f, 150f, prm, 0.35f);
        float tt;
        Vector3 spinT = -BallFlight.BackspinAxis(vel) * 150f;
        Vector3 hit = BallFlight.PredictLanding(from, vel, spinT, Vector3.zero, prm, 10f, 0.35f, out tt);
        Check((hit - new Vector3(target.x, hit.y, target.z)).magnitude < 6f, "tênis: SolveShot cai no alvo (erro " + (hit - new Vector3(target.x, hit.y, target.z)).magnitude.ToString("0.0") + " u)");
        Check(court.ClearsNet(from, vel, spinT, prm, 0.35f), "tênis: a bola passa sobre a rede");
        Check(court.InServiceBox(court.ServiceBoxCenter(1, 0), 1, 0) && !court.InServiceBox(court.ServiceBoxCenter(1, 1), 1, 0), "tênis: caixas de saque cruzadas");
        Check(court.InServiceBox(court.ServiceBoxCenter(0, 1), 0, 1) && court.InCourt(new Vector3(40f, 0f, 100f), 0) && !court.InCourt(new Vector3(45f, 0f, 100f), 0), "tênis: linhas de simples");

        Vector3 home = Vector3.zero, cf = new Vector3(-1f, 0f, 1f).normalized;
        Vector3 rel = home + cf * 184.4f + Vector3.up * 19f;
        Vector3 right = Vector3.Cross(Vector3.up, cf);
        foreach (var spin in new[] { Vector3.zero, BallFlight.BackspinAxis(-cf) * 210f, Vector3.up * -170f, -BallFlight.BackspinAxis(-cf) * 180f })
        {
            Vector3 tgt = home + right * 2.5f + Vector3.up * 8f;
            Vector3 v = PitchMath.Solve(rel, tgt, 360f, spin, home, cf, BallParams.Baseball, 10f);
            float tp;
            Vector3 at = PitchMath.PlateCrossing(rel, v, spin, home, cf, BallParams.Baseball, 10f, out tp);
            Check((at - tgt).magnitude < 0.5f && tp > 0.4f && tp < 0.7f, "beisebol: arremesso com spin " + spin.magnitude.ToString("0") + " cruza a base no alvo (erro " + (at - tgt).magnitude.ToString("0.00") + " u, " + tp.ToString("0.00") + " s)");
        }
        Vector3 rot = PitchMath.Rotate(Vector3.forward, Vector3.up, 90f);
        Check((rot - Vector3.right).magnitude < 1e-4f, "PitchMath.Rotate igual a Quaternion.AngleAxis (forward -> right)");
    }
}
