#!/bin/bash
# One-time dev setup on the Steam Deck. Run:  sudo bash /tmp/setup-deck.sh
# Installs /etc/decky-dev/deck-dev.sh (deploy|logs) and a sudoers rule so the
# PC-side dev-sync.ps1 can redeploy without a password.
# Remove after debugging:  sudo rm -r /etc/decky-dev /etc/sudoers.d/zz-decky-dev
set -euo pipefail
install -d -m 755 /etc/decky-dev
cat > /etc/decky-dev/deck-dev.sh <<'EOS'
#!/bin/bash
set -euo pipefail
PLUGINS=/home/deck/homebrew/plugins
STAGE=/tmp/vi-stage
# Reuse the folder of a store-installed copy (keeps its bin/whisper-server)
DEST=""
for pj in "$PLUGINS"/*/plugin.json; do
  if grep -q '"name": *"Voice Input"' "$pj" 2>/dev/null; then DEST="$(dirname "$pj")"; break; fi
done
DEST="${DEST:-$PLUGINS/decky-voice-input}"
case "${1:-}" in
  deploy)
    [ -d "$STAGE" ] || { echo "нет $STAGE"; exit 1; }
    mkdir -p "$DEST"
    for f in plugin.json package.json main.py dist py_modules; do
      [ -e "$STAGE/$f" ] || continue
      rm -rf "${DEST:?}/$f"; cp -r "$STAGE/$f" "$DEST/"
    done
    if [ -d "$STAGE/bin" ]; then
      mkdir -p "$DEST/bin"
      for b in "$STAGE"/bin/*; do  # tmp + rename: works even while the engine is running
        install -m 755 "$b" "$DEST/bin/.$(basename "$b").new" && mv -f "$DEST/bin/.$(basename "$b").new" "$DEST/bin/$(basename "$b")"
      done
    fi
    chown -R root:root "$DEST"
    systemctl restart plugin_loader
    echo "deployed to $DEST at $(date +%T)";;
  logs)
    echo "=== $(date '+%F %T') dest: $DEST"
    echo "=== plugin_loader journal (last 200) ==="
    journalctl -u plugin_loader -n 200 --no-pager -o short-iso || true
    echo
    for d in /home/deck/homebrew/logs/*; do
      case "$(basename "$d")" in *oice*) ;; *) continue;; esac
      ls -t "$d"/* 2>/dev/null | head -3 | while IFS= read -r f; do echo "=== $f ==="; tail -n 200 "$f"; echo; done
    done;;
  *) echo "usage: deck-dev.sh deploy|logs"; exit 2;;
esac
EOS
chmod 755 /etc/decky-dev/deck-dev.sh
echo 'deck ALL=(root) NOPASSWD: /etc/decky-dev/deck-dev.sh' > /etc/sudoers.d/zz-decky-dev
chmod 440 /etc/sudoers.d/zz-decky-dev
visudo -cf /etc/sudoers.d/zz-decky-dev
echo "OK: sudo /etc/decky-dev/deck-dev.sh deploy|logs работает без пароля"
