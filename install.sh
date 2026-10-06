#!/usr/bin/env bash
# Instala (ou atualiza) o Lumo neste PC.
#
#   ./install.sh            usa o .deb mais recente (compila se não houver)
#   ./install.sh --build    recompila antes de instalar
#
# O que faz:
#   1. compila o pacote .deb (npm + cargo), se preciso
#   2. instala com apt (pede a senha de administrador)
#   3. remove sobras de versões antigas: o atalho "Lumo" duplicado em
#      ~/.local/share/applications (apontava para start-lumo-silent.sh) e um
#      "iniciar com o sistema" apontando para o binário de desenvolvimento — era ele
#      que mostrava a página de erro fixa ao ligar o PC
#   4. reabre o Lumo instalado
set -euo pipefail

DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
cd "$DIR"

say() { printf '\033[1;35m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*"; }

VERSION="$(grep -m1 '"version"' src-tauri/tauri.conf.json | sed -E 's/.*"([0-9.]+)".*/\1/')"
DEB="src-tauri/target/release/bundle/deb/Lumo_${VERSION}_amd64.deb"
APPIMG="src-tauri/target/release/bundle/appimage/Lumo_${VERSION}_amd64.AppImage"
HAS_APT=0; command -v apt-get >/dev/null && HAS_APT=1
if ((HAS_APT)); then BUILT="$DEB"; else BUILT="$APPIMG"; fi

# ---- 1. compilar ----------------------------------------------------------------------
if [[ "${1:-}" == "--build" || ! -f "$BUILT" ]]; then
  command -v npm >/dev/null || { warn "Node.js/npm não encontrado (sudo apt install nodejs npm)."; exit 1; }
  export PATH="$HOME/.cargo/bin:$PATH"
  command -v cargo >/dev/null || { warn "Rust não encontrado: curl https://sh.rustup.rs -sSf | sh"; exit 1; }
  missing=()
  ((HAS_APT)) || warn "Sem apt: instale as bibliotecas WebKitGTK 4.1, GTK3, librsvg, OpenSSL e libayatana-appindicator pela sua distribuição."
  if ((HAS_APT)); then
    for pkg in libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev build-essential; do
      dpkg -s "$pkg" >/dev/null 2>&1 || missing+=("$pkg")
    done
  fi
  if ((${#missing[@]})); then
    say "Instalando dependências de compilação: ${missing[*]}"
    sudo apt-get install -y "${missing[@]}"
  fi
  [[ -d node_modules ]] || { say "npm install"; npm install; }
  say "Compilando o Lumo ${VERSION} (a primeira vez demora alguns minutos)…"
  npm run desktop:build
fi
[[ -f "$BUILT" ]] || { warn "Pacote não encontrado: $BUILT"; exit 1; }

# ---- sem apt: instala o AppImage no diretório do usuário ------------------------------------
if ((!HAS_APT)); then
  mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications" instalador
  cp -f "$APPIMG" instalador/
  install -m 755 "$APPIMG" "$HOME/.local/bin/Lumo.AppImage"
  cat >"$HOME/.local/share/applications/lumo.desktop" <<DESK
[Desktop Entry]
Type=Application
Name=Lumo
Comment=Assistente flutuante no topo da tela
Exec=env APPIMAGE_EXTRACT_AND_RUN=1 $HOME/.local/bin/Lumo.AppImage
Icon=$DIR/src-tauri/icons/128x128.png
Categories=Utility;
Terminal=false
DESK
  update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
  say "AppImage instalado em ~/.local/bin/Lumo.AppImage"
  setsid -f env -u GDK_BACKEND APPIMAGE_EXTRACT_AND_RUN=1 "$HOME/.local/bin/Lumo.AppImage" >/dev/null 2>&1 </dev/null || true
  exit 0
fi

mkdir -p instalador
cp -f "$DEB" instalador/
APPIMAGE_SRC="$(ls -t src-tauri/target/release/bundle/appimage/Lumo_"${VERSION}"_amd64.AppImage 2>/dev/null | head -1 || true)"
[[ -n "$APPIMAGE_SRC" ]] && cp -f "$APPIMAGE_SRC" instalador/

# ---- 2. fechar o Lumo aberto e instalar -------------------------------------------------
pkill -x lumo-assistant 2>/dev/null || true
say "Instalando o pacote (pede a senha de administrador)…"
sudo apt-get install -y --reinstall "./instalador/$(basename "$DEB")"

# ---- 3. limpar sobras -----------------------------------------------------------------------
LEGACY="$HOME/.local/share/applications/lumo.desktop"
if [[ -f "$LEGACY" ]] && grep -q "start-lumo" "$LEGACY"; then
  say "Removendo o atalho antigo duplicado do menu"
  rm -f "$LEGACY" "$HOME/.local/share/icons/hicolor/scalable/apps/lumo.svg"
  update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
fi

AUTOSTART="${XDG_CONFIG_HOME:-$HOME/.config}/autostart/Lumo.desktop"
if [[ -f "$AUTOSTART" ]] && grep -q "/target/" "$AUTOSTART"; then
  say "Corrigindo “Iniciar com o sistema” para usar o Lumo instalado"
  sed -i -E 's#^Exec=.*#Exec=/usr/bin/lumo-assistant --autostart#' "$AUTOSTART"
  grep -q '^X-GNOME-Autostart-Delay' "$AUTOSTART" || echo 'X-GNOME-Autostart-Delay=3' >>"$AUTOSTART"
fi

# ---- 4. abrir ------------------------------------------------------------------------------
say "Abrindo o Lumo"
env -u GDK_BACKEND setsid -f /usr/bin/lumo-assistant >/dev/null 2>&1 </dev/null || true

cat <<EOF

✔ Lumo ${VERSION} instalado.
  • Menu de aplicativos: pesquise “Lumo” (botão direito: E-mails, Sistema…)
  • Abrir/fechar painel: Ctrl+Alt+L (registrado no GNOME na primeira execução)
  • Iniciar com o sistema: Config → Sistema
  • Desinstalar: ./uninstall.sh
EOF
