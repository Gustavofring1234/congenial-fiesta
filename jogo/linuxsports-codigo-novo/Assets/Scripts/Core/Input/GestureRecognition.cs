// Reconhecedores de gesto sem dependência do Unity (só floats), usados pelo InputRouter.
// O Wii media o Wiimote (acelerômetro + IR); aqui cada fonte vira o mesmo evento normalizado:
//   speed  = intensidade do gesto, 1 = gesto "forte" de referência (pode passar de 1, saturado em maxSpeed)
//   angle  = direção em graus no plano da tela (0 = direita, 90 = cima), dirX/dirY = vetor unitário
//   duration = segundos entre o início do gesto e o disparo
// Pointer (mouse/toque): posições em alturas de tela (independe da resolução).
using System;

namespace LinuxSports.Core
{
    public enum GestureKind { Swing, Throw, Strike }
    public enum InputSource { MouseKeyboard, Touch, Gamepad, Motion }

    public struct GestureEvent
    {
        public GestureKind kind;
        public InputSource source;
        public float speed, angle, dirX, dirY, duration;
        public double time;

        public override string ToString()
        {
            return kind + " via " + source + " speed=" + speed.ToString("0.00") + " angle=" + angle.ToString("0") + "°";
        }
    }

    public struct GestureMeasure
    {
        public bool valid;
        public float speed, angle, dirX, dirY, duration;

        public static GestureMeasure From(float vx, float vy, float reference, float maxSpeed, float duration)
        {
            float mag = (float)Math.Sqrt(vx * vx + vy * vy);
            var m = new GestureMeasure { valid = mag > 0f, duration = duration };
            if (!m.valid) return m;
            m.speed = Math.Min(maxSpeed, mag / reference);
            m.dirX = vx / mag; m.dirY = vy / mag;
            m.angle = (float)(Math.Atan2(vy, vx) * 180.0 / Math.PI);
            return m;
        }
    }

    /// <summary>Arrasto de mouse/dedo -> toque curto (tap) ou gesto. A velocidade é o pico da média móvel
    /// na janela `window` (o usuário desacelera antes de soltar; o pico representa o "golpe").</summary>
    public sealed class SwipeTracker
    {
        public float window = 0.1f;          // s
        public float minSpeed = 0.8f;        // alturas de tela / s para contar como gesto
        public float referenceSpeed = 4f;    // alturas de tela / s = speed 1
        public float maxSpeed = 2f;
        public float tapMaxDistance = 0.025f;
        public float tapMaxTime = 0.3f;

        private const int N = 64;
        private readonly double[] ts = new double[N];
        private readonly float[] xs = new float[N], ys = new float[N];
        private int count, head;
        private double t0;
        private float x0, y0, peakVx, peakVy, peakMag;
        public bool Active { get; private set; }

        /// <summary>0..1 enquanto arrasta (pico atual / referência), para barras de força.</summary>
        public float Charge { get { return Active ? Math.Min(1f, peakMag / referenceSpeed) : 0f; } }

        public void Begin(double t, float x, float y)
        {
            Active = true; count = 0; head = 0; t0 = t; x0 = x; y0 = y; peakVx = peakVy = peakMag = 0f;
            Push(t, x, y);
        }

        public void Move(double t, float x, float y)
        {
            if (!Active) return;
            Push(t, x, y);
            // média na janela que termina agora
            int newest = (head - 1 + N) % N;
            int oldest = newest;
            for (int k = 1; k < count; k++)
            {
                int i = (newest - k + N) % N;
                if (t - ts[i] > window) break;
                oldest = i;
            }
            double dt = ts[newest] - ts[oldest];
            if (dt <= 1e-4) return;
            float vx = (float)((xs[newest] - xs[oldest]) / dt), vy = (float)((ys[newest] - ys[oldest]) / dt);
            float mag = (float)Math.Sqrt(vx * vx + vy * vy);
            if (mag > peakMag) { peakMag = mag; peakVx = vx; peakVy = vy; }
        }

