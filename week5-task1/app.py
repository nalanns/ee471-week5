import os
from pathlib import Path

import azure.cognitiveservices.speech as speechsdk
from dotenv import load_dotenv
from flask import Flask, Response, jsonify, render_template, request

# .env lives in the repo root, one level above this folder
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

SPEECH_KEY = os.getenv("SPEECH_KEY")
SPEECH_REGION = os.getenv("SPEECH_REGION")
VOICE_NAME = "en-US-JennyNeural"

app = Flask(__name__)


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


if __name__ == "__main__":
    # Port 5000 is taken by macOS AirPlay Receiver
    app.run(debug=True, port=5001)
