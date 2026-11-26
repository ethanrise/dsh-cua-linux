"""Render input-transparent X11 overlays from JSON lines on stdin."""
import json
import os
import sys

os.environ["GDK_BACKEND"] = "x11"
os.environ["GDK_SCALE"] = "1"

import gi
gi.require_version("Gtk", "3.0")
gi.require_foreign("cairo")
import cairo
from gi.repository import GLib, Gtk, Pango

if not Gtk.init_check()[0]:
    sys.exit(1)

def make_click_through(widget):
    target = widget.get_window()
    target.set_pass_through(True)
    target.input_shape_combine_region(cairo.Region(), 0, 0)


def popup(title):
    widget = Gtk.Window(type=Gtk.WindowType.POPUP, title=title)
    widget.set_accept_focus(False)
    widget.set_focus_on_map(False)
    widget.set_app_paintable(True)
    visual = widget.get_screen().get_rgba_visual()
    if visual:
        widget.set_visual(visual)
    widget.set_name("dsh-overlay-window")
    widget.connect("realize", make_click_through)
    return widget


def show(widget):
    widget.show_all()
    make_click_through(widget)
    widget.get_window().raise_()


window = popup("DSH CUA Progress")
banner = popup("DSH CUA Mouse Control")
marker = popup("DSH CUA Click Marker")
screen = window.get_screen()
banner_label = Gtk.Label(label="DSH 鼠标接管中")
banner_label.set_name("dsh-mouse-banner")
banner.add(banner_label)
banner_label.show()
marker.set_size_request(62, 62)


def draw_marker(_widget, cr):
    # The outer rings are centered exactly where XTEST sends the click.
    cr.arc(31, 31, 21, 0, 6.284)
    cr.set_source_rgba(0.05, 0.11, 0.20, 0.8)
    cr.set_line_width(6)
    cr.stroke_preserve()
    cr.set_source_rgba(0.37, 0.79, 1, 0.98)
    cr.set_line_width(3)
    cr.stroke()
    cr.move_to(31, 31)
    cr.line_to(34, 51)
    cr.line_to(39, 45)
    cr.line_to(46, 42)
    cr.close_path()
    cr.set_source_rgba(0.93, 0.98, 1, 1)
    cr.fill_preserve()
    cr.set_source_rgba(0.08, 0.14, 0.24, 1)
    cr.set_line_width(1.5)
    cr.stroke()
    return True


marker.connect("draw", draw_marker)

card = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=5)
card.set_name("dsh-progress-card")
card.set_size_request(318, -1)
window.add(card)
labels = {}
for key in ("heading", "task", "step", "result"):
    label = Gtk.Label(xalign=0)
    label.set_name("dsh-" + key)
    label.set_ellipsize(Pango.EllipsizeMode.END)
    label.set_max_width_chars(36)
    card.pack_start(label, False, False, 0)
    labels[key] = label
labels["heading"].set_text("DSH · 电脑操作")
card.show_all()

css = Gtk.CssProvider()
css.load_from_data(b"""
#dsh-overlay-window { background-color: transparent; }
#dsh-mouse-banner {
  padding: 6px 17px;
  background-color: rgba(21, 29, 46, 0.90);
  border: 1px solid rgba(108, 198, 255, 0.85);
  border-radius: 15px;
  color: #eff8ff;
  font-weight: 700;
}
#dsh-progress-card {
  padding: 12px 16px;
  background-color: rgba(21, 29, 46, 0.88);
  border: 1px solid rgba(139, 169, 224, 0.62);
  border-radius: 12px;
  color: #eff4ff;
}
#dsh-heading { color: #b5cbff; font-weight: 700; }
#dsh-task { font-size: 14px; font-weight: 700; }
#dsh-step { font-size: 13px; }
#dsh-result { color: #d1dbef; font-size: 12px; }
""")
Gtk.StyleContext.add_provider_for_screen(screen, css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)


def place():
    display = window.get_display()
    monitor = display.get_primary_monitor() or display.get_monitor(0)
    if monitor:
        area = monitor.get_workarea()
        width = card.get_preferred_width()[1]
        window.move(area.x + max(0, area.width - width - 16), area.y + 16)


def reply(request_id):
    print(json.dumps({"id": request_id}), flush=True)
    return GLib.SOURCE_REMOVE


paused = False
pointer_timers = {banner: None, marker: None}


def expire(widget):
    pointer_timers[widget] = None
    widget.hide()
    return GLib.SOURCE_REMOVE


def pulse(widget, duration):
    if pointer_timers[widget]:
        GLib.source_remove(pointer_timers[widget])
    pointer_timers[widget] = GLib.timeout_add(duration, expire, widget)
    if not paused:
        show(widget)


def pointer(command):
    x, y = command["x"], command["y"]
    display = window.get_display()
    monitor = display.get_monitor_at_point(x, y)
    if monitor:
        area = monitor.get_workarea()
        width = banner_label.get_preferred_width()[1]
        banner.move(area.x + max(0, (area.width - width) // 2), area.y + 10)
    pulse(banner, 950)
    if command["click"]:
        marker.move(x - 31, y - 31)
        marker.queue_draw()
        pulse(marker, 1150)


def handle(command):
    global paused
    kind = command["type"]
    if kind == "show":
        for key in ("task", "step", "result"):
            labels[key].set_text(command[key])
        place()
        if not paused:
            show(window)
    elif kind == "hide":
        window.hide()
    elif kind == "pointer":
        pointer(command)
    elif kind == "hide-all":
        paused = True
        was_visible = any(widget.get_visible() for widget in (window, banner, marker))
        for widget in (window, banner, marker):
            widget.hide()
        window.get_display().sync()
        if was_visible and screen.is_composited():
            GLib.timeout_add(34, reply, command["id"])
        else:
            reply(command["id"])
    elif kind == "resume":
        paused = False
        for widget, timer in pointer_timers.items():
            if timer:
                show(widget)


buffer = b""


def read_command(_source, _condition):
    global buffer
    data = os.read(sys.stdin.fileno(), 4096)
    if not data:
        Gtk.main_quit()
        return GLib.SOURCE_REMOVE
    buffer += data
    while b"\n" in buffer:
        line, buffer = buffer.split(b"\n", 1)
        handle(json.loads(line))
    return GLib.SOURCE_CONTINUE


GLib.io_add_watch(sys.stdin, GLib.PRIORITY_DEFAULT, GLib.IO_IN | GLib.IO_HUP | GLib.IO_ERR, read_command)
Gtk.main()
