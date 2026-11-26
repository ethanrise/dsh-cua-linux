"""One bounded AT-SPI request over stdin/stdout."""
import json
import sys

try:
    import gi
    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi
except (ImportError, ValueError):
    print(json.dumps({"error": "AT-SPI requires python3-gi and gir1.2-atspi-2.0"}))
    sys.exit()


def children(node):
    for index in range(min(node.get_child_count(), 512)):
        child = node.get_child_at_index(index)
        if child is not None:
            yield child


def is_descendant(pid, ancestor):
    for _ in range(16):
        if pid <= 1:
            return False
        if pid == ancestor:
            return True
        try:
            with open(f"/proc/{pid}/stat", encoding="utf-8") as stat:
                pid = int(stat.read().rsplit(")", 1)[1].split()[1])
        except (OSError, IndexError, ValueError):
            return False
    return False


def find_window(target):
    direct, descendants = [], []
    for app in children(Atspi.get_desktop(0)):
        pid = app.get_process_id()
        if pid == target["pid"]:
            candidates = direct
        elif target.get("allowDescendants") and is_descendant(pid, target["pid"]):
            candidates = descendants
        else:
            continue
        for node in children(app):
            if node.get_name() == target["title"]:
                candidates.append(node)
    candidates = direct or descendants
    if len(candidates) != 1:
        raise ValueError("No unique AT-SPI window for this X11 PID and title. Use a screenshot.")
    return candidates[0]


def state(node, flag):
    return node.get_state_set().contains(flag)


def visit(root, limit):
    pending = [(root, 0)]
    for _ in range(limit):
        if not pending:
            break
        node, depth = pending.pop()
        yield node, depth
        if depth < 20:
            pending.extend((child, depth + 1) for child in reversed(list(children(node))))


def describe(node, depth):
    actions = node.get_action_iface()
    secret = node.get_role() == Atspi.Role.PASSWORD_TEXT
    return {
        "path": node.path, "pid": node.get_process_id(), "depth": depth, "name": "" if secret else (node.get_name() or "")[:200],
        "role": node.get_role_name(), "enabled": state(node, Atspi.StateType.ENABLED),
        "showing": state(node, Atspi.StateType.SHOWING),
        "checked": state(node, Atspi.StateType.CHECKED),
        "selected": state(node, Atspi.StateType.SELECTED),
        "focused": state(node, Atspi.StateType.FOCUSED),
        "editable": not secret and bool(node.get_editable_text_iface()),
        "actions": [actions.get_action_name(i) for i in range(min(actions.get_n_actions(), 16))]
        if actions else [],
    }


def execute(request):
    Atspi.init()
    Atspi.set_timeout(600, 1200)
    root = find_window(request["window"])
    if request["operation"] == "observe":
        return {"nodes": [describe(node, depth) for node, depth in visit(root, request["limit"])]}
    expected = request["node"]
    for node, depth in visit(root, request["limit"]):
        if node.path == expected["path"] and node.get_process_id() == expected["pid"]:
            break
    else:
        raise ValueError("The element is no longer available. Observe the window again.")
    current = describe(node, depth)
    if any(current[key] != expected[key] for key in ("name", "role", "actions")):
        raise ValueError("The element changed. Observe the window again.")
    if not current["enabled"] or not current["showing"]:
        raise ValueError("The element is not enabled and showing.")
    if request["operation"] == "set_text":
        text = request["text"]
        if not current["editable"] or not node.get_text_iface():
            raise ValueError("The element has no readable editable text interface.")
        if not node.get_editable_text_iface().set_text_contents(text):
            raise ValueError("The application rejected the text update.")
        try:
            reader = node.get_text_iface()
            count = reader.get_character_count()
            verified = count == len(text) and reader.get_text(0, count) == text
        except Exception:
            verified = False
        return {"dispatched": True, "verified": verified}
    action = request["action"]
    if action not in current["actions"]:
        raise ValueError("Choose an action from the current observation.")
    if not node.get_action_iface().do_action(current["actions"].index(action)):
        raise ValueError("The application rejected the action. Observe the window before retrying.")
    return {"dispatched": True}


try:
    print(json.dumps(execute(json.load(sys.stdin))))
except Exception as error:
    print(json.dumps({"error": str(error)}))
