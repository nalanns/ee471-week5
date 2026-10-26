// Collects input and asks the backend to compute. No arithmetic happens here.
const display = document.getElementById("display");
const heard = document.getElementById("heard");
const statusLine = document.getElementById("status");
const micButton = document.getElementById("mic");

const state = {
    a: "",
    op: null,
    b: "",
    // true right after a result/error, so the next digit starts a new entry
    fresh: false,
};

function render(text, isError = false) {
    display.textContent = text;
    display.classList.toggle("error", isError);
}

function renderExpression() {
    const parts = [state.a, state.op, state.b].filter(Boolean);
    render(parts.length ? parts.join(" ") : "0");
}

function reset() {
    state.a = "";
    state.op = null;
    state.b = "";
    state.fresh = false;
}

function inputDigit(digit) {
    if (state.fresh) {
        reset();
    }
    const key = state.op ? "b" : "a";
    if (digit === "." && state[key].includes(".")) {
        return;
    }
    state[key] += digit;
    renderExpression();
}

// Send the entered text as a number when it parses, otherwise as-is so the
// API decides how to report it.
function toPayloadValue(text) {
    const n = Number(text);
    return text !== "" && Number.isFinite(n) ? n : text;
}

async function calculate() {
    try {
        const response = await fetch("/api/calculate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                a: toPayloadValue(state.a),
                b: toPayloadValue(state.b),
                op: state.op,
            }),
        });
        const data = await response.json();
        if (!response.ok) {
            return { error: data.error || "Request failed" };
        }
        return { result: data.result };
    } catch (err) {
        return { error: "Could not reach the server" };
    }
}

async function evaluate() {
    if (!state.op) {
        return null;
    }
    const { result, error } = await calculate();
    if (error !== undefined) {
        reset();
        state.fresh = true;
        render(error, true);
        return null;
    }
    state.a = String(result);
    state.op = null;
    state.b = "";
    state.fresh = true;
    render(state.a);
    return result;
}

async function inputOperator(op) {
    if (state.a === "") {
        return;
    }
    // Chained operation like "2 + 3 *": evaluate the pending one first
    if (state.op && state.b !== "") {
        if ((await evaluate()) === null) {
            return;
        }
    }
    state.op = op;
    state.fresh = false;
    renderExpression();
}

function showStatus(message, isError = false) {
    statusLine.textContent = message;
    statusLine.classList.toggle("error", isError);
}

// ---- Speech output ----

// The word each button speaks; "=" speaks "is <result>" instead
const WORDS = {
    "0": "Zero", "1": "One", "2": "Two", "3": "Three", "4": "Four",
    "5": "Five", "6": "Six", "7": "Seven", "8": "Eight", "9": "Nine",
    ".": "Point", "/": "Over", "*": "Times", "+": "Plus", "-": "Minus",
};

// text -> Promise of an object URL, for the fixed words only
const audioCache = new Map();
// Each clip is played after the previous one has finished
let playbackQueue = Promise.resolve();

async function fetchSpeech(text) {
    const response = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
    });
    if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Speech request failed");
    }
    return URL.createObjectURL(await response.blob());
}

function loadWord(word) {
    if (!audioCache.has(word)) {
        const url = fetchSpeech(word);
        // Drop failures so the next press tries again
        url.catch(() => audioCache.delete(word));
        audioCache.set(word, url);
    }
    return audioCache.get(word);
}

function play(url) {
    return new Promise((resolve) => {
        const audio = new Audio(url);
        audio.addEventListener("ended", resolve);
        audio.addEventListener("error", resolve);
        audio.play().catch(resolve);
    });
}

// Start fetching right away, but play in the order speak() was called
function speak(text, cached) {
    const url = cached ? loadWord(text) : fetchSpeech(text);
    url.catch(() => {}); // handled when its turn comes
    playbackQueue = playbackQueue.then(async () => {
        try {
            const src = await url;
            await play(src);
            if (!cached) {
                URL.revokeObjectURL(src);
            }
        } catch (err) {
            showStatus(`Speech unavailable: ${err.message}`, true);
        }
    });
}

