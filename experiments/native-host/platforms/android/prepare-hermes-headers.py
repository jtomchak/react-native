#!/usr/bin/env python3
"""Obtain platform-independent JSI headers matching the Android Hermes AAR.

The Android AAR omits JSI headers. The identical engine version's Apple archive
includes them. No Apple binary or platform-specific Hermes header is used.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import tarfile
import tempfile
import urllib.request

VERSION = "250829098.0.16"
URL = ("https://repo.maven.apache.org/maven2/com/facebook/hermes/hermes-ios/"
       f"{VERSION}/hermes-ios-{VERSION}-hermes-ios-debug.tar.gz")
ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, help="Existing matched destroot/include/jsi directory")
    args = parser.parse_args()
    target = ROOT / ".cache/hermes-jsi/jsi"
    target.mkdir(parents=True, exist_ok=True)
    if args.source:
        if not (args.source / "hermes-interfaces.h").is_file():
            parser.error("Source must be a matched JSI directory")
        shutil.copytree(args.source, target, dirs_exist_ok=True)
    else:
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "hermes.tar.gz"
            with urllib.request.urlopen(URL, timeout=90) as response, archive.open("wb") as output:
                shutil.copyfileobj(response, output)
            with tarfile.open(archive, "r:gz") as bundle:
                for member in bundle.getmembers():
                    marker = "/include/jsi/"
                    if marker not in member.name or not member.isfile():
                        continue
                    relative = Path(member.name.split(marker, 1)[1])
                    if relative.is_absolute() or ".." in relative.parts:
                        raise RuntimeError("Unsafe archive path")
                    destination = target / relative
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    with bundle.extractfile(member) as content, destination.open("wb") as output:
                        shutil.copyfileobj(content, output)
    if not (target / "hermes-interfaces.h").is_file():
        raise RuntimeError("Matched archive did not contain JSI headers")
    manifest = {"version": VERSION, "source": URL, "sha256": {
        str(path.relative_to(target)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(target.rglob("*")) if path.is_file()
    }}
    (target.parent / "provenance.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Prepared matched Hermes {VERSION} JSI headers")


if __name__ == "__main__":
    main()
