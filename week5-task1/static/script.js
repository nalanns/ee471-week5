const textInput = document.getElementById("text-input");
const synthesizeBtn = document.getElementById("synthesize-btn");
const clearBtn = document.getElementById("clear-btn");
const statusEl = document.getElementById("status");
const audioPanel = document.getElementById("audio-panel");
const audioPlayer = document.getElementById("audio-player");
const downloadBtn = document.getElementById("download-btn");

let audioUrl = null;

function showStatus(message, type) {
    statusEl.textContent = message;
    statusEl.className = `status ${type}`;
    statusEl.hidden = false;
}

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
        showStatus("Please enter some text.", "error");
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
        showStatus("Speech synthesized successfully!", "success");
    } catch (err) {
        showStatus(err.message, "error");
    } finally {
        synthesizeBtn.disabled = false;
        synthesizeBtn.textContent = "Synthesize Speech";
    }
});

clearBtn.addEventListener("click", () => {
    textInput.value = "";
    statusEl.hidden = true;
    clearAudio();
    textInput.focus();
});
