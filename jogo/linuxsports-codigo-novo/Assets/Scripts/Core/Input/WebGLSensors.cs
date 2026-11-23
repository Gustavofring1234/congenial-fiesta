// Lado C# de Assets/Plugins/WebGL/WebGLSensors.jslib. Fora do WebGL (Editor, desktop) as chamadas
// devolvem "sem sensor" e o áudio é considerado liberado.
using System.Runtime.InteropServices;

namespace LinuxSports.Core
{
    public struct DeviceSensorSample
    {
        public bool hasMotion, hasOrientation;
        public int permission;              // 0 desconhecida, 1 concedida, 2 negada, 3 não requer
        public float accX, accY, accZ;      // m/s², sem gravidade (DeviceMotionEvent.acceleration)
        public float gravX, gravY, gravZ;   // m/s², com gravidade
        public float rotAlpha, rotBeta, rotGamma;  // graus/s
        public float oriAlpha, oriBeta, oriGamma;  // graus (DeviceOrientationEvent)
        public float screenAngle;           // screen.orientation.angle
    }

    public static class WebGLSensors
    {
        private static readonly float[] buffer = new float[16];

#if UNITY_WEBGL && !UNITY_EDITOR
        [DllImport("__Internal")] private static extern int LS_Sensors_Start(int wantSensors);
        [DllImport("__Internal")] private static extern int LS_Sensors_Read(float[] dst);
        [DllImport("__Internal")] private static extern void LS_Sensors_RequestPermission();
        [DllImport("__Internal")] private static extern void LS_Audio_Unlock();
        [DllImport("__Internal")] private static extern int LS_Audio_IsRunning();
        [DllImport("__Internal")] private static extern int LS_Gesture_Count();
        public static bool Supported { get { return true; } }
#else
        private static int LS_Sensors_Start(int wantSensors) { return 0; }
        private static int LS_Sensors_Read(float[] dst) { return 0; }
        private static void LS_Sensors_RequestPermission() { }
        private static void LS_Audio_Unlock() { }
        private static int LS_Audio_IsRunning() { return 1; }
        private static int LS_Gesture_Count() { return 0; }
        public static bool Supported { get { return false; } }
#endif

        private static bool started;

        /// <summary>Registra os listeners (idempotente). wantSensors: pedir DeviceMotion no 1º gesto (iOS).</summary>
        public static bool Start(bool wantSensors)
        {
            started = true;
            return LS_Sensors_Start(wantSensors ? 1 : 0) != 0;
        }

        public static bool Read(out DeviceSensorSample s)
        {
            if (!started) Start(true);
            int ok = LS_Sensors_Read(buffer);
            var b = buffer;
            s = new DeviceSensorSample
            {
                accX = b[0], accY = b[1], accZ = b[2], gravX = b[3], gravY = b[4], gravZ = b[5],
                rotAlpha = b[6], rotBeta = b[7], rotGamma = b[8], oriAlpha = b[9], oriBeta = b[10], oriGamma = b[11],
                hasMotion = b[12] > 0.5f, hasOrientation = b[13] > 0.5f, permission = (int)b[14], screenAngle = b[15],
            };
            return ok != 0;
        }

        /// <summary>Pede permissão de sensores. No iOS só funciona chamado de dentro de um gesto; o .jslib já
        /// faz isso sozinho no 1º toque quando Start(true) foi chamado.</summary>
        public static void RequestPermission() { LS_Sensors_RequestPermission(); }

        public static void UnlockAudio() { LS_Audio_Unlock(); }
        public static bool AudioRunning { get { return LS_Audio_IsRunning() != 0; } }

        /// <summary>Quantos gestos de usuário o navegador já viu (pointerup/touchend/mouseup/keydown).</summary>
        public static int GestureCount { get { return LS_Gesture_Count(); } }
    }
}
