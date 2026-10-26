import difflib
import os
import re
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
RECOGNITION_LANGUAGE = "en-US"
TRANSLATION_TARGETS = {"tr", "de", "fr", "es"}

app = Flask(__name__)


def is_wav(file_storage):
    """Check the filename extension and the RIFF/WAVE header."""
    if not file_storage.filename.lower().endswith(".wav"):
        return False
    header = file_storage.stream.read(12)
    file_storage.stream.seek(0)
    return len(header) == 12 and header[:4] == b"RIFF" and header[8:12] == b"WAVE"


def recognition_config():
    speech_config = speechsdk.SpeechConfig(subscription=SPEECH_KEY, region=SPEECH_REGION)
    speech_config.speech_recognition_language = RECOGNITION_LANGUAGE
    return speech_config


def run_continuous(recognizer, start, stop):
    """Run a continuous session until it stops or is canceled. Returns an error message or None."""
    errors = []
    done = threading.Event()

    def on_canceled(evt):
        # EndOfStream is the normal end of a file; only Error is a failure
        details = evt.cancellation_details
        if details.reason == speechsdk.CancellationReason.Error:
            errors.append(f"Recognition canceled: {details.reason.name}. {details.error_details}")
        done.set()

    recognizer.canceled.connect(on_canceled)
    recognizer.session_stopped.connect(lambda evt: done.set())

    start()
    done.wait(timeout=600)
    stop()

    return errors[0] if errors else None


def process_audio(handler):
    """Validate the uploaded WAV, run handler(path) on a temp copy and return the JSON response.

    handler returns (payload, error); a non-empty error becomes a 500 response.
    """
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
        payload, error = handler(tmp_path)
    except Exception as exc:
        return jsonify({"error": f"Recognition failed: {exc}"}), 500
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass

    if error:
        return jsonify({"error": error}), 500
    return jsonify(payload)


def transcribe(wav_path):
    """Continuous speech recognition of a WAV file."""
    audio_config = speechsdk.audio.AudioConfig(filename=wav_path)
    recognizer = speechsdk.SpeechRecognizer(speech_config=recognition_config(), audio_config=audio_config)

    results = []

    def on_recognized(evt):
        if evt.result.reason == speechsdk.ResultReason.RecognizedSpeech and evt.result.text:
            results.append(evt.result.text)

    recognizer.recognized.connect(on_recognized)
    error = run_continuous(
        recognizer, recognizer.start_continuous_recognition, recognizer.stop_continuous_recognition
    )
    return {"text": " ".join(results)}, error


def diarize(wav_path):
    """Real-time diarization: who said what, in order."""
    audio_config = speechsdk.audio.AudioConfig(filename=wav_path)
    transcriber = speechsdk.transcription.ConversationTranscriber(
        speech_config=recognition_config(), audio_config=audio_config
    )

    segments = []

    def on_transcribed(evt):
        if evt.result.reason == speechsdk.ResultReason.RecognizedSpeech and evt.result.text:
            segments.append({"speaker": evt.result.speaker_id, "text": evt.result.text})

    transcriber.transcribed.connect(on_transcribed)
    error = run_continuous(
        transcriber,
        lambda: transcriber.start_transcribing_async().get(),
        lambda: transcriber.stop_transcribing_async().get(),
    )
    return {"segments": segments}, error


def translate(wav_path, target):
    """Recognize English speech and translate it into the target language."""
    translation_config = speechsdk.translation.SpeechTranslationConfig(
        subscription=SPEECH_KEY, region=SPEECH_REGION
    )
    translation_config.speech_recognition_language = RECOGNITION_LANGUAGE
    translation_config.add_target_language(target)
    audio_config = speechsdk.audio.AudioConfig(filename=wav_path)
    recognizer = speechsdk.translation.TranslationRecognizer(
        translation_config=translation_config, audio_config=audio_config
    )

    recognized = []
    translated = []

    def on_recognized(evt):
        if evt.result.reason == speechsdk.ResultReason.TranslatedSpeech and evt.result.text:
            recognized.append(evt.result.text)
            translated.append(evt.result.translations.get(target, ""))

    recognizer.recognized.connect(on_recognized)
    error = run_continuous(
        recognizer, recognizer.start_continuous_recognition, recognizer.stop_continuous_recognition
    )
    return {"recognized": " ".join(recognized), "translation": " ".join(translated)}, error


