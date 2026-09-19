"""Optional offline media production only; never imported by the Node game/build."""

import argparse
import hashlib
import json
import socket
import sys
from pathlib import Path


ROOT = Path(r"C:\AI\Wan2GP")
REVISION = "5020589aa562cea206a25eea208d7cbb1f6efae7"
REPOSITORY = "DeepBeepMeep/TTS"
FILES = [
    "stable_audio3_small_sfx_bf16.safetensors",
    "stable_audio3_same_s_bf16.safetensors",
    "t5gemma-b-b-ul2/t5gemma-b-b-ul2_bf16.safetensors",
    "t5gemma-b-b-ul2/config.json",
    "t5gemma-b-b-ul2/special_tokens_map.json",
    "t5gemma-b-b-ul2/tokenizer.json",
    "t5gemma-b-b-ul2/tokenizer.model",
    "t5gemma-b-b-ul2/tokenizer_config.json",
]


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def download(output):
    from huggingface_hub import HfApi, hf_hub_download

    info = HfApi(token=False).model_info(REPOSITORY, revision=REVISION, files_metadata=True)
    available = {entry.rfilename: entry for entry in info.siblings}
    total = sum(available[name].size for name in FILES)
    if total > 2_500_000_000:
        raise RuntimeError(f"Download exceeds approved 2.5 GB bound: {total}")
    entries = []
    for name in FILES:
        path = Path(hf_hub_download(
            REPOSITORY, name, revision=REVISION, token=False, local_dir=ROOT / "ckpts",
        ))
        digest = sha256(path)
        remote = available[name].lfs
        if remote is not None and digest != remote.sha256:
            raise RuntimeError(f"Checkpoint digest mismatch: {name}")
        if path.stat().st_size != available[name].size:
            raise RuntimeError(f"Checkpoint size mismatch: {name}")
        entries.append({"file": name, "bytes": path.stat().st_size, "sha256": digest})
        print(f"VERIFIED {name}", flush=True)
    write_json(output / "model-provenance.json", {
        "repository": REPOSITORY,
        "revision": REVISION,
        "bytes": total,
        "files": entries,
        "authorization": "User confirmed noncommercial hobby/evaluation and accepted Stability and Gemma terms via parent session.",
        "weightsRedistributedWithGame": False,
    })


def generate(manifest_path, output, only):
    for port in (7860, 7865):
        with socket.socket() as connection:
            connection.settimeout(1)
            if connection.connect_ex(("127.0.0.1", port)) == 0:
                raise RuntimeError(f"Port {port} is listening. Do not compete with a model service.")
    missing = [name for name in FILES if not (ROOT / "ckpts" / name).is_file()]
    if missing:
        raise RuntimeError(f"Run the explicitly approved download first: {missing}")
    sys.path.insert(0, str(ROOT))
    import torch
    import soundfile
    from models.TTS.stable_audio3.pipeline import StableAudio3Pipeline
    from shared.attention import attention_shared_state

    torch.set_num_threads(4)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    config = ROOT / "models" / "TTS" / "stable_audio3" / "configs" / "stable_audio3_small_config.json"
    print("LOADING pinned SFX, SAME-S and text encoder", flush=True)
    pipeline = StableAudio3Pipeline(
        str(ROOT / "ckpts" / FILES[0]),
        str(config),
        str(ROOT / "ckpts" / FILES[1]),
        str(ROOT / "ckpts" / FILES[2]),
        str(ROOT / "ckpts" / "t5gemma-b-b-ul2"),
        model_id="small-sfx",
        max_duration=120,
        dtype=torch.bfloat16,
    )
    pipeline.model.to("cuda")
    # WanGP deliberately stores the frozen encoder outside registered child modules.
    pipeline.model.conditioner.conditioners["prompt"].model.to("cuda")
    print("MODEL_READY cuda / bfloat16", flush=True)
    for take in manifest["takes"]:
        if only and take["id"] not in only:
            continue
        target = output / f'{take["id"]}.wav'
        metadata = output / f'{take["id"]}.json'
        if target.exists() or metadata.exists():
            raise RuntimeError(f"Refusing to replace a native take: {target}")
        print(f'GENERATING {take["id"]} seed={take["seed"]}', flush=True)
        with attention_shared_state("sdpa"):
            result = pipeline.generate(
                take["prompt"],
                sampling_steps=manifest["steps"],
                guide_scale=manifest["guidance"],
                sample_solver=manifest["sampler"],
                n_prompt=manifest["negativePrompt"],
                seed=take["seed"],
                duration_seconds=take["duration"],
            )
        if result is None:
            raise RuntimeError(f'No result for {take["id"]}')
        waveform = result["x"][0].float().cpu()
        rate = result["audio_sampling_rate"]
        if waveform.ndim != 2 or waveform.shape[0] != 2 or not torch.isfinite(waveform).all():
            raise RuntimeError(f'Invalid stereo waveform for {take["id"]}')
        if abs(waveform.shape[-1] / rate - take["duration"]) > 0.1:
            raise RuntimeError(f'Unexpected duration for {take["id"]}')
        peak = waveform.abs().max().item()
        if peak < 0.0001:
            raise RuntimeError(f'Effectively silent take: {take["id"]}')
        soundfile.write(str(target), waveform.transpose(0, 1).numpy(), rate, subtype="FLOAT")
        write_json(metadata, {
            **take,
            "model": manifest["model"],
            "distribution": REPOSITORY,
            "distributionRevision": REVISION,
            "wanGpRevision": "bb68ded24f8a25d51789f8a49b66cc63eccf53c9",
            "steps": manifest["steps"],
            "guidance": manifest["guidance"],
            "sampler": manifest["sampler"],
            "attention": "sdpa",
            "negativePrompt": manifest["negativePrompt"],
            "sampleRate": rate,
            "channels": 2,
            "frames": waveform.shape[-1],
            "nativePeak": peak,
            "nativeFormat": "WAV IEEE float32; no normalization",
            "sha256": sha256(target),
            "configSha256": sha256(config),
            "humanListening": "pending",
        })
        print(f"MASTER {target}", flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--manifest", type=Path, default=Path(__file__).with_name("sfx-takes.json"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--only", nargs="*")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    if args.download:
        download(args.output)
    else:
        generate(args.manifest, args.output, args.only)


if __name__ == "__main__":
    main()