        /// <summary>Fim do arrasto. tap = toque curto e parado; senão measure.valid indica gesto.</summary>
        public GestureMeasure End(double t, float x, float y, out bool tap)
        {
            Move(t, x, y);
            Active = false;
            float dx = x - x0, dy = y - y0;
            float dist = (float)Math.Sqrt(dx * dx + dy * dy);
            float dur = (float)(t - t0);
            tap = dist <= tapMaxDistance && dur <= tapMaxTime;
            if (tap || peakMag < minSpeed) return new GestureMeasure { valid = false, duration = dur };
            return GestureMeasure.From(peakVx, peakVy, referenceSpeed, maxSpeed, dur);
        }

        public void Cancel() { Active = false; }

        private void Push(double t, float x, float y)
        {
            ts[head] = t; xs[head] = x; ys[head] = y;
            head = (head + 1) % N;
            if (count < N) count++;
        }
    }

    /// <summary>Peteleco no analógico: sai do repouso (&lt; rest) e passa de fire em pouco tempo.
    /// speed = referenceTime / tempo de subida (subida em referenceTime = 1).</summary>
    public sealed class StickFlickDetector
    {
        public float rest = 0.25f, fire = 0.9f;
        public float referenceTime = 0.08f, maxTime = 0.2f, maxSpeed = 2f;
        private double leaveTime = -1;
        private bool armed = true;

        public GestureMeasure Update(double t, float x, float y)
        {
            float mag = (float)Math.Sqrt(x * x + y * y);
            if (mag < rest) { leaveTime = t; armed = true; return default(GestureMeasure); }
            if (armed && mag >= fire && leaveTime >= 0)
            {
                armed = false;
                float rise = (float)Math.Max(1e-3, t - leaveTime);
                if (rise > maxTime) return default(GestureMeasure);
                var m = GestureMeasure.From(x, y, 1f, maxSpeed, rise);
                m.speed = Math.Min(maxSpeed, referenceTime / rise);
                return m;
            }
            return default(GestureMeasure);
        }
    }

    /// <summary>Pico de aceleração linear (m/s², sem gravidade) do DeviceMotion: começa acima de trigger,
    /// acompanha o pico e dispara quando cai abaixo de release. speed = pico / reference.</summary>
    public sealed class MotionPeakDetector
    {
        public float trigger = 12f, release = 6f, reference = 30f, maxSpeed = 2f, refractory = 0.25f;
        private bool inPeak;
        private float px, py, pmag;
        private double start, lastFire = -10;

        public GestureMeasure Update(double t, float ax, float ay, float az)
        {
            float mag = (float)Math.Sqrt(ax * ax + ay * ay + az * az);
            if (!inPeak)
            {
                if (mag >= trigger && t - lastFire >= refractory) { inPeak = true; start = t; px = ax; py = ay; pmag = mag; }
                return default(GestureMeasure);
            }
            if (mag > pmag) { pmag = mag; px = ax; py = ay; }
            if (mag > release) return default(GestureMeasure);
            inPeak = false;
            lastFire = t;
            float planar = (float)Math.Sqrt(px * px + py * py);
            var m = planar > 1e-3f ? GestureMeasure.From(px, py, 1f, maxSpeed, (float)(t - start))
                                   : new GestureMeasure { valid = true, dirX = 0f, dirY = 1f, angle = 90f, duration = (float)(t - start) };
            m.speed = Math.Min(maxSpeed, pmag / reference);
            return m;
        }
    }

    public static class ScreenAxes
    {
        /// <summary>Gira um vetor do referencial do aparelho (retrato) para a tela conforme
        /// screen.orientation.angle (0, 90, 180, 270). Ângulo 90 = aparelho girado 90° no sentido anti-horário
        /// (window.orientation = 90): o +x do aparelho passa a apontar para cima na tela, logo tela = R(+ângulo)·aparelho.</summary>
        public static void DeviceToScreen(float angleDeg, float x, float y, out float sx, out float sy)
        {
            double a = angleDeg * Math.PI / 180.0;
            sx = (float)(x * Math.Cos(a) - y * Math.Sin(a));
            sy = (float)(x * Math.Sin(a) + y * Math.Cos(a));
        }
    }
}
