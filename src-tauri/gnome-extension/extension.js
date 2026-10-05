// Lumo — posição do cursor (GNOME Shell 42–44)
//
// No Wayland os apps não podem perguntar onde está o mouse fora da própria janela.
// O GNOME Shell (o compositor) sabe: esta extensão expõe SÓ a posição (x, y) em
// org.lumo.Cursor no barramento da sessão. Nenhum clique, tecla ou janela é lido.
const { Gio } = imports.gi;

const IFACE = `
<node>
  <interface name="org.lumo.Cursor">
    <method name="GetPosition">
      <arg type="i" direction="out" name="x"/>
      <arg type="i" direction="out" name="y"/>
    </method>
  </interface>
</node>`;

class LumoCursor {
  enable() {
    this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
    this._dbus.export(Gio.DBus.session, '/org/lumo/Cursor');
    this._owner = Gio.bus_own_name_on_connection(
      Gio.DBus.session,
      'org.lumo.Cursor',
      Gio.BusNameOwnerFlags.NONE,
      null,
      null
    );
  }

  disable() {
    if (this._dbus) {
      this._dbus.unexport();
      this._dbus = null;
    }
    if (this._owner) {
      Gio.bus_unown_name(this._owner);
      this._owner = 0;
    }
  }

  // Coordenadas lógicas da tela (mesmo espaço das janelas)
  GetPosition() {
    const [x, y] = global.get_pointer();
    return [x, y];
  }
}

function init() {
  return new LumoCursor();
}
