import math
import os
import tempfile
import threading
from pathlib import Path

import azure.cognitiveservices.speech as speechsdk
from dotenv import load_dotenv
from flask import Flask, Response, jsonify, render_template, request

from custom_classes import Calculator

# Load SPEECH_KEY / SPEECH_REGION from the .env file in the repo root, one level above this folder
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

SPEECH_KEY = os.getenv("SPEECH_KEY")
SPEECH_REGION = os.getenv("SPEECH_REGION")
VOICE_NAME = "en-US-JennyNeural"
RECOGNITION_LANGUAGE = "en-US"
MAX_TTS_LENGTH = 200

# Words the calculator understands; biases recognition towards them
PHRASES = [
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
    "point", "over", "times", "plus", "minus", "is",
]

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 10 * 1024 * 1024

OPERATIONS = {
    "+": "add",
    "-": "subtract",
    "*": "multiply",
    "/": "divide",
}


def error(message):
    return jsonify({"error": message}), 400


def is_number(value):
    # bool is a subclass of int, so exclude it explicitly
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/calculate", methods=["POST"])
def calculate():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return error("Request body must be a JSON object")

    missing = [field for field in ("a", "b", "op") if field not in data]
    if missing:
        return error(f"Missing field(s): {', '.join(missing)}")

    a, b, op = data["a"], data["b"], data["op"]
    if not is_number(a):
        return error("'a' must be a number")
    if not is_number(b):
        return error("'b' must be a number")
    if op not in OPERATIONS:
        return error(f"Unknown operator: {op}. Use one of + - * /")

    calculator = Calculator()
    try:
        result = getattr(calculator, OPERATIONS[op])(a, b)
    except ValueError as exc:
        return error(str(exc))

    if not math.isfinite(result):
        return error("Result is out of range")

    return jsonify({"result": result})


def speech_configured():
    return bool(SPEECH_KEY and SPEECH_REGION)


def is_wav(file_storage):
    """Check the RIFF/WAVE header."""
    header = file_storage.stream.read(12)
    file_storage.stream.seek(0)
    return len(header) == 12 and header[:4] == b"RIFF" and header[8:12] == b"WAVE"


@app.route("/api/tts", methods=["POST"])
def tts():
    data = request.get_json(silent=True)
    text = data.get("text") if isinstance(data, dict) else None
    if not isinstance(text, str) or not text.strip():
        return error("'text' must be a non-empty string")
    text = text.strip()
    if len(text) > MAX_TTS_LENGTH:
        return error(f"'text' must be at most {MAX_TTS_LENGTH} characters")
    if not speech_configured():
        return jsonify({"error": "SPEECH_KEY and SPEECH_REGION must be set in .env"}), 500

    speech_config = speechsdk.SpeechConfig(subscription=SPEECH_KEY, region=SPEECH_REGION)
    speech_config.speech_synthesis_voice_name = VOICE_NAME
    speech_config.set_speech_synthesis_output_format(
        speechsdk.SpeechSynthesisOutputFormat.Riff16Khz16BitMonoPcm
    )

    # audio_config=None keeps the audio in memory instead of playing it on the server
    synthesizer = speechsdk.SpeechSynthesizer(speech_config=speech_config, audio_config=None)
    result = synthesizer.speak_text_async(text).get()

    if result.reason == speechsdk.ResultReason.SynthesizingAudioCompleted:
        return Response(result.audio_data, mimetype="audio/wav")

    message = f"Speech synthesis failed: {result.reason.name}"
    if result.reason == speechsdk.ResultReason.Canceled:
        details = result.cancellation_details
        message = f"Speech synthesis canceled: {details.reason.name}"
        if details.reason == speechsdk.CancellationReason.Error and details.error_details:
            message += f" ({details.error_details})"
    return jsonify({"error": message}), 502


def recognize(wav_path):
    """Continuous recognition of a WAV file, so pauses between words don't cut it short.

    Returns (text, error message or None).
    """
    speech_config = speechsdk.SpeechConfig(subscription=SPEECH_KEY, region=SPEECH_REGION)
    speech_config.speech_recognition_language = RECOGNITION_LANGUAGE
    audio_config = speechsdk.audio.AudioConfig(filename=wav_path)
    recognizer = speechsdk.SpeechRecognizer(speech_config=speech_config, audio_config=audio_config)

    phrase_list = speechsdk.PhraseListGrammar.from_recognizer(recognizer)
    for phrase in PHRASES:
        phrase_list.addPhrase(phrase)

    texts = []
    errors = []
    done = threading.Event()

    def on_recognized(evt):
        if evt.result.reason == speechsdk.ResultReason.RecognizedSpeech and evt.result.text:
            texts.append(evt.result.text)

    def on_canceled(evt):
        # EndOfStream is the normal end of a file; only Error is a failure
        details = evt.cancellation_details
        if details.reason == speechsdk.CancellationReason.Error:
            errors.append(f"Recognition canceled: {details.error_details}")
        done.set()

    recognizer.recognized.connect(on_recognized)
    recognizer.canceled.connect(on_canceled)
    recognizer.session_stopped.connect(lambda evt: done.set())

    recognizer.start_continuous_recognition()
    done.wait(timeout=60)
    recognizer.stop_continuous_recognition()

    return " ".join(texts), errors[0] if errors else None


@app.route("/api/voice", methods=["POST"])
def voice():
    audio = request.files.get("audio")
    if audio is None:
        return error("Missing multipart field 'audio'")
    if not is_wav(audio):
        return error("'audio' must be a WAV file")
    if not speech_configured():
        return jsonify({"error": "SPEECH_KEY and SPEECH_REGION must be set in .env"}), 500

    fd, tmp_path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        audio.save(tmp_path)
        text, failure = recognize(tmp_path)
    except Exception as exc:
        return jsonify({"error": f"Recognition failed: {exc}"}), 500
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass

    if failure:
        return jsonify({"error": failure}), 502
    if not text.strip():
        return jsonify({"error": "No speech recognized"}), 422
    return jsonify({"text": text})


if __name__ == "__main__":
    # Port 5000 is taken by macOS AirPlay Receiver
    app.run(debug=True, port=5001)
