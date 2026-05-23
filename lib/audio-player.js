import { parseFile } from "music-metadata";
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

const STARTUP_GRACE_PERIOD_MS = 250;
const DEFAULT_PRIMARY_FALLBACK_DEVICE = "plughw:CARD=Audio,DEV=0";
const DEFAULT_FALLBACK_DEVICE = "plughw:CARD=Stereo,DEV=0";
const execFileAsync = promisify(execFile);

const DEFAULT_COMMAND_CANDIDATES = [
  { command: "mpg123", args: ["-q"], buildArgs: ({ device }) => (device ? ["-o", "alsa", "-a", device] : []) },
  { command: "ffplay", args: ["-nodisp", "-autoexit", "-loglevel", "error"] },
  { command: "cvlc", args: ["--play-and-exit", "--quiet"] },
  { command: "omxplayer", args: ["--no-osd"] },
  { command: "aplay", args: ["-q"], buildArgs: ({ device }) => (device ? ["-D", device] : []) },
];

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

function parseAlsaHardwareDevices(output) {
  const devices = [];
  const lines = output.split(/\r?\n/);

  for (const line of lines) {
    const match = line.match(/^card\s+(\d+):\s+[^,]+,\s+device\s+(\d+):/);

    if (!match) {
      continue;
    }

    const [, cardNumber, deviceNumber] = match;
    devices.push(`plughw:${cardNumber},${deviceNumber}`);
  }

  return devices;
}

function parseAlsaPcmDevices(output) {
  return output
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith(" ") && !line.startsWith("\t") && !line.startsWith("#"))
    .map((line) => line.trim());
}

export default class AudioPlayer {
  #baseDir;
  #commandCandidates;
  #currentProcess = null;
  #currentFilePath = null;
  #currentPlaybackToken = 0;
  #device;
  #loop;
  #onPlaybackCycleStart;

  /**
   * @param {{ baseDir?: string, device?: string, loop?: boolean, onPlaybackCycleStart?: (details: { source: string, filePath: string, durationMs: number, loopIndex: number }) => void | Promise<void>, commandCandidates?: Array<{ command: string, args: string[], buildArgs?: (context: { device: string }) => string[] }> }} [options]
   */
  constructor({ baseDir, device = "", loop = false, onPlaybackCycleStart = null, commandCandidates = DEFAULT_COMMAND_CANDIDATES } = {}) {
    this.#baseDir = baseDir;
    this.#device = device;
    this.#loop = loop;
    this.#onPlaybackCycleStart = typeof onPlaybackCycleStart === "function" ? onPlaybackCycleStart : null;
    this.#commandCandidates = commandCandidates;
  }

  get isPlaying() {
    return this.#currentProcess !== null;
  }

  async play(source) {
    const trimmedSource = typeof source === "string" ? source.trim() : "";

    if (!trimmedSource) {
      console.error("[audio] No audio file specified.");
      return false;
    }

    const filePath = this.#resolveSourcePath(trimmedSource);
    const durationMs = await this.#readDurationMs(filePath);

    try {
      await access(filePath, constants.R_OK);
    } catch {
      console.error(`[audio] Audio file not found: ${filePath}`);
      return false;
    }

    this.stop();
    const playbackToken = ++this.#currentPlaybackToken;
    const resolvedDeviceStack = await this.#resolveDeviceStack();
    const playbackDetails = { durationMs, filePath, source: trimmedSource };

    for (const candidate of this.#commandCandidates) {
      const started = await this.#startCandidatePlayback(candidate, filePath, playbackToken, resolvedDeviceStack, playbackDetails, 0);

      if (started) {
        return true;
      }
    }

    console.error("[audio] No supported audio playback command is available. Install one of: ffplay, mpg123, cvlc, omxplayer, aplay.");
    return false;
  }

  stop() {
    this.#currentPlaybackToken += 1;

    if (!this.#currentProcess) {
      return;
    }

    const processToStop = this.#currentProcess;
    this.#clearCurrentProcess(processToStop);

    if (processToStop.exitCode === null && !processToStop.killed) {
      processToStop.kill("SIGTERM");
    }
  }

  #resolveSourcePath(source) {
    if (isAbsolute(source) || !this.#baseDir) {
      return resolve(source);
    }

    return resolve(this.#baseDir, source);
  }

  async #resolveDeviceStack() {
    const requestedDevice = typeof this.#device === "string" ? this.#device.trim() : "";
    const preferredDevices = uniqueValues([requestedDevice, DEFAULT_PRIMARY_FALLBACK_DEVICE, DEFAULT_FALLBACK_DEVICE]);
    const availableDevices = await this.#getAvailableDevices();

