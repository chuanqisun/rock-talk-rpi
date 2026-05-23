import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCRIPT_PATH = resolve(__dirname, "../led/led-handler.py");
const DEFAULT_VENV_PATH = resolve(__dirname, "../env");
const DEFAULT_READY_TIMEOUT_MS = 3000;

function resolvePythonRuntime(explicitPythonCommand) {
  if (explicitPythonCommand) {
    return {
      pythonCommand: explicitPythonCommand,
      env: process.env,
    };
  }

  const virtualEnvPath = process.env.VIRTUAL_ENV || (existsSync(DEFAULT_VENV_PATH) ? DEFAULT_VENV_PATH : null);

  if (!virtualEnvPath) {
    return {
      pythonCommand: "python3",
      env: process.env,
    };
  }

  const virtualEnvBinPath = resolve(virtualEnvPath, "bin");
  const virtualEnvPython3 = resolve(virtualEnvBinPath, "python3");
  const virtualEnvPython = resolve(virtualEnvBinPath, "python");
  const pythonCommand = existsSync(virtualEnvPython3)
    ? virtualEnvPython3
    : existsSync(virtualEnvPython)
      ? virtualEnvPython
      : "python3";

  return {
    pythonCommand,
    env: {
      ...process.env,
      VIRTUAL_ENV: virtualEnvPath,
      PATH: `${virtualEnvBinPath}:${process.env.PATH ?? ""}`,
    },
  };
}

export default class LedController {
  #child = null;
  #currentMode = null;
  #disabled = false;
  #ready = false;
  #readyPromise = null;
  #pythonCommand;
  #scriptPath;
  #spawnEnv;

  /**
   * @param {{ pythonCommand?: string, scriptPath?: string }} [options]
   */
  constructor({ pythonCommand = process.env.ROCKTALK_LED_PYTHON, scriptPath = DEFAULT_SCRIPT_PATH } = {}) {
    const runtime = resolvePythonRuntime(pythonCommand);

    this.#pythonCommand = runtime.pythonCommand;
    this.#scriptPath = scriptPath;
    this.#spawnEnv = runtime.env;
  }

  async setMode(mode) {
    if (this.#disabled || this.#currentMode === mode) {
      return;
    }

    const started = await this.#start();

    if (!started || !this.#child?.stdin.writable) {
      return;
    }

    this.#send({ type: "setMode", mode });
    this.#currentMode = mode;
  }

  async close() {
    if (!this.#child) {
      return;
    }

    try {
      if (this.#child.stdin.writable) {
        this.#send({ type: "shutdown" });
        this.#child.stdin.end();
      }
    } catch {
      // Ignore shutdown errors during process teardown.
    }

    this.#currentMode = null;
    this.#ready = false;
    this.#readyPromise = null;
  }

  async #start() {
    if (this.#disabled) {
      return false;
    }

    if (this.#ready) {
      return true;
    }

    if (this.#readyPromise) {
      return this.#readyPromise;
    }

    this.#readyPromise = new Promise((resolvePromise) => {
      let settled = false;
      let timeoutId = null;
      const child = spawn(this.#pythonCommand, ["-u", this.#scriptPath], {
        env: { ...this.#spawnEnv, PYTHONUNBUFFERED: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      });

      const finish = (started) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }

        if (!settled) {
          settled = true;
          resolvePromise(started);
        }
      };

      const stdoutReader = createInterface({ input: child.stdout });
      stdoutReader.on("line", (line) => {
        let message;

        try {
          message = JSON.parse(line);
        } catch {
          console.log(`[led] ${line}`);
          return;
        }

        if (message.type === "ready") {
          this.#child = child;
          this.#ready = true;
          console.log(`[led] ready (${this.#pythonCommand} ${this.#scriptPath}).`);
          finish(true);
          return;
        }

        if (message.type === "ack") {
          console.log(`[led] mode -> ${message.mode}.`);
          return;
        }

        if (message.type === "error") {
          console.error(`[led] ${message.message}`);
        }
      });

      child.stderr.on("data", (chunk) => {
        const message = chunk.toString().trim();

        if (message) {
          console.error(`[led] ${message}`);
        }
      });

      child.once("error", (error) => {
        this.#disable(`failed to start LED worker: ${error instanceof Error ? error.message : String(error)}`);
        finish(false);
      });

      child.once("exit", (code, signal) => {
        this.#child = null;
        this.#ready = false;
        this.#readyPromise = null;
        this.#currentMode = null;

        if (!settled) {
          this.#disable(`LED worker exited before it became ready (${signal ?? code ?? "unknown"}).`);
          finish(false);
          return;
        }

        if (!this.#disabled) {
          console.log(`[led] worker exited (${signal ?? code ?? "unknown"}).`);
        }
      });

      timeoutId = setTimeout(() => {
        this.#disable(`LED worker did not signal readiness within ${DEFAULT_READY_TIMEOUT_MS}ms.`);

        if (child.exitCode === null) {
          child.kill("SIGTERM");
        }

        finish(false);
      }, DEFAULT_READY_TIMEOUT_MS);
    });

    return this.#readyPromise;
  }

  #disable(reason) {
    this.#disabled = true;
    this.#ready = false;
    this.#readyPromise = null;
    this.#currentMode = null;
    console.error(`[led] ${reason}`);
  }

  #send(message) {
    this.#child?.stdin.write(`${JSON.stringify(message)}\n`);
  }
}