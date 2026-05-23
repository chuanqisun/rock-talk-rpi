import { cancel, intro, isCancel, outro, select } from "@clack/prompts";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BehaviorSubject, concatMap, debounceTime, distinctUntilChanged, filter, from, map, merge, of, share, tap, withLatestFrom } from "rxjs";
import AudioPlayer from "./lib/audio-player.js";
import LedController from "./lib/led-controller.js";
import Rc522 from "./lib/rc522.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
const READER_POLL_INTERVAL_MS = 80;
const reader = new Rc522({ pollIntervalMs: READER_POLL_INTERVAL_MS });

function createStartEvent(uid, track) {
  return /** @type {{ type: "start", uid: string, track: string }} */ ({ type: "start", uid, track });
}

function createStopEvent() {
  return /** @type {{ type: "stop" }} */ ({ type: "stop" });
}

async function loadTrackMap() {
  const mapPath = resolve(__dirname, "map.json");
  const raw = await readFile(mapPath, "utf8");
  const entries = JSON.parse(raw);

  if (!Array.isArray(entries)) {
    throw new Error("map.json must contain an array of { id, track } entries.");
  }

  const exactMatches = new Map();
  let fallbackTrack = "";

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      throw new Error("Each map.json entry must be an object with id and track fields.");
    }

    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const track = typeof entry.track === "string" ? entry.track.trim() : "";

    if (!id || !track) {
      throw new Error("Each map.json entry must provide non-empty id and track values.");
    }

    if (id === "*") {
      fallbackTrack = track;
      continue;
    }

    exactMatches.set(id, track);
  }

  if (!fallbackTrack) {
    throw new Error("map.json must include a '*' fallback track.");
  }

  return {
    resolveTrack(uid) {
      return exactMatches.get(uid) ?? fallbackTrack;
    },
  };
}

function parseAlsaDevices(output) {
  const devices = [];
  const lines = output.split(/\r?\n/);

  for (const line of lines) {
    const match = line.match(/^card\s+(\d+):\s+([^\[]+)\[([^\]]+)\],\s+device\s+(\d+):\s+([^\[]+)\[([^\]]+)\]$/);

    if (!match) {
      continue;
    }

    const [, cardNumber, cardId, cardName, deviceNumber, deviceId, deviceName] = match;

    devices.push({
      cardId: cardId.trim(),
      deviceId: deviceId.trim(),
      value: `plughw:${cardNumber},${deviceNumber}`,
      label: `${cardName.trim()} / ${deviceName.trim()}`,
      hint: `card ${cardNumber} (${cardId.trim()}), device ${deviceNumber} (${deviceId.trim()})`,
    });
  }

  return devices;
}

async function getAudioDevices() {
  const { stdout } = await execFileAsync("aplay", ["-l"]);
  const devices = parseAlsaDevices(stdout);

  if (devices.length === 0) {
    throw new Error("No ALSA playback devices were reported by aplay -l.");
  }

  return devices;
}

function parseCliAudioDevice(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg !== "-a") {
      continue;
    }

    const value = argv[index + 1];

    if (!value || value.startsWith("-")) {
      throw new Error("Missing value for -a. Expected an ALSA device such as plughw:2,0.");
    }

    if (value.toLowerCase() === "auto") {
      return "";
    }

    return value;
  }

  return null;
}

async function promptForAudioDevice() {
  const devices = await getAudioDevices();
  const options = [
    {
      value: "",
      label: "Auto",
      hint: "Use the audio player's fallback device stack",
    },
    ...devices,
  ];

  const selected = await select({
    message: "Choose an audio device.",
    options,
  });

  if (isCancel(selected)) {
    return null;
  }

  return selected;
}

async function* infiniteRead() {
  while (true) {
    try {
      yield reader.readUidAsync();
    } catch (error) {
      // The chip might be approaching or leaving the reader's field. It's not a fatal error
    }

    await delay(READER_POLL_INTERVAL_MS);
  }
}

const state$ = new BehaviorSubject({ uid: "", state: "idle" });

