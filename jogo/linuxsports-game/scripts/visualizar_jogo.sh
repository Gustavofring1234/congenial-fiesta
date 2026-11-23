#!/usr/bin/env bash
# Roda o jogo original no emulador Dolphin dentro do Codespace e transmite a tela para o
# navegador via noVNC (porta 6080). Usa SEU dump do disco; não modifica o main.dol.
#
#   bash scripts/visualizar_jogo.sh setup              # instala Dolphin + tela virtual + noVNC (sudo)
#   bash scripts/visualizar_jogo.sh run /caminho/jogo.iso
#   bash scripts/visualizar_jogo.sh stop
set -euo pipefail

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
DISPLAY_NUM=:99
RES=1280x720x24
LOGS="${XDG_RUNTIME_DIR:-/tmp}/linuxsports-view"
PERFIL="$RAIZ/config/dolphin/Profiles/Wiimote/linuxsports_teclado.ini"
DOLPHIN_CFG="$HOME/.local/share/dolphin-emu"

setup() {
  sudo add-apt-repository -y ppa:dolphin-emu/ppa
  sudo apt-get update
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
    dolphin-emu xvfb x11vnc novnc websockify openbox libgl1-mesa-dri mesa-utils
  echo "Pronto. Agora: bash scripts/visualizar_jogo.sh run /caminho/do/jogo.iso"
}

config_dolphin() {
  mkdir -p "$DOLPHIN_CFG/Config/Profiles/Wiimote"
  cp "$PERFIL" "$DOLPHIN_CFG/Config/Profiles/Wiimote/"
  # Wii Remote 1 = emulado, usando o perfil de teclado (corpo do perfil vira a seção [Wiimote1])
  { echo "[Wiimote1]"; echo "Source = 1"; sed -n '/^\[Profile\]/,$p' "$PERFIL" | tail -n +2;
    echo "[Wiimote2]"; echo "Source = 0"; echo "[Wiimote3]"; echo "Source = 0";
    echo "[Wiimote4]"; echo "Source = 0"; echo "[BalanceBoard]"; echo "Source = 0"; } \
    > "$DOLPHIN_CFG/Config/WiimoteNew.ini"
  # Sem GPU no Codespace: renderizador por software via Mesa (llvmpipe), sem áudio.
  cat > "$DOLPHIN_CFG/Config/Dolphin.ini" <<'INI'
[Core]
GFXBackend = OGL
CPUThread = True
[DSP]
Backend = No Audio Output
[Interface]
ConfirmStop = False
[Display]
Fullscreen = False
RenderToMain = True
INI
}

run() {
  local jogo="${1:-}"
  [ -f "$jogo" ] || { echo "Informe o dump do disco: bash $0 run /caminho/jogo.iso (iso/wbfs/rvz)"; exit 1; }
  command -v dolphin-emu >/dev/null || { echo "Rode antes: bash $0 setup"; exit 1; }
  mkdir -p "$LOGS"
  config_dolphin
  Xvfb "$DISPLAY_NUM" -screen 0 "$RES" >"$LOGS/xvfb.log" 2>&1 &
  sleep 2
  DISPLAY=$DISPLAY_NUM openbox >"$LOGS/openbox.log" 2>&1 &
  x11vnc -display "$DISPLAY_NUM" -forever -shared -nopw -localhost -rfbport 5900 >"$LOGS/x11vnc.log" 2>&1 &
  websockify --web /usr/share/novnc 6080 localhost:5900 >"$LOGS/novnc.log" 2>&1 &
  DISPLAY=$DISPLAY_NUM LIBGL_ALWAYS_SOFTWARE=1 dolphin-emu -b -e "$jogo" >"$LOGS/dolphin.log" 2>&1 &
  echo "Abra a porta 6080 na aba PORTS do Codespace e acesse /vnc.html  (logs: $LOGS)"
  echo "Teclas: A=Z  B=X  movimento=WASD/F/G  agitar=Espaço  Home=Enter  ponteiro=mouse"
}

stop() { pkill -f dolphin-emu || true; pkill -f websockify || true; pkill -f x11vnc || true;
         pkill -f "Xvfb $DISPLAY_NUM" || true; pkill -x openbox || true; }

case "${1:-}" in
  setup) setup ;;
  run) run "${2:-}" ;;
  stop) stop ;;
  *) sed -n '2,8p' "$0" ;;
esac