    if (availableDevices.length === 0) {
      return preferredDevices;
    }

    const availableSet = new Set(availableDevices);
    const supportedPreferredDevices = preferredDevices.filter((device) => availableSet.has(device));
    const firstAvailableDevice = availableDevices[0] ?? "";

    return uniqueValues([...supportedPreferredDevices, firstAvailableDevice]);
  }

  async #getAvailableDevices() {
    try {
      const [pcmResult, hardwareResult] = await Promise.all([execFileAsync("aplay", ["-L"]), execFileAsync("aplay", ["-l"])]);

      return uniqueValues([...parseAlsaPcmDevices(pcmResult.stdout), ...parseAlsaHardwareDevices(hardwareResult.stdout)]);
    } catch {
      return [];
    }
  }

  async #startCandidatePlayback(candidate, filePath, playbackToken, resolvedDeviceStack, playbackDetails, loopIndex) {
    if (typeof candidate.buildArgs !== "function") {
      return this.#startProcess(candidate, filePath, playbackToken, "", playbackDetails, loopIndex);
    }

    const devicesToTry = resolvedDeviceStack.length > 0 ? resolvedDeviceStack : [""];

    for (const device of devicesToTry) {
      const started = await this.#startProcess(candidate, filePath, playbackToken, device, playbackDetails, loopIndex);

      if (started) {
        return true;
      }
    }

    return false;
  }

  async #startProcess(candidate, filePath, playbackToken, device, playbackDetails, loopIndex) {
    return new Promise((resolvePromise) => {
      let settled = false;
      let startupTimer = null;
      const candidateArgs = typeof candidate.buildArgs === "function" ? candidate.buildArgs({ device }) : [];
      const child = spawn(candidate.command, [...candidate.args, ...candidateArgs, filePath], {
        stdio: ["ignore", "ignore", "pipe"],
      });

      const finish = (started) => {
        if (startupTimer) {
          clearTimeout(startupTimer);
          startupTimer = null;
        }

        if (!settled) {
          settled = true;
          resolvePromise(started);
        }
      };

      const onError = (error) => {
        if (error && "code" in error && error.code === "ENOENT") {
          finish(false);
          return;
        }

        console.error(`[audio] Failed to start ${candidate.command}: ${error instanceof Error ? error.message : String(error)}`);
        finish(false);
      };

      child.once("error", onError);

      child.stderr?.on("data", (chunk) => {
        const message = chunk.toString().trim();

        if (message) {
          console.error(`[audio] ${message}`);
        }
      });

      child.once("spawn", () => {
        this.#currentProcess = child;
        this.#currentFilePath = filePath;
        this.#currentPlaybackToken = playbackToken;

        console.log(`[audio] Playing ${filePath} using ${candidate.command}${device ? ` on ${device}` : ""}.`);
        this.#emitPlaybackCycleStart({
          durationMs: playbackDetails.durationMs,
          filePath,
          loopIndex,
          source: playbackDetails.source,
        });

        startupTimer = setTimeout(() => {
          finish(true);
        }, STARTUP_GRACE_PERIOD_MS);

        child.once("exit", (code) => {
          this.#clearCurrentProcess(child);

          if (this.#loop && code === 0 && this.#currentPlaybackToken === playbackToken) {
            void this.#startCandidatePlayback(candidate, filePath, playbackToken, [device], playbackDetails, loopIndex + 1);
          }
        });
      });

      child.once("close", (code) => {
        if (!settled) {
          finish(code === 0);
        }

        if (code !== 0 && code !== null && this.#currentFilePath === filePath) {
          console.error(`[audio] ${candidate.command} exited with code ${code} while playing ${filePath}.`);
        }
      });
    });
  }

  #clearCurrentProcess(child) {
    if (this.#currentProcess === child) {
      this.#currentProcess = null;
      this.#currentFilePath = null;
    }
  }

  async #readDurationMs(filePath) {
    try {
      const metadata = await parseFile(filePath, { duration: true });
      const durationSeconds = metadata.format.duration;

      if (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        return 0;
      }

      return Math.round(durationSeconds * 1000);
    } catch (error) {
      console.warn(`[audio] Unable to read duration for ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    }
  }

  #emitPlaybackCycleStart(details) {
    if (!this.#onPlaybackCycleStart) {
      return;
    }

    Promise.resolve(this.#onPlaybackCycleStart(details)).catch((error) => {
      console.error(`[audio] Playback hook failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}
