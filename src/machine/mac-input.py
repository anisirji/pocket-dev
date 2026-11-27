#!/usr/bin/env python3
"""Optional macOS input adapter. Standard library only; no input is posted by --check.

The parent owns the authorization lease. Input is atomic (no held keys/buttons), bounded,
short-lived, and never recorded. OS authorization dialogs and locked sessions block input.
"""
import ctypes as C
import ctypes.util
import json
import signal
import sys
import time

if sys.platform != 'darwin':
    print(json.dumps({'state': 'unsupported', 'message': 'Desktop input is supported on macOS only.'}), flush=True)
    sys.exit(1)

cg = C.CDLL(ctypes.util.find_library('CoreGraphics'))
cf = C.CDLL(ctypes.util.find_library('CoreFoundation'))
ax = C.CDLL(ctypes.util.find_library('ApplicationServices'))

class Point(C.Structure):
    _fields_ = [('x', C.c_double), ('y', C.c_double)]

class Size(C.Structure):
    _fields_ = [('width', C.c_double), ('height', C.c_double)]

class Rect(C.Structure):
    _fields_ = [('origin', Point), ('size', Size)]

def bind(lib, name, result, args):
    fn = getattr(lib, name)
    fn.restype = result
    fn.argtypes = args
    return fn

release = bind(cf, 'CFRelease', None, [C.c_void_p])
string = bind(cf, 'CFStringCreateWithCString', C.c_void_p, [C.c_void_p, C.c_char_p, C.c_uint32])
get = bind(cf, 'CFDictionaryGetValue', C.c_void_p, [C.c_void_p, C.c_void_p])
boolean = bind(cf, 'CFBooleanGetValue', C.c_bool, [C.c_void_p])
to_string = bind(cf, 'CFStringGetCString', C.c_bool, [C.c_void_p, C.c_char_p, C.c_long, C.c_uint32])
array_count = bind(cf, 'CFArrayGetCount', C.c_long, [C.c_void_p])
array_get = bind(cf, 'CFArrayGetValueAtIndex', C.c_void_p, [C.c_void_p, C.c_long])
session_copy = bind(cg, 'CGSessionCopyCurrentDictionary', C.c_void_p, [])
windows_copy = bind(cg, 'CGWindowListCopyWindowInfo', C.c_void_p, [C.c_uint32, C.c_uint32])
trusted = bind(ax, 'AXIsProcessTrusted', C.c_bool, [])
capture_allowed = bind(cg, 'CGPreflightScreenCaptureAccess', C.c_bool, [])
display_active = bind(cg, 'CGDisplayIsActive', C.c_uint32, [C.c_uint32])
display_bounds = bind(cg, 'CGDisplayBounds', Rect, [C.c_uint32])
mouse_event = bind(cg, 'CGEventCreateMouseEvent', C.c_void_p, [C.c_void_p, C.c_uint32, Point, C.c_uint32])
keyboard_event = bind(cg, 'CGEventCreateKeyboardEvent', C.c_void_p, [C.c_void_p, C.c_uint16, C.c_bool])
unicode_text = bind(cg, 'CGEventKeyboardSetUnicodeString', None, [C.c_void_p, C.c_ulong, C.POINTER(C.c_uint16)])
set_flags = bind(cg, 'CGEventSetFlags', None, [C.c_void_p, C.c_uint64])
set_integer = bind(cg, 'CGEventSetIntegerValueField', None, [C.c_void_p, C.c_uint32, C.c_int64])
scroll_event = bind(cg, 'CGEventCreateScrollWheelEvent', C.c_void_p, [C.c_void_p, C.c_uint32, C.c_uint32, C.c_int32, C.c_int32])
post = bind(cg, 'CGEventPost', None, [C.c_uint32, C.c_void_p])
KEYS = dict(zip(list('ASDFHGZXCVBQWERYT'), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 17]))
KEYS.update(dict(zip(list('123465=97-80]OU[IP'), [18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35])))
KEYS.update({'L': 37, 'J': 38, 'K': 40, 'N': 45, 'M': 46, 'Enter': 36, 'Tab': 48, 'Space': 49, 'Backspace': 51, 'Escape': 53, 'Delete': 117, 'Home': 115, 'End': 119, 'PageUp': 116, 'PageDown': 121, 'ArrowLeft': 123, 'ArrowRight': 124, 'ArrowDown': 125, 'ArrowUp': 126})
MODS = {'shift': 1 << 17, 'control': 1 << 18, 'alt': 1 << 19, 'command': 1 << 20}
PROTECTED = {'loginwindow', 'SecurityAgent', 'authorizationhost', 'CoreServicesUIAgent', 'universalAccessAuthWarn'}
stopping = False

def value(dictionary, key):
    name = string(None, key.encode(), 0x08000100)
    try:
        return get(dictionary, name)
    finally:
        release(name)

