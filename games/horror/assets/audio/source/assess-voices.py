"""Reassess the actual runtime encodes after EQ/compression, without resynthesis."""

import argparse
import importlib.util
import json
import subprocess
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    helper = Path.home() / ".copilot" / "skills" / "speech-production" / "scripts" / "speech_production.py"
    spec = importlib.util.spec_from_file_location("speech_production", helper)
    speech = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(speech)
    region, key, credential_source = speech.get_speech_resource({"preferred_region": "eastus2"})
    inventory = json.loads(args.inventory.read_text(encoding="utf-8"))
    args.output.mkdir(parents=True, exist_ok=True)
    results = []
    for cue in inventory["cues"]:
        source = args.inventory.parent / cue["url"]
        if speech.sha256(source) != cue["sha256"]:
            raise RuntimeError(f'Runtime file changed: {cue["id"]}')
        wav = args.output / f'{cue["id"]}.wav'
        subprocess.run([
            "ffmpeg", "-hide_banner", "-v", "error", "-y", "-i", str(source),
            "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", str(wav),
        ], check=True)
        result = speech.assess(region, key, "en-US", wav, cue["caption"]["text"])
        waveform = speech.waveform_metrics(wav)
        passed = (
            result["accuracy_score"] >= 90
            and result["fluency_score"] >= 70
            and result["completeness_score"] >= 90
            and waveform["clipped_sample_fraction"] == 0
        )
        results.append({
            "id": cue["id"], "runtimeSha256": cue["sha256"], "decodedSha256": speech.sha256(wav),
            "text": cue["caption"]["text"], "assessment": result, "waveform": waveform,
            "decision": "PASS" if passed else "FAIL",
        })
        print(cue["id"], results[-1]["decision"], flush=True)
    passed = all(item["decision"] == "PASS" for item in results)
    report = {
        "scope": "Runtime Ogg Opus decoded to PCM and assessed after all EQ/compression; no resynthesis.",
        "credentialSource": credential_source,
        "region": region,
        "thresholds": {"accuracy": 90, "fluency": 70, "completeness": 90},
        "decision": "PASS" if passed else "FAIL",
        "humanListeningRequired": True,
        "segments": results,
    }
    (args.output / "runtime-speech-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    if not passed:
        sys.exit(2)


if __name__ == "__main__":
    main()
