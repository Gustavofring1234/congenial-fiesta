// Camada de entrada única para as modalidades (substitui o Wiimote): traduz mouse+teclado, toque,
// gamepad e sensores do celular (DeviceMotion/DeviceOrientation via WebGLSensors.jslib) em ações
// normalizadas: Swing/Throw/Strike (gesto com velocidade e ângulo; o tipo é o `gestureKind` que a
// modalidade ativa define), Aim e Move (vetores -1..1), Confirm e Back.
//
// Mapeamento:
//   Mouse      arrastar com o botão esquerdo e soltar = gesto (velocidade de pico do arrasto); clique curto =
//              Confirm; botão direito = Back; posição = Aim.
//   Teclado    WASD/setas = Move (e Aim, se não houver ponteiro); segurar Espaço carrega e soltar dispara o
//              gesto (força = tempo segurando / chargeTime); Enter = Confirm; Esc/Backspace = Back.
//   Toque      1 dedo: arrasto = gesto, toque curto = Confirm, posição = Aim; 2 dedos = Back.
//   Gamepad    analógico esquerdo = Move, direito = Aim; peteleco no direito = gesto; gatilho direito = gesto
//              com força do gatilho; A/Cross = Confirm, B/Circle = Back.
//   Sensores   pico de aceleração linear = gesto (força = pico / motionReference); com useTiltForAim, a
//              inclinação (beta/gamma, relativa à postura calibrada) vira Aim e Move.
using System;
using UnityEngine;
using UnityEngine.InputSystem;

namespace LinuxSports.Core
{
    [DefaultExecutionOrder(-100)]
    public sealed class InputRouter : MonoBehaviour
    {
        private static InputRouter instance;

        public static InputRouter Instance
        {
            get
            {
                if (instance == null)
                {
                    instance = FindObjectOfType<InputRouter>();
                    if (instance == null)
                    {
                        var go = new GameObject("[InputRouter]");
                        DontDestroyOnLoad(go);
                        instance = go.AddComponent<InputRouter>();
                    }
                }
                return instance;
            }
        }

        [Tooltip("O que um gesto significa na modalidade atual (golfe/tênis/beisebol = Swing, boliche = Throw, boxe = Strike).")]
        public GestureKind gestureKind = GestureKind.Swing;
        public bool useMotionSensors = true;
        public bool useTiltForAim;
        [Tooltip("Inclinação (graus) que corresponde a Aim/Move = 1.")]
        public float tiltRange = 35f;
        [Tooltip("Arrasto em alturas de tela por segundo que vale speed = 1.")]
        public float pointerReferenceSpeed = 4f;
        [Tooltip("Aceleração linear (m/s²) que vale speed = 1.")]
        public float motionReference = 30f;
        public float motionTrigger = 12f;
        [Tooltip("Segundos segurando Espaço para força 1.")]
        public float chargeTime = 1f;

        public event Action<GestureEvent> Gesture;
        public event Action Confirmed;
        public event Action BackPressed;

        public Vector2 Aim { get; private set; }
        public Vector2 Move { get; private set; }
        public InputSource LastSource { get; private set; }
        public bool ConfirmThisFrame { get; private set; }
        public bool BackThisFrame { get; private set; }
        public bool SensorsAvailable { get; private set; }
        /// <summary>0..1 durante um arrasto/carga (para barras de força da HUD).</summary>
        public float Charge { get; private set; }
        public GestureEvent? LastGesture { get; private set; }

        private readonly SwipeTracker mouseSwipe = new SwipeTracker();
        private readonly SwipeTracker touchSwipe = new SwipeTracker();
        private readonly StickFlickDetector flick = new StickFlickDetector();
        private readonly MotionPeakDetector motion = new MotionPeakDetector();
        private double spaceDown = -1;
        private bool triggerArmed = true;
        private float triggerPeak;
        private double triggerStart;
        private bool twoFingerDown;
        private Vector3 tiltNeutral;
        private bool tiltCalibrated;

        private void Awake()
        {
            if (instance != null && instance != this) { Destroy(this); return; }
            instance = this;
            SensorsAvailable = WebGLSensors.Start(useMotionSensors);
        }

        /// <summary>A postura atual do aparelho passa a ser a inclinação zero.</summary>
        public void CalibrateTilt() { tiltCalibrated = false; }

