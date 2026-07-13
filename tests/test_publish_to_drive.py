"""publish_to_drive: manifest construction, b64 payloads, retry logic.

No network anywhere — requests.post is monkeypatched on the module attribute
the script actually calls through. The script lives outside a package
(scripts/), so it is loaded by file path.
"""
from __future__ import annotations

import base64
import importlib.util
import json
from pathlib import Path

import pytest
import requests

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location(
    "publish_to_drive", ROOT / "scripts" / "publish_to_drive.py")
pub = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pub)

STAMP = "2026-07-13_abc1234"


@pytest.fixture
def artifacts(tmp_path: Path) -> Path:
    """Fake rendered tree shaped exactly like the workflow lays down."""
    (tmp_path / "resume" / "out").mkdir(parents=True)
    (tmp_path / "resume" / "out-alt").mkdir()
    for rel, content in {
        "resume/out/Salman_Shaheen_Resume.pdf": b"%PDF base",
        "resume/out/Salman_Shaheen_Resume.docx": b"PK base",
        "resume/out-alt/Salman_Shaheen_Resume.pdf": b"%PDF alt",
        "resume/out-alt/Salman_Shaheen_Resume.docx": b"PK alt",
        "resume/base.yaml": b"cv:\n  name: Salman Shaheen\n",
    }.items():
        (tmp_path / rel).write_bytes(content)
    return tmp_path


class Resp:
    def __init__(self, status: int = 200, body=None, text: str = ""):
        self.status_code = status
        self._body = body
        self.text = text if text else ("" if body is None else json.dumps(body))

    def json(self):
        if self._body is None:
            raise ValueError("not json")
        return self._body


# ---- manifest

def test_manifest_covers_all_targets(artifacts):
    m = pub.build_manifest(artifacts, STAMP)
    assert [(i["target"], i["filename"]) for i in m] == [
        ("current", "Salman_Shaheen_Resume.pdf"),
        ("current", "Salman_Shaheen_Resume.docx"),
        ("current-alt", "Salman_Shaheen_Resume.pdf"),
        ("current-alt", "Salman_Shaheen_Resume.docx"),
        ("archive", f"{STAMP}_Salman_Shaheen_Resume.pdf"),
        ("archive", f"{STAMP}_Salman_Shaheen_Resume_alt.pdf"),
        ("archive", f"{STAMP}_base.yaml"),
    ]
    mimes = {i["filename"]: i["mime"] for i in m}
    assert mimes["Salman_Shaheen_Resume.pdf"] == "application/pdf"
    assert mimes[f"{STAMP}_base.yaml"] == "application/x-yaml"
    assert "wordprocessingml" in mimes["Salman_Shaheen_Resume.docx"]


def test_manifest_fails_loud_on_missing_artifact(artifacts):
    (artifacts / "resume/out-alt/Salman_Shaheen_Resume.pdf").unlink()
    with pytest.raises(pub.PublishError, match="out-alt"):
        pub.build_manifest(artifacts, STAMP)


def test_payload_b64_roundtrip(artifacts):
    item = pub.build_manifest(artifacts, STAMP)[0]
    p = pub.payload_for(item, token="tok", label="tweak")
    assert set(p) == {"token", "target", "label", "filename", "content_b64", "mime"}
    assert base64.b64decode(p["content_b64"]) == b"%PDF base"
    assert (p["token"], p["label"]) == ("tok", "tweak")


# ---- retry

def test_retry_recovers_after_transient_failures(monkeypatch):
    calls, sleeps = [], []
    outcomes = [requests.exceptions.ConnectionError("boom"),
                Resp(status=500, text="Internal Error"),
                Resp(body={"ok": True})]

    def fake_post(url, json=None, timeout=None):
        calls.append(json)
        out = outcomes[len(calls) - 1]
        if isinstance(out, Exception):
            raise out
        return out

    monkeypatch.setattr(pub.requests, "post", fake_post)
    pub.post_with_retry("https://x", {"target": "current", "filename": "a.pdf"},
                        sleep=sleeps.append)
    assert len(calls) == 3
    assert sleeps == [2.0, 4.0]   # exponential backoff, no sleep after success


def test_retry_exhausted_raises_with_context(monkeypatch):
    calls = []
    monkeypatch.setattr(
        pub.requests, "post",
        lambda url, json=None, timeout=None: calls.append(1) or Resp(status=502, text="Bad Gateway"))
    with pytest.raises(pub.PublishError, match=r"current/a\.pdf.*3 attempts.*502"):
        pub.post_with_retry("https://x", {"target": "current", "filename": "a.pdf"},
                            sleep=lambda s: None)
    assert len(calls) == 3


def test_uploader_rejection_is_retried_then_raises(monkeypatch):
    calls = []
    monkeypatch.setattr(
        pub.requests, "post",
        lambda url, json=None, timeout=None: calls.append(1) or Resp(body={"ok": False, "error": "bad token"}))
    with pytest.raises(pub.PublishError, match="bad token"):
        pub.post_with_retry("https://x", {"target": "archive", "filename": "b.yaml"},
                            sleep=lambda s: None)
    assert len(calls) == 3


def test_non_json_200_is_a_failure(monkeypatch):
    monkeypatch.setattr(pub.requests, "post",
                        lambda url, json=None, timeout=None: Resp(text="<html>sign in</html>"))
    with pytest.raises(pub.PublishError, match="non-JSON"):
        pub.post_with_retry("https://x", {"target": "current", "filename": "a.pdf"},
                            retries=1, sleep=lambda s: None)


# ---- main

def test_dry_run_prints_manifest_and_skips_network(artifacts, capsys, monkeypatch):
    monkeypatch.setattr(pub.requests, "post",
                        lambda *a, **k: pytest.fail("dry run must not touch the network"))
    rc = pub.main(["--dry-run", "--repo-root", str(artifacts), "--label", "x"])
    out = capsys.readouterr().out
    assert rc == 0
    assert "current-alt" in out and "archive" in out and "dry run" in out


def test_main_requires_endpoint_env(artifacts, monkeypatch, capsys):
    monkeypatch.delenv("APPSSCRIPT_UPLOAD_URL", raising=False)
    monkeypatch.delenv("APPSSCRIPT_UPLOAD_SECRET", raising=False)
    rc = pub.main(["--repo-root", str(artifacts)])
    assert rc == 2
    assert "APPSSCRIPT_UPLOAD_URL" in capsys.readouterr().err


def test_main_uploads_every_manifest_item(artifacts, monkeypatch):
    monkeypatch.setenv("APPSSCRIPT_UPLOAD_URL", "https://script.example/exec")
    monkeypatch.setenv("APPSSCRIPT_UPLOAD_SECRET", "s3cret")
    monkeypatch.setenv("GITHUB_SHA", "abc1234def5678")
    sent = []
    monkeypatch.setattr(
        pub.requests, "post",
        lambda url, json=None, timeout=None: sent.append((url, json)) or Resp(body={"ok": True}))
    rc = pub.main(["--repo-root", str(artifacts), "--label", "tighten bullets"])
    assert rc == 0
    assert len(sent) == 7
    assert all(url == "https://script.example/exec" for url, _ in sent)
    assert {p["target"] for _, p in sent} == {"current", "current-alt", "archive"}
    assert all(p["token"] == "s3cret" and p["label"] == "tighten bullets" for _, p in sent)
    archive_names = [p["filename"] for _, p in sent if p["target"] == "archive"]
    assert len(archive_names) == 3
    assert all("_abc1234_" in n for n in archive_names)   # stamp carries the sha
