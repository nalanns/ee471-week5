// ---------- Shared helpers ----------

function showStatus(el, message, type) {
    el.textContent = message;
    el.className = `status ${type}`;
    el.hidden = false;
}

function hideStatus(el) {
    el.hidden = true;
}

// ---------- Tabs ----------

const tabButtons = document.querySelectorAll(".tab-btn");
const tabPanels = document.querySelectorAll(".tab-panel");

tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
        tabButtons.forEach((b) => {
            const active = b === btn;
            b.classList.toggle("active", active);
            b.setAttribute("aria-selected", active);
        });
        tabPanels.forEach((panel) => {
            panel.hidden = panel.id !== btn.dataset.tab;
        });
    });
});

// ---------- Text to Speech ----------

const textInput = document.getElementById("text-input");
const synthesizeBtn = document.getElementById("synthesize-btn");
const ttsClearBtn = document.getElementById("tts-clear-btn");
const ttsStatusEl = document.getElementById("tts-status");
const audioPanel = document.getElementById("audio-panel");
const audioPlayer = document.getElementById("audio-player");
const downloadBtn = document.getElementById("download-btn");

let audioUrl = null;

function clearAudio() {
    if (audioUrl) {
        URL.revokeObjectURL(audioUrl);
        audioUrl = null;
    }
    audioPlayer.removeAttribute("src");
    audioPlayer.load();
    downloadBtn.removeAttribute("href");
    audioPanel.hidden = true;
}

synthesizeBtn.addEventListener("click", async () => {
    const text = textInput.value.trim();
    if (!text) {
        showStatus(ttsStatusEl, "Please enter some text.", "error");
        return;
    }

    synthesizeBtn.disabled = true;
    synthesizeBtn.textContent = "Synthesizing...";

    try {
        const response = await fetch("/api/tts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text }),
        });

        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.error || `Request failed (${response.status})`);
        }

        const blob = await response.blob();
        clearAudio();
        audioUrl = URL.createObjectURL(blob);
        audioPlayer.src = audioUrl;
        downloadBtn.href = audioUrl;
        audioPanel.hidden = false;
        showStatus(ttsStatusEl, "Speech synthesized successfully!", "success");
    } catch (err) {
        showStatus(ttsStatusEl, err.message, "error");
    } finally {
        synthesizeBtn.disabled = false;
        synthesizeBtn.textContent = "Synthesize Speech";
    }
});

ttsClearBtn.addEventListener("click", () => {
    textInput.value = "";
    hideStatus(ttsStatusEl);
    clearAudio();
    textInput.focus();
});

// ---------- Speech to Text ----------

const TARGET_SAMPLE_RATE = 16000;

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const recordingIndicator = document.getElementById("recordingIndicator");
const playback = document.getElementById("playback");
const fileInput = document.getElementById("fileInput");
const transcribeBtn = document.getElementById("transcribeBtn");
const sttClearBtn = document.getElementById("sttClearBtn");
const sttStatusEl = document.getElementById("sttStatus");
const resultPanel = document.getElementById("resultPanel");
const resultText = document.getElementById("resultText");
const copyBtn = document.getElementById("copyBtn");

let audioContext = null;
let mediaStream = null;
let sourceNode = null;
let processorNode = null;
let recordedChunks = [];
let inputSampleRate = 44100;

// The audio that will be sent: the last recording or the last selected file
let currentAudio = null;

// Recording (Web Audio API)

async function startRecording() {
    try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
        showStatus(sttStatusEl, `Microphone access denied: ${err.message}`, "error");
        return;
    }

    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    inputSampleRate = audioContext.sampleRate;
    sourceNode = audioContext.createMediaStreamSource(mediaStream);
    processorNode = audioContext.createScriptProcessor(4096, 1, 1);
    recordedChunks = [];

    processorNode.onaudioprocess = (e) => {
        recordedChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };

    sourceNode.connect(processorNode);
    processorNode.connect(audioContext.destination);

    startBtn.disabled = true;
    stopBtn.disabled = false;
    recordingIndicator.classList.remove("hidden");
    hideStatus(sttStatusEl);
}

function stopRecording() {
    processorNode.disconnect();
    sourceNode.disconnect();
    mediaStream.getTracks().forEach((t) => t.stop());
    audioContext.close();

    startBtn.disabled = false;
    stopBtn.disabled = true;
    recordingIndicator.classList.add("hidden");

    const samples = mergeChunks(recordedChunks);
    recordedChunks = [];
    if (samples.length === 0) {
        showStatus(sttStatusEl, "No audio was recorded.", "error");
        return;
    }

    const downsampled = downsample(samples, inputSampleRate, TARGET_SAMPLE_RATE);
    const wavBlob = encodeWav(downsampled, TARGET_SAMPLE_RATE);

    currentAudio = { blob: wavBlob, name: "recording.wav" };
    fileInput.value = "";
    playback.src = URL.createObjectURL(wavBlob);
    playback.classList.remove("hidden");
    showStatus(sttStatusEl, "Recording ready. Click \"Transcribe Audio\".", "success");
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

// File upload

function onFileSelected() {
    const file = fileInput.files[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".wav")) {
        showStatus(sttStatusEl, "Please select a .wav file.", "error");
        fileInput.value = "";
        return;
    }
    currentAudio = { blob: file, name: file.name };
    playback.src = URL.createObjectURL(file);
    playback.classList.remove("hidden");
    hideStatus(sttStatusEl);
}

// Transcription

async function transcribe() {
    if (!currentAudio) {
        showStatus(sttStatusEl, "Please record audio or select a WAV file first.", "error");
        return;
    }

    const formData = new FormData();
    formData.append("audio", currentAudio.blob, currentAudio.name);

    transcribeBtn.disabled = true;
    showStatus(sttStatusEl, "Transcribing...", "info");

    try {
        const response = await fetch("/api/stt", { method: "POST", body: formData });
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error || `Request failed (${response.status})`);
        }

        if (data.text) {
            resultText.textContent = data.text;
            showStatus(sttStatusEl, "Transcription complete!", "success");
        } else {
            resultText.textContent = "(No speech recognized)";
            showStatus(sttStatusEl, "No speech was recognized in the audio.", "error");
        }
        resultPanel.classList.remove("hidden");
    } catch (err) {
        showStatus(sttStatusEl, `Error: ${err.message}`, "error");
    } finally {
        transcribeBtn.disabled = false;
    }
}

function clearTranscription() {
    currentAudio = null;
    fileInput.value = "";
    playback.removeAttribute("src");
    playback.classList.add("hidden");
    resultText.textContent = "";
    resultPanel.classList.add("hidden");
    hideStatus(sttStatusEl);
}

async function copyText() {
    try {
        await navigator.clipboard.writeText(resultText.textContent);
        showStatus(sttStatusEl, "Text copied to clipboard!", "success");
    } catch (err) {
        showStatus(sttStatusEl, "Could not copy text.", "error");
    }
}

startBtn.addEventListener("click", startRecording);
stopBtn.addEventListener("click", stopRecording);
fileInput.addEventListener("change", onFileSelected);
transcribeBtn.addEventListener("click", transcribe);
sttClearBtn.addEventListener("click", clearTranscription);
copyBtn.addEventListener("click", copyText);