def locked():
    session = session_copy()
    if not session:
        return True
    try:
        on_console = value(session, 'kCGSSessionOnConsoleKey')
        logged_in = value(session, 'kCGSessionLoginDoneKey')
        is_locked = value(session, 'CGSSessionScreenIsLocked')
        if not on_console or not boolean(on_console) or not logged_in or not boolean(logged_in) or (is_locked and boolean(is_locked)):
            return True
    finally:
        release(session)
    windows = windows_copy(1 | 16, 0)
    if not windows:
        return True
    try:
        for index in range(min(array_count(windows), 128)):
            owner = value(array_get(windows, index), 'kCGWindowOwnerName')
            if not owner:
                continue
            text = C.create_string_buffer(256)
            if to_string(owner, text, 256, 0x08000100) and text.value.decode('utf-8') in PROTECTED:
                return True
    finally:
        release(windows)
    return False

def status():
    if not trusted():
        return {'state': 'permission-required', 'code': 'PERMISSION_REQUIRED', 'message': 'Allow Accessibility for the program running Pocket Dev in macOS System Settings.'}
    if not capture_allowed():
        return {'state': 'permission-required', 'code': 'PERMISSION_REQUIRED', 'message': 'Allow Screen Recording for the program running Pocket Dev before controlling its display.'}
    if locked():
        return {'state': 'permission-required', 'code': 'SECURE_SCREEN', 'message': 'Unlock the Mac and close system authorization dialogs before requesting control.'}
    return {'state': 'ready', 'code': 'READY', 'message': 'Mac control is available with local approval.'}

def emit(data):
    print(json.dumps(data), flush=True)

def send_event(event):
    if not event:
        raise RuntimeError('macOS could not create an input event.')
    try:
        post(0, event)
    finally:
        release(event)

def act(event, display):
    if not display_active(display):
        raise RuntimeError('The selected display is unavailable.')
    bounds = display_bounds(display)
    point = Point(bounds.origin.x + event.get('x', 0) * max(0, bounds.size.width - 1), bounds.origin.y + event.get('y', 0) * max(0, bounds.size.height - 1))
    kind = event['kind']
    if kind in ('move', 'click', 'scroll'):
        send_event(mouse_event(None, 5, point, 0))
    if kind == 'click':
        right = event.get('button') == 'right'
        for index in range(event.get('count', 1)):
            down = mouse_event(None, 3 if right else 1, point, int(right))
            up = mouse_event(None, 4 if right else 2, point, int(right))
            if not down or not up:
                if down: release(down)
                if up: release(up)
                raise RuntimeError('macOS could not create a click.')
            set_integer(down, 1, index + 1)
            set_integer(up, 1, index + 1)
            try:
                send_event(down)
            finally:
                send_event(up)
    elif kind == 'scroll':
        send_event(scroll_event(None, 1, 2, -int(event['dy']), -int(event['dx'])))
    elif kind in ('key', 'text'):
        flags = sum(MODS[modifier] for modifier in set(event.get('modifiers', [])))
        code = KEYS[event['key']] if kind == 'key' else 0
        # Chromium consumes one character from a native key event. Send one
        # Unicode scalar per key pair; an astral character keeps its UTF-16 pair.
        for text in event['text'] if kind == 'text' else [None]:
            down, up = keyboard_event(None, code, True), keyboard_event(None, code, False)
            if not down or not up:
                if down: release(down)
                if up: release(up)
                raise RuntimeError('macOS could not create a keypress.')
            if text is not None:
                raw = text.encode('utf-16-le')
                chars = (C.c_uint16 * (len(raw) // 2)).from_buffer_copy(raw)
                unicode_text(down, len(chars), chars)
                unicode_text(up, len(chars), chars)
            set_flags(down, flags)
            set_flags(up, flags)
            try:
                send_event(down)
            finally:
                send_event(up)

def terminate(_signal, _frame):
    global stopping
    stopping = True

signal.signal(signal.SIGTERM, terminate)
if '--check' in sys.argv:
    emit(status())
    sys.exit(0)
display = int(sys.argv[1])
emit(status())
for line in sys.stdin.buffer:
    if stopping:
        break
    try:
        if len(line) > 4096:
            break
        request = json.loads(line)
        state = status()
        if state['state'] != 'ready':
            emit({'id': request.get('id'), **state})
            break
        if request.get('type') == 'check':
            emit({'id': request['id'], 'state': 'ready'})
            continue
        if abs(time.time() * 1000 - request['at']) > 1000:
            emit({'id': request['id'], 'state': 'failed', 'code': 'STALE_INPUT', 'message': 'Old input was discarded.'})
            break
        if stopping:
            break
        act(request['event'], display)
        emit({'id': request['id'], 'state': 'ready'})
    except Exception:
        emit({'state': 'failed', 'code': 'INPUT_FAILED', 'message': 'Mac input stopped. Request control again after checking the computer.'})
        break