const rawInput$ = from(infiniteRead()).pipe(share());

const idChange$ = from(rawInput$).pipe(
  map((result) => result.uid),
  distinctUntilChanged(),
  map((uid) => ({ type: "idChange", uid })),
  tap((event) => console.log(`[id changed] ${event.uid}.`)),
  share()
);

const detach$ = from(rawInput$).pipe(
  debounceTime(100),
  withLatestFrom(idChange$),
  map(([_, identity]) => ({ type: "detach", uid: identity.uid })),
  tap((event) => console.log(`[detached] ${event.uid}.`))
);

const hopSwap$ = idChange$.pipe(
  withLatestFrom(state$),
  filter(([idChange, state]) => state.state === "playing" && state.uid !== idChange.uid),
  tap(() => state$.next({ uid: "", state: "idle" })),
  tap(([_, state]) => console.log(`[stopped] ${state.uid}.`)),
  map(() => createStopEvent())
);

const stopPlay$ = detach$.pipe(
  withLatestFrom(state$),
  filter(([detach, state]) => state.state === "playing" && detach.uid === state.uid),
  tap(() => state$.next({ uid: "", state: "idle" })),
  tap(([_, state]) => console.log(`[stopped] ${state.uid}.`)),
  map(() => createStopEvent())
);

/**
 * @param {{ type: "start", uid: string, track: string } | { type: "stop" }} event
 */
async function handlePlaybackEvent(audioPlayer, ledController, event) {
  console.log(`[event] ${JSON.stringify(event)}`);

  if (event.type === "start") {
    const ledModePromise = ledController.setMode("playing");
    const didStart = await audioPlayer.play(event.track);

    if (didStart) {
      await ledModePromise;
      return;
    }

    state$.next({ uid: "", state: "idle" });
    await ledController.setMode("idle");
    return;
  }

  audioPlayer.stop();
  await ledController.setMode("idle");
}

async function main() {
  const trackMap = await loadTrackMap();
  const requestedDevice = parseCliAudioDevice(process.argv.slice(2));
  const useInteractivePrompt = requestedDevice === null;

  if (useInteractivePrompt) {
    intro("Rock Talk player");
  }

  const selectedDevice = requestedDevice ?? (await promptForAudioDevice());

  if (selectedDevice === null) {
    reader.close();

    if (useInteractivePrompt) {
      outro("Rock Talk player cancelled");
    }

    return;
  }

  const audioPlayer = new AudioPlayer({
    baseDir: resolve(__dirname, "tracks"),
    device: selectedDevice,
    loop: true,
  });
  const ledController = new LedController();

  void ledController.warmup();

  process.on("SIGINT", () => {
    console.log("\nExiting...");
    audioPlayer.stop();
    void ledController.close();
    reader.close();
    process.exit(0);
  });

  const read$ = from(rawInput$).pipe(concatMap((result) => of({ type: "read", ...result })));

  const startPlay$ = read$.pipe(
    withLatestFrom(state$),
    filter(([_, state]) => state.state === "idle"),
    tap(([event, _]) => state$.next({ uid: event.uid, state: "playing" })),
    tap(([event, _]) => console.log(`[playing] ${event.uid} -> ${trackMap.resolveTrack(event.uid)}.`)),
    map(([event]) => createStartEvent(event.uid, trackMap.resolveTrack(event.uid)))
  );

  merge(startPlay$, hopSwap$, stopPlay$)
    .pipe(concatMap((event) => from(handlePlaybackEvent(audioPlayer, ledController, event))))
    .subscribe();

  if (useInteractivePrompt) {
    outro(selectedDevice ? `Using audio device ${selectedDevice} with looping` : "Using automatic audio device selection with looping");
    return;
  }

  console.log(selectedDevice ? `Using audio device ${selectedDevice} with looping` : "Using automatic audio device selection with looping");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  const useInteractivePrompt = parseCliAudioDevice(process.argv.slice(2)) === null;

  if (useInteractivePrompt) {
    cancel(message);
  } else {
    console.error(message);
  }

  reader.close();
  process.exitCode = 1;
});
