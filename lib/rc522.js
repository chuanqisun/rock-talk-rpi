/* @ts-ignore */
import SPI from "spi-device";

const SPI_BUS = 0;
const SPI_DEVICE = 0;
const SPEED_HZ = 1_000_000;
const CRC_A_BYTE_LENGTH = 2;

// MFRC522 registers
const CommandReg = 0x01;
const ComIEnReg = 0x02;
const ComIrqReg = 0x04;
const DivIrqReg = 0x05;
const ErrorReg = 0x06;
const FIFODataReg = 0x09;
const FIFOLevelReg = 0x0a;
const ControlReg = 0x0c;
const BitFramingReg = 0x0d;
const ModeReg = 0x11;
const TxModeReg = 0x12;
const RxModeReg = 0x13;
const TxControlReg = 0x14;
const TxASKReg = 0x15;
const CRCResultRegH = 0x21;
const CRCResultRegL = 0x22;
const TModeReg = 0x2a;
const TPrescalerReg = 0x2b;
const TReloadRegH = 0x2c;
const TReloadRegL = 0x2d;
const VersionReg = 0x37;

// MFRC522 commands
const PCD_IDLE = 0x00;
const PCD_TRANSCEIVE = 0x0c;
const PCD_CALCCRC = 0x03;
const PCD_SOFTRESET = 0x0f;

// PICC commands
const PICC_REQA = 0x26;
const PICC_ANTICOLL_CL1 = 0x93;
const PICC_ANTICOLL_CL2 = 0x95;
const PICC_SELECT_CL1 = 0x93;
const PICC_SELECT_CL2 = 0x95;
const PICC_READ = 0x30;
const PICC_FAST_READ = 0x3a;
const PICC_WRITE = 0xa2;
const PICC_HALT = 0x50;

// NTAG213 layout
const NTAG213_TEXT_PAGE_START = 0x04;
const NTAG213_TEXT_PAGE_COUNT = 8;
const NTAG213_TEXT_PAGE_END = NTAG213_TEXT_PAGE_START + NTAG213_TEXT_PAGE_COUNT - 1;
const NTAG213_TEXT_BYTES = NTAG213_TEXT_PAGE_COUNT * 4;
const NTAG213_PAGE_SIZE = 4;
const NTAG_READ_RESPONSE_LENGTH = 16;
const NTAG_ACK = 0x0a;

const DEFAULT_POLL_INTERVAL_MS = 80;
const DEFAULT_RF_TIMEOUT_MS = 50;

const DEFAULT_OPTIONS = {
  bus: SPI_BUS,
  device: SPI_DEVICE,
  speedHz: SPEED_HZ,
  mode: SPI.MODE0,
  block: NTAG213_TEXT_PAGE_START,
  blocks: Array.from({ length: NTAG213_TEXT_PAGE_COUNT }, (_, index) => NTAG213_TEXT_PAGE_START + index),
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function bytesToHex(bytes) {
  return bytes.map((value) => value.toString(16).padStart(2, "0").toUpperCase()).join(":");
}

function calculateBcc(bytes) {
  return bytes.reduce((left, right) => left ^ right, 0);
}

function areSamePage(left, right) {
  return left.length === 4 && right.length === 4 && left[0] === right[0] && left[1] === right[1] && left[2] === right[2] && left[3] === right[3];
}

function trimTrailingNullBytes(buffer) {
  let end = buffer.length;

  while (end > 0 && buffer[end - 1] === 0x00) {
    end -= 1;
  }

  return buffer.subarray(0, end);
}

function decodeText(bytes) {
  return Buffer.from(bytes)
    .toString("utf8")
    .replace(/\0+$/u, "")
    .replace(/[^\x20-\x7E\n\r\t]/g, " ")
    .trim();
}

function normalizeBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new Error("NTAG213 pages must be a non-empty array of page numbers");
  }

  const normalized = blocks.map((block) => {
    if (!Number.isInteger(block)) {
      throw new Error("NTAG213 page numbers must be integers");
    }

    if (block < NTAG213_TEXT_PAGE_START || block > NTAG213_TEXT_PAGE_END) {
      throw new Error(`NTAG213 page ${block} is outside the supported text range ${NTAG213_TEXT_PAGE_START}..${NTAG213_TEXT_PAGE_END}`);
    }

    return block;
  });

  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index] !== normalized[index - 1] + 1) {
      throw new Error("NTAG213 text reads and writes require contiguous ascending pages");
    }
  }

  return normalized;
}

