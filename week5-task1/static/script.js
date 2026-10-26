const TARGET_SAMPLE_RATE = 16000;

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const recordingIndicator = document.getElementById("recordingIndicator");
const playback = document.getElementById("playback");
const fileInput = document.getElementById("fileInput");
const transcribeBtn = document.getElementById("transcribeBtn");
const clearBtn = document.getElementById("clearBtn");
const statusEl = document.getElementById("status");
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

function showStatus(message, type) {
    statusEl.textContent = message;
    statusEl.className = `status ${type}`;
}

function hideStatus() {
    statusEl.className = "status hidden";
}

// ---------- Recording (Web Audio API) ----------

async function startRecording() {
    try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
        showStatus(`Microphone access denied: ${err.message}`, "error");
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
    hideStatus();
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
        showStatus("No audio was recorded.", "error");
        return;
    }

    const downsampled = downsample(samples, inputSampleRate, TARGET_SAMPLE_RATE);
    const wavBlob = encodeWav(downsampled, TARGET_SAMPLE_RATE);

    currentAudio = { blob: wavBlob, name: "recording.wav" };
    fileInput.value = "";
    playback.src = URL.createObjectURL(wavBlob);
    playback.classList.remove("hidden");
    showStatus("Recording ready. Click \"Transcribe Audio\".", "success");
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

// ---------- File upload ----------

function onFileSelected() {
    const file = fileInput.files[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".wav")) {
        showStatus("Please select a .wav file.", "error");
        fileInput.value = "";
        return;
    }
    currentAudio = { blob: file, name: file.name };
    playback.src = URL.createObjectURL(file);
    playback.classList.remove("hidden");
    hideStatus();
}

// ---------- Transcription ----------

async function transcribe() {
    if (!currentAudio) {
        showStatus("Please record audio or select a WAV file first.", "error");
        return;
    }

    const formData = new FormData();
    formData.append("audio", currentAudio.blob, currentAudio.name);

    transcribeBtn.disabled = true;
    showStatus("Transcribing...", "info");

    try {
        const response = await fetch("/api/stt", { method: "POST", body: formData });
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error || `Request failed (${response.status})`);
        }

        if (data.text) {
            resultText.textContent = data.text;
            showStatus("Transcription complete!", "success");
        } else {
            resultText.textContent = "(No speech recognized)";
            showStatus("No speech was recognized in the audio.", "error");
        }
        resultPanel.classList.remove("hidden");
    } catch (err) {
        showStatus(`Error: ${err.message}`, "error");
    } finally {
        transcribeBtn.disabled = false;
    }
}

function clearAll() {
    currentAudio = null;
    fileInput.value = "";
    playback.removeAttribute("src");
    playback.classList.add("hidden");
    resultText.textContent = "";
    resultPanel.classList.add("hidden");
    hideStatus();
}

async function copyText() {
    try {
        await navigator.clipboard.writeText(resultText.textContent);
        showStatus("Text copied to clipboard!", "success");
    } catch (err) {
        showStatus("Could not copy text.", "error");
    }
}

startBtn.addEventListener("click", startRecording);
stopBtn.addEventListener("click", stopRecording);
fileInput.addEventListener("change", onFileSelected);
transcribeBtn.addEventListener("click", transcribe);
clearBtn.addEventListener("click", clearAll);
copyBtn.addEventListener("click", copyText);
