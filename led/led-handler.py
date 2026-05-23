import json
import select
import signal
import sys
import time

import adafruit_pixelbuf
import board
from adafruit_raspberry_pi5_neopixel_write import neopixel_write

NEOPIXEL = board.D13
num_pixels = 30 # Adjusted for actual number of LEDs
GREEN = (0, 0, 255)
OFF = (0, 0, 0)
SUPPORTED_MODES = {"idle", "playing"}
FRAME_INTERVAL_SECONDS = 0.05
FADE_OUT_DURATION_SECONDS = 0.35

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


def snapshot_pixels():
    return [tuple(pixels[index]) for index in range(num_pixels)]


def render_fade_out(source_colors, progress):
    brightness = max(0.0, min(1.0 - progress, 1.0))

    for index, color in enumerate(source_colors):
        pixels[index] = tuple(int(channel * brightness) for channel in color)

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
    global fade_state, playback_state, shutdown_pending
    command_type = command.get("type")

    if command_type == "setMode":
        mode = command.get("mode")

        if mode not in SUPPORTED_MODES:
            raise ValueError(f"Unsupported LED mode: {mode}")

        playback_state = None
        shutdown_pending = False

        if mode == "idle":
            fade_state = {
                "source_colors": snapshot_pixels(),
                "started_at": time.monotonic(),
            }
        else:
            fade_state = None

            if mode != current_mode:
                render_mode(mode)

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
        fade_state = None
        shutdown_pending = False
        fill_pixels(GREEN)

        emit({
            "type": "ack",
            "command": "playbackProgress",
            "durationMs": duration_ms,
            "introDelayMs": intro_delay_ms,
        })
        return "playing", False

    if command_type == "shutdown":
        playback_state = None
        fade_state = {
            "source_colors": snapshot_pixels(),
            "started_at": time.monotonic(),
        }
        shutdown_pending = True
        emit({"type": "ack", "command": "shutdown"})
        return current_mode, False

    if command_type == "ping":
        emit({"type": "pong"})
        return current_mode, False

    raise ValueError(f"Unsupported command: {command_type}")

pixels = Pi5Pixelbuf(NEOPIXEL, num_pixels, auto_write=True, byteorder="BGR")
running = True
fade_state = None
playback_state = None
shutdown_pending = False


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
        elif fade_state is not None:
            fade_progress = (time.monotonic() - fade_state["started_at"]) / FADE_OUT_DURATION_SECONDS

            if fade_progress >= 1.0:
                fade_state = None
                clear_pixels()

                if shutdown_pending:
                    break
            else:
                render_fade_out(fade_state["source_colors"], fade_progress)

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
