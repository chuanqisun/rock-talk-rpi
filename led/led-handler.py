import json
import select
import signal
import sys
import time

import adafruit_pixelbuf
import board
from adafruit_led_animation.animation.rainbowchase import RainbowChase
from adafruit_raspberry_pi5_neopixel_write import neopixel_write


NEOPIXEL = board.D13 # We use GPIO13 for data line. This may be customizable.
num_pixels = 30 # Adjusted for actual number of LEDs
brightness = 0.5 # Adjust brightness as needed (0.0 to 1.0)
GREEN = (0, 0, 255)
OFF = (0, 0, 0)
SUPPORTED_MODES = {"idle", "playing"}
FRAME_INTERVAL_SECONDS = 0.05
STARTUP_ANIMATION_DURATION_SECONDS = 1.5

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


def fill_pixels(color):
    pixels.fill(color)
    pixels.show()


def render_progress(cycle_elapsed_ms, duration_ms):
    if duration_ms <= 0:
        fill_pixels(GREEN)
        return

    progress = max(0.0, min(cycle_elapsed_ms / duration_ms, 1.0))
    played_pixels = min(num_pixels, int(progress * num_pixels))

    for index in range(num_pixels):
        pixels[index] = OFF if index < played_pixels else GREEN

    pixels.show()


def render_mode(mode):
    if mode == "idle":
        clear_pixels()
        return

    if mode == "playing":
        fill_pixels(GREEN)
        return

    raise ValueError(f"Unsupported LED mode: {mode}")


def handle_command(command, current_mode):
    global playback_state, startup_animation_state
    command_type = command.get("type")

    if command_type == "setMode":
        mode = command.get("mode")

        if mode not in SUPPORTED_MODES:
            raise ValueError(f"Unsupported LED mode: {mode}")

        if mode != current_mode:
            render_mode(mode)

        playback_state = None
        startup_animation_state = None

        emit({"type": "ack", "command": "setMode", "mode": mode})
        return mode, False

    if command_type == "playbackProgress":
        duration_ms = int(command.get("durationMs") or 0)
        intro_delay_ms = int(command.get("introDelayMs") or 0)

        if duration_ms < 0:
            raise ValueError("durationMs must be zero or greater")

        if intro_delay_ms < 0:
            raise ValueError("introDelayMs must be zero or greater")

        playback_state = {
            "duration_ms": duration_ms,
            "intro_delay_ms": intro_delay_ms,
            "started_at": time.monotonic(),
        }
        startup_animation_state = None
        fill_pixels(GREEN)

        emit({
            "type": "ack",
            "command": "playbackProgress",
            "durationMs": duration_ms,
            "introDelayMs": intro_delay_ms,
        })
        return "playing", False

    if command_type == "clear":
        playback_state = None
        startup_animation_state = None
        clear_pixels()
        emit({"type": "ack", "command": "clear"})
        return "idle", False

    if command_type == "shutdown":
        playback_state = None
        startup_animation_state = None
        clear_pixels()
        emit({"type": "ack", "command": "shutdown"})
        return current_mode, True

    if command_type == "ping":
        emit({"type": "pong"})
        return current_mode, False

    raise ValueError(f"Unsupported command: {command_type}")

pixels = Pi5Pixelbuf(
    NEOPIXEL,
    num_pixels,
    auto_write=True,
    byteorder="BGR",
    brightness=brightness,
)
startup_animation = RainbowChase(pixels, speed=0.02, size=5, spacing=3)
running = True
playback_state = None
startup_animation_state = {"started_at": time.monotonic()}


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
        if playback_state is not None:
            elapsed_ms = int((time.monotonic() - playback_state["started_at"]) * 1000)
            progress_duration_ms = max(playback_state["duration_ms"] - playback_state["intro_delay_ms"], 0)

            if elapsed_ms < playback_state["intro_delay_ms"]:
                fill_pixels(GREEN)
            else:
                cycle_elapsed_ms = 0

                if progress_duration_ms > 0:
                    cycle_elapsed_ms = (elapsed_ms - playback_state["intro_delay_ms"]) % progress_duration_ms

                render_progress(cycle_elapsed_ms, progress_duration_ms)
        elif startup_animation_state is not None:
            if time.monotonic() - startup_animation_state["started_at"] >= STARTUP_ANIMATION_DURATION_SECONDS:
                startup_animation_state = None
                clear_pixels()
            else:
                startup_animation.animate()

        ready_inputs, _, _ = select.select([sys.stdin], [], [], FRAME_INTERVAL_SECONDS)

        if not ready_inputs:
            continue

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