function encodeTextPayload(text, blocks) {
  if (typeof text !== "string") {
    throw new Error("NTAG213 text writes require a UTF-8 string payload");
  }

  const textBytes = Buffer.from(text, "utf8");
  const capacity = blocks.length * NTAG213_PAGE_SIZE;

  if (textBytes.length > capacity) {
    throw new Error(`Text payload is ${textBytes.length} bytes, exceeding ${capacity} bytes across pages ${blocks.join(", ")}`);
  }

  const payload = Buffer.alloc(capacity, 0x00);
  textBytes.copy(payload);
  return payload;
}

function chunkIntoPages(buffer) {
  const pages = [];

  for (let index = 0; index < buffer.length; index += NTAG213_PAGE_SIZE) {
    pages.push([...buffer.subarray(index, index + NTAG213_PAGE_SIZE)]);
  }

  return pages;
}

function createAbortError() {
  return new Error("RFID operation cancelled");
}

export default class Rc522 {
  #options;
  #spi = null;
  #initialized = false;
  #closed = false;

  constructor(options = {}) {
    const blocks = normalizeBlocks(options.blocks ?? DEFAULT_OPTIONS.blocks);

    this.#options = {
      ...DEFAULT_OPTIONS,
      ...options,
      blocks,
      block: options.block ?? blocks[0],
    };

    if (!blocks.includes(this.#options.block)) {
      throw new Error(`Default block ${this.#options.block} must be included in the configured text page range`);
    }
  }

  async readTextAsync(options = {}) {
    const blocks = this.#resolveBlocks(options);
    const settings = this.#resolveRuntimeOptions(options);

    await this.#ensureInitialized();
    const card = await this.#waitForTag(settings);

    try {
      const pageData = this.#fastReadPagesRaw(blocks[0], blocks[blocks.length - 1]);
      const raw = Buffer.from(pageData);
      const trimmed = Buffer.from(trimTrailingNullBytes(raw));

      return {
        uid: bytesToHex(card.uid),
        blocks,
        size: card.sak,
        data: trimmed,
        text: decodeText(raw),
      };
    } finally {
      this.#haltA();
    }
  }

  async readUidAsync(options = {}) {
    const settings = this.#resolveRuntimeOptions(options);

    await this.#ensureInitialized();
    const card = await this.#waitForTag(settings);

    try {
      return {
        uid: bytesToHex(card.uid),
        size: card.sak,
      };
    } finally {
      this.#haltA();
    }
  }

  async writeTextAsync(text, options = {}) {
    const blocks = this.#resolveBlocks(options);
    const settings = this.#resolveRuntimeOptions(options);
    const payload = encodeTextPayload(text, blocks);
    const pages = chunkIntoPages(payload);

    await this.#ensureInitialized();
    const waitStartedAt = Date.now();
    let lastCard = await this.#waitForTag(settings, waitStartedAt);

    for (let index = 0; index < pages.length; index += 1) {
      const page = blocks[index];
      lastCard = await this.#writePageCloneFriendly(page, pages[index], settings);
    }

    this.#throwIfCancelled(settings);

    this.#rfFieldReset(50);
    lastCard = this.#selectTag();
    await delay(20);

    try {
      const verify = [];

      for (const page of blocks) {
        this.#throwIfCancelled(settings);
        verify.push(...this.#readPageRaw(page));
      }

      const verifiedBuffer = Buffer.from(verify);

      if (!verifiedBuffer.equals(payload)) {
        throw new Error(`Write verification failed for pages ${blocks.join(", ")}`);
      }

      return {
        uid: bytesToHex(lastCard.uid),
        blocks,
        size: lastCard.sak,
        data: verifiedBuffer,
        text,
      };
    } finally {
      this.#haltA();
    }
  }

  close() {
    this.#closed = true;

    if (!this.#spi) {
      return;
    }

    try {
      this.#antennaOff();
    } catch (_) {}

    this.#spi.closeSync();
    this.#spi = null;
    this.#initialized = false;
  }

  #resolveBlocks(options) {
    return normalizeBlocks(options.blocks ?? this.#options.blocks);
  }

  #resolveRuntimeOptions(options) {
    return {
      pollIntervalMs: options.pollIntervalMs ?? this.#options.pollIntervalMs,
      timeoutMs: options.timeoutMs ?? 0,
      signal: options.signal ?? null,
    };
  }

