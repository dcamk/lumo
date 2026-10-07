#!/usr/bin/env bash
# Remove o Lumo da sua máquina.
#
#   ./uninstall.sh          remove o app, o "iniciar com o sistema" e o atalho do GNOME
#   ./uninstall.sh --purge  também apaga configurações e a conta Google conectada
set -euo pipefail

say() { printf '\033[1;35m▸\033[0m %s\n' "$*"; }

pkill -x lumo-assistant 2>/dev/null || true

if dpkg -s lumo >/dev/null 2>&1; then
  say "Removendo o pacote (pede a senha de administrador)…"
  sudo apt-get remove -y lumo
fi

rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/autostart/Lumo.desktop"
rm -f "$HOME/.local/share/applications/lumo.desktop" "$HOME/.local/share/icons/hicolor/scalable/apps/lumo.svg"

# Atalho Ctrl+Alt+L do GNOME
if command -v gsettings >/dev/null; then
  KEYS=org.gnome.settings-daemon.plugins.media-keys
  LUMO=/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/lumo/
  current="$(gsettings get "$KEYS" custom-keybindings 2>/dev/null || echo '@as []')"
  if [[ "$current" == *"$LUMO"* ]]; then
    say "Removendo o atalho do GNOME"
    updated="$(python3 -c "import ast,sys; l=[p for p in ast.literal_eval(sys.argv[1].replace('@as ','')) if p!=sys.argv[2]]; print(l)" "$current" "$LUMO")"
    gsettings set "$KEYS" custom-keybindings "$updated"
    gsettings reset-recursively "org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:$LUMO" 2>/dev/null || true
  fi
fi

if [[ "${1:-}" == "--purge" ]]; then
  say "Apagando configurações (tarefas, chaves de IA, conta Google)"
  rm -rf "${XDG_CONFIG_HOME:-$HOME/.config}/com.lumo.assistant" "$HOME/.local/share/com.lumo.assistant"
fi

echo "✔ Lumo removido."