// ---- Button presses ----

const buttons = new Map();
document.querySelectorAll(".keys button").forEach((button) => {
    const value = button.hasAttribute("data-equals")
        ? "="
        : button.dataset.digit ?? button.dataset.op;
    buttons.set(value, button);
});

async function handlePress(button) {
    button.classList.add("pressed");
    setTimeout(() => button.classList.remove("pressed"), 150);

    if (button.dataset.digit !== undefined) {
        speak(WORDS[button.dataset.digit], true);
        inputDigit(button.dataset.digit);
    } else if (button.dataset.op !== undefined) {
        speak(WORDS[button.dataset.op], true);
        await inputOperator(button.dataset.op);
    } else if (button.hasAttribute("data-equals")) {
        const result = await evaluate();
        if (result !== null) {
            speak(`is ${result}`, false);
        }
    }
}

// Presses run one at a time so an "=" waiting on the API can't be overtaken
let inputQueue = Promise.resolve();

function enqueue(action) {
    inputQueue = inputQueue.then(action).catch((err) => {
        showStatus(err.message, true);
    });
    return inputQueue;
}

function press(value) {
    return enqueue(() => handlePress(buttons.get(value)));
}

document.querySelector(".keys").addEventListener("click", (event) => {
    const key = event.target.closest("button");
    if (key) {
        enqueue(() => handlePress(key));
    }
});

document.addEventListener("keydown", (event) => {
    if (/^[0-9.+\-*/]$/.test(event.key)) {
        event.preventDefault();
        press(event.key);
    } else if (event.key === "Enter" || event.key === "=") {
        event.preventDefault();
        press("=");
    } else if (event.key === "Escape") {
        enqueue(() => {
            reset();
            renderExpression();
        });
    }
});

// ---- Voice commands ----

// Spoken words, homophones and symbols Azure may return -> button value
const VOICE_KEYS = {
    zero: "0", one: "1", two: "2", three: "3", four: "4",
    five: "5", six: "6", seven: "7", eight: "8", nine: "9",
    point: ".", over: "/", times: "*", plus: "+", minus: "-", is: "=",
    to: "2", too: "2", for: "4", won: "1", ate: "8", "it's": "=",
    x: "*", "×": "*", "*": "*", "/": "/", "÷": "/", "+": "+", "-": "-", "=": "=", ".": ".",
};

// Numbers ("52", "2.5", ".5"), words, operator symbols, a hyphen that isn't
// joining two words, and a "." standing on its own. Anything else (sentence
// punctuation like "five." or "what?") is skipped.
const TOKEN = /\d*\.?\d+|[a-z']+|[+×*/÷=]|(?<![a-z])-|-(?![a-z])|(?<!\S)\.(?!\S)/g;

function textToKeys(text) {
    const normalized = text
        .toLowerCase()
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/\u2212/g, "-")
        .replace(/(\d),(?=\d{3}\b)/g, "$1"); // 1,000 -> 1000
    const keys = [];
    for (const [token] of normalized.matchAll(TOKEN)) {
        if (/\d/.test(token)) {
            keys.push(...token); // one button per digit and point
        } else {
            const key = VOICE_KEYS[token.replace(/^'+|'+$/g, "")];
            if (key) {
                keys.push(key);
            }
        }
    }
    return keys;
}

const TARGET_SAMPLE_RATE = 16000;
let heardTimer = null;

function showHeard(text) {
    clearTimeout(heardTimer);
    heard.textContent = `\u201c${text}\u201d`;
    heardTimer = setTimeout(() => {
        heard.textContent = "";
    }, 4000);
}

function mergeChunks(chunks) {
    const length = chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Float32Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
    }
    return result;
}