def assess_pronunciation(wav_path, reference_text):
    """Score the speech against the reference text, overall and per word."""
    audio_config = speechsdk.audio.AudioConfig(filename=wav_path)
    recognizer = speechsdk.SpeechRecognizer(speech_config=recognition_config(), audio_config=audio_config)
    pronunciation_config = speechsdk.PronunciationAssessmentConfig(
        reference_text=reference_text,
        grading_system=speechsdk.PronunciationAssessmentGradingSystem.HundredMark,
        granularity=speechsdk.PronunciationAssessmentGranularity.Phoneme,
        enable_miscue=True,
    )
    pronunciation_config.apply_to(recognizer)

    texts = []
    assessments = []

    def on_recognized(evt):
        # Empty results (silence) carry no assessment data
        if evt.result.reason == speechsdk.ResultReason.RecognizedSpeech and evt.result.text:
            texts.append(evt.result.text)
            assessments.append(speechsdk.PronunciationAssessmentResult(evt.result))

    recognizer.recognized.connect(on_recognized)
    error = run_continuous(
        recognizer, recognizer.start_continuous_recognition, recognizer.stop_continuous_recognition
    )

    # In continuous mode the service scores each segment on its own and does not report
    # omissions/insertions, so align the recognized words with the reference text here
    # (same approach as Microsoft's continuous pronunciation assessment sample).
    reference_words = re.findall(r"[a-z0-9']+", reference_text.lower())
    spoken = [
        {"word": w.word, "accuracy": w.accuracy_score, "error_type": w.error_type}
        for a in assessments
        for w in a.words
    ]
    spoken_words = [w["word"].lower() for w in spoken]

    words = []
    matcher = difflib.SequenceMatcher(None, reference_words, spoken_words, autojunk=False)
    for tag, ref_start, ref_end, spoken_start, spoken_end in matcher.get_opcodes():
        if tag == "equal":
            words.extend(spoken[spoken_start:spoken_end])
            continue
        if tag in ("delete", "replace"):
            words.extend(
                {"word": word, "accuracy": 0, "error_type": "Omission"}
                for word in reference_words[ref_start:ref_end]
            )
        if tag in ("insert", "replace"):
            words.extend(
                {**w, "error_type": "Insertion"} for w in spoken[spoken_start:spoken_end]
            )

    scored = [w for w in words if w["error_type"] != "Insertion"]
    matched = [w for w in scored if w["error_type"] != "Omission"]
    accuracy = sum(w["accuracy"] for w in scored) / len(scored) if scored else 0
    completeness = 100 * len(matched) / len(reference_words) if reference_words else 0

    # Fluency comes from the service, averaged over segments weighted by word count
    weights = [max(len(a.words), 1) for a in assessments]
    fluency = (
        sum(a.fluency_score * w for a, w in zip(assessments, weights)) / sum(weights)
        if assessments
        else 0
    )

    # Overall score as the service computes it without prosody: 60% lowest, 20% each other
    lowest, middle, highest = sorted([accuracy, fluency, completeness])
    pronunciation = lowest * 0.6 + middle * 0.2 + highest * 0.2

    payload = {
        "recognized": " ".join(texts),
        "accuracy": round(accuracy, 1),
        "fluency": round(fluency, 1),
        "completeness": round(completeness, 1),
        "pronunciation": round(pronunciation, 1),
        "words": words,
    }
    return payload, error


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
    return process_audio(transcribe)


@app.post("/api/diarize")
def diarize_endpoint():
    return process_audio(diarize)


@app.post("/api/translate")
def translate_endpoint():
    target = request.form.get("target", "")
    if target not in TRANSLATION_TARGETS:
        return jsonify({"error": f"Target must be one of: {', '.join(sorted(TRANSLATION_TARGETS))}."}), 400
    return process_audio(lambda path: translate(path, target))


@app.post("/api/pronunciation")
def pronunciation_endpoint():
    reference_text = (request.form.get("reference_text") or "").strip()
    if not reference_text:
        return jsonify({"error": "Reference text must not be empty."}), 400
    return process_audio(lambda path: assess_pronunciation(path, reference_text))


if __name__ == "__main__":
    # Port 5000 is taken by macOS AirPlay Receiver
    app.run(debug=True, port=5001)
