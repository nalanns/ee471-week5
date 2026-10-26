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

// ---------- WAV recording (Web Audio API) ----------

const TARGET_SAMPLE_RATE = 16000;

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

// Wires up a tab's Start/Stop buttons, recording indicator, playback and .wav file input.
// The audio to send is the last recording or the last selected file.
function createAudioInput(prefix, statusEl, actionLabel) {
    const startBtn = document.getElementById(`${prefix}StartBtn`);
    const stopBtn = document.getElementById(`${prefix}StopBtn`);
    const recordingIndicator = document.getElementById(`${prefix}RecordingIndicator`);
    const playback = document.getElementById(`${prefix}Playback`);
    const fileInput = document.getElementById(`${prefix}FileInput`);

    let audioContext = null;
    let mediaStream = null;
    let sourceNode = null;
    let processorNode = null;
    let recordedChunks = [];
    let inputSampleRate = 44100;
    let currentAudio = null;
    let playbackUrl = null;

    function setPlayback(blob) {
        if (playbackUrl) URL.revokeObjectURL(playbackUrl);
        playbackUrl = blob ? URL.createObjectURL(blob) : null;
        if (playbackUrl) {
            playback.src = playbackUrl;
            playback.classList.remove("hidden");
        } else {
            playback.removeAttribute("src");
            playback.classList.add("hidden");
        }
    }

    async function startRecording() {
        try {
            mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (err) {
            showStatus(statusEl, `Microphone access denied: ${err.message}`, "error");
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
        hideStatus(statusEl);
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
            showStatus(statusEl, "No audio was recorded.", "error");
            return;
        }

        const downsampled = downsample(samples, inputSampleRate, TARGET_SAMPLE_RATE);
        const wavBlob = encodeWav(downsampled, TARGET_SAMPLE_RATE);

        currentAudio = { blob: wavBlob, name: "recording.wav" };
        fileInput.value = "";
        setPlayback(wavBlob);
        showStatus(statusEl, `Recording ready. Click "${actionLabel}".`, "success");
    }

    function onFileSelected() {
        const file = fileInput.files[0];
        if (!file) return;
        if (!file.name.toLowerCase().endsWith(".wav")) {
            showStatus(statusEl, "Please select a .wav file.", "error");
            fileInput.value = "";
            return;
        }
        currentAudio = { blob: file, name: file.name };
        setPlayback(file);
        hideStatus(statusEl);
    }

    startBtn.addEventListener("click", startRecording);
    stopBtn.addEventListener("click", stopRecording);
    fileInput.addEventListener("change", onFileSelected);

    return {
        getAudio: () => currentAudio,
        clear() {
            currentAudio = null;
            fileInput.value = "";
            setPlayback(null);
        },
    };
}

// Sends the audio (plus any extra form fields) and returns the JSON response
async function postAudio(url, audio, fields = {}) {
    const formData = new FormData();
    formData.append("audio", audio.blob, audio.name);
    for (const [name, value] of Object.entries(fields)) formData.append(name, value);

    const response = await fetch(url, { method: "POST", body: formData });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data.error || `Request failed (${response.status})`);
    }
    return data;
}

// Sets up an audio tab: recorder, action button, Clear button, status and result panel.
// validate() returns an error message or nothing; send(audio) returns the response data;
// render(data) fills the result panel and returns [message, statusType].
function setupAudioTab({ prefix, actionLabel, busyMessage, validate, send, render, reset }) {
    const actionBtn = document.getElementById(`${prefix}ActionBtn`);
    const clearBtn = document.getElementById(`${prefix}ClearBtn`);
    const statusEl = document.getElementById(`${prefix}Status`);
    const resultPanel = document.getElementById(`${prefix}ResultPanel`);
    const audioInput = createAudioInput(prefix, statusEl, actionLabel);

    actionBtn.addEventListener("click", async () => {
        const audio = audioInput.getAudio();
        if (!audio) {
            showStatus(statusEl, "Please record audio or select a WAV file first.", "error");
            return;
        }
        const problem = validate && validate();
        if (problem) {
            showStatus(statusEl, problem, "error");
            return;
        }

        actionBtn.disabled = true;
        showStatus(statusEl, busyMessage, "info");

        try {
            const data = await send(audio);
            const [message, type] = render(data);
            resultPanel.classList.remove("hidden");
            showStatus(statusEl, message, type);
        } catch (err) {
            showStatus(statusEl, `Error: ${err.message}`, "error");
        } finally {
            actionBtn.disabled = false;
        }
    });

    clearBtn.addEventListener("click", () => {
        audioInput.clear();
        resultPanel.classList.add("hidden");
        if (reset) reset();
        hideStatus(statusEl);
    });

    return { statusEl };
}

// ---------- Speech to Text ----------

const sttResultText = document.getElementById("sttResultText");
const sttCopyBtn = document.getElementById("sttCopyBtn");

const sttTab = setupAudioTab({
    prefix: "stt",
    actionLabel: "Transcribe Audio",
    busyMessage: "Transcribing...",
    send: (audio) => postAudio("/api/stt", audio),
    render(data) {
        if (data.text) {
            sttResultText.textContent = data.text;
            return ["Transcription complete!", "success"];
        }
        sttResultText.textContent = "(No speech recognized)";
        return ["No speech was recognized in the audio.", "error"];
    },
    reset() {
        sttResultText.textContent = "";
    },
});

