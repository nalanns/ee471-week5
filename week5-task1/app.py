import os
import tempfile
import threading
from pathlib import Path

import azure.cognitiveservices.speech as speechsdk
from dotenv import load_dotenv
from flask import Flask, Response, jsonify, render_template, request

# Load SPEECH_KEY / SPEECH_REGION from the .env file in the repo root, one level above this folder
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

SPEECH_KEY = os.getenv("SPEECH_KEY")
SPEECH_REGION = os.getenv("SPEECH_REGION")
VOICE_NAME = "en-US-JennyNeural"

app = Flask(__name__)


def is_wav(file_storage):
    """Check the filename extension and the RIFF/WAVE header."""
    if not file_storage.filename.lower().endswith(".wav"):
        return False
    header = file_storage.stream.read(12)
    file_storage.stream.seek(0)
    return len(header) == 12 and header[:4] == b"RIFF" and header[8:12] == b"WAVE"


def transcribe(wav_path):
    """Run continuous recognition on a WAV file. Returns (text, error)."""
    speech_config = speechsdk.SpeechConfig(subscription=SPEECH_KEY, region=SPEECH_REGION)
    speech_config.speech_recognition_language = "en-US"
    audio_config = speechsdk.audio.AudioConfig(filename=wav_path)
    recognizer = speechsdk.SpeechRecognizer(speech_config=speech_config, audio_config=audio_config)

    results = []
    errors = []
    done = threading.Event()

    def on_recognized(evt):
        if evt.result.reason == speechsdk.ResultReason.RecognizedSpeech and evt.result.text:
            results.append(evt.result.text)

    def on_canceled(evt):
        # EndOfStream is the normal end of a file; only Error is a failure
        if evt.cancellation_details.reason == speechsdk.CancellationReason.Error:
            details = evt.cancellation_details
            errors.append(f"Recognition canceled: {details.reason.name}. {details.error_details}")
        done.set()

    recognizer.recognized.connect(on_recognized)
    recognizer.canceled.connect(on_canceled)
    recognizer.session_stopped.connect(lambda evt: done.set())

    recognizer.start_continuous_recognition()
    done.wait(timeout=600)
    recognizer.stop_continuous_recognition()

    if errors:
        return None, errors[0]
    return " ".join(results), None


@app.get("/")
def index():
    return render_template("index.html")


@app.post("/api/tts")
def tts():
    data = request.get_json(silent=True) or {}
    text = (data.get("text") or "").strip()
    if not text:
        return jsonify({"error": "Text must not be empty."}), 400

    if not SPEECH_KEY or not SPEECH_REGION:
        return jsonify({"error": "SPEECH_KEY and SPEECH_REGION must be set in .env."}), 500

    speech_config = speechsdk.SpeechConfig(subscription=SPEECH_KEY, region=SPEECH_REGION)
    speech_config.speech_synthesis_voice_name = VOICE_NAME
    speech_config.set_speech_synthesis_output_format(
        speechsdk.SpeechSynthesisOutputFormat.Riff16Khz16BitMonoPcm
    )

    # audio_config=None keeps the audio in memory instead of playing it on the server
    synthesizer = speechsdk.SpeechSynthesizer(speech_config=speech_config, audio_config=None)
    result = synthesizer.speak_text_async(text).get()

    if result.reason == speechsdk.ResultReason.SynthesizingAudioCompleted:
        return Response(
            result.audio_data,
            mimetype="audio/wav",
            headers={"Content-Disposition": "inline; filename=speech.wav"},
        )

    if result.reason == speechsdk.ResultReason.Canceled:
        details = result.cancellation_details
        message = f"Speech synthesis canceled: {details.reason}"
        if details.reason == speechsdk.CancellationReason.Error and details.error_details:
            message += f" ({details.error_details})"
        return jsonify({"error": message}), 500

    return jsonify({"error": f"Speech synthesis failed: {result.reason}"}), 500


@app.post("/api/stt")
def stt():
    audio = request.files.get("audio")
    if audio is None or audio.filename == "":
        return jsonify({"error": "No audio file provided."}), 400
    if not is_wav(audio):
        return jsonify({"error": "File must be a WAV (.wav) audio file."}), 400
    if not SPEECH_KEY or not SPEECH_REGION:
        return jsonify({"error": "SPEECH_KEY and SPEECH_REGION must be set in .env."}), 500

    fd, tmp_path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        audio.save(tmp_path)
        text, error = transcribe(tmp_path)
    except Exception as exc:
        return jsonify({"error": f"Recognition failed: {exc}"}), 500
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass

    if error:
        return jsonify({"error": error}), 500
    return jsonify({"text": text})


if __name__ == "__main__":
    # Port 5000 is taken by macOS AirPlay Receiver
    app.run(debug=True, port=5001)