        private void Update()
        {
            ConfirmThisFrame = BackThisFrame = false;
            double t = Time.unscaledTimeAsDouble;
            Vector2 move = Vector2.zero, aim = Aim;
            float charge = 0f;
            float h = Mathf.Max(1, Screen.height), w = Mathf.Max(1, Screen.width);

            var kb = Keyboard.current;
            if (kb != null)
            {
                if (kb.aKey.isPressed || kb.leftArrowKey.isPressed) move.x -= 1f;
                if (kb.dKey.isPressed || kb.rightArrowKey.isPressed) move.x += 1f;
                if (kb.sKey.isPressed || kb.downArrowKey.isPressed) move.y -= 1f;
                if (kb.wKey.isPressed || kb.upArrowKey.isPressed) move.y += 1f;
                if (kb.enterKey.wasPressedThisFrame || kb.numpadEnterKey.wasPressedThisFrame) FireConfirm(InputSource.MouseKeyboard);
                if (kb.escapeKey.wasPressedThisFrame || kb.backspaceKey.wasPressedThisFrame) FireBack(InputSource.MouseKeyboard);
                if (kb.spaceKey.wasPressedThisFrame) spaceDown = t;
                if (spaceDown >= 0)
                {
                    float c = Mathf.Clamp01((float)(t - spaceDown) / Mathf.Max(0.05f, chargeTime));
                    charge = Mathf.Max(charge, c);
                    if (kb.spaceKey.wasReleasedThisFrame)
                    {
                        Vector2 d = move.sqrMagnitude > 0f ? move.normalized : (aim.sqrMagnitude > 0.01f ? aim.normalized : Vector2.up);
                        var m = GestureMeasure.From(d.x, d.y, 1f, 2f, (float)(t - spaceDown));
                        m.speed = c;
                        FireGesture(m, InputSource.MouseKeyboard, t);
                        spaceDown = -1;
                    }
                }
            }

            var mouse = Mouse.current;
            bool touching = false;
            var ts = Touchscreen.current;
            if (ts != null)
            {
                int down = 0;
                foreach (var tc in ts.touches) if (tc.press.isPressed) down++;
                var p = ts.primaryTouch;
                Vector2 pos = p.position.ReadValue();
                if (down >= 2)
                {
                    touchSwipe.Cancel();
                    if (!twoFingerDown) { twoFingerDown = true; FireBack(InputSource.Touch); }
                }
                else if (down == 0) twoFingerDown = false;
                if (!twoFingerDown)
                {
                    if (p.press.wasPressedThisFrame) touchSwipe.Begin(t, pos.x / h, pos.y / h);
                    else if (p.press.isPressed) touchSwipe.Move(t, pos.x / h, pos.y / h);
                    else if (p.press.wasReleasedThisFrame && touchSwipe.Active)
                    {
                        bool tap;
                        touchSwipe.referenceSpeed = pointerReferenceSpeed;
                        var m = touchSwipe.End(t, pos.x / h, pos.y / h, out tap);
                        if (tap) FireConfirm(InputSource.Touch);
                        else if (m.valid) FireGesture(m, InputSource.Touch, t);
                    }
                }
                if (p.press.isPressed)
                {
                    touching = true;
                    aim = new Vector2(pos.x / w * 2f - 1f, pos.y / h * 2f - 1f);
                    charge = Mathf.Max(charge, touchSwipe.Charge);
                    LastSource = InputSource.Touch;
                }
            }

            if (mouse != null && !touching)
            {
                Vector2 pos = mouse.position.ReadValue();
                if (mouse.delta.ReadValue().sqrMagnitude > 0f || mouse.leftButton.isPressed)
                {
                    aim = new Vector2(pos.x / w * 2f - 1f, pos.y / h * 2f - 1f);
                    LastSource = InputSource.MouseKeyboard;
                }
                if (mouse.leftButton.wasPressedThisFrame) mouseSwipe.Begin(t, pos.x / h, pos.y / h);
                else if (mouse.leftButton.isPressed) mouseSwipe.Move(t, pos.x / h, pos.y / h);
                else if (mouse.leftButton.wasReleasedThisFrame && mouseSwipe.Active)
                {
                    bool tap;
                    mouseSwipe.referenceSpeed = pointerReferenceSpeed;
                    var m = mouseSwipe.End(t, pos.x / h, pos.y / h, out tap);
                    if (tap) FireConfirm(InputSource.MouseKeyboard);
                    else if (m.valid) FireGesture(m, InputSource.MouseKeyboard, t);
                }
                if (mouse.rightButton.wasPressedThisFrame) FireBack(InputSource.MouseKeyboard);
                charge = Mathf.Max(charge, mouseSwipe.Charge);
            }

            var pad = Gamepad.current;
            if (pad != null)
            {
                Vector2 ls = pad.leftStick.ReadValue(), rs = pad.rightStick.ReadValue();
                if (ls.sqrMagnitude > 0.04f) { move = ls; LastSource = InputSource.Gamepad; }
                if (rs.sqrMagnitude > 0.04f) { aim = rs; LastSource = InputSource.Gamepad; }
                var fm = flick.Update(t, rs.x, rs.y);
                if (fm.valid) FireGesture(fm, InputSource.Gamepad, t);
                float rt = pad.rightTrigger.ReadValue();
                if (triggerArmed && rt > 0.15f) { triggerArmed = false; triggerPeak = rt; triggerStart = t; }
                if (!triggerArmed)
                {
                    triggerPeak = Mathf.Max(triggerPeak, rt);
                    charge = Mathf.Max(charge, triggerPeak);
                    if (rt < 0.1f)
                    {
                        triggerArmed = true;
                        Vector2 d = aim.sqrMagnitude > 0.01f ? aim.normalized : Vector2.up;
                        var m = GestureMeasure.From(d.x, d.y, 1f, 2f, (float)(t - triggerStart));
                        m.speed = triggerPeak;
                        FireGesture(m, InputSource.Gamepad, t);
                    }
                }
                if (pad.buttonSouth.wasPressedThisFrame) FireConfirm(InputSource.Gamepad);
                if (pad.buttonEast.wasPressedThisFrame) FireBack(InputSource.Gamepad);
            }

            if (useMotionSensors)
            {
                DeviceSensorSample s;
                if (WebGLSensors.Read(out s))
                {
                    SensorsAvailable = true;
                    if (s.hasMotion)
                    {
                        float ax, ay;
                        ScreenAxes.DeviceToScreen(s.screenAngle, s.accX, s.accY, out ax, out ay);
                        motion.trigger = motionTrigger;
                        motion.reference = motionReference;
                        var mm = motion.Update(t, ax, ay, s.accZ);
                        if (mm.valid) FireGesture(mm, InputSource.Motion, t);
                    }
                    if (useTiltForAim && s.hasOrientation)
                    {
                        var o = new Vector3(s.oriBeta, s.oriGamma, 0f);
                        if (!tiltCalibrated) { tiltNeutral = o; tiltCalibrated = true; }
                        float tx, ty;
                        ScreenAxes.DeviceToScreen(s.screenAngle, Mathf.DeltaAngle(tiltNeutral.y, o.y), -Mathf.DeltaAngle(tiltNeutral.x, o.x), out tx, out ty);
                        var tilt = new Vector2(Mathf.Clamp(tx / tiltRange, -1f, 1f), Mathf.Clamp(ty / tiltRange, -1f, 1f));
                        aim = tilt;
                        if (move == Vector2.zero) move = tilt;
                        LastSource = InputSource.Motion;
                    }
                }
            }

            Move = Vector2.ClampMagnitude(move, 1f);
            Aim = new Vector2(Mathf.Clamp(aim.x, -1f, 1f), Mathf.Clamp(aim.y, -1f, 1f));
            Charge = charge;
        }

        private void FireGesture(GestureMeasure m, InputSource src, double t)
        {
            var e = new GestureEvent
            {
                kind = gestureKind, source = src, speed = m.speed, angle = m.angle, dirX = m.dirX, dirY = m.dirY,
                duration = m.duration, time = t,
            };
            LastSource = src;
            LastGesture = e;
            if (Gesture != null) Gesture(e);
        }

        private void FireConfirm(InputSource src)
        {
            LastSource = src;
            ConfirmThisFrame = true;
            if (Confirmed != null) Confirmed();
        }

        private void FireBack(InputSource src)
        {
            LastSource = src;
            BackThisFrame = true;
            if (BackPressed != null) BackPressed();
        }
    }
}