sttCopyBtn.addEventListener("click", async () => {
    try {
        await navigator.clipboard.writeText(sttResultText.textContent);
        showStatus(sttTab.statusEl, "Text copied to clipboard!", "success");
    } catch (err) {
        showStatus(sttTab.statusEl, "Could not copy text.", "error");
    }
});

// ---------- Diarization ----------

const SPEAKER_COLORS = ["#667eea", "#e67e22", "#16a085", "#c0392b", "#8e44ad", "#2980b9"];
const diarizeSegments = document.getElementById("diarizeSegments");

setupAudioTab({
    prefix: "diarize",
    actionLabel: "Identify Speakers",
    busyMessage: "Identifying speakers...",
    send: (audio) => postAudio("/api/diarize", audio),
    render(data) {
        diarizeSegments.replaceChildren();
        const colors = new Map();

        for (const segment of data.segments) {
            if (!colors.has(segment.speaker)) {
                colors.set(segment.speaker, SPEAKER_COLORS[colors.size % SPEAKER_COLORS.length]);
            }
            const color = colors.get(segment.speaker);

            const item = document.createElement("li");
            item.className = "segment";
            item.style.borderLeftColor = color;
            const speaker = document.createElement("span");
            speaker.className = "speaker";
            speaker.style.color = color;
            speaker.textContent = `${segment.speaker}:`;
            item.append(speaker, ` ${segment.text}`);
            diarizeSegments.append(item);
        }

        if (data.segments.length === 0) {
            const item = document.createElement("li");
            item.className = "segment";
            item.textContent = "(No speech recognized)";
            diarizeSegments.append(item);
            return ["No speech was recognized in the audio.", "error"];
        }
        const count = colors.size;
        return [`Found ${count} speaker${count === 1 ? "" : "s"}.`, "success"];
    },
    reset() {
        diarizeSegments.replaceChildren();
    },
});

// ---------- Translation ----------

const translateTarget = document.getElementById("translateTarget");
const translateRecognized = document.getElementById("translateRecognized");
const translateLanguage = document.getElementById("translateLanguage");
const translateText = document.getElementById("translateText");

setupAudioTab({
    prefix: "translate",
    actionLabel: "Translate Audio",
    busyMessage: "Translating...",
    send(audio) {
        translateLanguage.textContent = translateTarget.selectedOptions[0].textContent;
        return postAudio("/api/translate", audio, { target: translateTarget.value });
    },
    render(data) {
        if (data.recognized) {
            translateRecognized.textContent = data.recognized;
            translateText.textContent = data.translation;
            return ["Translation complete!", "success"];
        }
        translateRecognized.textContent = "(No speech recognized)";
        translateText.textContent = "";
        return ["No speech was recognized in the audio.", "error"];
    },
    reset() {
        translateRecognized.textContent = "";
        translateText.textContent = "";
    },
});

// ---------- Pronunciation ----------

const pronReference = document.getElementById("pronReference");
const pronRecognized = document.getElementById("pronRecognized");
const pronWords = document.getElementById("pronWords");
const pronScores = {
    accuracy: document.getElementById("pronAccuracy"),
    fluency: document.getElementById("pronFluency"),
    completeness: document.getElementById("pronCompleteness"),
    pronunciation: document.getElementById("pronPronunciation"),
};

function scoreClass(score) {
    if (score >= 80) return "good";
    if (score >= 60) return "fair";
    return "poor";
}

setupAudioTab({
    prefix: "pron",
    actionLabel: "Assess Pronunciation",
    busyMessage: "Assessing pronunciation...",
    validate: () => (pronReference.value.trim() ? null : "Please enter the reference text."),
    send: (audio) =>
        postAudio("/api/pronunciation", audio, { reference_text: pronReference.value.trim() }),
    render(data) {
        for (const [name, el] of Object.entries(pronScores)) {
            el.textContent = Math.round(data[name]);
            el.className = `score-value ${scoreClass(data[name])}`;
        }

        pronRecognized.textContent = data.recognized || "(No speech recognized)";

        pronWords.replaceChildren();
        for (const word of data.words) {
            const chip = document.createElement("span");
            chip.className = `word ${scoreClass(word.accuracy)}`;
            chip.title = `Accuracy: ${Math.round(word.accuracy)}`;

            const text = document.createElement("span");
            text.className = "word-text";
            text.textContent = word.word;
            chip.append(text);

            if (word.error_type && word.error_type !== "None") {
                chip.classList.add(`word-${word.error_type.toLowerCase()}`);
                const error = document.createElement("span");
                error.className = "word-error";
                error.textContent = word.error_type;
                chip.append(error);
            }
            pronWords.append(chip);
        }

        if (!data.recognized) return ["No speech was recognized in the audio.", "error"];
        return ["Pronunciation assessment complete!", "success"];
    },
    reset() {
        pronRecognized.textContent = "";
        pronWords.replaceChildren();
    },
});
