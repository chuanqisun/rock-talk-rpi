import json
import signal
import sys
import time

import adafruit_pixelbuf
import board
from adafruit_raspberry_pi5_neopixel_write import neopixel_write

NEOPIXEL = board.D13
num_pixels = 30 # Adjusted for actual number of LEDs
BLUE = (0, 0, 255)
OFF = (0, 0, 0)
SUPPORTED_MODES = {"idle", "playing"}

class Pi5Pixelbuf(adafruit_pixelbuf.PixelBuf):
    def __init__(self, pin, size, **kwargs):
        self._pin = pin
        super().__init__(size=size, **kwargs)

    def _transmit(self, buf):
        neopixel_write(self._pin, buf)


def emit(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def clear_pixels():
    pixels.fill(OFF)
    pixels.show()


def render_mode(mode):
    if mode == "idle":
        clear_pixels()
        return

    if mode == "playing":
        for index in range(num_pixels):
            pixels[index] = BLUE if index % 2 == 0 else OFF

        pixels.show()
        return

    raise ValueError(f"Unsupported LED mode: {mode}")


def handle_command(command, current_mode):
    command_type = command.get("type")

    if command_type == "setMode":
        mode = command.get("mode")

        if mode not in SUPPORTED_MODES:
            raise ValueError(f"Unsupported LED mode: {mode}")

        if mode != current_mode:
            render_mode(mode)

        emit({"type": "ack", "command": "setMode", "mode": mode})
        return mode, False

    if command_type == "shutdown":
        clear_pixels()
        emit({"type": "ack", "command": "shutdown"})
        return current_mode, True

    if command_type == "ping":
        emit({"type": "pong"})
        return current_mode, False

    raise ValueError(f"Unsupported command: {command_type}")

pixels = Pi5Pixelbuf(NEOPIXEL, num_pixels, auto_write=True, byteorder="BGR")
running = True


def stop_worker(_signal_number, _frame):
    global running
    running = False


signal.signal(signal.SIGINT, stop_worker)
signal.signal(signal.SIGTERM, stop_worker)

current_mode = "idle"

try:
    clear_pixels()
    emit({"type": "ready", "supportedModes": sorted(SUPPORTED_MODES)})

    while running:
        raw_line = sys.stdin.readline()

        if raw_line == "":
            break

        line = raw_line.strip()

        if not line:
            continue

        try:
            command = json.loads(line)
            current_mode, should_shutdown = handle_command(command, current_mode)

            if should_shutdown:
                break
        except Exception as error:
            emit({"type": "error", "message": str(error)})
finally:
    time.sleep(0.02)
    clear_pixels()
