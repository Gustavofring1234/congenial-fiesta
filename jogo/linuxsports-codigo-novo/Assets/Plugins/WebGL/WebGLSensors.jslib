// Ponte WebGL <-> navegador para o InputRouter e o AudioManager (C#: LinuxSports.Core.WebGLSensors).
//  - DeviceMotion / DeviceOrientation: guardados no último valor; o C# lê por LS_Sensors_Read (poll, sem
//    SendMessage, para não depender de nomes de GameObject).
//  - iOS 13+: DeviceMotionEvent.requestPermission() só vale dentro de um gesto do usuário; por isso o
//    pedido é feito aqui, num listener de pointerup/touchend/keydown registrado pelo próprio JS.
//  - Áudio: o mesmo primeiro gesto chama resume() no AudioContext do Unity (WEBAudio.audioContext).
var LinuxSportsSensors = {
  $LSS: {
    s: null,
    state: function () {
      if (LSS.s) return LSS.s;
      LSS.s = {
        started: 0, motion: 0, orient: 0, permission: 0, // permission: 0 desconhecida, 1 concedida, 2 negada, 3 não requer
        acc: [0, 0, 0], accG: [0, 0, 0], rot: [0, 0, 0], ori: [0, 0, 0], interval: 0, gestures: 0
      };
      return LSS.s;
    },
    resumeAudio: function () {
      try {
        if (typeof WEBAudio !== 'undefined' && WEBAudio.audioContext && WEBAudio.audioContext.state !== 'running') {
          WEBAudio.audioContext.resume();
        }
      } catch (e) { }
    },
    audioRunning: function () {
      try {
        return (typeof WEBAudio !== 'undefined' && WEBAudio.audioContext && WEBAudio.audioContext.state === 'running') ? 1 : 0;
      } catch (e) { return 0; }
    },
    attachMotion: function () {
      var s = LSS.state();
      if (s.attached) return;
      s.attached = 1;
      window.addEventListener('devicemotion', function (e) {
        s.motion = 1;
        var a = e.acceleration, g = e.accelerationIncludingGravity, r = e.rotationRate;
        if (a) { s.acc[0] = a.x || 0; s.acc[1] = a.y || 0; s.acc[2] = a.z || 0; }
        if (g) { s.accG[0] = g.x || 0; s.accG[1] = g.y || 0; s.accG[2] = g.z || 0; }
        if (r) { s.rot[0] = r.alpha || 0; s.rot[1] = r.beta || 0; s.rot[2] = r.gamma || 0; }
        s.interval = e.interval || 0;
      }, true);
      window.addEventListener('deviceorientation', function (e) {
        if (e.alpha === null && e.beta === null && e.gamma === null) return;
        s.orient = 1;
        s.ori[0] = e.alpha || 0; s.ori[1] = e.beta || 0; s.ori[2] = e.gamma || 0;
      }, true);
    },
    requestPermission: function () {
      var s = LSS.state();
      var DM = window.DeviceMotionEvent, DO = window.DeviceOrientationEvent;
      if (DM && typeof DM.requestPermission === 'function') {
        try {
          DM.requestPermission().then(function (r) {
            s.permission = r === 'granted' ? 1 : 2;
            if (r === 'granted') LSS.attachMotion();
          }).catch(function () { s.permission = 2; });
          if (DO && typeof DO.requestPermission === 'function') DO.requestPermission().catch(function () { });
        } catch (e) { s.permission = 2; }
      } else {
        s.permission = 3;
        LSS.attachMotion();
      }
    },
    onGesture: function () {
      var s = LSS.state();
      s.gestures++;
      LSS.resumeAudio();
      if (s.wantSensors && s.permission === 0) LSS.requestPermission();
    }
  },

  LS_Sensors_Start__deps: ['$LSS'],
  LS_Sensors_Start: function (wantSensors) {
    var s = LSS.state();
    s.wantSensors = wantSensors ? 1 : 0;
    if (!s.started) {
      s.started = 1;
      var h = function () { LSS.onGesture(); };
      ['pointerup', 'touchend', 'mouseup', 'keydown'].forEach(function (t) { window.addEventListener(t, h, true); });
    }
    if (s.wantSensors) {
      var DM = window.DeviceMotionEvent;
      if (!(DM && typeof DM.requestPermission === 'function')) { s.permission = 3; LSS.attachMotion(); }
    }
    return (window.DeviceMotionEvent || window.DeviceOrientationEvent) ? 1 : 0;
  },

  // 16 floats: acc (sem gravidade) xyz, acc com gravidade xyz, rotationRate alpha/beta/gamma (graus/s),
  // orientação alpha/beta/gamma (graus), flags motion, orient, permission, ângulo da tela.
  LS_Sensors_Read__deps: ['$LSS'],
  LS_Sensors_Read: function (ptr) {
    var s = LSS.state();
    var o = ptr >> 2;
    var screenAngle = 0;
    try {
      if (screen.orientation && typeof screen.orientation.angle === 'number') screenAngle = screen.orientation.angle;
      else if (typeof window.orientation === 'number') screenAngle = window.orientation;
    } catch (e) { }
    var v = [s.acc[0], s.acc[1], s.acc[2], s.accG[0], s.accG[1], s.accG[2], s.rot[0], s.rot[1], s.rot[2],
             s.ori[0], s.ori[1], s.ori[2], s.motion, s.orient, s.permission, screenAngle];
    for (var k = 0; k < 16; k++) HEAPF32[o + k] = v[k];
    return s.motion || s.orient ? 1 : 0;
  },

  LS_Sensors_RequestPermission__deps: ['$LSS'],
  LS_Sensors_RequestPermission: function () { LSS.state().wantSensors = 1; LSS.requestPermission(); },

  LS_Audio_Unlock__deps: ['$LSS'],
  LS_Audio_Unlock: function () { LSS.resumeAudio(); },

  LS_Audio_IsRunning__deps: ['$LSS'],
  LS_Audio_IsRunning: function () { return LSS.audioRunning(); },

  LS_Gesture_Count__deps: ['$LSS'],
  LS_Gesture_Count: function () { return LSS.state().gestures; }
};

autoAddDeps(LinuxSportsSensors, '$LSS');
mergeInto(LibraryManager.library, LinuxSportsSensors);