// Downsample by averaging the input samples that fall into each output sample
function downsample(samples, fromRate, toRate) {
    if (fromRate === toRate) return samples;
    const ratio = fromRate / toRate;
    const outLength = Math.floor(samples.length / ratio);
    const result = new Float32Array(outLength);
    let inIndex = 0;
    for (let i = 0; i < outLength; i++) {
        const nextIn = Math.min(Math.round((i + 1) * ratio), samples.length);
        let sum = 0;
        let count = 0;
        for (; inIndex < nextIn; inIndex++) {
            sum += samples[inIndex];
            count++;
        }
        result[i] = count ? sum / count : 0;
    }
    return result;
}

// Encode mono float samples as 16-bit PCM WAV
function encodeWav(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);

    const writeString = (offset, str) => {
        for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };

    writeString(0, "RIFF");
    view.setUint32(4, 36 + samples.length * 2, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);             // fmt chunk size
    view.setUint16(20, 1, true);              // PCM
    view.setUint16(22, 1, true);              // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // byte rate
    view.setUint16(32, 2, true);              // block align
    view.setUint16(34, 16, true);             // bits per sample
    writeString(36, "data");
    view.setUint32(40, samples.length * 2, true);

    let offset = 44;
    for (let i = 0; i < samples.length; i++, offset += 2) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }

    return new Blob([view], { type: "audio/wav" });
}

const recorder = {
    audioContext: null,
    mediaStream: null,
    sourceNode: null,
    processorNode: null,
    chunks: [],
};
let micState = "idle"; // idle | recording | busy

function setMicState(state) {
    micState = state;
    micButton.classList.toggle("recording", state === "recording");
    micButton.classList.toggle("busy", state === "busy");
    micButton.setAttribute("aria-pressed", String(state === "recording"));
    micButton.setAttribute(
        "aria-label",
        state === "recording" ? "Stop and send voice command" : "Start voice command"
    );
}

async function startRecording() {
    // Busy while the permission prompt is open, so a second click can't start twice
    setMicState("busy");
    try {
        recorder.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
        showStatus(`Microphone unavailable: ${err.message}`, true);
        setMicState("idle");
        return;
    }

    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    recorder.audioContext = audioContext;
    recorder.sourceNode = audioContext.createMediaStreamSource(recorder.mediaStream);
    recorder.processorNode = audioContext.createScriptProcessor(4096, 1, 1);
    recorder.chunks = [];

    recorder.processorNode.onaudioprocess = (e) => {
        recorder.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };

    recorder.sourceNode.connect(recorder.processorNode);
    recorder.processorNode.connect(audioContext.destination);

    showStatus("Listening\u2026 click the microphone again to send.");
    setMicState("recording");
}

function stopRecording() {
    recorder.processorNode.disconnect();
    recorder.sourceNode.disconnect();
    recorder.mediaStream.getTracks().forEach((t) => t.stop());
    recorder.audioContext.close();

    const samples = mergeChunks(recorder.chunks);
    recorder.chunks = [];
    if (samples.length === 0) {
        return null;
    }
    const downsampled = downsample(samples, recorder.audioContext.sampleRate, TARGET_SAMPLE_RATE);
    return encodeWav(downsampled, TARGET_SAMPLE_RATE);
}

async function recognize(wav) {
    const form = new FormData();
    form.append("audio", wav, "command.wav");
    let response;
    try {
        response = await fetch("/api/voice", { method: "POST", body: form });
    } catch (err) {
        throw new Error("Could not reach the server");
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data.error || "Recognition failed");
    }
    return data.text;
}

async function sendRecording() {
    const wav = stopRecording();
    if (!wav) {
        showStatus("No audio was recorded.", true);
        setMicState("idle");
        return;
    }

    setMicState("busy");
    showStatus("Recognizing\u2026");
    try {
        const text = await recognize(wav);
        showHeard(text);
        const keys = textToKeys(text);
        if (keys.length === 0) {
            showStatus("No calculator words recognized.", true);
            return;
        }
        showStatus("");
        await Promise.all(keys.map(press));
    } catch (err) {
        showStatus(err.message, true);
    } finally {
        setMicState("idle");
    }
}

micButton.addEventListener("click", () => {
    if (micState === "idle") {
        startRecording();
    } else if (micState === "recording") {
        sendRecording();
    }
});