  #throwIfCancelled(settings) {
    if (this.#closed) {
      throw createAbortError();
    }

    if (settings.signal?.aborted) {
      throw createAbortError();
    }
  }

  async #waitForTag(settings, startedAt = Date.now()) {
    while (true) {
      this.#throwIfCancelled(settings);

      if (settings.timeoutMs > 0 && Date.now() - startedAt >= settings.timeoutMs) {
        throw new Error("Timed out waiting for RFID tag");
      }

      try {
        this.#rfFieldReset(50);
        return this.#selectTag();
      } catch (_) {
        this.#rfFieldReset(80);
        await delay(Math.max(1, settings.pollIntervalMs));
      }
    }
  }

  async #writePageCloneFriendly(page, bytes, settings) {
    let attempt = 0;

    while (true) {
      attempt += 1;
      this.#throwIfCancelled(settings);

      try {
        this.#rfFieldReset(attempt === 1 ? 30 : 100);

        const card = this.#selectTag();

        await delay(10);
        this.#readPageRaw(page);
        await delay(15);
        this.#writePageRaw(page, bytes);
        await delay(15);

        const verify = this.#readPageRaw(page);
        if (!areSamePage(verify, bytes)) {
          throw new Error(`verify mismatch on page 0x${page.toString(16)}: got ${bytesToHex(verify)}, expected ${bytesToHex(bytes)}`);
        }

        console.log(`[writer] Wrote page 0x${page.toString(16)} in ${attempt} attempt(s)`);

        return card;
      } catch (error) {
        try {
          this.#haltA();
        } catch (_) {}

        this.#rfFieldReset(100);
        await delay(120);

        this.#throwIfCancelled(settings);

        if (error instanceof Error && error.message === "RFID operation cancelled") {
          throw error;
        }
      }
    }
  }

  async #ensureInitialized() {
    if (this.#initialized) {
      return;
    }

    this.#closed = false;
    this.#spi = SPI.openSync(this.#options.bus, this.#options.device, {
      mode: this.#options.mode,
      maxSpeedHz: this.#options.speedHz,
    });

    this.#reset();
    sleepMs(50);

    this.#writeReg(TModeReg, 0x8d);
    this.#writeReg(TPrescalerReg, 0x3e);
    this.#writeReg(TReloadRegL, 0xe8);
    this.#writeReg(TReloadRegH, 0x03);

    this.#writeReg(TxASKReg, 0x40);
    this.#writeReg(ModeReg, 0x3d);
    this.#writeReg(TxModeReg, 0x00);
    this.#writeReg(RxModeReg, 0x00);
    this.#antennaOn();

    const version = this.#readReg(VersionReg);
    if (version === 0x00 || version === 0xff) {
      this.close();
      throw new Error("RC522 did not respond correctly over SPI");
    }

    this.#initialized = true;
  }

  #writeReg(reg, value) {
    const tx = Buffer.from([(reg << 1) & 0x7e, value]);
    const rx = Buffer.alloc(2);

    this.#spi.transferSync([
      {
        sendBuffer: tx,
        receiveBuffer: rx,
        byteLength: 2,
        speedHz: this.#options.speedHz,
      },
    ]);
  }

  #readReg(reg) {
    const tx = Buffer.from([((reg << 1) & 0x7e) | 0x80, 0x00]);
    const rx = Buffer.alloc(2);

    this.#spi.transferSync([
      {
        sendBuffer: tx,
        receiveBuffer: rx,
        byteLength: 2,
        speedHz: this.#options.speedHz,
      },
    ]);

    return rx[1];
  }

  #setBitMask(reg, mask) {
    this.#writeReg(reg, this.#readReg(reg) | mask);
  }

  #clearBitMask(reg, mask) {
    this.#writeReg(reg, this.#readReg(reg) & ~mask);
  }

  #reset() {
    this.#writeReg(CommandReg, PCD_SOFTRESET);
  }

  #antennaOn() {
    const value = this.#readReg(TxControlReg);
    if ((value & 0x03) !== 0x03) {
      this.#setBitMask(TxControlReg, 0x03);
    }
  }

  #antennaOff() {
    this.#clearBitMask(TxControlReg, 0x03);
  }

  #rfFieldReset(ms = 80) {
    try {
      this.#antennaOff();
    } catch (_) {}

    sleepMs(ms);

    try {
      this.#antennaOn();
    } catch (_) {}

    sleepMs(ms);
  }

  #transceive(data, validBits = 0, timeoutMs = DEFAULT_RF_TIMEOUT_MS) {
    const irqEn = 0x77;
    const waitIrq = 0x30;

    this.#writeReg(ComIEnReg, irqEn | 0x80);
    this.#writeReg(CommandReg, PCD_IDLE);
    this.#clearBitMask(ComIrqReg, 0x80);
    this.#setBitMask(FIFOLevelReg, 0x80);

    for (const value of data) {
      this.#writeReg(FIFODataReg, value);
    }

    this.#writeReg(BitFramingReg, validBits & 0x07);
    this.#writeReg(CommandReg, PCD_TRANSCEIVE);
    this.#setBitMask(BitFramingReg, 0x80);

    const deadline = Date.now() + timeoutMs;
    let timedOut = false;

    while (true) {
      const irq = this.#readReg(ComIrqReg);

      if (irq & waitIrq) {
        break;
      }

      if (irq & 0x01 || Date.now() >= deadline) {
        timedOut = true;
        break;
      }
    }

    this.#clearBitMask(BitFramingReg, 0x80);

    if (timedOut) {
      this.#writeReg(CommandReg, PCD_IDLE);
      throw new Error("Timeout waiting for tag");
    }

    let length = this.#readReg(FIFOLevelReg);
    const lastBits = this.#readReg(ControlReg) & 0x07;
    const bits = lastBits ? (length - 1) * 8 + lastBits : length * 8;
    const output = [];

    if (length === 0) {
      length = 1;
    }

    if (length > 64) {
      length = 64;
    }

    for (let index = 0; index < length; index += 1) {
      output.push(this.#readReg(FIFODataReg));
    }

    const error = this.#readReg(ErrorReg);
    const isFourBitResponse = bits === 4;
    const fatalMask = isFourBitResponse ? 0x1a : 0x1b;

    if (error & fatalMask) {
      throw new Error(`MFRC522 error: 0x${error.toString(16)}`);
    }

    return { data: output, bits };
  }

  #calculateCRC(data) {
    this.#writeReg(CommandReg, PCD_IDLE);
    this.#clearBitMask(DivIrqReg, 0x04);
    this.#setBitMask(FIFOLevelReg, 0x80);

    for (const value of data) {
      this.#writeReg(FIFODataReg, value);
    }

    this.#writeReg(CommandReg, PCD_CALCCRC);

    const deadline = Date.now() + 20;
    while (Date.now() < deadline) {
      if (this.#readReg(DivIrqReg) & 0x04) {
        this.#writeReg(CommandReg, PCD_IDLE);
        return [this.#readReg(CRCResultRegL), this.#readReg(CRCResultRegH)];
      }
    }

    this.#writeReg(CommandReg, PCD_IDLE);
    throw new Error("Timed out calculating CRC");
  }

  #requestA() {
    this.#writeReg(BitFramingReg, 0x07);
    return this.#transceive([PICC_REQA], 0x07);
  }

  #anticollision(cascadeCmd) {
    this.#writeReg(BitFramingReg, 0x00);
    const response = this.#transceive([cascadeCmd, 0x20], 0x00);

    if (response.data.length < 5) {
      throw new Error(`Anticollision failed, got ${response.data.length} bytes`);
    }

    const block = response.data.slice(0, 5);
    const bcc = calculateBcc(block.slice(0, 4));

    if (bcc !== block[4]) {
      throw new Error("UID BCC check failed");
    }

    return block;
  }

  #selectCascade(cascadeCmd, fiveBytes) {
    const frame = [cascadeCmd, 0x70, ...fiveBytes];
    const crc = this.#calculateCRC(frame);
    const response = this.#transceive([...frame, crc[0], crc[1]], 0x00, 40);

    if (response.bits !== 0x18 || response.data.length < 1) {
      throw new Error(`SELECT failed on cascade 0x${cascadeCmd.toString(16)} (${response.bits} bits)`);
    }

    return response.data[0];
  }

  #haltA() {
    const frame = [PICC_HALT, 0x00];
    const crc = this.#calculateCRC(frame);

    try {
      this.#transceive([...frame, crc[0], crc[1]], 0x00, 10);
    } catch (_) {}
  }

  #selectTag() {
    const atqa = this.#requestA().data;

    const cl1 = this.#anticollision(PICC_ANTICOLL_CL1);
    const sak1 = this.#selectCascade(PICC_SELECT_CL1, cl1);

    if (sak1 & 0x04) {
      if (cl1[0] !== 0x88) {
        throw new Error("Cascade bit set in SAK1 but CT marker missing in CL1 response");
      }

      const uid0to2 = cl1.slice(1, 4);
      const cl2 = this.#anticollision(PICC_ANTICOLL_CL2);
      const sak2 = this.#selectCascade(PICC_SELECT_CL2, cl2);
      const uid3to6 = cl2.slice(0, 4);

      return {
        atqa,
        uid: uid0to2.concat(uid3to6),
        sak: sak2,
      };
    }

    return {
      atqa,
      uid: cl1.slice(0, 4),
      sak: sak1,
    };
  }

  #readPageRaw(page) {
    const frame = [PICC_READ, page];
    const crc = this.#calculateCRC(frame);
    const response = this.#transceive([...frame, crc[0], crc[1]], 0x00, 60);
    const expectedLengths = new Set([NTAG_READ_RESPONSE_LENGTH, NTAG_READ_RESPONSE_LENGTH + CRC_A_BYTE_LENGTH]);

    if (!expectedLengths.has(response.data.length)) {
      throw new Error(`READ ${page} returned ${response.data.length} bytes`);
    }

    return response.data.slice(0, 4);
  }

  #fastReadPagesRaw(startPage, endPage) {
    if (endPage < startPage) {
      throw new Error(`FAST_READ range is invalid: ${startPage}..${endPage}`);
    }

    const expectedLength = (endPage - startPage + 1) * NTAG213_PAGE_SIZE;
    const frame = [PICC_FAST_READ, startPage, endPage];
    const crc = this.#calculateCRC(frame);
    const response = this.#transceive([...frame, crc[0], crc[1]], 0x00, 30);
    const expectedLengths = new Set([expectedLength, expectedLength + CRC_A_BYTE_LENGTH]);

    if (!expectedLengths.has(response.data.length)) {
      throw new Error(`FAST_READ ${startPage}..${endPage} returned ${response.data.length} bytes`);
    }

    return response.data.slice(0, expectedLength);
  }

  #writePageRaw(page, fourBytes) {
    if (fourBytes.length !== 4) {
      throw new Error(`writePage expects 4 bytes, got ${fourBytes.length}`);
    }

    const frame = [PICC_WRITE, page, ...fourBytes];
    const crc = this.#calculateCRC(frame);
    const response = this.#transceive([...frame, crc[0], crc[1]], 0x00, 150);

    if (response.bits !== 4 || response.data.length < 1) {
      throw new Error(`WRITE page ${page} returned unexpected frame (${response.bits} bits, ${response.data.length} bytes)`);
    }

    const ack = response.data[0] & 0x0f;
    if (ack !== NTAG_ACK) {
      throw new Error(`WRITE page ${page} NAK 0x${ack.toString(16)}`);
    }
  }
}
