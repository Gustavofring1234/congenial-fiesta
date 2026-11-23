// Menu "Nw4r > Criar cena do jogo": monta Assets/Scenes/LinuxSports.unity com câmera, luz e a
// GameStateMachine (que cria HUD, InputRouter e AudioManager em tempo de execução), coloca a cena como
// primeira do Build Settings e ajusta o Player para WebGL (compressão desligada para servir em qualquer
// servidor estático; o pós-processamento do URP é ligado pelo Nw4rEnvironment na câmera).
using System.Collections.Generic;
using System.IO;
using LinuxSports.Core;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace LinuxSports.EditorTools
{
    public static class GameSceneMenu
    {
        public const string ScenePath = "Assets/Scenes/LinuxSports.unity";

        [MenuItem("Nw4r/Criar cena do jogo (GameStateMachine)")]
        public static void CreateGameScene()
        {
            if (!EditorSceneManager.SaveCurrentModifiedScenesIfUserWantsTo()) return;
            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            var camGo = new GameObject("Main Camera");
            camGo.tag = "MainCamera";
            var cam = camGo.AddComponent<Camera>();
            cam.clearFlags = CameraClearFlags.SolidColor;
            cam.backgroundColor = new Color(0.45f, 0.65f, 0.9f);
            cam.nearClipPlane = 0.5f;
            cam.farClipPlane = 20000f;
            camGo.AddComponent<AudioListener>();
            camGo.transform.position = new Vector3(0f, 20f, 120f);
            camGo.transform.LookAt(new Vector3(0f, 10f, 0f));

            // Luz padrão até o Nw4rEnvironment da cena carregada criar as luzes do .plight.
            var lightGo = new GameObject("Directional Light");
            var light = lightGo.AddComponent<Light>();
            light.type = LightType.Directional;
            light.intensity = 1f;
            lightGo.transform.rotation = Quaternion.Euler(50f, -30f, 0f);

            var game = new GameObject("LinuxSports");
            game.AddComponent<GameStateMachine>();

            Directory.CreateDirectory(Path.GetDirectoryName(ScenePath));
            EditorSceneManager.SaveScene(scene, ScenePath);

            var scenes = new List<EditorBuildSettingsScene>(EditorBuildSettings.scenes);
            scenes.RemoveAll(s => s.path == ScenePath);
            scenes.Insert(0, new EditorBuildSettingsScene(ScenePath, true));
            EditorBuildSettings.scenes = scenes.ToArray();

            PlayerSettings.WebGL.compressionFormat = WebGLCompressionFormat.Disabled;
            PlayerSettings.runInBackground = true;
            Debug.Log("Cena do jogo criada em " + ScenePath + " e colocada no início do Build Settings. " +
                      "Rode antes o menu Nw4r > Importar tudo para gerar os prefabs dos modelos.");
        }

        [MenuItem("Nw4r/Gerar build WebGL")]
        public static void BuildWebGL()
        {
            if (!File.Exists(ScenePath)) CreateGameScene();
            var options = new BuildPlayerOptions
            {
                scenes = new[] { ScenePath },
                locationPathName = "Builds/WebGL",
                target = BuildTarget.WebGL,
                options = BuildOptions.None,
            };
            var report = BuildPipeline.BuildPlayer(options);
            Debug.Log("Build WebGL: " + report.summary.result + " (" + report.summary.totalErrors + " erros, " + report.summary.totalSize / (1024 * 1024) + " MB)");
        }
    }
}
